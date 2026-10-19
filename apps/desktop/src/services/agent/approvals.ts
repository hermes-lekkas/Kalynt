/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Which agent actions need the user's approval.
 *
 *   ask        edits, deletions and commands ask first (default)
 *   auto-edit  file edits apply directly; deletions and commands still ask
 *   full-auto  everything runs without asking, except commands that look
 *              destructive or need elevated rights, which always ask
 *
 * Reading, searching, planning and web search never ask; fetching a URL on
 * this machine or the local network does.
 */
import { isPrivateUrl } from './tools/webTools'
import type { AgentTool } from './tools'

export type AgentMode = 'ask' | 'auto-edit' | 'full-auto'

export const AGENT_MODES: Array<{ id: AgentMode; label: string; hint: string }> = [
    { id: 'ask', label: 'Ask before changes', hint: 'Approve each edit and command.' },
    { id: 'auto-edit', label: 'Auto-edit', hint: 'Edits apply directly; commands still ask.' },
    { id: 'full-auto', label: 'Full auto', hint: 'Runs edits and commands without asking. Risky commands still ask.' }
]

export interface ApprovalDecision {
    allow: boolean
    /** Don't ask again this conversation for this tool (or similar commands). */
    remember?: boolean
    /** Optional note for the agent when declining ("use pnpm instead"). */
    feedback?: string
}

/** Commands that always need a person to confirm. */
const DANGEROUS = [
    /\bsudo\b/, /\bsu\s+-/, /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, /\brm\s+-[a-z]*\s+[/~*]/i,
    /\bmkfs\b/, /\bdd\s+if=/, /\bformat\s+[a-z]:/i, /\bdel\s+\/[sq]/i, /\brmdir\s+\/s/i, /Remove-Item\b.*-Recurse/i,
    /\bgit\s+push\b.*(--force|-f\b)/, /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\s+-[a-z]*f/,
    /\bchmod\s+-R\s+777\b/, /\bchown\s+-R\b/, /:\(\)\s*\{\s*:\|:&\s*\};:/, /\bshutdown\b/, /\breboot\b/,
    /\bcurl\b[^|]*\|\s*(ba|z)?sh\b/, /\bwget\b[^|]*\|\s*(ba|z)?sh\b/, /\bnpm\s+publish\b/, /\bdocker\s+system\s+prune\b/
]

export const isDangerousCommand = (command: string) => DANGEROUS.some(re => re.test(command))

/** Interpreters given inline code: allowing "similar" would allow any program. */
const INLINE_CODE = /^(python3?|node|deno|bun|ruby|perl|php|bash|sh|zsh|pwsh|powershell)\b.*\s(-c|-e|--eval|-Command)\b/i

/**
 * "npm run test -- --watch" -> "npm run test": what "allow similar" remembers.
 * Empty when the command shouldn't be remembered at all.
 */
export function commandPrefix(command: string): string {
    if (INLINE_CODE.test(command.trim()) || /[;&|`$<>]/.test(command)) return ''
    const words = command.trim().split(/\s+/).filter(w => !/^[A-Z_]+=/.test(w))
    const take = ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'git', 'cargo', 'go', 'python', 'python3', 'pip', 'uv', 'dotnet', 'make', 'mvn', 'gradle', './gradlew'].includes(words[0]) ? 3 : 2
    return words.slice(0, take).filter(w => !w.startsWith('-')).join(' ')
}

/** "localhost:5173" for http://localhost:5173/x; empty when it isn't a URL. */
export function urlHost(url: unknown): string {
    try { return new URL(String(url ?? '')).host } catch { return '' }
}

export class ApprovalMemory {
    private readonly tools = new Set<string>()
    private readonly commands = new Set<string>()

    /** Local web addresses are remembered per host, everything else per tool. */
    private key(tool: AgentTool, args: Record<string, unknown>): string {
        return tool.kind === 'web' ? `${tool.name}:${urlHost(args.url)}` : tool.name
    }

    remember(tool: AgentTool, args: Record<string, unknown>) {
        if (tool.kind === 'execute') {
            const prefix = commandPrefix(String(args.command ?? ''))
            if (prefix) this.commands.add(prefix)
        } else this.tools.add(this.key(tool, args))
    }

    allows(tool: AgentTool, args: Record<string, unknown>): boolean {
        if (tool.kind === 'execute') {
            const command = String(args.command ?? '')
            const prefix = commandPrefix(command)
            return !!prefix && !isDangerousCommand(command) && this.commands.has(prefix)
        }
        return this.tools.has(this.key(tool, args))
    }

    clear() {
        this.tools.clear()
        this.commands.clear()
    }
}

export function needsApproval(tool: AgentTool, args: Record<string, unknown>, mode: AgentMode, memory: ApprovalMemory): boolean {
    switch (tool.kind) {
        case 'read':
        case 'search':
        case 'plan':
            return false
        case 'web':
            return tool.name === 'web_fetch' && isPrivateUrl(args.url) && !memory.allows(tool, args)
        case 'edit':
            return mode === 'ask' && !memory.allows(tool, args)
        case 'delete':
            return mode !== 'full-auto' && !memory.allows(tool, args)
        case 'execute': {
            const command = String(args.command ?? '')
            if (isDangerousCommand(command)) return true
            return mode !== 'full-auto' && !memory.allows(tool, args)
        }
    }
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Shell commands: run something and wait for it, or start a long-running
 * process (dev server, watcher) in the background and check on it later.
 */
import { cleanError, fail, type AgentTool, type ToolOutcome } from './types'
import { relativePath, resolvePath } from './paths'

const MODEL_OUTPUT_CHARS = 30_000
const DISPLAY_OUTPUT_CHARS = 20_000

const agentApi = () => {
    const agent = window.electronAPI?.agent
    if (!agent) throw new Error('Commands need the desktop app.')
    return agent
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

/** Long output keeps its beginning and (mostly) its end, where errors and summaries are. */
export function clip(text: string, max: number): string {
    if (text.length <= max) return text
    const head = Math.floor(max * 0.3)
    const tail = max - head
    return `${text.slice(0, head)}\n\n… ${text.length - max} characters omitted …\n\n${text.slice(-tail)}`
}

/** Background processes this conversation started, so the model can only touch its own. */
const backgroundIds = new Set<string>()

export const runCommandTool: AgentTool = {
    name: 'run_command',
    kind: 'execute',
    description: [
        'Run a shell command on the user\'s machine and return its output and exit code.',
        'Use it to run tests, builds, linters, scripts, package managers and git.',
        'Commands run non-interactively (no prompts, no TTY): pass flags such as --yes where needed.',
        'Set background to true for servers and watchers that keep running; you get a process id to check with command_output and stop with stop_command.',
        'The working directory defaults to the workspace; use cwd instead of `cd`.'
    ].join(' '),
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The command line, e.g. "npm test" or "python -m pytest -q".' },
            cwd: { type: 'string', description: 'Working directory. Default: the workspace root.' },
            timeout_seconds: { type: 'integer', description: 'Stop the command after this long. Default 120, maximum 1800.' },
            background: { type: 'boolean', description: 'Start and return after a few seconds, leaving it running.' }
        },
        required: ['command']
    },
    title: args => `Run ${str(args.command)}`,
    async preview(args, ctx) {
        let cwd = ctx.workspace ?? ''
        try { cwd = resolvePath(ctx.workspace, args.cwd || '.') } catch { /* shown as given */ }
        return { type: 'command', command: str(args.command), cwd: relativePath(ctx.workspace, cwd), output: '', exitCode: null, running: false, durationMs: 0, pending: true }
    },
    async execute(args, ctx): Promise<ToolOutcome> {
        const command = str(args.command).trim()
        if (!command) return fail('command is empty.')
        let cwd: string
        try { cwd = resolvePath(ctx.workspace, args.cwd || '.') } catch (e) { return fail(cleanError(e)) }
        const background = args.background === true
        const id = `agent-${ctx.callId}`
        const agent = agentApi()

        const off = agent.onExecOutput(({ id: outId, data }) => { if (outId === id) ctx.onOutput(data) })
        const abort = () => { void agent.execKill(id) }
        ctx.signal.addEventListener('abort', abort, { once: true })
        try {
            const timeoutSeconds = Math.min(Math.max(Number(args.timeout_seconds) || 120, 1), 1800)
            const result = await agent.exec({ id, command, cwd, timeoutMs: timeoutSeconds * 1000, background })
            if (!result.ok) return fail(result.error ?? 'The command could not be started.')
            if (background && result.running) backgroundIds.add(id)
            const display = {
                type: 'command' as const,
                command,
                cwd: relativePath(ctx.workspace, cwd),
                output: clip(result.output, DISPLAY_OUTPUT_CHARS),
                exitCode: result.exitCode,
                running: result.running,
                timedOut: result.timedOut,
                durationMs: result.durationMs,
                ...(background && result.running ? { processId: id } : {})
            }
            if (ctx.signal.aborted) return { content: 'Stopped by the user.', isError: true, display }
            const output = clip(result.output.trimEnd(), MODEL_OUTPUT_CHARS) || '(no output)'
            if (background) {
                return {
                    content: result.running
                        ? `Started in the background (process id: ${id}). Output so far:\n${output}`
                        : `The command exited right away with code ${result.exitCode}:\n${output}`,
                    isError: !result.running && result.exitCode !== 0,
                    display
                }
            }
            const status = result.timedOut ? `Timed out after ${timeoutSeconds}s and was stopped.` : `Exit code ${result.exitCode}.`
            return { content: `${output}\n\n${status}`, isError: result.timedOut || result.exitCode !== 0, display }
        } finally {
            off()
            ctx.signal.removeEventListener('abort', abort)
        }
    }
}

export const commandOutputTool: AgentTool = {
    name: 'command_output',
    kind: 'read',
    description: 'Get new output from a background command started with run_command, and whether it is still running.',
    parameters: {
        type: 'object',
        properties: { process_id: { type: 'string', description: 'The id run_command returned.' } },
        required: ['process_id']
    },
    title: () => 'Check command output',
    async execute(args) {
        const id = str(args.process_id)
        if (!backgroundIds.has(id)) return fail('No background command with that id was started in this conversation.')
        const result = await agentApi().execRead(id)
        if (!result.ok) { backgroundIds.delete(id); return fail(result.error ?? 'That process has ended.') }
        if (!result.running) backgroundIds.delete(id)
        const output = clip(result.output.trimEnd(), MODEL_OUTPUT_CHARS) || '(no new output)'
        return {
            content: `${output}\n\n${result.running ? 'Still running.' : `Exited with code ${result.exitCode}.`}`,
            display: { type: 'text', text: output }
        }
    }
}

export const stopCommandTool: AgentTool = {
    name: 'stop_command',
    kind: 'read',
    description: 'Stop a background command started with run_command.',
    parameters: {
        type: 'object',
        properties: { process_id: { type: 'string', description: 'The id run_command returned.' } },
        required: ['process_id']
    },
    title: () => 'Stop background command',
    async execute(args) {
        const id = str(args.process_id)
        if (!backgroundIds.has(id)) return fail('No background command with that id was started in this conversation.')
        await agentApi().execKill(id)
        backgroundIds.delete(id)
        return { content: 'Stopped.' }
    }
}

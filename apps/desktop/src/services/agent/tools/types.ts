/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The contract every agent tool implements, and what tool results carry for
 * the chat UI (diffs, command output, search hits).
 */
import type { JsonSchema } from '../../../types/aiProtocol'

/** Decides how a call is approved (see approvals.ts). */
export type ToolKind = 'read' | 'search' | 'edit' | 'delete' | 'execute' | 'web' | 'plan'

export type PlanStatus = 'pending' | 'in_progress' | 'done'

export interface PlanItem {
    text: string
    status: PlanStatus
}

export interface DiffLine {
    type: 'context' | 'add' | 'remove' | 'gap'
    text: string
    oldLine?: number
    newLine?: number
}

/** Structured result data for the tool's card in the chat. */
export type ToolDisplay =
    | { type: 'file'; path: string; startLine: number; endLine: number; totalLines: number }
    | { type: 'diff'; path: string; created: boolean; added: number; removed: number; lines: DiffLine[]; problems?: string }
    | { type: 'deleted'; path: string }
    | { type: 'moved'; from: string; to: string }
    | { type: 'command'; command: string; cwd: string; output: string; exitCode: number | null; running: boolean; timedOut?: boolean; durationMs: number; processId?: string; pending?: boolean }
    | { type: 'matches'; query: string; items: Array<{ file: string; line?: number; text?: string }>; total: number; truncated: boolean }
    | { type: 'files'; items: string[]; total: number; truncated: boolean }
    | { type: 'web-results'; query: string; results: Array<{ title: string; url: string; snippet: string }> }
    | { type: 'web-page'; url: string; title: string; chars: number; truncated: boolean }
    | { type: 'plan'; items: PlanItem[] }
    | { type: 'text'; text: string }

export interface ToolOutcome {
    /** What the model reads. */
    content: string
    isError?: boolean
    display?: ToolDisplay
}

export interface ToolContext {
    /** Absolute path of the open folder, if any. */
    workspace: string | null
    signal: AbortSignal
    callId: string
    /** Records a file's current content before the first change in this run. */
    checkpoint: (absolutePath: string) => Promise<void>
    /** Files read or written in this conversation, so edits act on known content. */
    knownFiles: Set<string>
    /** Live command output for the chat card. */
    onOutput: (chunk: string) => void
    plan: { get(): PlanItem[]; set(items: PlanItem[]): void }
}

export interface AgentTool {
    name: string
    kind: ToolKind
    description: string
    parameters: JsonSchema
    /** Short label for the call's card, e.g. "Read src/app.ts". */
    title(args: Record<string, unknown>, workspace: string | null): string
    execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>
    /** What the call would do, without doing it (shown when asking for approval). */
    preview?(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolDisplay | null>
}

export const fail = (content: string, display?: ToolDisplay): ToolOutcome => ({ content, isError: true, display })

/** Error text from IPC results reads better without Node's "Error: ENOENT:" prefixes. */
export function cleanError(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error ?? 'Unknown error')
    return text
        .replace(/^Error:\s*/, '')
        .replace(/^ENOENT: no such file or directory, \w+ '([^']+)'.*$/, 'No such file or folder: $1')
        .replace(/^EACCES: permission denied, \w+ '([^']+)'.*$/, 'Permission denied: $1')
        .replace(/^EISDIR: illegal operation on a directory.*$/, 'That path is a folder, not a file.')
}

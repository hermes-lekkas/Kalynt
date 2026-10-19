/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * An agent conversation: the transcript sent to the model, what each tool
 * call did (for the chat), file checkpoints for undo, and the plan.
 */
import type { ConversationItem, ProviderId } from '../../types/aiProtocol'
import type { PlanItem, ToolDisplay, ToolKind } from './tools'

export type ToolStatus = 'queued' | 'awaiting-approval' | 'running' | 'done' | 'error' | 'denied' | 'skipped'

export interface ToolRecord {
    name: string
    title: string
    kind: ToolKind
    status: ToolStatus
    display?: ToolDisplay
    /** Shown while approval is pending, e.g. the diff an edit would make. */
    preview?: ToolDisplay
    durationMs?: number
}

export interface RunCheckpoint {
    runId: string
    startedAt: number
    /** Original content of each file the run changed (null: it didn't exist). */
    files: Record<string, string | null>
    undone?: boolean
}

export interface AgentSession {
    id: string
    title: string
    spaceId?: string
    createdAt: number
    updatedAt: number
    provider?: ProviderId | 'local'
    model?: string
    /** Fixed when the conversation starts, so caches and preserved thinking stay valid. */
    system?: string
    items: ConversationItem[]
    /** Turns before a compaction: shown in the chat, no longer sent to the model. */
    archive?: ConversationItem[]
    tools: Record<string, ToolRecord>
    checkpoints: RunCheckpoint[]
    plan: PlanItem[]
    usage: { input: number; output: number }
    /** Set when the last run stopped at the step limit, to offer "Continue". */
    paused?: boolean
    /** Notes shown between turns (compaction, refusals, errors), by item index. */
    notes?: Array<{ at: number; text: string; tone?: 'info' | 'error' }>
}

export function newSession(spaceId?: string): AgentSession {
    const now = Date.now()
    return {
        id: crypto.randomUUID(),
        title: 'New conversation',
        spaceId,
        createdAt: now,
        updatedAt: now,
        items: [],
        tools: {},
        checkpoints: [],
        plan: [],
        usage: { input: 0, output: 0 }
    }
}

/** A short title from the first request. */
export function titleFrom(text: string): string {
    const line = text.replace(/@\[([^\]]+)\]\([^)]*\)/g, '$1').split('\n').map(l => l.trim()).find(Boolean) ?? 'New conversation'
    return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line
}

/** Rough token count of the transcript (about 3.5 characters per token). */
export function estimateTokens(session: Pick<AgentSession, 'items' | 'system'>): number {
    let chars = session.system?.length ?? 0
    for (const item of session.items) {
        if (item.role === 'user') chars += item.content.length
        else if (item.role === 'tool') chars += item.content.length
        else {
            chars += item.text.length + (item.reasoning?.length ?? 0)
            for (const call of item.toolCalls) chars += JSON.stringify(call.arguments).length
        }
    }
    return Math.ceil(chars / 3.5)
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The conversation as the user sees it: their messages, and for each agent
 * turn its reasoning, its text and a card per tool call.
 */
import { memo, useState, type ReactNode } from 'react'
import { AlertCircle, ChevronRight, Info } from 'lucide-react'
import type { AssistantItem, ConversationItem, ToolCall, ToolResultItem } from '../../../types/aiProtocol'
import { getTool } from '../../../services/agent/tools'
import { modelLabel } from '../../../types/aiProviders'
import type { AgentSession, ToolRecord } from '../../../services/agent/session'
import type { ApprovalDecision } from '../../../services/agent/approvals'
import type { ApprovalRequest } from '../../../services/agent/runner'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { localModelName } from './modelNames'

export function Reasoning({ text, live }: { text: string; live?: boolean }) {
    const [open, setOpen] = useState(false)
    if (!text.trim()) return null
    const lastLine = text.trim().split('\n').filter(Boolean).pop() ?? ''
    return (
        <div className={`agent-reasoning ${live ? 'is-live' : ''}`}>
            <button type="button" className="agent-reasoning__head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
                <ChevronRight size={12} className={open ? 'is-open' : ''} aria-hidden />
                <span>{live ? 'Thinking' : 'Thought'}</span>
                {!open && live && <span className="agent-reasoning__peek truncate">{lastLine}</span>}
            </button>
            {open && <div className="agent-reasoning__body selectable"><Markdown text={text} /></div>}
        </div>
    )
}

const modelName = (item: AssistantItem) => item.provider === 'local' ? localModelName(item.model) : modelLabel(item.model)

interface TranscriptProps {
    session: AgentSession
    workspace: string | null
    /** The session is updated in place; this changes whenever it does. */
    revision: number
    outputs: Record<string, string>
    approval: { request: ApprovalRequest; decide: (d: ApprovalDecision) => void } | null
}

/** A record for calls that haven't started yet, or were made before records existed. */
function fallbackRecord(call: ToolCall, workspace: string | null, result?: ToolResultItem): ToolRecord {
    const tool = getTool(call.name)
    let title = call.name.replace(/_/g, ' ')
    try { if (tool) title = tool.title(call.arguments, workspace) } catch { /* keep the name */ }
    return { name: call.name, title, kind: tool?.kind ?? 'read', status: !result ? 'queued' : result.isError ? 'error' : 'done' }
}

export const Transcript = memo(function Transcript({ session, workspace, outputs, approval }: TranscriptProps) {
    const results = new Map<string, ToolResultItem>()
    const all: ConversationItem[] = [...(session.archive ?? []), ...session.items]
    for (const item of all) if (item.role === 'tool') results.set(item.callId, item)
    const archived = session.archive?.length ?? 0
    const notesAt = new Map<number, Array<{ text: string; tone?: 'info' | 'error' }>>()
    for (const note of session.notes ?? []) {
        const at = archived + note.at
        notesAt.set(at, [...(notesAt.get(at) ?? []), note])
    }

    const blocks: ReactNode[] = []
    let lastWasUser = true
    const pushNotes = (index: number) => {
        for (const [n, note] of (notesAt.get(index) ?? []).entries()) {
            blocks.push(
                <p key={`note-${index}-${n}`} className={`agent-note ${note.tone === 'error' ? 'is-error' : ''}`}>
                    {note.tone === 'error' ? <AlertCircle size={13} aria-hidden /> : <Info size={13} aria-hidden />}
                    <span>{note.text}</span>
                </p>
            )
        }
    }

    all.forEach((item, index) => {
        pushNotes(index)
        if (index === archived && archived > 0) blocks.push(<div key="archive-divider" className="agent-divider" role="separator">Summarized above this line</div>)
        if (item.role === 'user') {
            lastWasUser = true
            blocks.push(
                <div key={index} className={`chat-msg chat-msg--user selectable ${index < archived ? 'is-archived' : ''}`}>
                    <Markdown text={item.display ?? item.content} />
                </div>
            )
            return
        }
        if (item.role !== 'assistant') return
        const showMeta = lastWasUser
        lastWasUser = false
        blocks.push(
            <div key={index} className={`agent-turn ${index < archived ? 'is-archived' : ''}`}>
                {showMeta && <div className="chat-msg__meta">{modelName(item)}</div>}
                {item.reasoning && <Reasoning text={item.reasoning} />}
                {item.text.trim() && <div className="chat-msg chat-msg--agent selectable"><Markdown text={item.text} /></div>}
                {item.toolCalls.map(call => (
                    <ToolCard
                        key={call.id}
                        record={session.tools[call.id] ?? fallbackRecord(call, workspace, results.get(call.id))}
                        resultText={results.get(call.id)?.content}
                        liveOutput={outputs[call.id]}
                        approval={approval?.request.callId === call.id ? approval : null}
                    />
                ))}
            </div>
        )
    })
    pushNotes(all.length)
    return <>{blocks}</>
})

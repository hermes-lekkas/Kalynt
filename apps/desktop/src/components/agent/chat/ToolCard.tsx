/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * One tool call in the conversation: what the agent did, its status and
 * result, and the approval controls when it needs the user's go-ahead.
 */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import {
    AlertTriangle, Ban, Check, ChevronRight, FilePen, FilePlus2, FileText, FolderOpen, GitBranch, Globe,
    Clock, ListChecks, Loader2, MoveRight, Search, ShieldAlert, SquareTerminal, Stethoscope, Trash2, X
} from 'lucide-react'
import type { ToolRecord } from '../../../services/agent/session'
import type { ApprovalDecision } from '../../../services/agent/approvals'
import { commandPrefix, urlHost } from '../../../services/agent/approvals'
import type { ApprovalRequest } from '../../../services/agent/runner'
import { Button } from '../../ui'
import { ToolBody, headerStat } from './ToolBodies'

function toolIcon(record: ToolRecord): ReactNode {
    const size = 13
    if (record.display?.type === 'diff' && record.display.created) return <FilePlus2 size={size} />
    switch (record.name) {
        case 'read_file': return <FileText size={size} />
        case 'list_directory': return <FolderOpen size={size} />
        case 'find_files': case 'search_code': case 'search_codebase': return <Search size={size} />
        case 'edit_file': case 'write_file': return <FilePen size={size} />
        case 'move_path': return <MoveRight size={size} />
        case 'delete_path': return <Trash2 size={size} />
        case 'run_command': case 'command_output': case 'stop_command': return <SquareTerminal size={size} />
        case 'web_search': case 'web_fetch': return <Globe size={size} />
        case 'update_plan': return <ListChecks size={size} />
        case 'git_status': case 'git_diff': return <GitBranch size={size} />
        case 'get_diagnostics': return <Stethoscope size={size} />
        default: return <FileText size={size} />
    }
}

/** Plain-language titles; the rest are "<verb> <path or command>". */
const PLAIN_TITLES = new Set(['update_plan', 'git_status', 'command_output', 'stop_command', 'list_directory'])

function splitTitle(name: string, title: string): [string, string] {
    if (PLAIN_TITLES.has(name) && !/^List (?!the project)/.test(title)) return [title, '']
    const match = /^(Search the web for|Look up|Search for|Move|\S+)\s+(.+)$/.exec(title)
    return match ? [match[1], match[2]] : [title, '']
}

function StatusIcon({ status }: { status: ToolRecord['status'] }) {
    switch (status) {
        case 'running': return <Loader2 size={13} className="spin" aria-label="Running" />
        case 'done': return <Check size={13} aria-label="Done" />
        case 'error': return <X size={13} aria-label="Failed" />
        case 'denied': return <Ban size={13} aria-label="Declined" />
        case 'skipped': return <Ban size={13} aria-label="Skipped" />
        case 'awaiting-approval': return <ShieldAlert size={13} aria-label="Needs approval" />
        case 'queued': return <Clock size={13} aria-label="Waiting" />
    }
}

function rememberLabel(request: ApprovalRequest): string | null {
    if (request.dangerous) return null
    switch (request.tool.kind) {
        case 'execute': {
            const prefix = commandPrefix(String(request.args.command ?? ''))
            return prefix ? `Always allow “${prefix}”` : null
        }
        case 'edit': return 'Allow all edits in this chat'
        case 'delete': return 'Allow deletions in this chat'
        case 'web': {
            const host = urlHost(request.args.url)
            return host ? `Always allow ${host}` : null
        }
        default: return 'Always allow'
    }
}

function Approval({ request, onDecide }: { request: ApprovalRequest; onDecide: (decision: ApprovalDecision) => void }) {
    const allowRef = useRef<HTMLButtonElement>(null)
    const [rejecting, setRejecting] = useState(false)
    const [feedback, setFeedback] = useState('')
    const remember = rememberLabel(request)

    useEffect(() => {
        allowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        allowRef.current?.focus({ preventScroll: true })
    }, [request.callId])

    const hint = request.dangerous
        ? 'This command can delete data or change your system. Check it carefully.'
        : request.tool.kind === 'execute' ? 'Runs on your computer with your permissions.'
            : request.tool.kind === 'delete' ? 'Deleted files can be restored with Undo after the run.'
                : request.tool.kind === 'web' ? 'Opens an address on this machine or your local network.'
                    : 'You can undo the agent\'s changes after the run.'

    return (
        <div className={`tool-approve ${request.dangerous ? 'is-danger' : ''}`} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onDecide({ allow: false }) } }}>
            <p className="tool-approve__hint">{request.dangerous && <AlertTriangle size={13} aria-hidden />}{hint}</p>
            {rejecting ? (
                <form className="tool-approve__reject" onSubmit={e => { e.preventDefault(); onDecide({ allow: false, feedback }) }}>
                    <input
                        className="tool-approve__input"
                        autoFocus
                        value={feedback}
                        onChange={e => setFeedback(e.target.value)}
                        placeholder="Optional: tell the agent what to do instead"
                        aria-label="What the agent should do instead"
                    />
                    <Button size="sm" type="submit" variant="secondary">Decline</Button>
                </form>
            ) : (
                <div className="tool-approve__actions">
                    <Button size="sm" variant="ghost" onClick={() => setRejecting(true)}>Decline…</Button>
                    {remember && <Button size="sm" variant="secondary" onClick={() => onDecide({ allow: true, remember: true })}>{remember}</Button>}
                    <Button ref={allowRef} size="sm" variant={request.dangerous ? 'danger' : 'agent'} onClick={() => onDecide({ allow: true })}>
                        {request.tool.kind === 'execute' ? 'Run' : 'Allow'}
                    </Button>
                </div>
            )}
        </div>
    )
}

interface ToolCardProps {
    record: ToolRecord
    /** The tool result text, for calls without structured display data. */
    resultText?: string
    liveOutput?: string
    approval?: { request: ApprovalRequest; decide: (d: ApprovalDecision) => void } | null
}

export const ToolCard = memo(function ToolCard({ record, resultText, liveOutput, approval }: ToolCardProps) {
    const awaiting = record.status === 'awaiting-approval' && !!approval
    const command = record.display?.type === 'command'
    const [open, setOpen] = useState(false)
    const expanded = open || awaiting || (record.status === 'running' && record.name === 'run_command')
    const display = record.display ?? record.preview
    const stat = headerStat(record.display)
    const isError = record.status === 'error'
    const body = display || liveOutput || (resultText && (isError || record.status === 'denied'))
    const [verb, target] = splitTitle(record.name, record.title)

    return (
        <div className={`tool-card is-${record.status} ${command ? 'is-command' : ''}`}>
            <button type="button" className="tool-card__head" onClick={() => setOpen(o => !o)} aria-expanded={expanded} disabled={!body}>
                <span className="tool-card__icon" aria-hidden>{toolIcon(record)}</span>
                <span className="tool-card__title truncate" title={record.title}>
                    {verb}{target && <> <span className="tool-card__target">{target}</span></>}
                </span>
                {stat && <span className={`tool-card__stat ${record.display?.type === 'diff' ? 'is-diff' : ''}`}>{stat}</span>}
                {record.durationMs !== undefined && record.durationMs > 1500 && <span className="tool-card__time">{(record.durationMs / 1000).toFixed(1)} s</span>}
                <span className="tool-card__status"><StatusIcon status={record.status} /></span>
                {body && <ChevronRight size={12} className={`tool-card__chevron ${expanded ? 'is-open' : ''}`} aria-hidden />}
            </button>
            {expanded && body && (
                <div className="tool-card__body">
                    <ToolBody display={display} liveOutput={liveOutput} />
                    {(!display || isError) && resultText && <pre className="tool-output selectable">{resultText.slice(0, 4000)}</pre>}
                </div>
            )}
            {awaiting && approval && <Approval request={approval.request} onDecide={approval.decide} />}
        </div>
    )
})

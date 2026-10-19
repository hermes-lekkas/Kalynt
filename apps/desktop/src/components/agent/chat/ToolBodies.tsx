/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Bodies of tool cards: what a call did, in the most readable form for its
 * kind (diffs, command output, search hits, web results, the plan).
 */
import { CheckCircle2, Circle, CircleDot, ExternalLink } from 'lucide-react'
import type { DiffLine, PlanItem, ToolDisplay } from '../../../services/agent/tools'

const openFile = (path: string, line?: number) =>
    window.dispatchEvent(new CustomEvent('kalynt-open-file', { detail: { path, line } }))

const openExternal = (url: string) => { void window.electronAPI?.shell?.openExternal(url) }

export function DiffView({ lines, maxLines = 400 }: { lines: DiffLine[]; maxLines?: number }) {
    const shown = lines.slice(0, maxLines)
    return (
        <div className="diff-view selectable" role="table" aria-label="Changes">
            {shown.map((line, i) => line.type === 'gap'
                ? <div key={i} className="diff-view__gap">{line.text}</div>
                : (
                    <div key={i} className={`diff-view__line is-${line.type}`} role="row">
                        <span className="diff-view__num" aria-hidden>{line.type === 'add' ? '' : line.oldLine}</span>
                        <span className="diff-view__num" aria-hidden>{line.type === 'remove' ? '' : line.newLine}</span>
                        <span className="diff-view__sign" aria-hidden>{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
                        <span className="diff-view__text">{line.text || ' '}</span>
                    </div>
                ))}
            {lines.length > maxLines && <div className="diff-view__gap">{lines.length - maxLines} more lines</div>}
        </div>
    )
}

export function CommandOutput({ output, running }: { output: string; running?: boolean }) {
    return (
        <pre className={`tool-output selectable ${running ? 'is-live' : ''}`}>{output.trimEnd() || (running ? 'Waiting for output…' : 'No output.')}</pre>
    )
}

export function PlanList({ items }: { items: PlanItem[] }) {
    return (
        <ol className="plan-list">
            {items.map((item, i) => (
                <li key={i} className={`plan-list__item is-${item.status}`}>
                    {item.status === 'done' ? <CheckCircle2 size={13} aria-label="Done" />
                        : item.status === 'in_progress' ? <CircleDot size={13} aria-label="In progress" />
                            : <Circle size={13} aria-label="To do" />}
                    <span>{item.text}</span>
                </li>
            ))}
        </ol>
    )
}

/** The body for a finished call (or its preview while waiting for approval). */
export function ToolBody({ display, liveOutput }: { display?: ToolDisplay; liveOutput?: string }) {
    if (!display) return liveOutput ? <CommandOutput output={liveOutput} running /> : null
    switch (display.type) {
        case 'diff':
            return (
                <>
                    <DiffView lines={display.lines} />
                    {display.problems && <pre className="tool-output tool-output--problems selectable">{display.problems}</pre>}
                </>
            )
        case 'command':
            return (
                <>
                    <pre className="tool-command selectable"><span aria-hidden>$ </span>{display.command}</pre>
                    {display.pending
                        ? <p className="tool-note">Runs in {display.cwd === '.' ? 'the project folder' : display.cwd}.</p>
                        : <CommandOutput output={liveOutput && display.running ? liveOutput : display.output} running={display.running} />}
                </>
            )
        case 'matches':
            return (
                <ul className="tool-list">
                    {display.items.slice(0, 50).map((m, i) => (
                        <li key={i}>
                            <button type="button" className="tool-list__link mono" onClick={() => openFile(m.file, m.line)}>
                                {m.file}{m.line ? `:${m.line}` : ''}
                            </button>
                            {m.text && <span className="tool-list__text mono truncate">{m.text.trim()}</span>}
                        </li>
                    ))}
                    {display.items.length === 0 && <li className="tool-list__empty">No matches.</li>}
                    {display.truncated && <li className="tool-list__empty">More matches not shown.</li>}
                </ul>
            )
        case 'files':
            return (
                <ul className="tool-list">
                    {display.items.slice(0, 80).map(file => (
                        <li key={file}>
                            {file.endsWith('/') ? <span className="mono">{file}</span>
                                : <button type="button" className="tool-list__link mono" onClick={() => openFile(file)}>{file}</button>}
                        </li>
                    ))}
                    {display.items.length === 0 && <li className="tool-list__empty">Nothing found.</li>}
                    {display.truncated && <li className="tool-list__empty">{display.total - display.items.length} more not shown.</li>}
                </ul>
            )
        case 'web-results':
            return (
                <ul className="tool-list tool-list--web">
                    {display.results.map(r => (
                        <li key={r.url}>
                            <button type="button" className="tool-list__link" onClick={() => openExternal(r.url)} title={r.url}>
                                {r.title || r.url} <ExternalLink size={11} aria-hidden />
                            </button>
                            {r.snippet && <span className="tool-list__text">{r.snippet}</span>}
                        </li>
                    ))}
                    {display.results.length === 0 && <li className="tool-list__empty">No results.</li>}
                </ul>
            )
        case 'web-page':
            return (
                <p className="tool-note">
                    Read {display.chars.toLocaleString()} characters{display.truncated ? ' (truncated)' : ''} from{' '}
                    <button type="button" className="tool-list__link" onClick={() => openExternal(display.url)}>{display.title || display.url}</button>
                </p>
            )
        case 'plan':
            return <PlanList items={display.items} />
        case 'file':
            return <p className="tool-note">{display.totalLines === 0 ? 'Empty file.' : `Lines ${display.startLine}–${display.endLine} of ${display.totalLines}.`}</p>
        case 'deleted':
            return <p className="tool-note">Deleted {display.path}.</p>
        case 'moved':
            return <p className="tool-note">Moved {display.from} to {display.to}.</p>
        case 'text':
            return <pre className="tool-output selectable">{display.text}</pre>
    }
}

/** A short summary shown on the card header, if the result has one. */
export function headerStat(display?: ToolDisplay): string | null {
    if (!display) return null
    switch (display.type) {
        case 'diff': return `${display.created ? `new, ${display.added} lines` : `+${display.added} −${display.removed}`}${display.problems ? ' · errors' : ''}`
        case 'command': return display.running ? 'running' : display.timedOut ? 'timed out' : display.exitCode === null ? null : `exit ${display.exitCode}`
        case 'matches': return `${display.total}${display.truncated ? '+' : ''} ${display.total === 1 ? 'match' : 'matches'}`
        case 'files': return `${display.total} ${display.total === 1 ? 'item' : 'items'}`
        case 'web-results': return `${display.results.length} results`
        case 'file': return display.totalLines ? `${display.endLine - display.startLine + 1} lines` : 'empty'
        case 'plan': return `${display.items.filter(i => i.status === 'done').length}/${display.items.length}`
        default: return null
    }
}

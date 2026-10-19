/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Around the conversation: the files the last run changed (with Undo), a
 * Continue button when a run paused at its step limit, and the agent's plan.
 */
import { useState } from 'react'
import { ChevronRight, FileDiff, Play, Undo2 } from 'lucide-react'
import type { AgentSession } from '../../../services/agent/session'
import { relativePath } from '../../../services/agent/tools/paths'
import { Button, confirmAction } from '../../ui'
import { PlanList } from './ToolBodies'

interface RunFooterProps {
    session: AgentSession
    folder: string | null
    running: boolean
    onUndo: (runId: string) => void
    onContinue: () => void
}

export function RunFooter({ session, folder, running, onUndo, onContinue }: RunFooterProps) {
    if (running) return null
    const last = session.checkpoints[session.checkpoints.length - 1]
    const files = last && !last.undone ? Object.keys(last.files) : []

    const undo = async () => {
        const ok = await confirmAction({
            title: 'Undo the changes from the last run?',
            message: `${files.length} file${files.length === 1 ? '' : 's'} will go back to how they were before the run. Edits you made to them since will be lost.`,
            confirmLabel: 'Undo changes',
            danger: true
        })
        if (ok && last) onUndo(last.runId)
    }

    if (!files.length && !session.paused) return null
    return (
        <div className="run-footer">
            {files.length > 0 && (
                <section className="run-changes" aria-label="Changed files">
                    <header className="run-changes__head">
                        <FileDiff size={13} aria-hidden />
                        <span>{files.length} file{files.length === 1 ? '' : 's'} changed</span>
                        <Button size="sm" variant="ghost" icon={<Undo2 size={13} />} onClick={undo}>Undo</Button>
                    </header>
                    <ul className="run-changes__list">
                        {files.map(path => (
                            <li key={path}>
                                <button
                                    type="button"
                                    className="tool-list__link mono truncate"
                                    onClick={() => window.dispatchEvent(new CustomEvent('kalynt-open-file', { detail: { path } }))}
                                >
                                    {relativePath(folder, path)}{last.files[path] === null ? ' (new)' : ''}
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            {session.paused && (
                <div className="run-paused">
                    <span>The agent paused after many steps.</span>
                    <Button size="sm" variant="agent" icon={<Play size={13} />} onClick={onContinue}>Continue</Button>
                </div>
            )}
        </div>
    )
}

export function PlanPanel({ session, running }: { session: AgentSession; running: boolean }) {
    const [open, setOpen] = useState(true)
    const plan = session.plan
    if (!plan.length) return null
    const done = plan.filter(p => p.status === 'done').length
    if (done === plan.length && !running) return null
    const current = plan.find(p => p.status === 'in_progress')
    return (
        <section className="plan-panel" aria-label="Plan">
            <button type="button" className="plan-panel__head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
                <ChevronRight size={12} className={open ? 'is-open' : ''} aria-hidden />
                <span>Plan</span>
                <span className="plan-panel__count">{done}/{plan.length}</span>
                {!open && current && <span className="plan-panel__current truncate">{current.text}</span>}
            </button>
            {open && <PlanList items={plan} />}
        </section>
    )
}

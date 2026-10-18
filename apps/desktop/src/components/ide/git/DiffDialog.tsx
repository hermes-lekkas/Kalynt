/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useState } from 'react'
import { Button, Dialog, Spinner } from '../../ui'
import type { GitApi, GitChange } from './useGit'

const BINARY = /\.(png|jpe?g|gif|ico|pdf|zip|tar|gz|mp3|mp4|woff2?|ttf|exe|dll|so|dylib|bin|pyc|wasm)$/i

interface DiffLine {
    kind: 'add' | 'remove' | 'hunk' | 'meta' | 'note' | 'context'
    text: string
    oldNo?: number
    newNo?: number
}

function parseDiff(diff: string): DiffLine[] {
    const out: DiffLine[] = []
    let oldNo = 0
    let newNo = 0
    const lines = diff.replace(/\n$/, '').split('\n')
    for (const text of lines) {
        if (text.startsWith('\\')) {
            out.push({ kind: 'note', text: text.slice(1).trim() })
        } else if (text.startsWith('@@')) {
            const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text)
            if (m) { oldNo = Number(m[1]); newNo = Number(m[2]) }
            out.push({ kind: 'hunk', text })
        } else if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename)/.test(text)) {
            out.push({ kind: 'meta', text })
        } else if (text.startsWith('+')) {
            out.push({ kind: 'add', text: text.slice(1), newNo: newNo++ })
        } else if (text.startsWith('-')) {
            out.push({ kind: 'remove', text: text.slice(1), oldNo: oldNo++ })
        } else if (text.length > 0 || out.length > 0) {
            out.push({ kind: 'context', text: text.slice(1), oldNo: oldNo++, newNo: newNo++ })
        }
    }
    return out.filter(l => l.kind !== 'meta')
}

interface DiffDialogProps {
    change: GitChange
    git: GitApi
    onClose: () => void
    onOpen: () => void
}

export function DiffDialog({ change, git, onClose, onOpen }: DiffDialogProps) {
    const [state, setState] = useState<{ lines?: DiffLine[]; error?: string; note?: string } | null>(null)

    useEffect(() => {
        let cancelled = false
        if (BINARY.test(change.path)) {
            setState({ note: 'This is a binary file, so there is no text diff to show.' })
            return
        }
        if (change.kind === 'untracked') {
            setState({ note: 'This file is new and not tracked yet. Stage it to include it in the next commit.' })
            return
        }
        git.diff(change.path, change.staged).then(result => {
            if (cancelled) return
            if (result.error) setState({ error: result.error })
            else if (!result.diff?.trim()) setState({ note: 'No line changes. The file mode or line endings may have changed.' })
            else setState({ lines: parseDiff(result.diff) })
        })
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [change])

    return (
        <Dialog
            open
            size="xl"
            bare
            title={<span className="mono">{change.path}</span>}
            description={change.staged ? 'Staged changes compared with the last commit' : 'Working changes compared with the staged version'}
            onClose={onClose}
            footer={
                <>
                    {change.kind !== 'deleted' && <Button variant="ghost" onClick={onOpen}>Open file</Button>}
                    {change.staged
                        ? <Button onClick={() => { git.unstage([change.path]); onClose() }}>Unstage</Button>
                        : <Button variant="primary" onClick={() => { git.stage([change.path]); onClose() }}>Stage file</Button>}
                </>
            }
        >
            <div className="diff-view">
                {!state && <div className="diff-view__note"><Spinner label="Loading diff" /></div>}
                {state?.note && <p className="diff-view__note">{state.note}</p>}
                {state?.error && <p className="diff-view__note diff-view__note--error selectable">{state.error}</p>}
                {state?.lines && (
                    <table className="diff-table selectable">
                        <tbody>
                            {state.lines.map((line, i) => (
                                <tr key={i} className={`diff-line diff-line--${line.kind}`}>
                                    <td className="diff-line__no">{line.oldNo ?? ''}</td>
                                    <td className="diff-line__no">{line.newNo ?? ''}</td>
                                    <td className="diff-line__sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ''}</td>
                                    <td className="diff-line__text">{line.text || ' '}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </Dialog>
    )
}

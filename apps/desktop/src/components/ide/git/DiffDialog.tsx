/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Full-height Monaco DiffEditor modal for working-tree changes, staged changes,
 * untracked file previews, and historical commit file diffs.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { Columns2, Rows2 } from 'lucide-react'
import { Button, Dialog, IconButton, Spinner } from '../../ui'
import { usePermissions } from '../../../hooks/usePermissions'
import { baseName, languageFromFileName } from '../languages'
import type { GitApi, GitChange } from './useGit'

const MonacoDiffView = lazy(() => import('./MonacoDiffView'))

const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|bmp|pdf|zip|tar|gz|rar|7z|mp3|mp4|avi|mov|woff2?|ttf|otf|exe|dll|so|dylib|bin|pyc|wasm|class|jar)$/i
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

interface ParsedHunk {
    oldStart: number
    newStart: number
    lines: Array<{ kind: 'context' | 'add' | 'remove'; text: string }>
}

interface ParsedUnifiedDiff {
    binary: boolean
    hunks: ParsedHunk[]
}

/** Linear-time, backtracking-free unified diff parser. */
function parseUnifiedDiff(diff: string): ParsedUnifiedDiff {
    const hunks: ParsedHunk[] = []
    let current: ParsedHunk | null = null
    let binary = false

    const rawLines = diff.split('\n')
    for (let i = 0; i < rawLines.length; i++) {
        const raw = rawLines[i]
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

        if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
            binary = true
            continue
        }
        if (line.startsWith('diff --git ')) {
            current = null
            continue
        }
        if (line.startsWith('@@ ')) {
            const m = HUNK_HEADER.exec(line)
            if (m) {
                current = {
                    oldStart: Number(m[1]),
                    newStart: Number(m[3]),
                    lines: []
                }
                hunks.push(current)
            }
            continue
        }
        if (!current) continue
        if (line.startsWith('\\')) continue
        if (line.startsWith('+')) {
            current.lines.push({ kind: 'add', text: line.slice(1) })
        } else if (line.startsWith('-')) {
            current.lines.push({ kind: 'remove', text: line.slice(1) })
        } else if (line.startsWith(' ')) {
            current.lines.push({ kind: 'context', text: line.slice(1) })
        }
    }

    return { binary, hunks }
}

/**
 * Reconstructs full original content by reverse-applying unified diff hunks to
 * the current file content on disk. Returns null if the file no longer matches
 * the diff (e.g. staged diff with additional working edits).
 */
function reconstructOriginalFromModified(modifiedContent: string, hunks: ParsedHunk[]): string | null {
    if (hunks.length === 0) return null
    const modLines = modifiedContent.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l))
    const origLines: string[] = []
    let cursor = 1 // 1-indexed line cursor into modLines

    for (const hunk of hunks) {
        const targetStart = Math.max(1, hunk.newStart)
        if (targetStart < cursor) return null
        while (cursor < targetStart && cursor <= modLines.length) {
            origLines.push(modLines[cursor - 1])
            cursor++
        }
        for (const entry of hunk.lines) {
            if (entry.kind === 'remove') {
                origLines.push(entry.text)
            } else if (entry.kind === 'context') {
                if (cursor > modLines.length || modLines[cursor - 1] !== entry.text) return null
                origLines.push(entry.text)
                cursor++
            } else if (entry.kind === 'add') {
                if (cursor > modLines.length || modLines[cursor - 1] !== entry.text) return null
                cursor++
            }
        }
    }

    while (cursor <= modLines.length) {
        origLines.push(modLines[cursor - 1])
        cursor++
    }
    return origLines.join('\n')
}

function buildHunkPair(hunks: ParsedHunk[]): { original: string; modified: string } {
    const orig: string[] = []
    const mod: string[] = []
    hunks.forEach((hunk, idx) => {
        if (idx > 0) {
            orig.push('')
            mod.push('')
        }
        for (const entry of hunk.lines) {
            if (entry.kind === 'context') {
                orig.push(entry.text)
                mod.push(entry.text)
            } else if (entry.kind === 'remove') {
                orig.push(entry.text)
            } else if (entry.kind === 'add') {
                mod.push(entry.text)
            }
        }
    })
    return { original: orig.join('\n'), modified: mod.join('\n') }
}

export interface CommitDiffTarget {
    hash: string
    shortHash?: string
    file: string
    message?: string
    loadDiff: () => Promise<{ diff?: string; error?: string }>
}

interface DiffDialogProps {
    change?: GitChange
    git?: GitApi
    folder?: string | null
    commitDiff?: CommitDiffTarget
    canEdit?: boolean
    onClose: () => void
    onOpen?: () => void
}

type DiffState =
    | { kind: 'ready'; original: string; modified: string }
    | { kind: 'note'; text: string }
    | { kind: 'error'; text: string }

export function DiffDialog({ change, git, folder, commitDiff, canEdit: canEditProp, onClose, onOpen }: DiffDialogProps) {
    const permissions = usePermissions()
    const canEdit = canEditProp ?? permissions.canEdit
    const [sideBySide, setSideBySide] = useState(true)
    const [state, setState] = useState<DiffState | null>(null)

    const targetPath = commitDiff ? commitDiff.file : change?.path ?? ''
    const language = languageFromFileName(baseName(targetPath))

    useEffect(() => {
        let cancelled = false
        setState(null)

        if (!targetPath) {
            setState({ kind: 'note', text: 'No file selected.' })
            return
        }
        if (BINARY_EXT.test(targetPath)) {
            setState({ kind: 'note', text: 'This is a binary file, so there is no text diff to show.' })
            return
        }

        const load = async () => {
            // Untracked file: read directly from disk and preview as added content in Monaco.
            if (change && change.kind === 'untracked') {
                const fullPath = folder ? `${folder.replace(/[\\/]+$/, '')}/${change.path.replace(/^\/+/, '')}` : change.path
                const res = await window.electronAPI?.fs?.readFile?.(fullPath)
                if (cancelled) return
                if (!res?.success || typeof res.content !== 'string') {
                    setState({ kind: 'note', text: 'This file is untracked and could not be previewed.' })
                    return
                }
                setState({ kind: 'ready', original: '', modified: res.content })
                return
            }

            const result = commitDiff
                ? await commitDiff.loadDiff()
                : change && git
                    ? await git.diff(change.path, change.staged)
                    : { error: 'Diff source unavailable.' }

            if (cancelled) return
            if (result.error) {
                setState({ kind: 'error', text: result.error })
                return
            }
            if (!result.diff?.trim()) {
                setState({ kind: 'note', text: 'No line changes. The file mode or line endings may have changed.' })
                return
            }

            const parsed = parseUnifiedDiff(result.diff)
            if (parsed.binary) {
                setState({ kind: 'note', text: 'This is a binary file, so there is no text diff to show.' })
                return
            }
            if (parsed.hunks.length === 0) {
                setState({ kind: 'note', text: 'No line changes. The file mode or metadata changed.' })
                return
            }

            // For working-tree diffs of existing files, try full-file reverse reconstruction so
            // Monaco shows complete context and accurate line numbers.
            if (change && !change.staged && change.kind !== 'deleted' && folder) {
                const fullPath = `${folder.replace(/[\\/]+$/, '')}/${change.path.replace(/^\/+/, '')}`
                const disk = await window.electronAPI?.fs?.readFile?.(fullPath)
                if (cancelled) return
                if (disk?.success && typeof disk.content === 'string') {
                    const original = reconstructOriginalFromModified(disk.content, parsed.hunks)
                    if (original !== null) {
                        setState({ kind: 'ready', original, modified: disk.content })
                        return
                    }
                }
            }

            const pair = buildHunkPair(parsed.hunks)
            setState({ kind: 'ready', original: pair.original, modified: pair.modified })
        }

        void load()
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [change?.path, change?.staged, change?.kind, commitDiff?.hash, commitDiff?.file, folder])

    const description = commitDiff
        ? `Commit ${commitDiff.shortHash || commitDiff.hash.slice(0, 7)}${commitDiff.message ? ` — ${commitDiff.message}` : ''}`
        : change?.kind === 'untracked'
            ? 'Untracked file preview (not yet staged)'
            : change?.staged
                ? 'Staged changes compared with the last commit'
                : 'Working changes compared with the staged version'

    return (
        <Dialog
            open
            size="xl"
            bare
            className="git-diff-dialog"
            title={<span className="mono">{targetPath}</span>}
            description={description}
            onClose={onClose}
            headerActions={
                <div className="git-diff-dialog__modes" role="group" aria-label="Diff layout">
                    <IconButton
                        size="sm"
                        label="Side by side diff"
                        icon={<Columns2 size={14} />}
                        active={sideBySide}
                        onClick={() => setSideBySide(true)}
                    />
                    <IconButton
                        size="sm"
                        label="Inline diff"
                        icon={<Rows2 size={14} />}
                        active={!sideBySide}
                        onClick={() => setSideBySide(false)}
                    />
                </div>
            }
            footer={
                <>
                    {onOpen && change?.kind !== 'deleted' && (
                        <Button variant="ghost" onClick={onOpen}>Open file</Button>
                    )}
                    {change && git && canEdit && (
                        change.staged
                            ? <Button onClick={() => { git.unstage([change.path]); onClose() }}>Unstage</Button>
                            : <Button variant="primary" onClick={() => { git.stage([change.path]); onClose() }}>Stage file</Button>
                    )}
                    <Button variant={change && git && canEdit ? 'ghost' : 'secondary'} onClick={onClose}>Close</Button>
                </>
            }
        >
            <div className="git-diff-view">
                {!state && <div className="git-diff-view__note"><Spinner label="Loading diff" /></div>}
                {state?.kind === 'note' && <p className="git-diff-view__note">{state.text}</p>}
                {state?.kind === 'error' && <p className="git-diff-view__note git-diff-view__note--error selectable">{state.text}</p>}
                {state?.kind === 'ready' && (
                    <Suspense fallback={<div className="git-diff-view__note"><Spinner label="Loading diff editor" /></div>}>
                        <MonacoDiffView
                            original={state.original}
                            modified={state.modified}
                            language={language}
                            sideBySide={sideBySide}
                        />
                    </Suspense>
                )}
            </div>
        </Dialog>
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useCallback, useState } from 'react'
import {
    Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, ChevronRight, CloudDownload,
    CloudUpload, FileText, GitBranch, Minus, MoreHorizontal, Plus, RefreshCw,
    RotateCcw, Trash2, X
} from 'lucide-react'
import { Button, Checkbox, EmptyState, IconButton, Menu, Spinner, Tabs, TextArea, promptText, useMenuAnchor } from '../../ui'
import { formatShortcut } from '../../../stores/commandStore'
import { usePermissions } from '../../../hooks/usePermissions'
import type { CommitFile, GitApi, GitChange, GitCommit } from './useGit'
import { BranchMenu } from './BranchMenu'
import { DiffDialog, type CommitDiffTarget } from './DiffDialog'
import { FileGlyph } from '../explorer/fileIcons'
import { baseName, dirName } from '../languages'
import './git.css'

const KIND_LETTER: Record<GitChange['kind'], string> = {
    modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!'
}
const KIND_LABEL: Record<GitChange['kind'], string> = {
    modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', untracked: 'Untracked', conflicted: 'Conflict'
}

function relativeDate(value: string): string {
    const ms = Date.now() - new Date(value).getTime()
    if (Number.isNaN(ms)) return ''
    const m = Math.round(ms / 60000)
    if (m < 60) return `${Math.max(m, 1)} min ago`
    const h = Math.round(m / 60)
    if (h < 24) return `${h} h ago`
    const d = Math.round(h / 24)
    return d < 30 ? `${d} d ago` : new Date(value).toLocaleDateString()
}

function commitStatusClass(status: string): string {
    const code = status.charAt(0).toUpperCase()
    if (code === 'A') return 'added'
    if (code === 'D') return 'deleted'
    if (code === 'R' || code === 'C') return 'renamed'
    return 'modified'
}

interface GitPanelProps {
    folder: string | null
    git: GitApi
    onOpenFile: (path: string) => void
    canEdit?: boolean
    dirtyPaths?: string[]
}

export function GitPanel({ folder, git, onOpenFile, canEdit: canEditProp, dirtyPaths }: GitPanelProps) {
    const permissions = usePermissions()
    const canEdit = canEditProp ?? permissions.canEdit
    const [tab, setTab] = useState<'changes' | 'log'>('changes')
    const [message, setMessage] = useState('')
    const [amend, setAmend] = useState(false)
    const [diff, setDiff] = useState<GitChange | null>(null)
    const [commitDiffTarget, setCommitDiffTarget] = useState<CommitDiffTarget | null>(null)
    const [expandedCommit, setExpandedCommit] = useState<string | null>(null)
    const [commitFilesMap, setCommitFilesMap] = useState<Record<string, { loading: boolean; files?: CommitFile[]; error?: string }>>({})
    const moreMenu = useMenuAnchor()

    const toggleCommit = useCallback(async (commit: GitCommit) => {
        if (expandedCommit === commit.hash) {
            setExpandedCommit(null)
            return
        }
        setExpandedCommit(commit.hash)
        if (commitFilesMap[commit.hash]?.files) return
        setCommitFilesMap(prev => ({ ...prev, [commit.hash]: { loading: true } }))
        const res = await git.commitFiles(commit.hash)
        setCommitFilesMap(prev => ({
            ...prev,
            [commit.hash]: { loading: false, files: res.files, error: res.error }
        }))
    }, [expandedCommit, commitFilesMap, git])

    if (!folder) return <EmptyState compact title="No folder open" description="Open a folder to use source control." />
    if (git.isRepo === null) return <div className="git-panel__loading"><Spinner label="Reading repository" /></div>
    if (!git.isRepo) {
        return (
            <EmptyState
                compact
                icon={<GitBranch size={28} />}
                title="Not a Git repository"
                description="Start tracking changes in this folder to commit, branch and sync."
                actions={
                    <Button
                        variant="primary"
                        size="sm"
                        disabled={!canEdit}
                        loading={git.busy === 'Initialize'}
                        onClick={git.init}
                    >
                        Initialize repository
                    </Button>
                }
            />
        )
    }

    const staged = git.changes.filter(c => c.staged)
    const unstaged = git.changes.filter(c => !c.staged)
    const canAmend = git.commits.length > 0
    const useAmend = amend && canAmend
    const stageAllMode = staged.length === 0 && unstaged.length > 0 && !useAmend
    const hasMessage = message.trim().length > 0
    const canSubmitCommit = canEdit && !git.busy && (
        useAmend
            ? (hasMessage || staged.length > 0)
            : (hasMessage && (staged.length > 0 || unstaged.length > 0))
    )

    const submitCommit = async () => {
        if (!canSubmitCommit) return
        const trimmed = message.trim()
        let ok = false
        if (stageAllMode) {
            ok = await git.stageAllAndCommit(trimmed, unstaged.map(c => c.path), false)
        } else if (useAmend) {
            ok = await git.amend(trimmed || undefined)
        } else {
            ok = await git.commit(trimmed)
        }
        if (ok) {
            setMessage('')
            setAmend(false)
        }
    }

    const handleStash = async () => {
        if (!canEdit) return
        const stashMsg = await promptText({
            title: 'Stash changes',
            label: 'Message (optional)',
            placeholder: 'e.g. WIP refactor',
            confirmLabel: 'Stash',
            validate: () => null
        })
        if (stashMsg === null) return
        void git.stash(stashMsg.trim() || undefined)
    }

    const row = (change: GitChange) => (
        <li key={`${change.staged}-${change.path}`} className="git-row">
            <button type="button" className="git-row__main" onClick={() => setDiff(change)} title={`${KIND_LABEL[change.kind]}: ${change.path}`}>
                <span className="git-row__name">{baseName(change.path)}</span>
                <span className="git-row__dir truncate">{dirName(change.path)}</span>
            </button>
            <span className="git-row__actions">
                {change.kind !== 'deleted' && (
                    <IconButton size="sm" label="Open file" icon={<FileText size={13} />} onClick={() => onOpenFile(`${folder}/${change.path}`)} />
                )}
                {canEdit && (
                    change.staged ? (
                        <IconButton size="sm" label="Unstage" icon={<Minus size={14} />} onClick={() => git.unstage([change.path])} />
                    ) : (
                        <>
                            {change.kind === 'untracked' ? (
                                <IconButton
                                    size="sm"
                                    tone="danger"
                                    label="Delete untracked file"
                                    icon={<Trash2 size={13} />}
                                    onClick={() => git.discard([change.path], { untracked: true, dirtyPaths })}
                                />
                            ) : (
                                <IconButton
                                    size="sm"
                                    tone="danger"
                                    label="Discard changes"
                                    icon={<RotateCcw size={13} />}
                                    onClick={() => git.discard([change.path], { dirtyPaths })}
                                />
                            )}
                            <IconButton size="sm" label="Stage" icon={<Plus size={14} />} onClick={() => git.stage([change.path])} />
                        </>
                    )
                )}
            </span>
            <span className={`git-row__kind git-row__kind--${change.kind}`} aria-label={KIND_LABEL[change.kind]}>{KIND_LETTER[change.kind]}</span>
        </li>
    )

    const commitButtonLabel = useAmend
        ? (staged.length ? `Amend (${staged.length} staged)` : 'Amend last commit')
        : stageAllMode
            ? `Stage all & commit (${unstaged.length})`
            : staged.length
                ? `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}`
                : 'Commit'

    return (
        <div className="git-panel">
            <div className="side-head">
                <h2 className="side-head__title">Source control</h2>
                <div className="side-head__actions">
                    {git.tracking ? (
                        <>
                            <button
                                type="button"
                                className={`git-sync-btn ${git.behind > 0 ? 'has-count' : ''}`}
                                aria-label={`Pull${git.behind ? ` ${git.behind} commit${git.behind === 1 ? '' : 's'}` : ''}`}
                                title={`Pull${git.behind ? ` (${git.behind} behind)` : ''}`}
                                onClick={git.pull}
                                disabled={!canEdit || !!git.busy}
                            >
                                <ArrowDown size={13} aria-hidden />
                                {git.behind > 0 && <span className="git-sync-btn__count">{git.behind}</span>}
                            </button>
                            <button
                                type="button"
                                className={`git-sync-btn ${git.ahead > 0 ? 'has-count' : ''}`}
                                aria-label={`Push${git.ahead ? ` ${git.ahead} commit${git.ahead === 1 ? '' : 's'}` : ''}`}
                                title={`Push${git.ahead ? ` (${git.ahead} ahead)` : ''}`}
                                onClick={git.push}
                                disabled={!canEdit || !!git.busy}
                            >
                                <ArrowUp size={13} aria-hidden />
                                {git.ahead > 0 && <span className="git-sync-btn__count">{git.ahead}</span>}
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            className="git-sync-btn git-sync-btn--publish"
                            aria-label="Publish branch"
                            title="Publish branch and set upstream (-u)"
                            onClick={() => git.publish()}
                            disabled={!canEdit || !!git.busy}
                        >
                            <CloudUpload size={13} aria-hidden />
                            <span>Publish</span>
                        </button>
                    )}
                    <IconButton size="sm" label="Fetch" icon={<CloudDownload size={14} />} onClick={git.fetch} disabled={!!git.busy} />
                    <IconButton size="sm" label="Refresh" icon={<RefreshCw size={14} className={git.loading ? 'spin' : ''} />} onClick={() => git.refresh()} />
                    <IconButton size="sm" label="More Git actions" icon={<MoreHorizontal size={14} />} onClick={moreMenu.toggle} />
                </div>
                <Menu
                    open={moreMenu.open}
                    anchor={moreMenu.anchor}
                    onClose={moreMenu.close}
                    placement="bottom-end"
                    items={[
                        { label: 'Fetch from remote', icon: <CloudDownload size={14} />, disabled: !!git.busy, onSelect: () => { void git.fetch() } },
                        ...(!git.tracking ? [{ label: 'Publish branch (-u)', icon: <CloudUpload size={14} />, disabled: !canEdit || !!git.busy, onSelect: () => { void git.publish() } }] : []),
                        'separator',
                        { label: 'Stash changes…', icon: <Archive size={14} />, disabled: !canEdit || !!git.busy || git.changes.length === 0, onSelect: () => { void handleStash() } },
                        {
                            label: git.stashes.length ? `Pop latest stash (${git.stashes.length})` : 'Pop latest stash',
                            icon: <ArchiveRestore size={14} />,
                            disabled: !canEdit || !!git.busy || git.stashes.length === 0,
                            onSelect: () => { void git.stashPop() }
                        }
                    ]}
                />
            </div>

            <div className="git-panel__branch">
                <BranchMenu git={git} canEdit={canEdit} />
                {git.busy ? (
                    <Spinner label={`${git.busy}…`} />
                ) : git.stashes.length > 0 ? (
                    <button
                        type="button"
                        className="git-stash-pill"
                        title={`${git.stashes.length} stash${git.stashes.length === 1 ? '' : 'es'} — click to pop latest`}
                        disabled={!canEdit}
                        onClick={() => git.stashPop()}
                    >
                        <Archive size={12} aria-hidden />
                        <span>{git.stashes.length}</span>
                    </button>
                ) : null}
            </div>

            {git.error && (
                <div className="git-panel__error" role="alert">
                    <p className="selectable">{git.error}</p>
                    <IconButton size="sm" label="Dismiss" icon={<X size={13} />} onClick={git.clearError} />
                </div>
            )}

            <div className="git-panel__tabs">
                <Tabs
                    size="sm"
                    ariaLabel="Source control views"
                    value={tab}
                    onChange={setTab}
                    items={[
                        { id: 'changes', label: 'Changes', badge: git.changes.length || undefined },
                        { id: 'log', label: 'History' }
                    ]}
                />
            </div>

            {tab === 'changes' ? (
                <div className="git-panel__body">
                    <div className="git-commit">
                        <TextArea
                            rows={2}
                            value={message}
                            disabled={!canEdit}
                            placeholder={
                                !canEdit
                                    ? 'Read-only workspace'
                                    : useAmend
                                        ? 'New commit message (leave empty to keep existing)'
                                        : staged.length
                                            ? 'Describe what changed'
                                            : unstaged.length
                                                ? 'Message (will stage all & commit)'
                                                : 'No changes to commit'
                            }
                            aria-label="Commit message"
                            onChange={e => setMessage(e.target.value)}
                            onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void submitCommit() } }}
                        />
                        <div className="git-commit__controls">
                            <Button
                                variant="primary"
                                size="sm"
                                block
                                icon={<Check size={14} />}
                                disabled={!canSubmitCommit}
                                loading={git.busy === 'Commit' || git.busy === 'Amend'}
                                onClick={submitCommit}
                                title={`${commitButtonLabel} (${formatShortcut('Ctrl+Enter')})`}
                            >
                                {commitButtonLabel}
                            </Button>
                            {canAmend && (
                                <div className="git-commit__options">
                                    <Checkbox
                                        checked={useAmend}
                                        disabled={!canEdit}
                                        onChange={setAmend}
                                        label="Amend last commit"
                                    />
                                    {git.changes.length > 0 && canEdit && (
                                        <button
                                            type="button"
                                            className="git-commit__stash-link"
                                            disabled={!!git.busy}
                                            onClick={() => git.stash()}
                                            title="Stash working changes"
                                        >
                                            <Archive size={12} aria-hidden /> Stash
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {git.changes.length === 0 ? (
                        <p className="git-panel__clean">No changes since the last commit.</p>
                    ) : (
                        <>
                            {staged.length > 0 && (
                                <section className="git-group" aria-label="Staged changes">
                                    <header className="git-group__head">
                                        <span>Staged</span>
                                        <span className="git-group__count">{staged.length}</span>
                                        {canEdit && (
                                            <IconButton size="sm" label="Unstage all" icon={<Minus size={14} />} onClick={() => git.unstage(staged.map(c => c.path))} />
                                        )}
                                    </header>
                                    <ul className="git-group__list">{staged.map(row)}</ul>
                                </section>
                            )}
                            {unstaged.length > 0 && (
                                <section className="git-group" aria-label="Changes">
                                    <header className="git-group__head">
                                        <span>Changes</span>
                                        <span className="git-group__count">{unstaged.length}</span>
                                        {canEdit && (
                                            <IconButton size="sm" label="Stage all" icon={<Plus size={14} />} onClick={() => git.stage(unstaged.map(c => c.path))} />
                                        )}
                                    </header>
                                    <ul className="git-group__list">{unstaged.map(row)}</ul>
                                </section>
                            )}
                        </>
                    )}
                </div>
            ) : (
                <ol className="git-log">
                    {git.commits.map(c => {
                        const isOpen = expandedCommit === c.hash
                        const entry = commitFilesMap[c.hash]
                        return (
                            <li key={c.hash} className={`git-log__item ${isOpen ? 'is-open' : ''}`}>
                                <button
                                    type="button"
                                    className="git-log__btn"
                                    aria-expanded={isOpen}
                                    title={c.hash}
                                    onClick={() => void toggleCommit(c)}
                                >
                                    <span className="git-log__top">
                                        <ChevronRight size={13} className={`git-log__chev ${isOpen ? 'is-open' : ''}`} aria-hidden />
                                        <span className="git-log__message">{c.message}</span>
                                    </span>
                                    <span className="git-log__meta">
                                        <span className="mono">{c.shortHash}</span>
                                        <span className="truncate">{c.author}</span>
                                        <span>{relativeDate(c.date)}</span>
                                    </span>
                                </button>
                                {isOpen && (
                                    <div className="git-log__files">
                                        {entry?.loading ? (
                                            <div className="git-log__files-note"><Spinner label="Loading files" /></div>
                                        ) : entry?.error ? (
                                            <p className="git-log__files-note">{entry.error}</p>
                                        ) : entry?.files && entry.files.length > 0 ? (
                                            <ul className="git-log__file-list">
                                                {entry.files.map(f => (
                                                    <li key={`${c.hash}-${f.path}`}>
                                                        <button
                                                            type="button"
                                                            className="git-log__file-row"
                                                            title={f.path}
                                                            onClick={() => setCommitDiffTarget({
                                                                hash: c.hash,
                                                                shortHash: c.shortHash,
                                                                file: f.path,
                                                                message: c.message,
                                                                loadDiff: () => git.commitDiff(c.hash, f.path)
                                                            })}
                                                        >
                                                            <FileGlyph name={baseName(f.path)} size={13} className="git-log__file-icon" />
                                                            <span className="git-log__file-name truncate">{baseName(f.path)}</span>
                                                            <span className="git-log__file-dir truncate">{dirName(f.path)}</span>
                                                            <span className={`git-row__kind git-row__kind--${commitStatusClass(f.status)}`}>{f.status.charAt(0)}</span>
                                                        </button>
                                                    </li>
                                                ))}
                                            </ul>
                                        ) : (
                                            <p className="git-log__files-note">No changed files recorded.</p>
                                        )}
                                    </div>
                                )}
                            </li>
                        )
                    })}
                    {git.commits.length === 0 && <li className="git-panel__clean">No commits yet.</li>}
                </ol>
            )}

            {diff && (
                <DiffDialog
                    change={diff}
                    git={git}
                    folder={folder}
                    canEdit={canEdit}
                    onClose={() => setDiff(null)}
                    onOpen={() => { onOpenFile(`${folder}/${diff.path}`); setDiff(null) }}
                />
            )}
            {commitDiffTarget && (
                <DiffDialog
                    commitDiff={commitDiffTarget}
                    folder={folder}
                    canEdit={canEdit}
                    onClose={() => setCommitDiffTarget(null)}
                />
            )}
        </div>
    )
}

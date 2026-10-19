/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState } from 'react'
import { ArrowDown, ArrowUp, Check, FileText, GitBranch, Minus, Plus, RefreshCw, RotateCcw, X } from 'lucide-react'
import { Button, EmptyState, IconButton, Spinner, Tabs, TextArea } from '../../ui'
import { formatShortcut } from '../../../stores/commandStore'
import type { GitApi, GitChange } from './useGit'
import { BranchMenu } from './BranchMenu'
import { DiffDialog } from './DiffDialog'
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

interface GitPanelProps {
    folder: string | null
    git: GitApi
    onOpenFile: (path: string) => void
}

export function GitPanel({ folder, git, onOpenFile }: GitPanelProps) {
    const [tab, setTab] = useState<'changes' | 'log'>('changes')
    const [message, setMessage] = useState('')
    const [diff, setDiff] = useState<GitChange | null>(null)

    if (!folder) return <EmptyState compact title="No folder open" description="Open a folder to use source control." />
    if (git.isRepo === null) return <div className="git-panel__loading"><Spinner label="Reading repository" /></div>
    if (!git.isRepo) {
        return (
            <EmptyState
                compact
                icon={<GitBranch size={28} />}
                title="Not a Git repository"
                description="Start tracking changes in this folder to commit, branch and sync."
                actions={<Button variant="primary" size="sm" loading={git.busy === 'Initialize'} onClick={git.init}>Initialize repository</Button>}
            />
        )
    }

    const staged = git.changes.filter(c => c.staged)
    const unstaged = git.changes.filter(c => !c.staged)
    const commit = async () => {
        if (!message.trim() || staged.length === 0) return
        if (await git.commit(message.trim())) setMessage('')
    }

    const row = (change: GitChange) => (
        <li key={`${change.staged}-${change.path}`} className="git-row">
            <button type="button" className="git-row__main" onClick={() => setDiff(change)} title={`${KIND_LABEL[change.kind]}: ${change.path}`}>
                <span className="git-row__name">{baseName(change.path)}</span>
                <span className="git-row__dir truncate">{dirName(change.path)}</span>
            </button>
            <span className="git-row__actions">
                {change.kind !== 'deleted' && <IconButton size="sm" label="Open file" icon={<FileText size={13} />} onClick={() => onOpenFile(`${folder}/${change.path}`)} />}
                {change.staged ? (
                    <IconButton size="sm" label="Unstage" icon={<Minus size={14} />} onClick={() => git.unstage([change.path])} />
                ) : (
                    <>
                        {change.kind !== 'untracked' && <IconButton size="sm" tone="danger" label="Discard changes" icon={<RotateCcw size={13} />} onClick={() => git.discard([change.path])} />}
                        <IconButton size="sm" label="Stage" icon={<Plus size={14} />} onClick={() => git.stage([change.path])} />
                    </>
                )}
            </span>
            <span className={`git-row__kind git-row__kind--${change.kind}`} aria-label={KIND_LABEL[change.kind]}>{KIND_LETTER[change.kind]}</span>
        </li>
    )

    return (
        <div className="git-panel">
            <div className="side-head">
                <h2 className="side-head__title">Source control</h2>
                <div className="side-head__actions">
                    <IconButton size="sm" label={`Pull${git.behind ? ` ${git.behind} commit${git.behind === 1 ? '' : 's'}` : ''}`} icon={<ArrowDown size={14} />} badge={git.behind || undefined} onClick={git.pull} disabled={!!git.busy || !git.tracking} />
                    <IconButton size="sm" label={`Push${git.ahead ? ` ${git.ahead} commit${git.ahead === 1 ? '' : 's'}` : ''}`} icon={<ArrowUp size={14} />} badge={git.ahead || undefined} onClick={git.push} disabled={!!git.busy} />
                    <IconButton size="sm" label="Refresh" icon={<RefreshCw size={14} className={git.loading ? 'spin' : ''} />} onClick={git.refresh} />
                </div>
            </div>

            <div className="git-panel__branch">
                <BranchMenu git={git} />
                {git.busy && <Spinner label={`${git.busy}…`} />}
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
                            placeholder={staged.length ? 'Describe what changed' : 'Stage changes to commit them'}
                            aria-label="Commit message"
                            onChange={e => setMessage(e.target.value)}
                            onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); commit() } }}
                        />
                        <Button
                            variant="primary"
                            size="sm"
                            block
                            icon={<Check size={14} />}
                            disabled={!message.trim() || staged.length === 0}
                            loading={git.busy === 'Commit'}
                            onClick={commit}
                            title={`Commit (${formatShortcut('Ctrl+Enter')})`}
                        >
                            {staged.length ? `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}` : 'Commit'}
                        </Button>
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
                                        <IconButton size="sm" label="Unstage all" icon={<Minus size={14} />} onClick={() => git.unstage(staged.map(c => c.path))} />
                                    </header>
                                    <ul className="git-group__list">{staged.map(row)}</ul>
                                </section>
                            )}
                            {unstaged.length > 0 && (
                                <section className="git-group" aria-label="Changes">
                                    <header className="git-group__head">
                                        <span>Changes</span>
                                        <span className="git-group__count">{unstaged.length}</span>
                                        <IconButton size="sm" label="Stage all" icon={<Plus size={14} />} onClick={() => git.stage(unstaged.map(c => c.path))} />
                                    </header>
                                    <ul className="git-group__list">{unstaged.map(row)}</ul>
                                </section>
                            )}
                        </>
                    )}
                </div>
            ) : (
                <ol className="git-log">
                    {git.commits.map(c => (
                        <li key={c.hash} className="git-log__item" title={c.hash}>
                            <span className="git-log__message">{c.message}</span>
                            <span className="git-log__meta">
                                <span className="mono">{c.shortHash}</span>
                                <span>{c.author}</span>
                                <span>{relativeDate(c.date)}</span>
                            </span>
                        </li>
                    ))}
                    {git.commits.length === 0 && <li className="git-panel__clean">No commits yet.</li>}
                </ol>
            )}

            {diff && <DiffDialog change={diff} git={git} onClose={() => setDiff(null)} onOpen={() => { onOpenFile(`${folder}/${diff.path}`); setDiff(null) }} />}
        </div>
    )
}

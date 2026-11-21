/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The workspace's history as recorded by Git, with expandable commit file lists
 * and Monaco diff inspection. Commits are made from Source control in the code view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Archive, Copy, FileDiff, GitBranch, GitCommitHorizontal, RefreshCw } from 'lucide-react'
import type { Space } from '../../stores/appStore'
import { useWorkspaceFolderStore, folderName } from '../../stores/workspaceFolderStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { Avatar, Button, EmptyState, IconButton, SearchInput, Select, Spinner } from '../ui'
import { DiffDialog, type CommitDiffTarget } from '../ide/git/DiffDialog'
import type { CommitFile } from '../ide/git/useGit'
import { FileGlyph } from '../ide/explorer/fileIcons'
import { baseName, dirName } from '../ide/languages'
import '../workspace/workspace.css'
import './history.css'

interface Commit {
    hash: string
    date: string
    message: string
    body?: string
    author: string
    email?: string
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function statusTone(status: string): string {
    const code = status.charAt(0).toUpperCase()
    if (code === 'A') return 'added'
    if (code === 'D') return 'deleted'
    if (code === 'R' || code === 'C') return 'renamed'
    return 'modified'
}

export default function HistoryView({ space }: { space: Space }) {
    const folder = useWorkspaceFolderStore(s => s.records[space.id]?.folder ?? null)
    const showSidePanel = useLayoutStore(s => s.showSidePanel)
    const setMainView = useLayoutStore(s => s.setMainView)
    const addNotification = useNotificationStore(s => s.addNotification)
    const [commits, setCommits] = useState<Commit[] | null>(null)
    const [branch, setBranch] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [author, setAuthor] = useState('')
    const [open, setOpen] = useState<string | null>(null)
    const [backingUp, setBackingUp] = useState(false)
    const [filesByHash, setFilesByHash] = useState<Record<string, { loading: boolean; files?: CommitFile[]; error?: string }>>({})
    const [diffTarget, setDiffTarget] = useState<CommitDiffTarget | null>(null)
    const generation = useRef(0)

    const load = useCallback(async () => {
        if (!folder) return
        const gen = ++generation.current
        setError(null)
        const git = window.electronAPI?.git
        const [log, status] = await Promise.all([git?.log({ repoPath: folder, maxCount: 300 }), git?.status(folder)])
        if (gen !== generation.current) return
        if (!log?.success) {
            setCommits([])
            setError(log?.error?.includes('Not a git repository') ? 'not-a-repo' : log?.error || 'The history could not be read.')
            return
        }
        if (status?.success) setBranch(status.status.current || '')
        setCommits((log.log?.all ?? []).map((c: { hash: string; date: string; message: string; body?: string; author_name: string; author_email?: string }) => ({
            hash: c.hash, date: c.date, message: c.message, body: c.body, author: c.author_name, email: c.author_email
        })))
    }, [folder])

    useEffect(() => {
        generation.current++
        setCommits(null)
        setOpen(null)
        setFilesByHash({})
        if (folder) void load()
        return () => { generation.current++ }
    }, [folder, load])

    const toggleCommit = useCallback(async (hash: string) => {
        if (open === hash) {
            setOpen(null)
            return
        }
        setOpen(hash)
        if (!folder || filesByHash[hash]?.files) return
        setFilesByHash(prev => ({ ...prev, [hash]: { loading: true } }))
        const res = await window.electronAPI?.git?.commitFiles?.({ repoPath: folder, hash })
        setFilesByHash(prev => ({
            ...prev,
            [hash]: res?.success
                ? { loading: false, files: (res.files ?? []) as CommitFile[] }
                : { loading: false, error: res?.error || 'Could not load changed files.' }
        }))
    }, [open, folder, filesByHash])

    const openCommitFileDiff = useCallback((commit: Commit, file: CommitFile) => {
        if (!folder) return
        setDiffTarget({
            hash: commit.hash,
            shortHash: commit.hash.slice(0, 7),
            file: file.path,
            message: commit.message,
            loadDiff: async () => {
                const res = await window.electronAPI?.git?.commitDiff?.({ repoPath: folder, hash: commit.hash, file: file.path })
                return res?.success ? { diff: res.diff as string } : { error: res?.error || 'The commit diff could not be loaded.' }
            }
        })
    }, [folder])

    const authors = useMemo(() => Array.from(new Set((commits ?? []).map(c => c.author))).sort(), [commits])
    const groups = useMemo(() => {
        const q = query.trim().toLowerCase()
        const list = (commits ?? []).filter(c =>
            (!author || c.author === author) &&
            (!q || c.message.toLowerCase().includes(q) || c.hash.startsWith(q) || c.author.toLowerCase().includes(q)))
        const map = new Map<string, Commit[]>()
        for (const c of list) {
            const label = day(c.date)
            let bucket = map.get(label)
            if (!bucket) {
                bucket = []
                map.set(label, bucket)
            }
            bucket.push(c)
        }
        return Array.from(map.entries())
    }, [commits, query, author])

    const backup = async () => {
        setBackingUp(true)
        try {
            const result = await window.electronAPI?.fs?.backupWorkspace?.()
            if (result?.success) addNotification('Backup saved', 'success')
            else if (result && !result.canceled) addNotification(`The backup didn't finish: ${result.error ?? 'unknown error'}`, 'error')
        } finally {
            setBackingUp(false)
        }
    }

    const goToGit = () => { setMainView('code'); showSidePanel('git') }

    return (
        <div className="page">
            <header className="page__header">
                <div className="page__titles">
                    <h1 className="page__title">History</h1>
                    <p className="page__subtitle">
                        {folder ? <>Commits in <span title={folder}>{folderName(folder)}</span>{branch && <> on <GitBranch size={12} className="history__inline-icon" aria-hidden /> <span className="mono">{branch}</span></>}. Commit from Source control in the code view.</> : 'Open a folder in the code view to see its history.'}
                    </p>
                </div>
                <div className="page__actions">
                    <Button icon={<Archive size={14} />} loading={backingUp} onClick={backup} disabled={!folder}>Back up folder</Button>
                    <IconButton label="Refresh" icon={<RefreshCw size={15} />} onClick={load} disabled={!folder} />
                </div>
            </header>

            {folder && commits && commits.length > 0 && (
                <div className="page__toolbar">
                    <SearchInput size="sm" value={query} onChange={setQuery} placeholder="Search messages, authors or hashes" aria-label="Search history" />
                    {authors.length > 1 && (
                        <Select size="sm" value={author} onChange={e => setAuthor(e.target.value)} aria-label="Filter by author">
                            <option value="">Everyone</option>
                            {authors.map(a => <option key={a} value={a}>{a}</option>)}
                        </Select>
                    )}
                </div>
            )}

            <div className="page__body">
                {!folder ? (
                    <EmptyState title="No folder yet" description="History comes from the folder's Git repository." actions={<Button onClick={() => setMainView('code')}>Go to code</Button>} />
                ) : commits === null ? (
                    <div className="history__loading"><Spinner label="Reading history" /></div>
                ) : error === 'not-a-repo' ? (
                    <EmptyState icon={<GitCommitHorizontal size={28} />} title="This folder isn’t tracked by Git" description="Initialize a repository from Source control to start recording history." actions={<Button onClick={goToGit}>Open source control</Button>} />
                ) : error ? (
                    <EmptyState title="The history couldn’t be read" description={error} actions={<Button onClick={load}>Try again</Button>} />
                ) : commits.length === 0 ? (
                    <EmptyState title="No commits yet" description="Commit your first change from Source control." actions={<Button onClick={goToGit}>Open source control</Button>} />
                ) : groups.length === 0 ? (
                    <EmptyState compact title="No commits match" />
                ) : groups.map(([date, list]) => (
                    <section key={date} className="history__day" aria-label={date}>
                        <h2 className="history__date">{date}</h2>
                        <ol className="history__list">
                            {list.map(c => {
                                const isOpen = open === c.hash
                                const entry = filesByHash[c.hash]
                                return (
                                    <li key={c.hash} className={`commit ${isOpen ? 'is-open' : ''}`}>
                                        <button type="button" className="commit__main" onClick={() => void toggleCommit(c.hash)} aria-expanded={isOpen}>
                                            <Avatar name={c.author} size={22} />
                                            <span className="commit__message">{c.message}</span>
                                            <span className="commit__author">{c.author}</span>
                                            <span className="commit__time">{time(c.date)}</span>
                                            <span className="commit__hash mono">{c.hash.slice(0, 7)}</span>
                                        </button>
                                        {isOpen && (
                                            <div className="commit__detail selectable">
                                                {c.body && <p className="commit__body">{c.body}</p>}
                                                <div className="commit__meta-bar">
                                                    <div>
                                                        <p className="commit__full mono">{c.hash}</p>
                                                        <p className="commit__when">{new Date(c.date).toLocaleString()}{c.email ? `, ${c.email}` : ''}</p>
                                                    </div>
                                                    <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => { navigator.clipboard.writeText(c.hash); addNotification('Commit hash copied', 'info') }}>Copy hash</Button>
                                                </div>

                                                <div className="commit__files">
                                                    {entry?.loading ? (
                                                        <Spinner label="Loading changed files" />
                                                    ) : entry?.error ? (
                                                        <p className="commit__files-note">{entry.error}</p>
                                                    ) : entry?.files && entry.files.length > 0 ? (
                                                        <>
                                                            <p className="commit__files-heading">Changed files ({entry.files.length})</p>
                                                            <ul className="commit__file-list">
                                                                {entry.files.map(f => (
                                                                    <li key={`${c.hash}-${f.path}`}>
                                                                        <button
                                                                            type="button"
                                                                            className="commit__file-row"
                                                                            onClick={() => openCommitFileDiff(c, f)}
                                                                            title={`View diff for ${f.path}`}
                                                                        >
                                                                            <FileGlyph name={baseName(f.path)} size={14} className="commit__file-icon" />
                                                                            <span className="commit__file-name">{baseName(f.path)}</span>
                                                                            <span className="commit__file-dir truncate">{dirName(f.path)}</span>
                                                                            <span className="commit__file-action"><FileDiff size={13} aria-hidden /> Diff</span>
                                                                            <span className={`commit__file-status commit__file-status--${statusTone(f.status)}`}>{f.status.charAt(0)}</span>
                                                                        </button>
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        </>
                                                    ) : (
                                                        <p className="commit__files-note">No changed files recorded.</p>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </li>
                                )
                            })}
                        </ol>
                    </section>
                ))}
            </div>

            {diffTarget && (
                <DiffDialog
                    commitDiff={diffTarget}
                    folder={folder}
                    onClose={() => setDiffTarget(null)}
                />
            )}
        </div>
    )
}

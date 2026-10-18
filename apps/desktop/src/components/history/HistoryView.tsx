/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The workspace's history as recorded by Git, with a way to back the
 * folder up. Commits are made from Source control in the code view.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, Copy, GitBranch, GitCommitHorizontal, RefreshCw } from 'lucide-react'
import type { Space } from '../../stores/appStore'
import { useWorkspaceFolderStore, folderName } from '../../stores/workspaceFolderStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { Avatar, Button, EmptyState, IconButton, SearchInput, Select, Spinner } from '../ui'
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

    const load = useCallback(async () => {
        if (!folder) return
        setError(null)
        const git = window.electronAPI?.git
        const [log, status] = await Promise.all([git?.log({ repoPath: folder, maxCount: 300 }), git?.status(folder)])
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

    useEffect(() => { load() }, [load])

    const authors = useMemo(() => Array.from(new Set((commits ?? []).map(c => c.author))).sort(), [commits])
    const groups = useMemo(() => {
        const q = query.trim().toLowerCase()
        const list = (commits ?? []).filter(c =>
            (!author || c.author === author) &&
            (!q || c.message.toLowerCase().includes(q) || c.hash.startsWith(q) || c.author.toLowerCase().includes(q)))
        const map = new Map<string, Commit[]>()
        list.forEach(c => map.set(day(c.date), [...(map.get(day(c.date)) ?? []), c]))
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
                            {list.map(c => (
                                <li key={c.hash} className={`commit ${open === c.hash ? 'is-open' : ''}`}>
                                    <button type="button" className="commit__main" onClick={() => setOpen(open === c.hash ? null : c.hash)} aria-expanded={open === c.hash}>
                                        <Avatar name={c.author} size={22} />
                                        <span className="commit__message">{c.message}</span>
                                        <span className="commit__author">{c.author}</span>
                                        <span className="commit__time">{time(c.date)}</span>
                                        <span className="commit__hash mono">{c.hash.slice(0, 7)}</span>
                                    </button>
                                    {open === c.hash && (
                                        <div className="commit__detail selectable">
                                            {c.body && <p className="commit__body">{c.body}</p>}
                                            <p className="commit__full mono">{c.hash}</p>
                                            <p className="commit__when">{new Date(c.date).toLocaleString()}{c.email ? `, ${c.email}` : ''}</p>
                                            <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => { navigator.clipboard.writeText(c.hash); addNotification('Commit hash copied', 'info') }}>Copy hash</Button>
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ol>
                    </section>
                ))}
            </div>
        </div>
    )
}

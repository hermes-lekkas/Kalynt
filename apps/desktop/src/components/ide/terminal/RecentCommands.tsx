/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Commands run in the active terminal (from shell integration), with
 * bookmarks for the ones you reuse. Choosing one runs it again.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { History, Star } from 'lucide-react'
import { IconButton, Popover, SearchInput } from '../../ui'

interface HistoryEntry {
    command: string
    timestamp: number
    exitCode?: number
}

const BOOKMARKS_KEY = 'kalynt-terminal-bookmarks'

function loadBookmarks(): string[] {
    try { return JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '[]') } catch { return [] }
}

export function RecentCommands({ terminalId, onRun }: { terminalId: string | null; onRun: (command: string) => void }) {
    const triggerRef = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [history, setHistory] = useState<HistoryEntry[]>([])
    const [bookmarks, setBookmarks] = useState<string[]>(loadBookmarks)

    useEffect(() => {
        if (!open || !terminalId) return
        window.electronAPI?.terminal?.getCommandHistory(terminalId).then(result => {
            if (result?.success && Array.isArray(result.history)) {
                setHistory(result.history.map((h: HistoryEntry) => ({ command: h.command, timestamp: h.timestamp, exitCode: h.exitCode })).reverse())
            }
        }).catch(() => undefined)
    }, [open, terminalId])

    const toggleBookmark = (command: string) => {
        setBookmarks(prev => {
            const next = prev.includes(command) ? prev.filter(c => c !== command) : [command, ...prev]
            try { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
            return next
        })
    }

    const items = useMemo(() => {
        const q = query.trim().toLowerCase()
        const seen = new Set<string>()
        const recent = history.filter(h => h.command && !seen.has(h.command) && (seen.add(h.command), true)).map(h => h.command)
        const filter = (list: string[]) => (q ? list.filter(c => c.toLowerCase().includes(q)) : list)
        return { saved: filter(bookmarks), recent: filter(recent.filter(c => !bookmarks.includes(c))).slice(0, 30) }
    }, [history, bookmarks, query])

    const run = (command: string) => { setOpen(false); setQuery(''); onRun(command) }

    const row = (command: string) => (
        <li key={command} className="recent-cmd">
            <button type="button" className="recent-cmd__run mono truncate" onClick={() => run(command)} title={`Run ${command}`}>{command}</button>
            <IconButton
                size="sm"
                label={bookmarks.includes(command) ? 'Remove bookmark' : 'Bookmark'}
                active={bookmarks.includes(command)}
                icon={<Star size={13} fill={bookmarks.includes(command) ? 'currentColor' : 'none'} />}
                onClick={() => toggleBookmark(command)}
            />
        </li>
    )

    return (
        <>
            <IconButton ref={triggerRef} size="sm" label="Recent commands" icon={<History size={14} />} onClick={() => setOpen(o => !o)} disabled={!terminalId} aria-expanded={open} />
            <Popover open={open} onClose={() => setOpen(false)} anchor={triggerRef.current} placement="top-end" width={360} ariaLabel="Recent commands">
                <div className="recent-cmds">
                    <SearchInput size="sm" value={query} onChange={setQuery} placeholder="Find a command" autoFocus />
                    {items.saved.length > 0 && (<><p className="recent-cmds__heading">Bookmarked</p><ul>{items.saved.map(row)}</ul></>)}
                    <p className="recent-cmds__heading">Recent in this terminal</p>
                    {items.recent.length > 0 ? <ul>{items.recent.map(row)}</ul> : <p className="recent-cmds__empty">Commands you run here will show up for reuse.</p>}
                </div>
            </Popover>
        </>
    )
}

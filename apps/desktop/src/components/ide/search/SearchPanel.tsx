/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CaseSensitive, ChevronRight, Filter, Regex, Replace, ReplaceAll, Square, WholeWord, X } from 'lucide-react'
import { Button, EmptyState, IconButton, ProgressBar, TextInput, VirtualList } from '../../ui'
import { FileGlyph } from '../explorer/fileIcons'
import { dirName, relativePath } from '../languages'
import { useWorkspaceSearch } from './useWorkspaceSearch'
import type { SearchMatch } from './searchUtils'
import { FOCUS_SEARCH_EVENT } from '../hooks/useIdeCommands'
import './search.css'

type Row = { kind: 'file'; path: string; name: string; count: number; open: boolean } | { kind: 'match'; match: SearchMatch }

interface SearchPanelProps {
    folder: string | null
    visible: boolean
    onOpenMatch: (path: string, line: number) => void
}

export function SearchPanel({ folder, visible, onOpenMatch }: SearchPanelProps) {
    const s = useWorkspaceSearch(folder)
    const [showReplace, setShowReplace] = useState(false)
    const [showFilters, setShowFilters] = useState(false)
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
    const [historyOpen, setHistoryOpen] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        const focus = () => requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
        if (visible) focus()
        window.addEventListener(FOCUS_SEARCH_EVENT, focus)
        return () => window.removeEventListener(FOCUS_SEARCH_EVENT, focus)
    }, [visible])

    // Re-run when options change and there is something to refresh.
    const optionsKey = `${s.options.regex}${s.options.caseSensitive}${s.options.wholeWord}`
    useEffect(() => {
        if (s.query.trim() && s.progress) s.search()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [optionsKey])

    const rows = useMemo<Row[]>(() => {
        const byFile = new Map<string, SearchMatch[]>()
        s.results.forEach(m => byFile.set(m.filePath, [...(byFile.get(m.filePath) ?? []), m]))
        const out: Row[] = []
        byFile.forEach((matches, path) => {
            const open = !collapsed.has(path)
            out.push({ kind: 'file', path, name: matches[0].fileName, count: matches.length, open })
            if (open) matches.forEach(match => out.push({ kind: 'match', match }))
        })
        return out
    }, [s.results, collapsed])

    const toggleFile = (path: string) => setCollapsed(prev => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
    })

    if (!folder) {
        return <EmptyState compact title="No folder open" description="Open a folder to search its files." />
    }

    const option = (key: keyof typeof s.options, label: string, icon: ReactNode) => (
        <IconButton size="sm" label={label} icon={icon} active={s.options[key]} onClick={() => s.setOptions({ ...s.options, [key]: !s.options[key] })} />
    )

    const summary = s.progress && (
        s.progress.matches === 0 && s.progress.done
            ? `No results in ${s.progress.filesSearched} files`
            : `${s.progress.matches}${s.progress.truncated ? '+' : ''} result${s.progress.matches === 1 ? '' : 's'} in ${s.progress.files} file${s.progress.files === 1 ? '' : 's'}`
    )

    return (
        <div className="search-panel">
            <div className="side-head">
                <h2 className="side-head__title">Search</h2>
                <div className="side-head__actions">
                    <IconButton size="sm" label="Replace" icon={<Replace size={14} />} active={showReplace} onClick={() => setShowReplace(v => !v)} />
                    <IconButton size="sm" label="Files to include or exclude" icon={<Filter size={14} />} active={showFilters} onClick={() => setShowFilters(v => !v)} />
                    <IconButton size="sm" label="Clear results" icon={<X size={14} />} onClick={() => { s.setQuery(''); s.clear() }} disabled={!s.query && !s.results.length} />
                </div>
            </div>

            <form className="search-panel__form" onSubmit={e => { e.preventDefault(); setHistoryOpen(false); s.search() }}>
                <TextInput
                    ref={inputRef}
                    size="sm"
                    value={s.query}
                    invalid={!!s.error}
                    placeholder="Search"
                    aria-label="Search text"
                    onChange={e => s.setQuery(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                            e.preventDefault()
                            setHistoryOpen(false)
                            s.search()
                        }
                    }}
                    onFocus={() => setHistoryOpen(true)}
                    onBlur={() => setTimeout(() => setHistoryOpen(false), 120)}
                    trailing={<>
                        {option('caseSensitive', 'Match case', <CaseSensitive size={14} />)}
                        {option('wholeWord', 'Match whole word', <WholeWord size={14} />)}
                        {option('regex', 'Use regular expression', <Regex size={14} />)}
                    </>}
                />
                {s.error && <p className="search-panel__error" role="alert">{s.error}</p>}
                {historyOpen && !s.query && s.history.length > 0 && (
                    <ul className="search-panel__history" aria-label="Recent searches">
                        {s.history.slice(0, 8).map(h => (
                            <li key={h}><button type="button" className="mono truncate" onMouseDown={e => e.preventDefault()} onClick={() => { s.setQuery(h); setHistoryOpen(false); s.search(h) }}>{h}</button></li>
                        ))}
                    </ul>
                )}
                {showReplace && (
                    <div className="search-panel__replace">
                        <TextInput size="sm" value={s.replacement} placeholder="Replace with" aria-label="Replacement text" onChange={e => s.setReplacement(e.target.value)} />
                        <IconButton size="sm" label="Keep the case of each match" icon={<span className="search-panel__ab">AB</span>} active={s.keepCase} onClick={() => s.setKeepCase(!s.keepCase)} disabled={s.options.regex} />
                        <IconButton size="sm" label="Replace all" icon={<ReplaceAll size={14} />} onClick={s.replaceAll} disabled={!s.results.length || s.replacing} />
                    </div>
                )}
                {showFilters && (
                    <div className="search-panel__filters">
                        <TextInput size="sm" value={s.include} placeholder="Files to include, e.g. ts, tsx" aria-label="Files to include" onChange={e => s.setInclude(e.target.value)} />
                        <TextInput size="sm" value={s.exclude} placeholder="Folders to exclude" aria-label="Folders to exclude" onChange={e => s.setExclude(e.target.value)} />
                    </div>
                )}
            </form>

            {(s.searching || summary) && (
                <div className="search-panel__status" role="status">
                    <span>{s.searching && !summary ? 'Searching…' : summary}</span>
                    {s.searching && <Button size="sm" variant="ghost" icon={<Square size={11} />} onClick={s.stop}>Stop</Button>}
                </div>
            )}
            {s.searching && <ProgressBar label="Searching files" />}
            {s.progress?.truncated && <p className="search-panel__note">Showing the first 2,000 results. Narrow the search to see the rest.</p>}

            {rows.length > 0 ? (
                <VirtualList
                    className="search-results"
                    items={rows}
                    rowHeight={24}
                    renderRow={(row) => row.kind === 'file' ? (
                        <div key={`f-${row.path}`} className="search-file" title={row.path}>
                            <button type="button" className="search-file__toggle" aria-expanded={row.open} onClick={() => toggleFile(row.path)}>
                                <ChevronRight size={13} className={row.open ? 'is-open' : ''} aria-hidden />
                                <FileGlyph name={row.name} size={14} className="search-file__icon" />
                                <span className="search-file__name">{row.name}</span>
                                <span className="search-file__dir truncate">{relativePath(dirName(row.path), folder)}</span>
                            </button>
                            {showReplace && (
                                <IconButton size="sm" className="search-file__replace" label={`Replace in ${row.name}`} icon={<ReplaceAll size={13} />} onClick={() => s.replaceInFile(row.path)} />
                            )}
                            <span className="search-file__count">{row.count}</span>
                        </div>
                    ) : (
                        <div key={`m-${row.match.filePath}-${row.match.line}-${row.match.column}`} className="search-match">
                            <button type="button" className="search-match__open" onClick={() => onOpenMatch(row.match.filePath, row.match.line)} title={`Line ${row.match.line}`}>
                                <span className="search-match__line">{row.match.line}</span>
                                <span className="search-match__text mono">
                                    {row.match.before}
                                    <mark className={showReplace && s.replacement ? 'is-replacing' : ''}>{row.match.matchText}</mark>
                                    {showReplace && s.replacement && <ins>{s.replacement}</ins>}
                                    {row.match.after}
                                </span>
                            </button>
                            {showReplace && (
                                <IconButton size="sm" className="search-match__replace" label="Replace this match" icon={<Replace size={13} />} onClick={() => s.replaceOne(row.match)} />
                            )}
                        </div>
                    )}
                />
            ) : !s.searching && !s.progress ? (
                <p className="search-panel__hint">Press Enter to search every file in {relativePath(folder, null).split('/').pop()}.</p>
            ) : null}
        </div>
    )
}

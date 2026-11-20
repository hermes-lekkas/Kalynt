/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
    CaseSensitive, ChevronRight, ChevronsDownUp, ChevronsUpDown,
    Filter, Regex, Replace, ReplaceAll, Square, WholeWord, X
} from 'lucide-react'
import { Button, EmptyState, IconButton, ProgressBar, TextInput, VirtualList, hasOpenLayer } from '../../ui'
import { useLayoutStore } from '../../../stores/layoutStore'
import { usePermissions } from '../../../hooks/usePermissions'
import { FileGlyph } from '../explorer/fileIcons'
import { dirName, relativePath } from '../languages'
import { useWorkspaceSearch } from './useWorkspaceSearch'
import { buildPattern, formatReplacementPreview, type SearchMatch } from './searchUtils'
import { FOCUS_SEARCH_EVENT } from '../hooks/useIdeCommands'
import type { OpenFilesApi } from '../hooks/useOpenFiles'
import './search.css'

export const FOCUS_REPLACE_EVENT = 'kalynt-focus-replace'
export const FIND_IN_FOLDER_EVENT = 'kalynt-find-in-folder'

type Row = { kind: 'file'; path: string; name: string; count: number; open: boolean } | { kind: 'match'; match: SearchMatch }

interface SearchPanelProps {
    folder: string | null
    buffers: OpenFilesApi
    visible: boolean
    onOpenMatch: (path: string, line: number, column?: number) => void
    canEdit?: boolean
}

export function SearchPanel({ folder, buffers, visible, onOpenMatch, canEdit: canEditProp }: SearchPanelProps) {
    const permissions = usePermissions()
    const canEdit = canEditProp ?? permissions.canEdit
    const s = useWorkspaceSearch(folder, buffers)
    const [showReplace, setShowReplace] = useState(false)
    const [showFilters, setShowFilters] = useState(false)
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
    const [historyOpen, setHistoryOpen] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const replaceInputRef = useRef<HTMLInputElement>(null)
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const searchRef = useRef(s.search)
    searchRef.current = s.search
    const clearRef = useRef(s.clear)
    clearRef.current = s.clear
    const queryRef = useRef(s.query)
    queryRef.current = s.query

    // Focus search / replace inputs on visibility, FOCUS_SEARCH_EVENT, FOCUS_REPLACE_EVENT,
    // FIND_IN_FOLDER_EVENT, and Ctrl+Shift+H / Cmd+Shift+H.
    useEffect(() => {
        const focusSearch = () => requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
        const focusReplace = () => {
            setShowReplace(true)
            requestAnimationFrame(() => {
                if (queryRef.current.trim()) {
                    replaceInputRef.current?.focus()
                    replaceInputRef.current?.select()
                } else {
                    inputRef.current?.focus()
                    inputRef.current?.select()
                }
            })
        }
        const onFindInFolder = (e: Event) => {
            const detail = (e as CustomEvent<{ include?: string }>).detail
            if (detail?.include !== undefined) {
                setShowFilters(true)
                s.setInclude(detail.include)
            }
            useLayoutStore.getState().showSidePanel('search')
            focusSearch()
        }
        const onKeyDown = (e: KeyboardEvent) => {
            if (hasOpenLayer() || e.defaultPrevented || e.altKey) return
            const mod = e.ctrlKey || e.metaKey
            if (mod && e.shiftKey && e.key.toLowerCase() === 'h') {
                e.preventDefault()
                useLayoutStore.getState().showSidePanel('search')
                focusReplace()
            }
        }
        if (visible) focusSearch()
        window.addEventListener(FOCUS_SEARCH_EVENT, focusSearch)
        window.addEventListener(FOCUS_REPLACE_EVENT, focusReplace)
        window.addEventListener(FIND_IN_FOLDER_EVENT, onFindInFolder)
        window.addEventListener('keydown', onKeyDown)
        return () => {
            window.removeEventListener(FOCUS_SEARCH_EVENT, focusSearch)
            window.removeEventListener(FOCUS_REPLACE_EVENT, focusReplace)
            window.removeEventListener(FIND_IN_FOLDER_EVENT, onFindInFolder)
            window.removeEventListener('keydown', onKeyDown)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible])

    // Debounced search-as-you-type across query, options, include, and exclude.
    const optionsKey = `${s.options.regex}|${s.options.caseSensitive}|${s.options.wholeWord}`
    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current)
        if (!folder) return
        if (!s.query) {
            clearRef.current()
            return
        }
        debounceRef.current = setTimeout(() => {
            debounceRef.current = null
            void searchRef.current(undefined, { recordHistory: false })
        }, 220)
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current)
        }
    }, [folder, s.query, s.include, s.exclude, optionsKey])

    const runImmediate = (overrideQuery?: string) => {
        if (debounceRef.current) {
            clearTimeout(debounceRef.current)
            debounceRef.current = null
        }
        setHistoryOpen(false)
        void s.search(overrideQuery, { recordHistory: true })
    }

    const { rows, filePaths } = useMemo<{ rows: Row[]; filePaths: string[] }>(() => {
        const byFile = new Map<string, SearchMatch[]>()
        for (const m of s.results) {
            let list = byFile.get(m.filePath)
            if (!list) {
                list = []
                byFile.set(m.filePath, list)
            }
            list.push(m)
        }
        const out: Row[] = []
        const paths: string[] = []
        byFile.forEach((matches, path) => {
            paths.push(path)
            const open = !collapsed.has(path)
            out.push({ kind: 'file', path, name: matches[0].fileName, count: matches.length, open })
            if (open) {
                for (const match of matches) out.push({ kind: 'match', match })
            }
        })
        return { rows: out, filePaths: paths }
    }, [s.results, collapsed])

    const activePattern = useMemo(() => {
        if (!s.query || !s.options.regex) return null
        const p = buildPattern(s.query, s.options)
        return typeof p === 'string' ? null : p
    }, [s.query, s.options])

    const allCollapsed = filePaths.length > 0 && filePaths.every(p => collapsed.has(p))

    const toggleCollapseAll = () => {
        if (allCollapsed) setCollapsed(new Set())
        else setCollapsed(new Set(filePaths))
    }

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
        <IconButton
            size="sm"
            label={label}
            icon={icon}
            active={s.options[key]}
            onClick={() => s.setOptions({ ...s.options, [key]: !s.options[key] })}
        />
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
                    {filePaths.length > 0 && (
                        <IconButton
                            size="sm"
                            label={allCollapsed ? 'Expand all' : 'Collapse all'}
                            icon={allCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
                            onClick={toggleCollapseAll}
                        />
                    )}
                    <IconButton size="sm" label="Toggle replace" shortcut="Ctrl+Shift+H" icon={<Replace size={14} />} active={showReplace} onClick={() => setShowReplace(v => !v)} />
                    <IconButton size="sm" label="Files to include or exclude" icon={<Filter size={14} />} active={showFilters} onClick={() => setShowFilters(v => !v)} />
                    <IconButton size="sm" label="Clear results" icon={<X size={14} />} onClick={() => { s.setQuery(''); s.clear(); setCollapsed(new Set()) }} disabled={!s.query && !s.results.length} />
                </div>
            </div>

            <form className="search-panel__form" onSubmit={e => { e.preventDefault(); runImmediate() }}>
                <div className="search-panel__query-wrap">
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
                                runImmediate()
                            } else if (e.key === 'Escape' && historyOpen) {
                                e.stopPropagation()
                                setHistoryOpen(false)
                            }
                        }}
                        onFocus={() => setHistoryOpen(true)}
                        onBlur={() => setTimeout(() => setHistoryOpen(false), 120)}
                    />
                    {historyOpen && !s.query && s.history.length > 0 && (
                        <ul className="search-panel__history" aria-label="Recent searches">
                            {s.history.slice(0, 8).map(h => (
                                <li key={h}>
                                    <button
                                        type="button"
                                        className="mono truncate"
                                        onMouseDown={e => e.preventDefault()}
                                        onClick={() => { s.setQuery(h); runImmediate(h) }}
                                    >
                                        {h}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="search-panel__options" role="toolbar" aria-label="Search options">
                    {option('caseSensitive', 'Match case', <CaseSensitive size={14} />)}
                    {option('wholeWord', 'Match whole word', <WholeWord size={14} />)}
                    {option('regex', 'Use regular expression', <Regex size={14} />)}
                    {showReplace && (
                        <IconButton
                            size="sm"
                            label="Preserve case"
                            icon={<span className="search-panel__ab">AB</span>}
                            active={s.keepCase}
                            onClick={() => s.setKeepCase(!s.keepCase)}
                            disabled={s.options.regex}
                        />
                    )}
                </div>

                {s.error && <p className="search-panel__error" role="alert">{s.error}</p>}

                {showReplace && (
                    <div className="search-panel__replace">
                        <TextInput
                            ref={replaceInputRef}
                            size="sm"
                            value={s.replacement}
                            placeholder={canEdit ? 'Replace with' : 'Read-only workspace'}
                            aria-label="Replacement text"
                            disabled={!canEdit}
                            onChange={e => s.setReplacement(e.target.value)}
                            onKeyDown={e => {
                                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canEdit && s.results.length > 0 && !s.replacing) {
                                    e.preventDefault()
                                    void s.replaceAll()
                                }
                            }}
                        />
                        <IconButton
                            size="sm"
                            label={canEdit ? 'Replace all' : 'Replace disabled (read-only)'}
                            icon={<ReplaceAll size={14} />}
                            onClick={s.replaceAll}
                            disabled={!canEdit || !s.results.length || s.replacing || s.isStale}
                        />
                    </div>
                )}

                {showFilters && (
                    <div className="search-panel__filters">
                        <TextInput size="sm" value={s.include} placeholder="Files to include (e.g. src/**/*.{ts,tsx})" aria-label="Files to include" onChange={e => s.setInclude(e.target.value)} />
                        <TextInput size="sm" value={s.exclude} placeholder="Files to exclude" aria-label="Folders or files to exclude" onChange={e => s.setExclude(e.target.value)} />
                    </div>
                )}
            </form>

            {(s.searching || summary) && (
                <div className="search-panel__status" role="status">
                    <span className="search-panel__summary">{s.searching && !summary ? 'Searching…' : summary}</span>
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
                            <span className="search-file__actions">
                                {showReplace && (
                                    <IconButton
                                        size="sm"
                                        className="search-file__replace"
                                        label={canEdit ? `Replace in ${row.name}` : 'Replace disabled (read-only)'}
                                        icon={<ReplaceAll size={13} />}
                                        disabled={!canEdit || s.replacing || s.isStale}
                                        onClick={() => s.replaceInFile(row.path)}
                                    />
                                )}
                                <IconButton
                                    size="sm"
                                    className="search-file__dismiss"
                                    label={`Dismiss ${row.name}`}
                                    icon={<X size={12} />}
                                    onClick={() => s.dismissFile(row.path)}
                                />
                            </span>
                            <span className="search-file__count">{row.count}</span>
                        </div>
                    ) : (() => {
                        const preview = showReplace
                            ? formatReplacementPreview(row.match.matchText, s.replacement, s.keepCase, s.options.regex, activePattern)
                            : ''
                        return (
                            <div key={`m-${row.match.filePath}-${row.match.line}-${row.match.column}`} className="search-match">
                                <button
                                    type="button"
                                    className="search-match__open"
                                    onClick={() => onOpenMatch(row.match.filePath, row.match.line, row.match.column)}
                                    title={`Line ${row.match.line}, Col ${row.match.column}`}
                                >
                                    <span className="search-match__line">{row.match.line}</span>
                                    <span className="search-match__text mono">
                                        {row.match.before}
                                        <mark className={showReplace ? 'is-replacing' : ''}>{row.match.matchText}</mark>
                                        {showReplace && preview.length > 0 && <ins>{preview}</ins>}
                                        {row.match.after}
                                    </span>
                                </button>
                                <span className="search-match__actions">
                                    {showReplace && (
                                        <IconButton
                                            size="sm"
                                            className="search-match__replace"
                                            label={canEdit ? 'Replace this match' : 'Replace disabled (read-only)'}
                                            icon={<Replace size={13} />}
                                            disabled={!canEdit || s.replacing || s.isStale}
                                            onClick={() => s.replaceOne(row.match)}
                                        />
                                    )}
                                    <IconButton
                                        size="sm"
                                        className="search-match__dismiss"
                                        label="Dismiss match"
                                        icon={<X size={12} />}
                                        onClick={() => s.dismissMatch(row.match)}
                                    />
                                </span>
                            </div>
                        )
                    })()}
                />
            ) : !s.searching && !s.progress ? (
                <p className="search-panel__hint">Type to search across {relativePath(folder, null).split('/').pop()}.</p>
            ) : null}
        </div>
    )
}

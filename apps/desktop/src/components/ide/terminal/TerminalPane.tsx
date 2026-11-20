/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Terminal as TerminalIcon, X } from 'lucide-react'
import type { SearchAddon } from '@xterm/addon-search'
import { Button, EmptyState, IconButton, Menu, useMenuAnchor, type Anchor, type MenuEntry } from '../../ui'
import type { TerminalsApi } from './useTerminals'

interface TerminalPaneProps {
    terminals: TerminalsApi
    searchOpen: boolean
    onCloseSearch: () => void
}

const SEARCH_DECORATIONS = {
    matchOverviewRuler: '#e9b44c',
    activeMatchColorOverviewRuler: '#a48dff',
    matchBackground: '#e9b44c55',
    activeMatchBackground: '#8b6cff88'
}

export function TerminalPane({ terminals, searchOpen, onCloseSearch }: TerminalPaneProps) {
    const [menu, setMenu] = useState<Anchor>(null)
    const profileMenu = useMenuAnchor()

    const activeTab = terminals.tabs.find(t => t.id === terminals.activeId) ?? null

    const profileItems: MenuEntry[] = [
        { heading: 'New terminal profile' },
        ...terminals.profiles.map(p => ({
            label: p.label,
            icon: <TerminalIcon size={13} />,
            onSelect: () => terminals.add(p.shell)
        }))
    ]

    if (terminals.tabs.length === 0) {
        return (
            <EmptyState
                compact
                title="No terminal is running"
                actions={
                    <div className="terminal-empty-actions">
                        <Button size="sm" onClick={() => terminals.add()}>New terminal</Button>
                        <IconButton
                            size="sm"
                            label="Choose shell profile"
                            icon={<ChevronDown size={13} />}
                            onClick={profileMenu.toggle}
                            aria-expanded={profileMenu.open}
                        />
                        <Menu
                            open={profileMenu.open}
                            anchor={profileMenu.anchor}
                            onClose={profileMenu.close}
                            items={profileItems}
                            ariaLabel="Shell profiles"
                        />
                    </div>
                }
            />
        )
    }

    const contextItems: MenuEntry[] = [
        { label: 'Copy', shortcut: 'Ctrl+Shift+C', onSelect: terminals.copySelection },
        { label: 'Paste', shortcut: 'Ctrl+Shift+V', onSelect: () => { void terminals.paste() } },
        { label: 'Select all', onSelect: terminals.selectAll },
        'separator',
        ...profileItems,
        'separator',
        { label: 'Clear', onSelect: terminals.clear },
        { label: 'Kill terminal', danger: true, onSelect: () => { if (terminals.activeId) terminals.close(terminals.activeId) } }
    ]

    return (
        <div className="terminal-pane" onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}>
            <div className="terminal-pane__host" ref={el => { terminals.hostRef.current = el }} />
            {searchOpen && <TerminalSearch search={terminals.search} onClose={() => { onCloseSearch(); terminals.focus() }} />}
            {activeTab && (
                <button
                    type="button"
                    className="terminal-pane__profile"
                    onClick={profileMenu.toggle}
                    aria-expanded={profileMenu.open}
                    aria-label="New terminal with shell profile"
                    title={`Active shell: ${activeTab.shell} — click to launch a profile`}
                >
                    <TerminalIcon size={11} aria-hidden />
                    <span>{activeTab.title}</span>
                    <ChevronDown size={11} aria-hidden />
                </button>
            )}
            <Menu
                open={profileMenu.open}
                anchor={profileMenu.anchor}
                onClose={profileMenu.close}
                placement="top-end"
                items={profileItems}
                ariaLabel="Shell profiles"
            />
            <Menu
                open={menu !== null}
                anchor={menu}
                onClose={() => setMenu(null)}
                items={contextItems}
                ariaLabel="Terminal actions"
            />
        </div>
    )
}

function TerminalSearch({ search, onClose }: { search: SearchAddon | null; onClose: () => void }) {
    const [query, setQuery] = useState('')
    const [caseSensitive, setCaseSensitive] = useState(false)
    const [regex, setRegex] = useState(false)
    const [found, setFound] = useState<boolean | null>(null)
    const [counts, setCounts] = useState<{ index: number; total: number } | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => { inputRef.current?.focus() }, [])

    useEffect(() => {
        if (!search) return
        const sub = search.onDidChangeResults(({ resultIndex, resultCount }) => {
            setCounts({ index: resultIndex, total: resultCount })
        })
        return () => {
            sub.dispose()
            search.clearDecorations()
        }
    }, [search])

    const run = useCallback((
        direction: 'next' | 'previous',
        value: string,
        opts: { caseSensitive: boolean; regex: boolean }
    ) => {
        if (!search || !value) {
            search?.clearDecorations()
            setFound(null)
            setCounts(null)
            return
        }
        const searchOptions = {
            caseSensitive: opts.caseSensitive,
            regex: opts.regex,
            decorations: SEARCH_DECORATIONS
        }
        try {
            const ok = direction === 'next'
                ? search.findNext(value, searchOptions)
                : search.findPrevious(value, searchOptions)
            setFound(ok)
        } catch {
            // Invalid regex while typing
            setFound(false)
            setCounts({ index: -1, total: 0 })
        }
    }, [search])

    const toggleCase = () => {
        const next = !caseSensitive
        setCaseSensitive(next)
        if (query) run('next', query, { caseSensitive: next, regex })
    }

    const toggleRegex = () => {
        const next = !regex
        setRegex(next)
        if (query) run('next', query, { caseSensitive, regex: next })
    }

    const matchLabel = query && counts
        ? counts.total > 0
            ? `${counts.index >= 0 ? counts.index + 1 : 1} / ${counts.total}`
            : 'No results'
        : null

    return (
        <div className="terminal-search" role="search">
            <input
                ref={inputRef}
                className={found === false ? 'is-missing' : ''}
                value={query}
                placeholder="Find in terminal"
                aria-label="Find in terminal"
                onChange={e => {
                    const next = e.target.value
                    setQuery(next)
                    run('next', next, { caseSensitive, regex })
                }}
                onKeyDown={e => {
                    if (e.key === 'Enter') {
                        e.preventDefault()
                        run(e.shiftKey ? 'previous' : 'next', query, { caseSensitive, regex })
                    }
                    if (e.key === 'Escape') {
                        e.preventDefault()
                        e.stopPropagation()
                        search?.clearDecorations()
                        onClose()
                    }
                }}
            />
            {matchLabel && (
                <span className={`terminal-search__count ${found === false ? 'is-missing' : ''}`}>
                    {matchLabel}
                </span>
            )}
            <button
                type="button"
                className={`terminal-search__opt ${caseSensitive ? 'is-active' : ''}`}
                onClick={toggleCase}
                aria-pressed={caseSensitive}
                title="Match case"
            >
                Aa
            </button>
            <button
                type="button"
                className={`terminal-search__opt ${regex ? 'is-active' : ''}`}
                onClick={toggleRegex}
                aria-pressed={regex}
                title="Use regular expression"
            >
                .*
            </button>
            <IconButton size="sm" label="Previous match" icon={<ArrowUp size={13} />} onClick={() => run('previous', query, { caseSensitive, regex })} />
            <IconButton size="sm" label="Next match" icon={<ArrowDown size={13} />} onClick={() => run('next', query, { caseSensitive, regex })} />
            <IconButton size="sm" label="Close search" icon={<X size={13} />} onClick={() => { search?.clearDecorations(); onClose() }} />
        </div>
    )
}

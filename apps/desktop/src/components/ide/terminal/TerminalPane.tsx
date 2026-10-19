/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import type { SearchAddon } from '@xterm/addon-search'
import { Button, EmptyState, IconButton, Menu, type Anchor } from '../../ui'
import type { TerminalsApi } from './useTerminals'

interface TerminalPaneProps {
    terminals: TerminalsApi
    searchOpen: boolean
    onCloseSearch: () => void
}

export function TerminalPane({ terminals, searchOpen, onCloseSearch }: TerminalPaneProps) {
    const [menu, setMenu] = useState<Anchor>(null)

    if (terminals.tabs.length === 0) {
        return (
            <EmptyState
                compact
                title="No terminal is running"
                actions={<Button size="sm" onClick={() => terminals.add()}>New terminal</Button>}
            />
        )
    }

    return (
        <div className="terminal-pane" onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}>
            <div className="terminal-pane__host" ref={el => { terminals.hostRef.current = el }} />
            {searchOpen && <TerminalSearch search={terminals.search} onClose={() => { onCloseSearch(); terminals.focus() }} />}
            <Menu
                open={menu !== null}
                anchor={menu}
                onClose={() => setMenu(null)}
                items={[
                    { label: 'Copy', shortcut: 'Ctrl+Shift+C', onSelect: terminals.copySelection },
                    { label: 'Paste', shortcut: 'Ctrl+Shift+V', onSelect: () => { terminals.paste() } },
                    { label: 'Select all', onSelect: terminals.selectAll },
                    'separator',
                    { label: 'Clear', onSelect: terminals.clear },
                    { label: 'Kill terminal', danger: true, onSelect: () => { if (terminals.activeId) terminals.close(terminals.activeId) } }
                ]}
            />
        </div>
    )
}

function TerminalSearch({ search, onClose }: { search: SearchAddon | null; onClose: () => void }) {
    const [query, setQuery] = useState('')
    const [found, setFound] = useState<boolean | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => { inputRef.current?.focus() }, [])

    const run = (direction: 'next' | 'previous', value = query) => {
        if (!search || !value) { setFound(null); return }
        const options = { decorations: { matchOverviewRuler: '#e9b44c', activeMatchColorOverviewRuler: '#a48dff', matchBackground: '#e9b44c55', activeMatchBackground: '#8b6cff88' } }
        setFound(direction === 'next' ? search.findNext(value, options) : search.findPrevious(value, options))
    }

    return (
        <div className="terminal-search" role="search">
            <input
                ref={inputRef}
                className={found === false ? 'is-missing' : ''}
                value={query}
                placeholder="Find in terminal"
                aria-label="Find in terminal"
                onChange={e => { setQuery(e.target.value); run('next', e.target.value) }}
                onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); run(e.shiftKey ? 'previous' : 'next') }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); search?.clearDecorations(); onClose() }
                }}
            />
            <IconButton size="sm" label="Previous match" icon={<ArrowUp size={13} />} onClick={() => run('previous')} />
            <IconButton size="sm" label="Next match" icon={<ArrowDown size={13} />} onClick={() => run('next')} />
            <IconButton size="sm" label="Close search" icon={<X size={13} />} onClick={() => { search?.clearDecorations(); onClose() }} />
        </div>
    )
}

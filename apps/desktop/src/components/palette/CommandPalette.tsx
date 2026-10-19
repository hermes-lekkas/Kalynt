/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * One box for everything: type to find a file, ">" for commands, "#" for
 * workspaces. Opens with Ctrl+P (files) or Ctrl+Shift+P (commands).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Fuse from 'fuse.js'
import { FolderGit2 } from 'lucide-react'
import { useUiStore, type PaletteMode } from '../../stores/uiStore'
import { useAppStore } from '../../stores/appStore'
import { allCommands, formatShortcut, useCommandStore } from '../../stores/commandStore'
import { useWorkspaceFolderStore, folderName } from '../../stores/workspaceFolderStore'
import { Kbd, useLayer } from '../ui'
import { FileGlyph } from '../ide/explorer/fileIcons'
import { dirName, relativePath } from '../ide/languages'
import { openWorkspace } from '../home/workspaceActions'
import { globalCommands } from './globalCommands'
import { CommandIcon } from './commandIcon'
import './palette.css'

interface Item {
    id: string
    kind: 'file' | 'command' | 'workspace'
    title: string
    detail?: string
    shortcut?: string
    icon?: string | ReactNode
    run: () => void
}

const MAX_ITEMS = 60

/** The prefix decides the mode; without one, files inside a workspace and workspaces on the home screen. */
function modeOf(query: string, inWorkspace: boolean): { mode: PaletteMode; text: string } {
    if (query.startsWith('>')) return { mode: 'commands', text: query.slice(1).trim() }
    if (query.startsWith('#')) return { mode: 'workspaces', text: query.slice(1).trim() }
    return { mode: inWorkspace ? 'files' : 'workspaces', text: query.trim() }
}

export default function CommandPalette() {
    const { paletteMode, closePalette } = useUiStore()
    const { sources, files, workspaceRoot, openFile } = useCommandStore()
    const spaces = useAppStore(s => s.spaces)
    const currentSpace = useAppStore(s => s.currentSpace)
    const records = useWorkspaceFolderStore(s => s.records)
    const [query, setQuery] = useState(() => paletteMode === 'commands' ? '>' : paletteMode === 'workspaces' && currentSpace ? '#' : '')
    const [active, setActive] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLUListElement>(null)
    const depth = useLayer(true, closePalette)

    useEffect(() => { inputRef.current?.focus() }, [])

    const { mode: effectiveMode, text } = modeOf(query, !!currentSpace)

    const commandItems = useMemo<Item[]>(() => [...allCommands(sources), ...globalCommands()].map(c => ({
        id: c.id, kind: 'command', title: c.title, shortcut: formatShortcut(c.shortcut), icon: c.icon, run: () => { c.action() }
    })), [sources])

    const fileItems = useMemo<Item[]>(() => files.filter(f => f.type === 'file').map(f => ({
        id: f.path, kind: 'file', title: f.name, detail: relativePath(dirName(f.path), workspaceRoot), run: () => openFile?.(f.path)
    })), [files, workspaceRoot, openFile])

    const workspaceItems = useMemo<Item[]>(() => [...spaces]
        .sort((a, b) => (records[b.id]?.lastOpened || b.createdAt) - (records[a.id]?.lastOpened || a.createdAt))
        .map(s => ({ id: s.id, kind: 'workspace', title: s.name, detail: folderName(records[s.id]?.folder) || 'No folder', run: () => openWorkspace(s) })),
    [spaces, records])

    const source = effectiveMode === 'commands' ? commandItems : effectiveMode === 'workspaces' ? workspaceItems : fileItems
    const fuse = useMemo(() => new Fuse(source, { keys: [{ name: 'title', weight: 3 }, { name: 'detail', weight: 1 }], threshold: 0.38, ignoreLocation: true }), [source])
    const results = useMemo(() => (text ? fuse.search(text, { limit: MAX_ITEMS }).map(r => r.item) : source.slice(0, MAX_ITEMS)), [fuse, text, source])

    useEffect(() => { setActive(0) }, [query])
    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
    }, [active])

    const run = (item: Item | undefined) => {
        if (!item) return
        closePalette()
        // Let the palette unmount before running, so dialogs opened by the command get focus.
        setTimeout(item.run, 0)
    }

    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(results.length - 1, i + 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)) }
        else if (e.key === 'Enter') { e.preventDefault(); run(results[active]) }
        else if (e.key === 'PageDown') { e.preventDefault(); setActive(i => Math.min(results.length - 1, i + 10)) }
        else if (e.key === 'PageUp') { e.preventDefault(); setActive(i => Math.max(0, i - 10)) }
    }

    const placeholder = effectiveMode === 'commands' ? 'Run a command' : effectiveMode === 'workspaces' ? 'Switch to a workspace' : 'Go to a file. Type > for commands, # for workspaces'
    const empty = effectiveMode === 'files' && files.length === 0
        ? 'Open a folder to search its files. Type > for commands.'
        : `Nothing matches “${text}”.`

    return createPortal(
        <div className="palette-scrim" data-layer-depth={depth} onMouseDown={e => { if (e.target === e.currentTarget) closePalette() }}>
            <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
                <input
                    ref={inputRef}
                    className="palette__input"
                    value={query}
                    placeholder={placeholder}
                    aria-label={placeholder}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    role="combobox"
                    aria-expanded="true"
                    aria-controls="palette-list"
                    aria-activedescendant={results[active] ? `palette-item-${active}` : undefined}
                    spellCheck={false}
                />
                <ul ref={listRef} id="palette-list" className="palette__list" role="listbox" aria-label="Results">
                    {results.map((item, i) => (
                        <li
                            key={`${item.kind}-${item.id}`}
                            id={`palette-item-${i}`}
                            data-index={i}
                            role="option"
                            aria-selected={i === active}
                            className={`palette__item ${i === active ? 'is-active' : ''}`}
                            onMouseMove={() => setActive(i)}
                            onClick={() => run(item)}
                        >
                            <span className="palette__icon" aria-hidden>
                                {item.kind === 'file' ? <FileGlyph name={item.title} size={15} />
                                    : item.kind === 'workspace' ? <FolderGit2 size={15} strokeWidth={1.6} />
                                        : <CommandIcon icon={item.icon} />}
                            </span>
                            <span className="palette__title">{item.title}</span>
                            {item.detail && <span className="palette__detail truncate">{item.detail}</span>}
                            {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
                        </li>
                    ))}
                    {results.length === 0 && <li className="palette__empty">{empty}</li>}
                </ul>
                <footer className="palette__footer">
                    <span><Kbd>↑</Kbd><Kbd>↓</Kbd> to move</span>
                    <span><Kbd>Enter</Kbd> to open</span>
                    <span><Kbd>Esc</Kbd> to close</span>
                </footer>
            </div>
        </div>,
        document.body
    )
}

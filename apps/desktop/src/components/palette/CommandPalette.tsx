/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * One box for everything: type to find a file, ">" for commands, "#" for
 * workspaces, ":" to jump to a line, "@" to jump to a symbol.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Fuse, { type RangeTuple } from 'fuse.js'
import { AtSign, Box, Braces, Code2, FolderGit2, Hash, Terminal } from 'lucide-react'
import { useUiStore, type PaletteMode } from '../../stores/uiStore'
import { useAppStore } from '../../stores/appStore'
import { allCommands, formatShortcut, useCommandStore } from '../../stores/commandStore'
import { useEditorStatusStore } from '../../stores/editorStatusStore'
import { useWorkspaceFolderStore, folderName } from '../../stores/workspaceFolderStore'
import { Kbd, focusableWithin, layerZIndex, useLayer } from '../ui'
import { FileGlyph } from '../ide/explorer/fileIcons'
import { baseName, dirName, relativePath } from '../ide/languages'
import { openWorkspace } from '../home/workspaceActions'
import { globalCommands } from './globalCommands'
import { CommandIcon } from './commandIcon'
import './palette.css'

type EffectiveMode = PaletteMode | 'line' | 'symbol'

interface Item {
    id: string
    kind: 'file' | 'command' | 'workspace' | 'line' | 'symbol'
    title: string
    detail?: string
    badge?: string
    shortcut?: string
    icon?: string | ReactNode
    run: () => void
}

interface SearchHit {
    item: Item
    titleMatches?: readonly RangeTuple[]
    detailMatches?: readonly RangeTuple[]
}

interface DocumentSymbol {
    name: string
    kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'heading'
    line: number
}

const MAX_ITEMS = 60

function prefixForMode(mode: EffectiveMode, inWorkspace: boolean): string {
    if (mode === 'commands') return '>'
    if (mode === 'workspaces') return inWorkspace ? '#' : ''
    if (mode === 'line') return ':'
    if (mode === 'symbol') return '@'
    return ''
}

function stripPrefix(query: string): string {
    return /^[>#:@]/.test(query) ? query.slice(1) : query
}

/** The prefix decides the mode; without one, files inside a workspace and workspaces on the home screen. */
function modeOf(query: string, inWorkspace: boolean): { mode: EffectiveMode; text: string } {
    if (query.startsWith('>')) return { mode: 'commands', text: query.slice(1).trim() }
    if (query.startsWith('#')) return { mode: 'workspaces', text: query.slice(1).trim() }
    if (inWorkspace && query.startsWith(':')) return { mode: 'line', text: query.slice(1).trim() }
    if (inWorkspace && query.startsWith('@')) return { mode: 'symbol', text: query.slice(1).trim() }
    return { mode: inWorkspace ? 'files' : 'workspaces', text: query.trim() }
}

function extractSymbols(content: string, fileName: string): DocumentSymbol[] {
    const symbols: DocumentSymbol[] = []
    const seen = new Set<string>()
    const lines = content.split(/\r?\n/)
    const isMarkdown = /\.(md|mdx|markdown)$/i.test(fileName)

    const push = (name: string, kind: DocumentSymbol['kind'], line: number) => {
        const key = `${line}:${name}`
        if (seen.has(key)) return
        seen.add(key)
        symbols.push({ name, kind, line })
    }

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]
        const trimmed = raw.trim()
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue
        const lineNum = i + 1

        if (isMarkdown) {
            const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/)
            if (heading) push(heading[2], 'heading', lineNum)
            continue
        }

        const fnMatch = trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|def|fn|func)\s+(?:\([^)]*\)\s+)?([A-Za-z_$][\w$]*)/)
        if (fnMatch) { push(fnMatch[1], 'function', lineNum); continue }

        const classMatch = trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?(?:class|struct|trait|enum|impl)\s+([A-Za-z_$][\w$]*)/)
        if (classMatch) { push(classMatch[1], 'class', lineNum); continue }

        const ifaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/)
        if (ifaceMatch) { push(ifaceMatch[1], 'interface', lineNum); continue }

        const typeMatch = trimmed.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/)
        if (typeMatch) { push(typeMatch[1], 'type', lineNum); continue }

        const varFnMatch = trimmed.match(/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/)
        if (varFnMatch) { push(varFnMatch[1], 'function', lineNum); continue }

        const exportConst = trimmed.match(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/)
        if (exportConst) { push(exportConst[1], 'const', lineNum); continue }
    }
    return symbols
}

function Highlight({ text, indices }: { text: string; indices?: readonly RangeTuple[] }) {
    if (!indices || indices.length === 0) return <>{text}</>
    const parts: ReactNode[] = []
    let cursor = 0
    for (let i = 0; i < indices.length; i++) {
        const [start, end] = indices[i]
        if (start > cursor) parts.push(<Fragment key={`t-${i}`}>{text.slice(cursor, start)}</Fragment>)
        parts.push(<mark key={`m-${i}`} className="palette__mark">{text.slice(start, end + 1)}</mark>)
        cursor = end + 1
    }
    if (cursor < text.length) parts.push(<Fragment key="tail">{text.slice(cursor)}</Fragment>)
    return <>{parts}</>
}

function symbolIcon(kind: DocumentSymbol['kind']) {
    switch (kind) {
        case 'class': return <Box size={14} strokeWidth={1.6} />
        case 'interface':
        case 'type': return <Braces size={14} strokeWidth={1.6} />
        case 'heading': return <Hash size={14} strokeWidth={1.6} />
        default: return <Code2 size={14} strokeWidth={1.6} />
    }
}

export default function CommandPalette() {
    const paletteMode = useUiStore(s => s.paletteMode)
    const closePalette = useUiStore(s => s.closePalette)
    const { sources, files, workspaceRoot, openFile } = useCommandStore()
    const spaces = useAppStore(s => s.spaces)
    const currentSpace = useAppStore(s => s.currentSpace)
    const records = useWorkspaceFolderStore(s => s.records)
    const currentLine = useEditorStatusStore(s => s.line)

    const inWorkspace = !!currentSpace
    const activeFilePath = currentSpace ? records[currentSpace.id]?.activeFile ?? null : null

    const [query, setQuery] = useState(() => prefixForMode(paletteMode, inWorkspace))
    const [active, setActive] = useState(0)
    const [symbols, setSymbols] = useState<DocumentSymbol[]>([])
    const [loadingSymbols, setLoadingSymbols] = useState(false)

    const paletteRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLUListElement>(null)
    const mountedModeRef = useRef(paletteMode)
    const depth = useLayer(true, closePalette)

    // Focus input on mount and restore focus to the prior element on close.
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null
        inputRef.current?.focus({ preventScroll: true })
        return () => {
            if (previous && document.contains(previous)) {
                previous.focus({ preventScroll: true })
            }
        }
    }, [])

    // Sync query prefix when paletteMode changes while the palette is already open (e.g. Ctrl+P -> Ctrl+Shift+P).
    useEffect(() => {
        if (mountedModeRef.current === paletteMode) return
        mountedModeRef.current = paletteMode
        const nextPrefix = prefixForMode(paletteMode, inWorkspace)
        setQuery(prev => `${nextPrefix}${stripPrefix(prev)}`)
        requestAnimationFrame(() => {
            const input = inputRef.current
            if (!input) return
            input.focus({ preventScroll: true })
            const len = input.value.length
            input.setSelectionRange(len, len)
        })
    }, [paletteMode, inWorkspace])

    const { mode: effectiveMode, text } = modeOf(query, inWorkspace)

    // Support `file:line` jump syntax inside Files mode.
    const fileSearch = useMemo(() => {
        if (effectiveMode !== 'files') return { searchText: text, line: undefined as number | undefined }
        const m = text.match(/^(.*?):(\d+)(?::\d+)?$/)
        if (!m) return { searchText: text, line: undefined }
        const parsedLine = Number(m[2])
        return { searchText: m[1].trim(), line: parsedLine > 0 ? parsedLine : undefined }
    }, [effectiveMode, text])

    // Load symbols for the active document when entering `@` symbol mode.
    useEffect(() => {
        if (effectiveMode !== 'symbol' || !activeFilePath) {
            setSymbols([])
            setLoadingSymbols(false)
            return
        }
        let cancelled = false
        setLoadingSymbols(true)
        void window.electronAPI?.fs?.readFile(activeFilePath)
            .then((result: { success?: boolean; content?: string } | undefined) => {
                if (cancelled) return
                if (result?.success && typeof result.content === 'string') {
                    setSymbols(extractSymbols(result.content, baseName(activeFilePath)))
                } else {
                    setSymbols([])
                }
            })
            .catch(() => { if (!cancelled) setSymbols([]) })
            .finally(() => { if (!cancelled) setLoadingSymbols(false) })
        return () => { cancelled = true }
    }, [effectiveMode, activeFilePath])

    const allRegisteredCommands = useMemo(() => [...allCommands(sources), ...globalCommands()], [sources])

    const commandItems = useMemo<Item[]>(() => allRegisteredCommands.map(c => ({
        id: c.id, kind: 'command', title: c.title, shortcut: formatShortcut(c.shortcut), icon: c.icon, run: () => { c.action() }
    })), [allRegisteredCommands])

    const fileItems = useMemo<Item[]>(() => files.filter(f => f.type === 'file').map(f => ({
        id: f.path,
        kind: 'file',
        title: f.name,
        detail: relativePath(dirName(f.path), workspaceRoot),
        badge: fileSearch.line ? `:${fileSearch.line}` : undefined,
        run: () => {
            if (fileSearch.line) {
                window.dispatchEvent(new CustomEvent('kalynt-open-file', { detail: { path: f.path, line: fileSearch.line } }))
            } else {
                openFile?.(f.path)
            }
        }
    })), [files, workspaceRoot, openFile, fileSearch.line])

    const workspaceItems = useMemo<Item[]>(() => [...spaces]
        .sort((a, b) => (records[b.id]?.lastOpened || b.createdAt) - (records[a.id]?.lastOpened || a.createdAt))
        .map(s => ({ id: s.id, kind: 'workspace', title: s.name, detail: folderName(records[s.id]?.folder) || 'No folder', run: () => openWorkspace(s) })),
    [spaces, records])

    const lineItems = useMemo<Item[]>(() => {
        const parsed = text.match(/^(\d+)(?::(\d+))?$/)
        const lineNum = parsed ? Number(parsed[1]) : NaN
        const colNum = parsed && parsed[2] ? Number(parsed[2]) : undefined
        const fileLabel = activeFilePath ? baseName(activeFilePath) : 'Current editor'
        const items: Item[] = []

        if (Number.isInteger(lineNum) && lineNum > 0) {
            items.push({
                id: `goto-line-${lineNum}-${colNum ?? 1}`,
                kind: 'line',
                title: colNum ? `Go to line ${lineNum}, column ${colNum}` : `Go to line ${lineNum}`,
                detail: fileLabel,
                badge: `Ln ${lineNum}`,
                run: () => {
                    if (activeFilePath) {
                        window.dispatchEvent(new CustomEvent('kalynt-open-file', { detail: { path: activeFilePath, line: lineNum, column: colNum } }))
                    }
                    window.dispatchEvent(new CustomEvent('kalynt-goto-line', { detail: { line: lineNum, column: colNum } }))
                }
            })
        } else {
            const goToLineCmd = allRegisteredCommands.find(c => c.id === 'edit.goToLine')
            items.push({
                id: 'goto-line-prompt',
                kind: 'line',
                title: `Type a line number (currently Ln ${currentLine})`,
                detail: activeFilePath ? fileLabel : 'Open a file to jump to a line',
                shortcut: goToLineCmd ? formatShortcut(goToLineCmd.shortcut) : undefined,
                run: () => { goToLineCmd?.action() }
            })
        }
        return items
    }, [text, activeFilePath, currentLine, allRegisteredCommands])

    const symbolItems = useMemo<Item[]>(() => {
        const items: Item[] = symbols.map(s => ({
            id: `sym-${s.line}-${s.name}`,
            kind: 'symbol',
            title: s.name,
            detail: s.kind,
            badge: `:${s.line}`,
            icon: symbolIcon(s.kind),
            run: () => {
                if (activeFilePath) {
                    window.dispatchEvent(new CustomEvent('kalynt-open-file', { detail: { path: activeFilePath, line: s.line } }))
                }
                window.dispatchEvent(new CustomEvent('kalynt-goto-symbol', { detail: { name: s.name, line: s.line } }))
            }
        }))
        if (items.length === 0 && !loadingSymbols) {
            items.push({
                id: 'sym-outline-action',
                kind: 'symbol',
                title: activeFilePath ? 'Open editor symbol outline' : 'Open a file to browse symbols',
                detail: activeFilePath ? baseName(activeFilePath) : undefined,
                run: () => {
                    window.dispatchEvent(new CustomEvent('kalynt-goto-symbol', { detail: { query: text } }))
                }
            })
        }
        return items
    }, [symbols, loadingSymbols, activeFilePath, text])

    const source = effectiveMode === 'commands' ? commandItems
        : effectiveMode === 'workspaces' ? workspaceItems
            : effectiveMode === 'line' ? lineItems
                : effectiveMode === 'symbol' ? symbolItems
                    : fileItems

    const searchQuery = effectiveMode === 'files' ? fileSearch.searchText
        : effectiveMode === 'line' ? ''
            : text

    const fuse = useMemo(() => new Fuse(source, {
        keys: [{ name: 'title', weight: 3 }, { name: 'detail', weight: 1 }],
        threshold: 0.38,
        ignoreLocation: true,
        includeMatches: true
    }), [source])

    const results = useMemo<SearchHit[]>(() => {
        if (!searchQuery) return source.slice(0, MAX_ITEMS).map(item => ({ item }))
        return fuse.search(searchQuery, { limit: MAX_ITEMS }).map(r => ({
            item: r.item,
            titleMatches: r.matches?.find(m => m.key === 'title')?.indices,
            detailMatches: r.matches?.find(m => m.key === 'detail')?.indices
        }))
    }, [fuse, searchQuery, source])

    useEffect(() => { setActive(0) }, [query])
    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
    }, [active])

    const switchMode = (nextMode: EffectiveMode) => {
        const nextPrefix = prefixForMode(nextMode, inWorkspace)
        const body = effectiveMode === 'line' ? '' : stripPrefix(query)
        setQuery(`${nextPrefix}${body}`)
        inputRef.current?.focus({ preventScroll: true })
    }

    const run = (hit: SearchHit | undefined) => {
        if (!hit) return
        closePalette()
        // Let the palette unmount and restore focus before running, so dialogs or editor jumps claim focus cleanly.
        setTimeout(hit.item.run, 0)
    }

    const onContainerKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Tab' || !paletteRef.current) return
        const items = focusableWithin(paletteRef.current)
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
        }
    }

    const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(results.length - 1, i + 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)) }
        else if (e.key === 'Enter') { e.preventDefault(); run(results[active]) }
        else if (e.key === 'PageDown') { e.preventDefault(); setActive(i => Math.min(results.length - 1, i + 10)) }
        else if (e.key === 'PageUp') { e.preventDefault(); setActive(i => Math.max(0, i - 10)) }
    }

    const placeholder = effectiveMode === 'commands' ? 'Run a command…'
        : effectiveMode === 'workspaces' ? 'Switch to a workspace…'
            : effectiveMode === 'line' ? 'Go to line (e.g. :42 or :42:10)…'
                : effectiveMode === 'symbol' ? 'Go to symbol in active file…'
                    : 'Go to file (:line, > commands, @ symbols, # workspaces)'

    const empty = effectiveMode === 'files' && files.length === 0
        ? 'Open a folder to search its files. Type > for commands.'
        : effectiveMode === 'symbol' && loadingSymbols
            ? 'Scanning symbols…'
            : `Nothing matches “${searchQuery}”.`

    const modeTabs: Array<{ id: EffectiveMode; label: string; prefix?: string }> = inWorkspace
        ? [
            { id: 'files', label: 'Files' },
            { id: 'commands', label: 'Commands', prefix: '>' },
            { id: 'workspaces', label: 'Workspaces', prefix: '#' },
            { id: 'line', label: 'Line', prefix: ':' },
            { id: 'symbol', label: 'Symbols', prefix: '@' }
        ]
        : [
            { id: 'workspaces', label: 'Workspaces' },
            { id: 'commands', label: 'Commands', prefix: '>' }
        ]

    return createPortal(
        <div
            className="palette-scrim"
            style={{ zIndex: layerZIndex(depth) }}
            data-layer-depth={depth}
            onMouseDown={e => { if (e.target === e.currentTarget) closePalette() }}
        >
            <div
                ref={paletteRef}
                className="palette"
                role="dialog"
                aria-modal="true"
                aria-label="Command palette"
                onKeyDown={onContainerKeyDown}
            >
                <div className="palette__modes" role="tablist" aria-label="Palette mode">
                    {modeTabs.map(tab => (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={effectiveMode === tab.id}
                            className={`palette__mode ${effectiveMode === tab.id ? 'is-active' : ''}`}
                            onClick={() => switchMode(tab.id)}
                        >
                            {tab.prefix && <span className="palette__mode-prefix mono" aria-hidden>{tab.prefix}</span>}
                            <span>{tab.label}</span>
                        </button>
                    ))}
                </div>
                <input
                    ref={inputRef}
                    className="palette__input"
                    value={query}
                    placeholder={placeholder}
                    aria-label={placeholder}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={onInputKeyDown}
                    role="combobox"
                    aria-expanded="true"
                    aria-controls="palette-list"
                    aria-activedescendant={results[active] ? `palette-item-${active}` : undefined}
                    spellCheck={false}
                />
                <ul ref={listRef} id="palette-list" className="palette__list" role="listbox" aria-label="Results">
                    {results.map((hit, i) => {
                        const { item } = hit
                        return (
                            <li
                                key={`${item.kind}-${item.id}`}
                                id={`palette-item-${i}`}
                                data-index={i}
                                role="option"
                                aria-selected={i === active}
                                className={`palette__item ${i === active ? 'is-active' : ''}`}
                                onMouseMove={() => setActive(i)}
                                onClick={() => run(hit)}
                            >
                                <span className="palette__icon" aria-hidden>
                                    {item.kind === 'file' ? <FileGlyph name={item.title} size={15} />
                                        : item.kind === 'workspace' ? <FolderGit2 size={15} strokeWidth={1.6} />
                                            : item.kind === 'line' ? <Hash size={15} strokeWidth={1.6} />
                                                : item.kind === 'symbol' ? (item.icon ?? <AtSign size={14} strokeWidth={1.6} />)
                                                    : item.icon ? <CommandIcon icon={item.icon} /> : <Terminal size={14} />}
                                </span>
                                <span className="palette__title">
                                    <Highlight text={item.title} indices={hit.titleMatches} />
                                </span>
                                {item.detail && (
                                    <span className="palette__detail truncate">
                                        <Highlight text={item.detail} indices={hit.detailMatches} />
                                    </span>
                                )}
                                {item.badge && <span className="palette__badge mono tabular-nums">{item.badge}</span>}
                                {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
                            </li>
                        )
                    })}
                    {results.length === 0 && <li className="palette__empty">{empty}</li>}
                </ul>
                <footer className="palette__footer">
                    <span><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
                    <span><Kbd>Enter</Kbd> open</span>
                    <span><Kbd>Tab</Kbd> switch mode</span>
                    <span><Kbd>Esc</Kbd> close</span>
                </footer>
            </div>
        </div>,
        document.body
    )
}

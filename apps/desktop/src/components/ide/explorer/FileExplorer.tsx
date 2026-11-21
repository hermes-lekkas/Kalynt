/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
    ChevronsDownUp, ClipboardCopy, ClipboardPaste, Columns2, Copy, FilePlus, FolderOpen,
    FolderPlus, MoreHorizontal, RefreshCw, Scissors, Search, TerminalSquare, Trash2
} from 'lucide-react'
import type { FileSystemItem } from '../../../vite-env'
import type { FileItem } from '../../../types/ide'
import { folderName } from '../../../stores/workspaceFolderStore'
import { useLayoutStore } from '../../../stores/layoutStore'
import { useNotificationStore } from '../../../stores/notificationStore'
import { formatShortcut } from '../../../stores/commandStore'
import { usePermissions } from '../../../hooks/usePermissions'
import { Button, EmptyState, IconButton, Menu, SearchInput, Spinner, useMenuAnchor, type Anchor, type MenuEntry } from '../../ui'
import { useGitStatusForFolder, type ChangeKind, type GitChange } from '../git/useGit'
import { FIND_IN_FOLDER_EVENT } from '../search/SearchPanel'
import { useFileTree } from './useFileTree'
import { FileTree, type InlineTreeEdit } from './FileTree'
import { FileGlyph } from './fileIcons'
import {
    copyEntry, createEntryDirect, deleteEntry, duplicateEntry,
    moveEntry, moveEntryDirect, renameEntryDirect, validateName
} from './fileOps'
import { baseName, dirName, relativePath, samePath } from '../languages'
import './explorer.css'

export const AGENT_MENTION_EVENT = 'kalynt-agent-mention'
export const OPEN_FILE_SIDE_EVENT = 'kalynt-open-file-side'
export const OPEN_TERMINAL_AT_EVENT = 'kalynt-open-terminal-at'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform)
const normKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

const GIT_LETTER: Record<ChangeKind, string> = {
    modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!'
}

const GIT_PRIORITY: Record<ChangeKind, number> = {
    conflicted: 6, deleted: 5, modified: 4, renamed: 3, added: 2, untracked: 1
}

/** Fuzzy/path score: higher is better, -1 means no match. */
function scoreFileMatch(relPath: string, name: string, rawQuery: string): number {
    const q = rawQuery.trim().toLowerCase()
    if (!q) return 0
    const nameLow = name.toLowerCase()
    const pathLow = relPath.toLowerCase()

    if (nameLow === q) return 1000
    if (nameLow.startsWith(q)) return 800 - nameLow.length
    const nameIdx = nameLow.indexOf(q)
    if (nameIdx >= 0) return 600 - nameIdx * 2 - nameLow.length
    const pathIdx = pathLow.indexOf(q)
    if (pathIdx >= 0) return 400 - pathIdx - pathLow.length

    // Fuzzy subsequence match across relative path (e.g. "src/btn" or "fb" -> "FileButton")
    let qi = 0
    let score = 200
    let lastMatch = -1
    for (let i = 0; i < pathLow.length && qi < q.length; i++) {
        if (pathLow[i] === q[qi]) {
            if (lastMatch === i - 1) score += 12
            if (i === 0 || pathLow[i - 1] === '/' || pathLow[i - 1] === '-' || pathLow[i - 1] === '_' || pathLow[i - 1] === '.') score += 16
            lastMatch = i
            qi++
        }
    }
    return qi === q.length ? score - pathLow.length : -1
}

interface ClipboardItem {
    mode: 'copy' | 'cut'
    path: string
    isDirectory: boolean
}

interface FileExplorerProps {
    folder: string | null
    indexFiles: FileItem[]
    selectedPath: string | null
    reveal: { path: string; kind: 'file' | 'dir' } | null
    onRevealed: () => void
    onOpenFile: (path: string) => void
    onOpenFolder: () => void
    onCloseFolder: () => void
    onRenamed: (from: string, to: string) => void
    onDeleted: (path: string) => void
    canEdit?: boolean
    gitChanges?: GitChange[]
}

export function FileExplorer({
    folder, indexFiles, selectedPath, reveal, onRevealed, onOpenFile, onOpenFolder, onCloseFolder, onRenamed, onDeleted,
    canEdit: canEditProp, gitChanges: gitChangesProp
}: FileExplorerProps) {
    const permissions = usePermissions()
    const canEdit = canEditProp ?? permissions.canEdit
    const liveGitChanges = useGitStatusForFolder(folder)
    const gitChanges = gitChangesProp ?? liveGitChanges
    const addNotification = useNotificationStore(s => s.addNotification)

    const tree = useFileTree(folder)
    const [focusPath, setFocusPath] = useState<string | null>(null)
    const [filterOpen, setFilterOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [filterIndex, setFilterIndex] = useState(0)
    const [inlineEdit, setInlineEdit] = useState<InlineTreeEdit | null>(null)
    const [filterRenamePath, setFilterRenamePath] = useState<string | null>(null)
    const [filterRenameVal, setFilterRenameVal] = useState('')
    const [clipboard, setClipboard] = useState<ClipboardItem | null>(null)
    const [menu, setMenu] = useState<{ item: FileSystemItem | null; anchor: Anchor } | null>(null)
    const filterInputRef = useRef<HTMLInputElement>(null)
    const more = useMenuAnchor()

    // Reset transient UI state on folder switch.
    useEffect(() => {
        setInlineEdit(null)
        setFilterRenamePath(null)
        setClipboard(null)
        setQuery('')
        setFilterOpen(false)
    }, [folder])

    // Build fast lookup maps for Git file markers and dirty parent directories.
    const { gitStatusMap, gitDirtyDirs } = useMemo(() => {
        const statusMap = new Map<string, ChangeKind>()
        const dirtyDirs = new Set<string>()
        if (!folder || gitChanges.length === 0) return { gitStatusMap: statusMap, gitDirtyDirs: dirtyDirs }

        const rootNorm = normKey(folder)
        for (const c of gitChanges) {
            const fullKey = `${rootNorm}/${c.path.replace(/\\/g, '/').replace(/^\/+/, '')}`
            const existing = statusMap.get(fullKey)
            if (!existing || GIT_PRIORITY[c.kind] > GIT_PRIORITY[existing]) {
                statusMap.set(fullKey, c.kind)
            }
            let dir = normKey(dirName(fullKey))
            while (dir && dir.length > rootNorm.length && dir.startsWith(rootNorm + '/')) {
                dirtyDirs.add(dir)
                const parent = normKey(dirName(dir))
                if (parent === dir) break
                dir = parent
            }
        }
        return { gitStatusMap: statusMap, gitDirtyDirs: dirtyDirs }
    }, [folder, gitChanges])

    // Reveal requests from tabs, breadcrumbs and "open" on a directory.
    useEffect(() => {
        if (!reveal) return
        const { path, kind } = reveal
        tree.reveal(path).then(async () => {
            if (kind === 'dir' && path.replace(/[\\/]+$/, '') !== folder?.replace(/[\\/]+$/, '')) await tree.expand(path)
            setFocusPath(path)
            setQuery('')
            setFilterOpen(false)
            onRevealed()
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reveal])

    // Keep the active file visible in the tree, without moving keyboard focus.
    useEffect(() => {
        if (selectedPath && folder) void tree.reveal(selectedPath)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedPath, folder])

    const openFilterBar = useCallback(() => {
        setFilterOpen(true)
        requestAnimationFrame(() => {
            filterInputRef.current?.focus()
            filterInputRef.current?.select()
        })
    }, [])

    const closeFilterBar = useCallback(() => {
        setQuery('')
        setFilterOpen(false)
        setFilterRenamePath(null)
    }, [])

    const matches = useMemo(() => {
        const q = query.trim()
        if (!q || !folder) return []
        const scored: Array<{ file: FileItem; rel: string; score: number }> = []
        for (const f of indexFiles) {
            if (f.type !== 'file') continue
            const rel = relativePath(f.path, folder)
            const score = scoreFileMatch(rel, f.name, q)
            if (score >= 0) scored.push({ file: f, rel, score })
        }
        scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
        return scored.slice(0, 200)
    }, [query, indexFiles, folder])

    useEffect(() => {
        setFilterIndex(0)
    }, [query])

    if (!folder) {
        return (
            <div className="explorer">
                <EmptyState
                    compact
                    icon={<FolderOpen size={28} />}
                    title="No folder open"
                    description="Choose the folder this workspace works in."
                    actions={<Button variant="primary" size="sm" onClick={onOpenFolder}>Open folder</Button>}
                />
            </div>
        )
    }

    const targetDir = (item: FileSystemItem | null) => (item ? (item.isDirectory ? item.path : dirName(item.path)) : folder)

    const startCreate = async (kind: 'file' | 'folder', item: FileSystemItem | null) => {
        if (!canEdit) return
        setQuery('')
        setFilterOpen(false)
        const dir = targetDir(item)
        if (item?.isDirectory) await tree.expand(item.path)
        else if (normKey(dir) !== normKey(folder)) await tree.expand(dir)
        setInlineEdit({ kind: kind === 'file' ? 'create-file' : 'create-folder', parentDir: dir })
    }

    const startRename = (item: FileSystemItem) => {
        if (!canEdit) return
        if (query.trim()) {
            setFilterRenamePath(item.path)
            setFilterRenameVal(item.name)
            return
        }
        setInlineEdit({ kind: 'rename', item })
    }

    const commitInlineEdit = async (value: string) => {
        const current = inlineEdit
        setInlineEdit(null)
        if (!current || !canEdit) return
        if (current.kind === 'rename') {
            const result = await renameEntryDirect(current.item.path, value)
            if (!result) return
            onRenamed(result.from, result.to)
            await tree.refresh()
            setFocusPath(result.to)
            return
        }
        const kind = current.kind === 'create-file' ? 'file' : 'folder'
        const created = await createEntryDirect(current.parentDir, value, kind)
        if (!created) return
        await tree.refresh()
        await tree.reveal(created)
        setFocusPath(created)
        if (kind === 'file') onOpenFile(created)
    }

    const commitFilterRename = async (itemPath: string) => {
        const nextName = filterRenameVal.trim()
        setFilterRenamePath(null)
        if (!canEdit || !nextName || nextName === baseName(itemPath)) return
        if (validateName(nextName)) {
            addNotification(validateName(nextName)!, 'error')
            return
        }
        const result = await renameEntryDirect(itemPath, nextName)
        if (!result) return
        onRenamed(result.from, result.to)
        await tree.refresh()
        setFocusPath(result.to)
    }

    const remove = async (item: FileSystemItem) => {
        if (!canEdit) return
        if (!(await deleteEntry(item.path, item.isDirectory))) return
        if (clipboard && samePath(clipboard.path, item.path)) setClipboard(null)
        onDeleted(item.path)
        await tree.refresh()
    }

    const move = async (source: string, dest: string) => {
        if (!canEdit) return
        const result = await moveEntry(source, dest)
        if (!result) return
        onRenamed(result.from, result.to)
        await tree.refresh()
        setFocusPath(result.to)
    }

    const handleCopy = (item: FileSystemItem) => {
        setClipboard({ mode: 'copy', path: item.path, isDirectory: item.isDirectory })
        addNotification(`Copied ${item.name}`, 'info')
    }

    const handleCut = (item: FileSystemItem) => {
        if (!canEdit) return
        setClipboard({ mode: 'cut', path: item.path, isDirectory: item.isDirectory })
        addNotification(`Cut ${item.name}`, 'info')
    }

    const handlePaste = async (item: FileSystemItem | null) => {
        if (!canEdit || !clipboard) return
        const destDir = targetDir(item)
        if (clipboard.mode === 'cut') {
            const moved = await moveEntryDirect(clipboard.path, destDir, false)
            if (!moved) return
            setClipboard(null)
            onRenamed(moved.from, moved.to)
            await tree.refresh()
            await tree.reveal(moved.to)
            setFocusPath(moved.to)
            return
        }
        const copied = await copyEntry(clipboard.path, destDir, clipboard.isDirectory)
        if (!copied) return
        await tree.refresh()
        await tree.reveal(copied)
        setFocusPath(copied)
    }

    const handleDuplicate = async (item: FileSystemItem) => {
        if (!canEdit) return
        const dup = await duplicateEntry(item.path, item.isDirectory)
        if (!dup) return
        await tree.refresh()
        setFocusPath(dup)
        if (!item.isDirectory) onOpenFile(dup)
    }

    const openToSide = (path: string) => {
        const evt = new CustomEvent(OPEN_FILE_SIDE_EVENT, { detail: { path }, cancelable: true })
        const handled = !window.dispatchEvent(evt)
        if (!handled) {
            onOpenFile(path)
            useLayoutStore.getState().setEditorPref({ splitEditor: true })
        }
    }

    const findInFolder = (dir: string) => {
        const rel = relativePath(dir, folder)
        const include = normKey(dir) === normKey(folder) || !rel ? '' : `${rel}/**`
        window.dispatchEvent(new CustomEvent(FIND_IN_FOLDER_EVENT, { detail: { include } }))
    }

    const openInTerminal = (dir: string) => {
        const layout = useLayoutStore.getState()
        layout.setBottomOpen(true)
        layout.setBottomTab('terminal')
        const evt = new CustomEvent(OPEN_TERMINAL_AT_EVENT, { detail: { cwd: dir }, cancelable: true })
        window.dispatchEvent(evt)
    }

    const toFsItem = (f: FileItem): FileSystemItem => ({
        name: f.name,
        path: f.path,
        isDirectory: f.type === 'directory',
        isFile: f.type === 'file'
    })

    const onFilterKeyDown = (e: KeyboardEvent) => {
        if (filterRenamePath) return
        if (e.key === 'Escape') {
            e.preventDefault()
            closeFilterBar()
            return
        }
        if (matches.length === 0) return
        const current = matches[Math.min(filterIndex, matches.length - 1)]
        const currentItem = current ? toFsItem(current.file) : null
        const mod = e.ctrlKey || e.metaKey

        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setFilterIndex(i => Math.min(matches.length - 1, i + 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setFilterIndex(i => Math.max(0, i - 1))
        } else if (e.key === 'Enter' && current) {
            e.preventDefault()
            onOpenFile(current.file.path)
        } else if (e.key === 'F2' && currentItem && canEdit) {
            e.preventDefault()
            startRename(currentItem)
        } else if ((e.key === 'Delete' || (e.metaKey && e.key === 'Backspace')) && currentItem && canEdit) {
            e.preventDefault()
            void remove(currentItem)
        } else if (mod && !e.altKey && !e.shiftKey && currentItem) {
            const k = e.key.toLowerCase()
            if (k === 'c' && document.activeElement !== filterInputRef.current) { e.preventDefault(); handleCopy(currentItem) }
            if (k === 'x' && canEdit && document.activeElement !== filterInputRef.current) { e.preventDefault(); handleCut(currentItem) }
            if (k === 'v' && canEdit && clipboard && document.activeElement !== filterInputRef.current) { e.preventDefault(); void handlePaste(currentItem) }
        }
    }

    const deleteShortcut = isMac ? '⌘⌫' : 'Del'

    const contextItems = (item: FileSystemItem | null): MenuEntry[] => {
        const dir = targetDir(item)
        return [
            { label: 'New file', icon: <FilePlus size={14} />, disabled: !canEdit, onSelect: () => { void startCreate('file', item) } },
            { label: 'New folder', icon: <FolderPlus size={14} />, disabled: !canEdit, onSelect: () => { void startCreate('folder', item) } },
            ...(item ? [
                'separator' as const,
                ...(!item.isDirectory ? [
                    { label: 'Open', onSelect: () => onOpenFile(item.path) },
                    { label: 'Open to side', icon: <Columns2 size={14} />, onSelect: () => openToSide(item.path) }
                ] : []),
                { label: 'Find in folder…', icon: <Search size={14} />, onSelect: () => findInFolder(dir) },
                { label: 'Open in terminal', icon: <TerminalSquare size={14} />, onSelect: () => openInTerminal(dir) },
                { label: 'Mention in agent chat', onSelect: () => window.dispatchEvent(new CustomEvent(AGENT_MENTION_EVENT, { detail: { path: item.path, name: item.name } })) },
                'separator' as const,
                { label: 'Cut', icon: <Scissors size={14} />, shortcut: formatShortcut('Ctrl+X'), disabled: !canEdit, onSelect: () => handleCut(item) },
                { label: 'Copy', icon: <ClipboardCopy size={14} />, shortcut: formatShortcut('Ctrl+C'), onSelect: () => handleCopy(item) },
                { label: 'Paste', icon: <ClipboardPaste size={14} />, shortcut: formatShortcut('Ctrl+V'), disabled: !canEdit || !clipboard, onSelect: () => { void handlePaste(item) } },
                { label: 'Duplicate', icon: <Copy size={14} />, disabled: !canEdit, onSelect: () => { void handleDuplicate(item) } },
                'separator' as const,
                { label: 'Copy path', onSelect: () => navigator.clipboard.writeText(item.path) },
                { label: 'Copy relative path', onSelect: () => navigator.clipboard.writeText(relativePath(item.path, folder)) },
                { label: 'Show in file manager', onSelect: () => window.electronAPI?.shell?.showItemInFolder?.(item.path) },
                'separator' as const,
                { label: 'Rename', shortcut: 'F2', disabled: !canEdit, onSelect: () => startRename(item) },
                { label: 'Delete…', icon: <Trash2 size={14} />, shortcut: deleteShortcut, danger: true, disabled: !canEdit, onSelect: () => { void remove(item) } }
            ] : [
                'separator' as const,
                ...(clipboard ? [{ label: 'Paste', icon: <ClipboardPaste size={14} />, shortcut: formatShortcut('Ctrl+V'), disabled: !canEdit, onSelect: () => { void handlePaste(null) } }] : []),
                { label: 'Find in folder…', icon: <Search size={14} />, onSelect: () => findInFolder(folder) },
                { label: 'Open in terminal', icon: <TerminalSquare size={14} />, onSelect: () => openInTerminal(folder) },
                { label: 'Refresh', icon: <RefreshCw size={14} />, onSelect: () => { void tree.refresh() } }
            ])
        ]
    }

    return (
        <div className="explorer">
            <div className="side-head">
                <h2 className="side-head__title truncate" title={folder}>{folderName(folder)}</h2>
                <div className="side-head__actions">
                    <IconButton
                        size="sm"
                        label="Filter files (/)"
                        icon={<Search size={14} />}
                        active={filterOpen || !!query}
                        onClick={() => (filterOpen ? closeFilterBar() : openFilterBar())}
                    />
                    <IconButton
                        size="sm"
                        label={canEdit ? 'New file' : 'New file (read-only)'}
                        icon={<FilePlus size={14} />}
                        disabled={!canEdit}
                        onClick={() => { void startCreate('file', null) }}
                    />
                    <IconButton size="sm" label="More actions" icon={<MoreHorizontal size={14} />} onClick={more.toggle} />
                </div>
                <Menu
                    open={more.open}
                    anchor={more.anchor}
                    onClose={more.close}
                    placement="bottom-end"
                    items={[
                        { label: 'New folder', icon: <FolderPlus size={14} />, disabled: !canEdit, onSelect: () => { void startCreate('folder', null) } },
                        { label: 'Refresh', icon: <RefreshCw size={14} />, onSelect: () => { void tree.refresh() } },
                        { label: 'Collapse folders', icon: <ChevronsDownUp size={14} />, onSelect: tree.collapseAll },
                        'separator',
                        { label: 'Find in folder…', icon: <Search size={14} />, onSelect: () => findInFolder(folder) },
                        { label: 'Open in terminal', icon: <TerminalSquare size={14} />, onSelect: () => openInTerminal(folder) },
                        'separator',
                        { label: 'Change folder…', onSelect: onOpenFolder },
                        { label: 'Show in file manager', onSelect: () => window.electronAPI?.shell?.showItemInFolder?.(folder) },
                        'separator',
                        { label: 'Close folder', onSelect: onCloseFolder }
                    ]}
                />
            </div>

            {filterOpen && (
                <div className="explorer__filter">
                    <SearchInput
                        ref={filterInputRef}
                        size="sm"
                        value={query}
                        onChange={setQuery}
                        onClear={() => setQuery('')}
                        onKeyDown={onFilterKeyDown}
                        placeholder="Filter by name or path…"
                        aria-label="Filter files by name or path"
                    />
                </div>
            )}

            {query.trim() ? (
                <ul
                    className="explorer__matches"
                    role="listbox"
                    aria-label="Matching files"
                    tabIndex={0}
                    onKeyDown={onFilterKeyDown}
                >
                    {matches.map(({ file }, idx) => {
                        const fsItem = toFsItem(file)
                        const isSelected = samePath(selectedPath, file.path)
                        const isFocused = idx === filterIndex
                        const isRenaming = filterRenamePath !== null && samePath(filterRenamePath, file.path)
                        const gitKind = gitStatusMap.get(normKey(file.path))
                        return (
                            <li key={file.path} role="option" aria-selected={isSelected}>
                                {isRenaming ? (
                                    <div className="match-row match-row--editing">
                                        <FileGlyph name={file.name} size={14} className="tree-row__icon" />
                                        <input
                                            type="text"
                                            className="tree-row__inline-input mono"
                                            value={filterRenameVal}
                                            autoFocus
                                            spellCheck={false}
                                            onChange={e => setFilterRenameVal(e.target.value)}
                                            onKeyDown={e => {
                                                e.stopPropagation()
                                                if (e.key === 'Enter') { e.preventDefault(); void commitFilterRename(file.path) }
                                                if (e.key === 'Escape') { e.preventDefault(); setFilterRenamePath(null) }
                                            }}
                                            onBlur={() => setFilterRenamePath(null)}
                                        />
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        className={[
                                            'match-row',
                                            isSelected && 'is-selected',
                                            isFocused && 'is-focused',
                                            gitKind && `tree-row--git-${gitKind}`
                                        ].filter(Boolean).join(' ')}
                                        onClick={() => { setFilterIndex(idx); onOpenFile(file.path) }}
                                        onContextMenu={e => {
                                            e.preventDefault()
                                            e.stopPropagation()
                                            setFilterIndex(idx)
                                            setMenu({ item: fsItem, anchor: { x: e.clientX, y: e.clientY } })
                                        }}
                                        title={file.path}
                                    >
                                        <FileGlyph name={file.name} size={14} className="tree-row__icon" />
                                        <span className="match-row__name">{file.name}</span>
                                        <span className="match-row__dir truncate">{relativePath(dirName(file.path), folder)}</span>
                                        {gitKind && (
                                            <span className={`tree-row__git tree-row__git--${gitKind}`}>{GIT_LETTER[gitKind]}</span>
                                        )}
                                    </button>
                                )}
                            </li>
                        )
                    })}
                    {matches.length === 0 && <li className="explorer__none">No files match “{query.trim()}”.</li>}
                </ul>
            ) : tree.rootLoading ? (
                <div className="explorer__loading"><Spinner label="Reading folder" /></div>
            ) : tree.error ? (
                <EmptyState
                    compact
                    title="Couldn’t read this folder"
                    description={tree.error}
                    actions={<Button size="sm" onClick={() => tree.refresh()}>Try again</Button>}
                />
            ) : tree.rows.length === 0 && !inlineEdit ? (
                <EmptyState
                    compact
                    title="This folder is empty"
                    actions={canEdit ? <Button size="sm" onClick={() => { void startCreate('file', null) }}>New file</Button> : undefined}
                />
            ) : (
                <FileTree
                    rows={tree.rows}
                    rootPath={folder}
                    selectedPath={selectedPath}
                    focusPath={focusPath}
                    canEdit={canEdit}
                    cutPath={clipboard?.mode === 'cut' ? clipboard.path : null}
                    gitStatusMap={gitStatusMap}
                    gitDirtyDirs={gitDirtyDirs}
                    inlineEdit={inlineEdit}
                    onCommitInlineEdit={val => { void commitInlineEdit(val) }}
                    onCancelInlineEdit={() => setInlineEdit(null)}
                    onFocusPath={setFocusPath}
                    onOpen={item => onOpenFile(item.path)}
                    onToggle={tree.toggle}
                    onContextMenu={(item, e: MouseEvent) => setMenu({ item, anchor: { x: e.clientX, y: e.clientY } })}
                    onRename={startRename}
                    onDelete={item => { void remove(item) }}
                    onMove={(source, dest) => { void move(source, dest) }}
                    onCopy={handleCopy}
                    onCut={handleCut}
                    onPaste={item => { void handlePaste(item) }}
                    onOpenFilter={openFilterBar}
                />
            )}

            {menu && <Menu open anchor={menu.anchor} onClose={() => setMenu(null)} items={contextItems(menu.item)} />}
        </div>
    )
}

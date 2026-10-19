/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { ChevronsDownUp, FilePlus, FolderOpen, FolderPlus, MoreHorizontal, RefreshCw } from 'lucide-react'
import type { FileSystemItem } from '../../../vite-env'
import type { FileItem } from '../../../types/ide'
import { folderName } from '../../../stores/workspaceFolderStore'
import { Button, EmptyState, IconButton, Menu, SearchInput, Spinner, useMenuAnchor, type Anchor, type MenuEntry } from '../../ui'
import { useFileTree } from './useFileTree'
import { FileTree } from './FileTree'
import { FileGlyph } from './fileIcons'
import { createEntry, deleteEntry, moveEntry, renameEntry } from './fileOps'
import { dirName, relativePath } from '../languages'
import './explorer.css'

export const AGENT_MENTION_EVENT = 'kalynt-agent-mention'

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
}

export function FileExplorer({
    folder, indexFiles, selectedPath, reveal, onRevealed, onOpenFile, onOpenFolder, onCloseFolder, onRenamed, onDeleted
}: FileExplorerProps) {
    const tree = useFileTree(folder)
    const [focusPath, setFocusPath] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [menu, setMenu] = useState<{ item: FileSystemItem | null; anchor: Anchor } | null>(null)
    const more = useMenuAnchor()

    // Reveal requests from tabs, breadcrumbs and "open" on a directory.
    useEffect(() => {
        if (!reveal) return
        const { path, kind } = reveal
        tree.reveal(path).then(async () => {
            if (kind === 'dir' && path.replace(/[\\/]+$/, '') !== folder?.replace(/[\\/]+$/, '')) await tree.expand(path)
            setFocusPath(path)
            setQuery('')
            onRevealed()
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reveal])

    // Keep the active file visible in the tree, without moving keyboard focus.
    useEffect(() => {
        if (selectedPath && folder) tree.reveal(selectedPath)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedPath, folder])

    const matches = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return []
        return indexFiles.filter(f => f.type === 'file' && f.name.toLowerCase().includes(q)).slice(0, 200)
    }, [query, indexFiles])

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

    const create = async (kind: 'file' | 'folder', item: FileSystemItem | null) => {
        const dir = targetDir(item)
        if (item?.isDirectory) await tree.expand(item.path)
        const path = await createEntry(dir, kind)
        if (!path) return
        await tree.refresh()
        setFocusPath(path)
        if (kind === 'file') onOpenFile(path)
    }

    const rename = async (item: FileSystemItem) => {
        const result = await renameEntry(item.path)
        if (!result) return
        onRenamed(result.from, result.to)
        await tree.refresh()
        setFocusPath(result.to)
    }

    const remove = async (item: FileSystemItem) => {
        if (!(await deleteEntry(item.path, item.isDirectory))) return
        onDeleted(item.path)
        await tree.refresh()
    }

    const move = async (source: string, dest: string) => {
        const result = await moveEntry(source, dest)
        if (!result) return
        onRenamed(result.from, result.to)
        await tree.refresh()
        setFocusPath(result.to)
    }

    const contextItems = (item: FileSystemItem | null): MenuEntry[] => [
        { label: 'New file…', icon: <FilePlus size={14} />, onSelect: () => create('file', item) },
        { label: 'New folder…', icon: <FolderPlus size={14} />, onSelect: () => create('folder', item) },
        ...(item ? [
            'separator' as const,
            ...(!item.isDirectory ? [{ label: 'Open', onSelect: () => onOpenFile(item.path) }] : []),
            { label: 'Mention in agent chat', onSelect: () => window.dispatchEvent(new CustomEvent(AGENT_MENTION_EVENT, { detail: { path: item.path, name: item.name } })) },
            'separator' as const,
            { label: 'Copy path', onSelect: () => navigator.clipboard.writeText(item.path) },
            { label: 'Copy relative path', onSelect: () => navigator.clipboard.writeText(relativePath(item.path, folder)) },
            { label: 'Show in file manager', onSelect: () => window.electronAPI?.shell?.showItemInFolder?.(item.path) },
            'separator' as const,
            { label: 'Rename…', shortcut: 'F2', onSelect: () => rename(item) },
            { label: 'Delete…', shortcut: 'Del', danger: true, onSelect: () => remove(item) }
        ] : [])
    ]

    return (
        <div className="explorer">
            <div className="side-head">
                <h2 className="side-head__title truncate" title={folder}>{folderName(folder)}</h2>
                <div className="side-head__actions">
                    <IconButton size="sm" label="New file" icon={<FilePlus size={14} />} onClick={() => create('file', null)} />
                    <IconButton size="sm" label="New folder" icon={<FolderPlus size={14} />} onClick={() => create('folder', null)} />
                    <IconButton size="sm" label="Refresh" icon={<RefreshCw size={14} />} onClick={() => tree.refresh()} />
                    <IconButton size="sm" label="Collapse folders" icon={<ChevronsDownUp size={14} />} onClick={tree.collapseAll} />
                    <IconButton size="sm" label="More" icon={<MoreHorizontal size={14} />} onClick={more.toggle} />
                </div>
                <Menu
                    open={more.open}
                    anchor={more.anchor}
                    onClose={more.close}
                    placement="bottom-end"
                    items={[
                        { label: 'Change folder…', onSelect: onOpenFolder },
                        { label: 'Show in file manager', onSelect: () => window.electronAPI?.shell?.showItemInFolder?.(folder) },
                        'separator',
                        { label: 'Close folder', onSelect: onCloseFolder }
                    ]}
                />
            </div>

            <div className="explorer__filter">
                <SearchInput size="sm" value={query} onChange={setQuery} placeholder="Filter files by name" aria-label="Filter files by name" />
            </div>

            {query.trim() ? (
                <ul className="explorer__matches" aria-label="Matching files">
                    {matches.map(f => (
                        <li key={f.path}>
                            <button type="button" className={`match-row ${selectedPath === f.path ? 'is-selected' : ''}`} onClick={() => onOpenFile(f.path)} title={f.path}>
                                <FileGlyph name={f.name} size={14} className="tree-row__icon" />
                                <span className="match-row__name">{f.name}</span>
                                <span className="match-row__dir truncate">{relativePath(dirName(f.path), folder)}</span>
                            </button>
                        </li>
                    ))}
                    {matches.length === 0 && <li className="explorer__none">No file names contain “{query.trim()}”.</li>}
                </ul>
            ) : tree.rootLoading ? (
                <div className="explorer__loading"><Spinner label="Reading folder" /></div>
            ) : tree.error ? (
                <EmptyState compact title="Couldn’t read this folder" description={tree.error}
                    actions={<Button size="sm" onClick={() => tree.refresh()}>Try again</Button>} />
            ) : tree.rows.length === 0 ? (
                <EmptyState compact title="This folder is empty" actions={<Button size="sm" onClick={() => create('file', null)}>New file</Button>} />
            ) : (
                <FileTree
                    rows={tree.rows}
                    rootPath={folder}
                    selectedPath={selectedPath}
                    focusPath={focusPath}
                    onFocusPath={setFocusPath}
                    onOpen={item => onOpenFile(item.path)}
                    onToggle={tree.toggle}
                    onContextMenu={(item, e: MouseEvent) => setMenu({ item, anchor: { x: e.clientX, y: e.clientY } })}
                    onRename={rename}
                    onDelete={remove}
                    onMove={move}
                />
            )}

            {menu && <Menu open anchor={menu.anchor} onClose={() => setMenu(null)} items={contextItems(menu.item)} />}
        </div>
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Virtualised, keyboard-navigable tree (WAI-ARIA tree pattern) with
 * drag-to-move.
 */
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import type { FileSystemItem } from '../../../vite-env'
import { VirtualList, type VirtualListHandle } from '../../ui'
import type { TreeRow } from './useFileTree'
import { FileGlyph, FolderGlyph } from './fileIcons'
import { dirName, samePath } from '../languages'

const ROW_HEIGHT = 24
const INDENT = 12

interface FileTreeProps {
    rows: TreeRow[]
    rootPath: string
    selectedPath: string | null
    focusPath: string | null
    onFocusPath: (path: string | null) => void
    onOpen: (item: FileSystemItem) => void
    onToggle: (path: string) => void
    onContextMenu: (item: FileSystemItem | null, e: MouseEvent) => void
    onRename: (item: FileSystemItem) => void
    onDelete: (item: FileSystemItem) => void
    onMove: (source: string, targetDir: string) => void
}

const IGNORED_LOOK = new Set(['node_modules', 'dist', 'build', 'out', '.git', '.next', 'target', 'coverage'])

export function FileTree({
    rows, rootPath, selectedPath, focusPath, onFocusPath, onOpen, onToggle, onContextMenu, onRename, onDelete, onMove
}: FileTreeProps) {
    const listRef = useRef<VirtualListHandle>(null)
    const [dropTarget, setDropTarget] = useState<string | null>(null)
    const focusIndex = rows.findIndex(r => samePath(r.item.path, focusPath))

    useEffect(() => {
        if (focusIndex >= 0) listRef.current?.scrollToIndex(focusIndex)
    }, [focusIndex])

    const onKeyDown = (e: KeyboardEvent) => {
        if (rows.length === 0) return
        const index = focusIndex
        const row = rows[index]
        const focusAt = (i: number) => onFocusPath(rows[Math.max(0, Math.min(rows.length - 1, i))].item.path)

        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); focusAt(index + 1); break
            case 'ArrowUp': e.preventDefault(); focusAt(index < 0 ? 0 : index - 1); break
            case 'Home': e.preventDefault(); focusAt(0); break
            case 'End': e.preventDefault(); focusAt(rows.length - 1); break
            case 'ArrowRight':
                e.preventDefault()
                if (row?.item.isDirectory && !row.expanded) onToggle(row.item.path)
                else if (row?.expanded) focusAt(index + 1)
                break
            case 'ArrowLeft': {
                e.preventDefault()
                if (!row) break
                if (row.item.isDirectory && row.expanded) { onToggle(row.item.path); break }
                const parent = dirName(row.item.path.replace(/\\/g, '/'))
                const parentIndex = rows.findIndex(r => samePath(r.item.path, parent))
                if (parentIndex >= 0) focusAt(parentIndex)
                break
            }
            case 'Enter':
            case ' ':
                if (!row) break
                e.preventDefault()
                if (row.item.isDirectory) onToggle(row.item.path)
                else onOpen(row.item)
                break
            case 'F2': if (row) { e.preventDefault(); onRename(row.item) } break
            case 'Delete': if (row) { e.preventDefault(); onDelete(row.item) } break
        }
    }

    const dragOver = (e: DragEvent, target: string | null) => {
        if (!e.dataTransfer.types.includes('application/x-kalynt-path')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropTarget(target)
    }

    const drop = (e: DragEvent, targetDir: string) => {
        e.preventDefault()
        e.stopPropagation()
        setDropTarget(null)
        const source = e.dataTransfer.getData('application/x-kalynt-path')
        if (source) onMove(source, targetDir)
    }

    return (
        <VirtualList
            ref={listRef}
            className="file-tree"
            role="tree"
            aria-label="Files"
            tabIndex={0}
            aria-activedescendant={focusIndex >= 0 ? `tree-row-${focusIndex}` : undefined}
            onKeyDown={onKeyDown}
            onFocus={() => { if (focusIndex < 0 && rows.length) onFocusPath(rows[0].item.path) }}
            onContextMenu={e => { if (e.target === e.currentTarget) onContextMenu(null, e) }}
            onDragOver={e => dragOver(e, rootPath)}
            onDragLeave={() => setDropTarget(null)}
            onDrop={e => drop(e, rootPath)}
            items={rows}
            rowHeight={ROW_HEIGHT}
            renderRow={(row, index) => {
                const { item, depth, expanded, loading } = row
                const isSelected = samePath(item.path, selectedPath)
                const isFocused = index === focusIndex
                const dim = item.name.startsWith('.') || IGNORED_LOOK.has(item.name)
                const target = item.isDirectory ? item.path : dirName(item.path)
                return (
                    <div
                        key={item.path}
                        id={`tree-row-${index}`}
                        role="treeitem"
                        aria-level={depth + 1}
                        aria-expanded={item.isDirectory ? expanded : undefined}
                        aria-selected={isSelected}
                        className={[
                            'tree-row', isSelected && 'is-selected', isFocused && 'is-focused', dim && 'is-dim',
                            dropTarget && samePath(dropTarget, target) && 'is-drop-target'
                        ].filter(Boolean).join(' ')}
                        style={{ height: ROW_HEIGHT, paddingLeft: 8 + depth * INDENT }}
                        title={item.path}
                        draggable
                        onDragStart={e => {
                            e.dataTransfer.setData('application/x-kalynt-path', item.path)
                            e.dataTransfer.setData('text/plain', item.path)
                            e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragOver={e => { e.stopPropagation(); dragOver(e, target) }}
                        onDrop={e => drop(e, target)}
                        onClick={() => {
                            onFocusPath(item.path)
                            if (item.isDirectory) onToggle(item.path)
                            else onOpen(item)
                        }}
                        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onFocusPath(item.path); onContextMenu(item, e) }}
                    >
                        {Array.from({ length: depth }, (_, i) => (
                            <span key={i} className="tree-row__guide" style={{ left: 14 + i * INDENT }} aria-hidden />
                        ))}
                        <span className="tree-row__twisty" aria-hidden>
                            {item.isDirectory && (loading
                                ? <Loader2 size={12} className="spin" />
                                : <ChevronRight size={13} className={expanded ? 'is-open' : ''} />)}
                        </span>
                        {item.isDirectory
                            ? <FolderGlyph open={expanded} size={15} className="tree-row__icon" />
                            : <FileGlyph name={item.name} size={15} className="tree-row__icon" />}
                        <span className="tree-row__name">{item.name}</span>
                    </div>
                )
            }}
        />
    )
}

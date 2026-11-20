/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Virtualised, keyboard-navigable tree (WAI-ARIA tree pattern) with
 * inline create/rename rows, Git status markers, clipboard shortcuts,
 * and drag-to-move.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import type { FileSystemItem } from '../../../vite-env'
import { VirtualList, type VirtualListHandle } from '../../ui'
import type { ChangeKind } from '../git/useGit'
import type { TreeRow } from './useFileTree'
import { FileGlyph, FolderGlyph } from './fileIcons'
import { validateName, validateRelativePath } from './fileOps'
import { dirName, samePath } from '../languages'

const ROW_HEIGHT = 24
const INDENT = 12

const GIT_LETTER: Record<ChangeKind, string> = {
    modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!'
}

export type InlineTreeEdit =
    | { kind: 'create-file' | 'create-folder'; parentDir: string }
    | { kind: 'rename'; item: FileSystemItem }

type DisplayRow =
    | { kind: 'entry'; row: TreeRow }
    | { kind: 'create'; createKind: 'file' | 'folder'; parentDir: string; depth: number }

interface FileTreeProps {
    rows: TreeRow[]
    rootPath: string
    selectedPath: string | null
    focusPath: string | null
    canEdit?: boolean
    cutPath?: string | null
    gitStatusMap?: Map<string, ChangeKind>
    gitDirtyDirs?: Set<string>
    inlineEdit?: InlineTreeEdit | null
    onCommitInlineEdit?: (value: string) => void
    onCancelInlineEdit?: () => void
    onFocusPath: (path: string | null) => void
    onOpen: (item: FileSystemItem) => void
    onToggle: (path: string) => void
    onContextMenu: (item: FileSystemItem | null, e: MouseEvent) => void
    onRename: (item: FileSystemItem) => void
    onDelete: (item: FileSystemItem) => void
    onMove: (source: string, targetDir: string) => void
    onCopy?: (item: FileSystemItem) => void
    onCut?: (item: FileSystemItem) => void
    onPaste?: (item: FileSystemItem | null) => void
    onOpenFilter?: () => void
}

const IGNORED_LOOK = new Set(['node_modules', 'dist', 'build', 'out', '.git', '.next', 'target', 'coverage'])
const normKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

function InlineRowInput({
    initialValue,
    selectStem,
    placeholder,
    validate,
    onCommit,
    onCancel
}: {
    initialValue: string
    selectStem?: boolean
    placeholder: string
    validate: (v: string) => string | null
    onCommit: (value: string) => void
    onCancel: () => void
}) {
    const [value, setValue] = useState(initialValue)
    const [error, setError] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const settled = useRef(false)

    useEffect(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        if (selectStem && initialValue) {
            const dot = initialValue.lastIndexOf('.')
            el.setSelectionRange(0, dot > 0 ? dot : initialValue.length)
        } else {
            el.select()
        }
    }, [initialValue, selectStem])

    const submit = () => {
        if (settled.current) return
        const trimmed = value.trim()
        if (!trimmed) {
            settled.current = true
            onCancel()
            return
        }
        const err = validate(trimmed)
        if (err) {
            setError(err)
            return
        }
        settled.current = true
        onCommit(trimmed)
    }

    const cancel = () => {
        if (settled.current) return
        settled.current = true
        onCancel()
    }

    return (
        <span className="tree-row__inline-wrap" onClick={e => e.stopPropagation()}>
            <input
                ref={inputRef}
                type="text"
                className={`tree-row__inline-input mono ${error ? 'is-invalid' : ''}`}
                value={value}
                placeholder={placeholder}
                aria-label={placeholder}
                spellCheck={false}
                onChange={e => {
                    const next = e.target.value
                    setValue(next)
                    if (error) setError(next.trim() ? validate(next) : null)
                }}
                onKeyDown={e => {
                    e.stopPropagation()
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        submit()
                    } else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancel()
                    }
                }}
                onBlur={() => cancel()}
            />
            {error && <span className="tree-row__inline-error" role="alert">{error}</span>}
        </span>
    )
}

export function FileTree({
    rows, rootPath, selectedPath, focusPath, canEdit = true, cutPath,
    gitStatusMap, gitDirtyDirs, inlineEdit, onCommitInlineEdit, onCancelInlineEdit,
    onFocusPath, onOpen, onToggle, onContextMenu, onRename, onDelete, onMove,
    onCopy, onCut, onPaste, onOpenFilter
}: FileTreeProps) {
    const listRef = useRef<VirtualListHandle>(null)
    const [dropTarget, setDropTarget] = useState<string | null>(null)

    const displayRows = useMemo<DisplayRow[]>(() => {
        const list: DisplayRow[] = rows.map(row => ({ kind: 'entry', row }))
        if (!inlineEdit || inlineEdit.kind === 'rename') return list
        const createKind = inlineEdit.kind === 'create-file' ? 'file' : 'folder'
        const parentNorm = normKey(inlineEdit.parentDir)
        const rootNorm = normKey(rootPath)
        if (parentNorm === rootNorm) {
            list.unshift({ kind: 'create', createKind, parentDir: inlineEdit.parentDir, depth: 0 })
            return list
        }
        const parentIdx = list.findIndex(r => r.kind === 'entry' && normKey(r.row.item.path) === parentNorm)
        if (parentIdx >= 0) {
            const parentDepth = (list[parentIdx] as { kind: 'entry'; row: TreeRow }).row.depth
            list.splice(parentIdx + 1, 0, { kind: 'create', createKind, parentDir: inlineEdit.parentDir, depth: parentDepth + 1 })
        } else {
            list.unshift({ kind: 'create', createKind, parentDir: inlineEdit.parentDir, depth: 0 })
        }
        return list
    }, [rows, inlineEdit, rootPath])

    const focusIndex = displayRows.findIndex(r => r.kind === 'entry' && samePath(r.row.item.path, focusPath))
    const createIndex = displayRows.findIndex(r => r.kind === 'create')

    useEffect(() => {
        if (createIndex >= 0) listRef.current?.scrollToIndex(createIndex)
        else if (focusIndex >= 0) listRef.current?.scrollToIndex(focusIndex)
    }, [focusIndex, createIndex])

    const onKeyDown = (e: KeyboardEvent) => {
        if (inlineEdit) return
        if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault()
            onOpenFilter?.()
            return
        }
        if (rows.length === 0) return
        const rowIndex = rows.findIndex(r => samePath(r.item.path, focusPath))
        const row = rows[rowIndex]
        const focusAt = (i: number) => onFocusPath(rows[Math.max(0, Math.min(rows.length - 1, i))].item.path)
        const mod = e.ctrlKey || e.metaKey

        if (mod && !e.altKey && !e.shiftKey) {
            const k = e.key.toLowerCase()
            if (k === 'c' && row) { e.preventDefault(); onCopy?.(row.item); return }
            if (k === 'x' && row && canEdit) { e.preventDefault(); onCut?.(row.item); return }
            if (k === 'v' && canEdit) { e.preventDefault(); onPaste?.(row?.item ?? null); return }
        }
        if (e.metaKey && e.key === 'Backspace' && row && canEdit) {
            e.preventDefault()
            onDelete(row.item)
            return
        }

        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); focusAt(rowIndex + 1); break
            case 'ArrowUp': e.preventDefault(); focusAt(rowIndex < 0 ? 0 : rowIndex - 1); break
            case 'Home': e.preventDefault(); focusAt(0); break
            case 'End': e.preventDefault(); focusAt(rows.length - 1); break
            case 'ArrowRight':
                e.preventDefault()
                if (row?.item.isDirectory && !row.expanded) onToggle(row.item.path)
                else if (row?.expanded) focusAt(rowIndex + 1)
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
            case 'F2': if (row && canEdit) { e.preventDefault(); onRename(row.item) } break
            case 'Delete': if (row && canEdit) { e.preventDefault(); onDelete(row.item) } break
        }
    }

    const dragOver = (e: DragEvent, target: string | null) => {
        if (!canEdit || !e.dataTransfer.types.includes('application/x-kalynt-path')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropTarget(target)
    }

    const drop = (e: DragEvent, targetDir: string) => {
        if (!canEdit) return
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
            onContextMenu={e => {
                // Row handlers call e.stopPropagation(); any contextmenu reaching VirtualList
                // (including clicks on its inner spacer div or empty area) targets the root folder.
                e.preventDefault()
                onContextMenu(null, e)
            }}
            onDragOver={e => dragOver(e, rootPath)}
            onDragLeave={() => setDropTarget(null)}
            onDrop={e => drop(e, rootPath)}
            items={displayRows}
            rowHeight={ROW_HEIGHT}
            renderRow={(entry, index) => {
                if (entry.kind === 'create') {
                    return (
                        <div
                            key={`__create-${entry.parentDir}`}
                            className="tree-row tree-row--editing"
                            style={{ height: ROW_HEIGHT, paddingLeft: 8 + entry.depth * INDENT }}
                            onContextMenu={e => e.stopPropagation()}
                        >
                            {Array.from({ length: entry.depth }, (_, i) => (
                                <span key={i} className="tree-row__guide" style={{ left: 14 + i * INDENT }} aria-hidden />
                            ))}
                            <span className="tree-row__twisty" aria-hidden />
                            {entry.createKind === 'folder'
                                ? <FolderGlyph open={false} size={15} className="tree-row__icon" />
                                : <FileGlyph name="file.txt" size={15} className="tree-row__icon" />}
                            <InlineRowInput
                                initialValue=""
                                placeholder={entry.createKind === 'file' ? 'file.ts or dir/file.ts' : 'folder name'}
                                validate={validateRelativePath}
                                onCommit={val => onCommitInlineEdit?.(val)}
                                onCancel={() => onCancelInlineEdit?.()}
                            />
                        </div>
                    )
                }

                const { item, depth, expanded, loading } = entry.row
                const isSelected = samePath(item.path, selectedPath)
                const isFocused = index === focusIndex
                const isRenaming = inlineEdit?.kind === 'rename' && samePath(inlineEdit.item.path, item.path)
                const isCut = !!cutPath && samePath(cutPath, item.path)
                const dim = item.name.startsWith('.') || IGNORED_LOOK.has(item.name)
                const target = item.isDirectory ? item.path : dirName(item.path)
                const itemKey = normKey(item.path)
                const gitKind = !item.isDirectory ? gitStatusMap?.get(itemKey) : undefined
                const dirDirty = item.isDirectory && !!gitDirtyDirs?.has(itemKey)

                return (
                    <div
                        key={item.path}
                        id={`tree-row-${index}`}
                        role="treeitem"
                        aria-level={depth + 1}
                        aria-expanded={item.isDirectory ? expanded : undefined}
                        aria-selected={isSelected}
                        className={[
                            'tree-row',
                            isSelected && 'is-selected',
                            isFocused && 'is-focused',
                            dim && 'is-dim',
                            isCut && 'is-cut',
                            isRenaming && 'tree-row--editing',
                            gitKind && `tree-row--git-${gitKind}`,
                            dropTarget && samePath(dropTarget, target) && 'is-drop-target'
                        ].filter(Boolean).join(' ')}
                        style={{ height: ROW_HEIGHT, paddingLeft: 8 + depth * INDENT }}
                        title={item.path}
                        draggable={canEdit && !isRenaming}
                        onDragStart={e => {
                            if (!canEdit || isRenaming) return
                            e.dataTransfer.setData('application/x-kalynt-path', item.path)
                            e.dataTransfer.setData('text/plain', item.path)
                            e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragOver={e => { e.stopPropagation(); dragOver(e, target) }}
                        onDrop={e => drop(e, target)}
                        onClick={() => {
                            if (isRenaming) return
                            onFocusPath(item.path)
                            if (item.isDirectory) onToggle(item.path)
                            else onOpen(item)
                        }}
                        onContextMenu={e => {
                            e.preventDefault()
                            e.stopPropagation()
                            onFocusPath(item.path)
                            onContextMenu(item, e)
                        }}
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
                        {isRenaming ? (
                            <InlineRowInput
                                initialValue={item.name}
                                selectStem={!item.isDirectory}
                                placeholder="New name"
                                validate={val => (val === item.name ? null : validateName(val))}
                                onCommit={val => onCommitInlineEdit?.(val)}
                                onCancel={() => onCancelInlineEdit?.()}
                            />
                        ) : (
                            <>
                                <span className="tree-row__name">{item.name}</span>
                                {gitKind && (
                                    <span className={`tree-row__git tree-row__git--${gitKind}`} aria-label={gitKind}>
                                        {GIT_LETTER[gitKind]}
                                    </span>
                                )}
                                {dirDirty && <span className="tree-row__git-dot" aria-hidden />}
                            </>
                        )}
                    </div>
                )
            }}
        />
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { ChevronDown, X } from 'lucide-react'
import type { OpenFile } from '../../../types/ide'
import { formatShortcut } from '../../../stores/commandStore'
import { IconButton, Menu, useMenuAnchor, type Anchor } from '../../ui'
import { FileGlyph } from '../explorer/fileIcons'
import { dirName, relativePath } from '../languages'

interface EditorTabsProps {
    files: OpenFile[]
    activePath: string | null
    folder: string | null
    onSelect: (path: string) => void
    onClose: (path: string) => void
    onCloseOthers: (path: string) => void
    onCloseToRight?: (path: string) => void
    onCloseSaved?: () => void
    onCloseAll: () => void
    onReorder?: (fromIndex: number, toIndex: number) => void
    onSplitWith?: (path: string) => void
    onReveal: (path: string) => void
}

export function EditorTabs({
    files, activePath, folder, onSelect, onClose, onCloseOthers, onCloseToRight, onCloseSaved, onCloseAll, onReorder, onSplitWith, onReveal
}: EditorTabsProps) {
    const stripRef = useRef<HTMLDivElement>(null)
    const [menu, setMenu] = useState<{ path: string; index: number; anchor: Anchor } | null>(null)
    const [overflowLeft, setOverflowLeft] = useState(false)
    const [overflowRight, setOverflowRight] = useState(false)
    const [dragIndex, setDragIndex] = useState<number | null>(null)
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
    const allTabsMenu = useMenuAnchor()
    const sc = formatShortcut

    // Same-named files get their parent folder as a hint.
    const hints = useMemo(() => {
        const counts = new Map<string, number>()
        files.forEach(f => counts.set(f.name, (counts.get(f.name) ?? 0) + 1))
        const result = new Map<string, string>()
        files.forEach(f => {
            if ((counts.get(f.name) ?? 0) > 1) {
                const relDir = relativePath(dirName(f.path), folder)
                result.set(f.path, relDir ? relDir.split('/').slice(-2).join('/') : '')
            }
        })
        return result
    }, [files, folder])

    const updateOverflow = useCallback(() => {
        const el = stripRef.current
        if (!el) return
        setOverflowLeft(el.scrollLeft > 2)
        setOverflowRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2)
    }, [])

    useEffect(() => {
        const active = stripRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
        active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        updateOverflow()
    }, [activePath, files.length, updateOverflow])

    // Mouse-wheel horizontal scroll + overflow edge detection.
    useEffect(() => {
        const el = stripRef.current
        if (!el) return
        updateOverflow()
        const onWheel = (e: WheelEvent) => {
            if (el.scrollWidth <= el.clientWidth) return
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                e.preventDefault()
                el.scrollLeft += e.deltaY
            }
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        el.addEventListener('scroll', updateOverflow, { passive: true })
        const ro = new ResizeObserver(updateOverflow)
        ro.observe(el)
        return () => {
            el.removeEventListener('wheel', onWheel)
            el.removeEventListener('scroll', updateOverflow)
            ro.disconnect()
        }
    }, [updateOverflow])

    if (files.length === 0) return null

    const focusAndSelect = (index: number) => {
        const target = files[index]
        if (!target) return
        onSelect(target.path)
        requestAnimationFrame(() => {
            stripRef.current?.querySelector<HTMLElement>(`[data-tab-index="${index}"]`)?.focus()
        })
    }

    const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number, path: string) => {
        if (e.key === 'ArrowRight') {
            e.preventDefault()
            focusAndSelect((index + 1) % files.length)
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault()
            focusAndSelect((index - 1 + files.length) % files.length)
        } else if (e.key === 'Home') {
            e.preventDefault()
            focusAndSelect(0)
        } else if (e.key === 'End') {
            e.preventDefault()
            focusAndSelect(files.length - 1)
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(path)
        } else if (e.key === 'Delete') {
            e.preventDefault()
            onClose(path)
        }
    }

    const handleDragStart = (e: DragEvent<HTMLDivElement>, index: number) => {
        if (!onReorder) return
        setDragIndex(index)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(index))
    }

    const handleDragOver = (e: DragEvent<HTMLDivElement>, index: number) => {
        if (dragIndex === null || !onReorder) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (dragOverIndex !== index) setDragOverIndex(index)
    }

    const handleDrop = (e: DragEvent<HTMLDivElement>, index: number) => {
        e.preventDefault()
        if (dragIndex !== null && dragIndex !== index && onReorder) {
            onReorder(dragIndex, index)
        }
        setDragIndex(null)
        setDragOverIndex(null)
    }

    const handleDragEnd = () => {
        setDragIndex(null)
        setDragOverIndex(null)
    }

    const hasSavedTabs = files.some(f => !f.isDirty)
    const showDropdown = overflowLeft || overflowRight || files.length > 4

    return (
        <div
            className={[
                'editor-tabs-wrap',
                overflowLeft && 'has-overflow-left',
                overflowRight && 'has-overflow-right'
            ].filter(Boolean).join(' ')}
        >
            <div className="editor-tabs" ref={stripRef} role="tablist" aria-label="Open files">
                {files.map((file, index) => {
                    const active = file.path === activePath
                    const hint = hints.get(file.path)
                    const classes = [
                        'editor-tab',
                        active && 'is-active',
                        file.isDirty && 'is-dirty',
                        dragIndex === index && 'is-dragging',
                        dragOverIndex === index && dragIndex !== index && 'is-drag-over'
                    ].filter(Boolean).join(' ')
                    return (
                        <div
                            key={file.path}
                            data-tab-index={index}
                            role="tab"
                            aria-selected={active}
                            tabIndex={active ? 0 : -1}
                            draggable={!!onReorder}
                            className={classes}
                            title={relativePath(file.path, folder)}
                            onClick={() => onSelect(file.path)}
                            onKeyDown={e => onTabKeyDown(e, index, file.path)}
                            onAuxClick={e => { if (e.button === 1) { e.preventDefault(); onClose(file.path) } }}
                            onContextMenu={e => { e.preventDefault(); setMenu({ path: file.path, index, anchor: { x: e.clientX, y: e.clientY } }) }}
                            onDragStart={e => handleDragStart(e, index)}
                            onDragOver={e => handleDragOver(e, index)}
                            onDrop={e => handleDrop(e, index)}
                            onDragEnd={handleDragEnd}
                        >
                            <FileGlyph name={file.name} size={14} className="editor-tab__icon" />
                            <span className="editor-tab__name">{file.name}</span>
                            {hint && <span className="editor-tab__hint">{hint}</span>}
                            <button
                                type="button"
                                className="editor-tab__close"
                                aria-label={file.isDirty ? `Close ${file.name}, unsaved changes` : `Close ${file.name}`}
                                title={file.isDirty ? 'Unsaved changes. Close' : 'Close'}
                                tabIndex={-1}
                                onClick={e => { e.stopPropagation(); onClose(file.path) }}
                            >
                                <span className="editor-tab__dot" aria-hidden />
                                <X size={13} className="editor-tab__x" aria-hidden />
                            </button>
                        </div>
                    )
                })}
            </div>

            {showDropdown && (
                <div className="editor-tabs__more">
                    <IconButton
                        size="sm"
                        label="Show all open editors"
                        icon={<ChevronDown size={14} />}
                        onClick={allTabsMenu.toggle}
                        aria-haspopup="menu"
                        aria-expanded={allTabsMenu.open}
                    />
                    <Menu
                        open={allTabsMenu.open}
                        anchor={allTabsMenu.anchor}
                        onClose={allTabsMenu.close}
                        placement="bottom-end"
                        width={260}
                        ariaLabel="Open editors"
                        items={files.map(file => ({
                            label: file.name,
                            hint: file.isDirty ? 'unsaved' : relativePath(dirName(file.path), folder) || undefined,
                            icon: <FileGlyph name={file.name} size={14} />,
                            checked: file.path === activePath,
                            onSelect: () => onSelect(file.path)
                        }))}
                    />
                </div>
            )}

            {menu && (
                <Menu
                    open
                    anchor={menu.anchor}
                    onClose={() => setMenu(null)}
                    items={[
                        { label: 'Close', shortcut: sc('Ctrl+W'), onSelect: () => onClose(menu.path) },
                        { label: 'Close others', disabled: files.length < 2, onSelect: () => onCloseOthers(menu.path) },
                        ...(onCloseToRight ? [{ label: 'Close to the right', disabled: menu.index >= files.length - 1, onSelect: () => onCloseToRight(menu.path) }] : []),
                        ...(onCloseSaved ? [{ label: 'Close saved', disabled: !hasSavedTabs, onSelect: onCloseSaved }] : []),
                        { label: 'Close all', shortcut: sc('Ctrl+Shift+W'), onSelect: onCloseAll },
                        'separator',
                        ...(onSplitWith ? [{ label: 'Open to side', shortcut: sc('Ctrl+\\'), onSelect: () => onSplitWith(menu.path) }] : []),
                        { label: 'Copy path', onSelect: () => { void navigator.clipboard.writeText(menu.path) } },
                        { label: 'Copy relative path', onSelect: () => { void navigator.clipboard.writeText(relativePath(menu.path, folder)) } },
                        { label: 'Reveal in explorer', onSelect: () => onReveal(menu.path) }
                    ]}
                />
            )}
        </div>
    )
}

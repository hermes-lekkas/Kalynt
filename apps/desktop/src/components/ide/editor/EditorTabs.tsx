/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { OpenFile } from '../../../types/ide'
import { Menu, type Anchor } from '../../ui'
import { FileGlyph } from '../explorer/fileIcons'
import { dirName, relativePath } from '../languages'

interface EditorTabsProps {
    files: OpenFile[]
    activePath: string | null
    folder: string | null
    onSelect: (path: string) => void
    onClose: (path: string) => void
    onCloseOthers: (path: string) => void
    onCloseAll: () => void
    onReveal: (path: string) => void
}

export function EditorTabs({ files, activePath, folder, onSelect, onClose, onCloseOthers, onCloseAll, onReveal }: EditorTabsProps) {
    const stripRef = useRef<HTMLDivElement>(null)
    const [menu, setMenu] = useState<{ path: string; anchor: Anchor } | null>(null)

    // Same-named files get their parent folder as a hint.
    const hints = useMemo(() => {
        const counts = new Map<string, number>()
        files.forEach(f => counts.set(f.name, (counts.get(f.name) ?? 0) + 1))
        const result = new Map<string, string>()
        files.forEach(f => {
            if ((counts.get(f.name) ?? 0) > 1) result.set(f.path, relativePath(dirName(f.path), folder).split('/').slice(-2).join('/'))
        })
        return result
    }, [files, folder])

    useEffect(() => {
        const active = stripRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
        active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }, [activePath])

    if (files.length === 0) return null

    return (
        <div className="editor-tabs" ref={stripRef} role="tablist" aria-label="Open files">
            {files.map(file => {
                const active = file.path === activePath
                return (
                    <div
                        key={file.path}
                        role="tab"
                        aria-selected={active}
                        tabIndex={active ? 0 : -1}
                        className={`editor-tab ${active ? 'is-active' : ''} ${file.isDirty ? 'is-dirty' : ''}`}
                        title={relativePath(file.path, folder)}
                        onClick={() => onSelect(file.path)}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(file.path) } }}
                        onAuxClick={e => { if (e.button === 1) { e.preventDefault(); onClose(file.path) } }}
                        onContextMenu={e => { e.preventDefault(); setMenu({ path: file.path, anchor: { x: e.clientX, y: e.clientY } }) }}
                    >
                        <FileGlyph name={file.name} size={14} className="editor-tab__icon" />
                        <span className="editor-tab__name">{file.name}</span>
                        {hints.get(file.path) && <span className="editor-tab__hint">{hints.get(file.path)}</span>}
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
            {menu && (
                <Menu
                    open
                    anchor={menu.anchor}
                    onClose={() => setMenu(null)}
                    items={[
                        { label: 'Close', shortcut: 'Ctrl+W', onSelect: () => onClose(menu.path) },
                        { label: 'Close others', disabled: files.length < 2, onSelect: () => onCloseOthers(menu.path) },
                        { label: 'Close all', shortcut: 'Ctrl+Shift+W', onSelect: onCloseAll },
                        'separator',
                        { label: 'Copy path', onSelect: () => navigator.clipboard.writeText(menu.path) },
                        { label: 'Copy relative path', onSelect: () => navigator.clipboard.writeText(relativePath(menu.path, folder)) },
                        { label: 'Reveal in explorer', onSelect: () => onReveal(menu.path) }
                    ]}
                />
            )}
        </div>
    )
}

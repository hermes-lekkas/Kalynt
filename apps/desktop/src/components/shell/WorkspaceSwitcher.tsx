/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, LayoutGrid, LogIn, Plus } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useUiStore } from '../../stores/uiStore'
import { useWorkspaceFolderStore, folderName } from '../../stores/workspaceFolderStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { Popover, SearchInput, promptText } from '../ui'

export function WorkspaceSwitcher() {
    const { spaces, currentSpace, setCurrentSpace, createSpace } = useAppStore()
    const records = useWorkspaceFolderStore(s => s.records)
    const openCollaboration = useUiStore(s => s.openCollaboration)
    const addNotification = useNotificationStore(s => s.addNotification)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        const sorted = [...spaces].sort((a, b) => (records[b.id]?.lastOpened ?? b.createdAt) - (records[a.id]?.lastOpened ?? a.createdAt))
        return q ? sorted.filter(s => s.name.toLowerCase().includes(q)) : sorted
    }, [spaces, records, query])

    if (!currentSpace) return null
    const currentFolder = folderName(records[currentSpace.id]?.folder)

    const close = () => { setOpen(false); setQuery('') }

    const createNew = async () => {
        close()
        const name = await promptText({ title: 'New workspace', label: 'Workspace name', placeholder: 'e.g. Payments API', confirmLabel: 'Create workspace' })
        if (!name) return
        setCurrentSpace(createSpace(name))
        addNotification(`Created ${name}`, 'success')
    }

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                className={`ws-switcher no-drag ${open ? 'is-open' : ''}`}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen(o => !o)}
                title="Switch workspace"
            >
                <span className="ws-switcher__name truncate">{currentSpace.name}</span>
                {currentFolder && <span className="ws-switcher__folder truncate">{currentFolder}</span>}
                <ChevronDown size={14} aria-hidden />
            </button>

            <Popover open={open} onClose={close} anchor={triggerRef.current} width={300} ariaLabel="Switch workspace">
                <div className="ws-menu">
                    {spaces.length > 6 && (
                        <div className="ws-menu__search">
                            <SearchInput size="sm" value={query} onChange={setQuery} placeholder="Find a workspace" autoFocus />
                        </div>
                    )}
                    <ul className="ws-menu__list" role="listbox" aria-label="Workspaces">
                        {filtered.map(space => {
                            const active = space.id === currentSpace.id
                            const folder = folderName(records[space.id]?.folder)
                            return (
                                <li key={space.id} role="option" aria-selected={active}>
                                    <button
                                        type="button"
                                        className={`ws-menu__item ${active ? 'is-active' : ''}`}
                                        onClick={() => { close(); setCurrentSpace(space) }}
                                    >
                                        <span className="ws-menu__item-text">
                                            <span className="truncate">{space.name}</span>
                                            <span className="ws-menu__item-folder truncate">{folder || 'No folder yet'}</span>
                                        </span>
                                        {active && <Check size={14} aria-hidden />}
                                    </button>
                                </li>
                            )
                        })}
                        {filtered.length === 0 && <li className="ws-menu__empty">No workspace matches “{query}”.</li>}
                    </ul>
                    <div className="ws-menu__actions">
                        <button type="button" className="ws-menu__action" onClick={createNew}>
                            <Plus size={14} /> New workspace
                        </button>
                        <button type="button" className="ws-menu__action" onClick={() => { close(); openCollaboration('join') }}>
                            <LogIn size={14} /> Join a session
                        </button>
                        <button type="button" className="ws-menu__action" onClick={() => { close(); setCurrentSpace(null) }}>
                            <LayoutGrid size={14} /> All workspaces
                        </button>
                    </div>
                </div>
            </Popover>
        </>
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState, type MouseEvent } from 'react'
import { FolderInput, FolderOpen, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useAppStore, type Space } from '../../stores/appStore'
import { useWorkspaceFolderStore } from '../../stores/workspaceFolderStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { EmptyState, IconButton, Menu, confirmAction, promptText, type Anchor } from '../ui'
import { openWorkspace, pickFolder, relativeTime } from './workspaceActions'

interface WorkspaceListProps {
    spaces: Space[]
    query: string
}

export function WorkspaceList({ spaces, query }: WorkspaceListProps) {
    const records = useWorkspaceFolderStore(s => s.records)
    const [menu, setMenu] = useState<{ space: Space; anchor: Anchor } | null>(null)

    if (spaces.length === 0) {
        return <EmptyState compact title="No matches" description={`No workspace name or folder contains “${query}”.`} />
    }

    const openMenu = (e: MouseEvent<HTMLElement>, space: Space) => {
        e.stopPropagation()
        setMenu({ space, anchor: e.currentTarget })
    }

    return (
        <>
            <ul className="ws-list" aria-label="Workspaces">
                {spaces.map(space => {
                    const record = records[space.id]
                    return (
                        <li key={space.id} className="ws-list__row" onContextMenu={e => { e.preventDefault(); setMenu({ space, anchor: { x: e.clientX, y: e.clientY } }) }}>
                            <button type="button" className="ws-list__open" onClick={() => openWorkspace(space)}>
                                <span className="ws-list__name truncate">{space.name}</span>
                                <span className={`ws-list__folder truncate ${record?.folder ? 'mono' : ''}`} title={record?.folder ?? undefined}>
                                    {record?.folder ?? 'No folder yet'}
                                </span>
                                <span className="ws-list__when">{relativeTime(record?.lastOpened || 0)}</span>
                            </button>
                            <IconButton
                                className="ws-list__more"
                                label={`More actions for ${space.name}`}
                                icon={<MoreHorizontal size={16} />}
                                onClick={e => openMenu(e, space)}
                            />
                        </li>
                    )
                })}
            </ul>
            {menu && <WorkspaceMenu space={menu.space} anchor={menu.anchor} onClose={() => setMenu(null)} />}
        </>
    )
}

function WorkspaceMenu({ space, anchor, onClose }: { space: Space; anchor: Anchor; onClose: () => void }) {
    const { renameSpace, deleteSpace } = useAppStore()
    const { records, setFolder, forget } = useWorkspaceFolderStore()
    const addNotification = useNotificationStore(s => s.addNotification)
    const folder = records[space.id]?.folder ?? null

    return (
        <Menu
            open
            anchor={anchor}
            onClose={onClose}
            ariaLabel={`${space.name} actions`}
            items={[
                { label: 'Open', icon: <FolderOpen size={14} />, onSelect: () => openWorkspace(space) },
                {
                    label: 'Rename…', icon: <Pencil size={14} />, onSelect: async () => {
                        const name = await promptText({ title: 'Rename workspace', label: 'Name', initialValue: space.name, confirmLabel: 'Rename' })
                        if (name) renameSpace(space.id, name)
                    }
                },
                {
                    label: folder ? 'Change folder…' : 'Choose folder…', icon: <FolderInput size={14} />, onSelect: async () => {
                        const picked = await pickFolder()
                        if (picked) setFolder(space.id, picked)
                    }
                },
                ...(folder ? [{ label: 'Show folder in file manager', onSelect: () => window.electronAPI?.shell?.showItemInFolder?.(folder) }] : []),
                'separator',
                {
                    label: 'Remove from Kalynt…', icon: <Trash2 size={14} />, danger: true, onSelect: async () => {
                        const ok = await confirmAction({
                            title: `Remove ${space.name}?`,
                            message: 'Kalynt forgets this workspace, its open tabs and its place in the list. Files in the folder stay on disk.',
                            confirmLabel: 'Remove workspace',
                            danger: true
                        })
                        if (!ok) return
                        deleteSpace(space.id)
                        forget(space.id)
                        addNotification(`Removed ${space.name}`, 'info')
                    }
                }
            ]}
        />
    )
}

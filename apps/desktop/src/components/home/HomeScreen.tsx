/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useMemo, useState } from 'react'
import { FolderOpen, GitBranch, LogIn, Plus } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useUiStore } from '../../stores/uiStore'
import { useWorkspaceFolderStore } from '../../stores/workspaceFolderStore'
import { Button, SearchInput } from '../ui'
import { WorkspaceList } from './WorkspaceList'
import { MachineSummary } from './MachineSummary'
import { NewWorkspaceDialog } from './NewWorkspaceDialog'
import { CloneDialog } from './CloneDialog'
import { openFolderAsWorkspace } from './workspaceActions'
import './home.css'

export function HomeScreen() {
    const spaces = useAppStore(s => s.spaces)
    const records = useWorkspaceFolderStore(s => s.records)
    const openCollaboration = useUiStore(s => s.openCollaboration)
    const [query, setQuery] = useState('')
    const [dialog, setDialog] = useState<'new' | 'clone' | null>(null)

    const sorted = useMemo(() => {
        const q = query.trim().toLowerCase()
        const list = [...spaces].sort((a, b) =>
            (records[b.id]?.lastOpened || b.createdAt) - (records[a.id]?.lastOpened || a.createdAt))
        return q ? list.filter(s => s.name.toLowerCase().includes(q) || records[s.id]?.folder?.toLowerCase().includes(q)) : list
    }, [spaces, records, query])

    const actions = (
        <div className="home__actions">
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setDialog('new')}>New workspace</Button>
            <Button icon={<FolderOpen size={15} />} onClick={() => openFolderAsWorkspace()}>Open folder</Button>
            <Button icon={<GitBranch size={15} />} onClick={() => setDialog('clone')}>Clone repository</Button>
            <Button icon={<LogIn size={15} />} onClick={() => openCollaboration('join')}>Join a session</Button>
        </div>
    )

    return (
        <div className="home">
            <div className="home__inner">
                <header className="home__header">
                    <h1 className="home__title">{spaces.length === 0 ? 'Start your first workspace' : 'Workspaces'}</h1>
                    <p className="home__lede">
                        A workspace is a folder on this machine together with its agent conversations, tasks and history.
                        Share it with a link to edit together, peer to peer, without a server in between.
                    </p>
                    {actions}
                </header>

                {spaces.length > 0 && (
                    <section className="home__section" aria-labelledby="home-recent">
                        <div className="home__section-head">
                            <h2 id="home-recent">Recent</h2>
                            {spaces.length > 4 && (
                                <div className="home__search">
                                    <SearchInput size="sm" value={query} onChange={setQuery} placeholder="Filter by name or folder" aria-label="Filter workspaces" />
                                </div>
                            )}
                        </div>
                        <WorkspaceList spaces={sorted} query={query} />
                    </section>
                )}

                <section className="home__section" aria-labelledby="home-machine">
                    <div className="home__section-head">
                        <h2 id="home-machine">On this machine</h2>
                    </div>
                    <MachineSummary />
                </section>
            </div>

            <NewWorkspaceDialog open={dialog === 'new'} onClose={() => setDialog(null)} />
            <CloneDialog open={dialog === 'clone'} onClose={() => setDialog(null)} />
        </div>
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Right-hand panel: the coding agent (chat and workspace review) and the
 * team chat. A thin violet-to-magenta wire runs along its top edge while the
 * agent is working; it is the only ambient motion in the app.
 */
import { useEffect, useState } from 'react'
import { MessageSquarePlus, Users } from 'lucide-react'
import type { Space } from '../../stores/appStore'
import type { FileItem } from '../../types/ide'
import { useLayoutStore } from '../../stores/layoutStore'
import { useAgentStatusStore } from '../../stores/agentStatusStore'
import { useUiStore } from '../../stores/uiStore'
import { IconButton, RegionBoundary, Tabs } from '../ui'
import { TAG_CLICK_EVENT } from './chat/Markdown'
import { AGENT_EVENTS } from '../ide/hooks/useIdeCommands'
import { AGENT_MENTION_EVENT } from '../ide/explorer/FileExplorer'
import { useModelChoice } from './chat/useModelChoice'
import { sessionLabel, useAgentChat } from './chat/useAgentChat'
import { AgentChat } from './chat/AgentChat'
import { ChatHistory } from './chat/ChatHistory'
import { WorkspaceReview } from './review/WorkspaceReview'
import { useTeamChat } from './team/useTeamChat'
import { TeamChat } from './team/TeamChat'
import './agent.css'

interface AgentPanelProps {
    space: Space
    folder: string | null
    files: FileItem[]
    canUseAgent: boolean
    visible: boolean
}

export function AgentPanel({ space, folder, files, canUseAgent, visible }: AgentPanelProps) {
    const rightTab = useLayoutStore(s => s.rightTab)
    const setRightTab = useLayoutStore(s => s.setRightTab)
    const activity = useAgentStatusStore(s => s.activity)
    const openCollaboration = useUiStore(s => s.openCollaboration)
    const [agentView, setAgentView] = useState<'chat' | 'review'>('chat')
    const model = useModelChoice()
    const chat = useAgentChat(space.id, folder, model)
    const team = useTeamChat(space.id, visible && rightTab === 'team')

    // File mentions in either chat open the file (or the shared-files view).
    useEffect(() => {
        const onTag = (e: Event) => {
            const { type, path } = (e as CustomEvent<{ type: string; path: string }>).detail
            if (type === 'local') window.dispatchEvent(new CustomEvent('kalynt-open-file', { detail: { path } }))
            else if (type === 'p2p') useLayoutStore.getState().setMainView('files')
        }
        // Anything aimed at the agent chat brings it into view first.
        const toChat = () => { useLayoutStore.getState().showRightTab('agent'); setAgentView('chat') }
        const chatEvents = [AGENT_EVENTS.focus, AGENT_EVENTS.newChat, AGENT_MENTION_EVENT]
        window.addEventListener(TAG_CLICK_EVENT, onTag)
        chatEvents.forEach(name => window.addEventListener(name, toChat))
        return () => {
            window.removeEventListener(TAG_CLICK_EVENT, onTag)
            chatEvents.forEach(name => window.removeEventListener(name, toChat))
        }
    }, [])

    const working = activity !== 'idle'

    return (
        <div className="agent-panel">
            <header className="agent-panel__head">
                <Tabs
                    ariaLabel="Agent and team"
                    value={rightTab}
                    onChange={setRightTab}
                    items={[
                        { id: 'agent', label: 'Agent' },
                        { id: 'team', label: 'Team', badge: team.unread > 0 ? team.unread : undefined }
                    ]}
                />
                <div className="agent-panel__actions">
                    {rightTab === 'agent' ? (
                        <>
                            <ChatHistory chat={chat} />
                            <IconButton size="sm" label="New conversation" icon={<MessageSquarePlus size={14} />} onClick={chat.newChat} disabled={chat.running} />
                        </>
                    ) : (
                        <IconButton size="sm" label="Members and invites" icon={<Users size={14} />} onClick={() => openCollaboration('members')} />
                    )}
                </div>
                <span className={`agent-wire ${working ? 'is-live' : ''}`} aria-hidden />
            </header>

            {rightTab === 'agent' && (
                <div className="agent-panel__sub">
                    <Tabs
                        variant="segmented"
                        size="sm"
                        ariaLabel="Agent mode"
                        value={agentView}
                        onChange={setAgentView}
                        items={[{ id: 'chat', label: 'Chat' }, { id: 'review', label: 'Review code' }]}
                    />
                    {agentView === 'chat' && chat.session && <span className="agent-panel__title truncate" title={sessionLabel(chat.session.title)}>{sessionLabel(chat.session.title)}</span>}
                </div>
            )}

            <div className="agent-panel__body">
                <div className="agent-panel__view" hidden={rightTab !== 'agent' || agentView !== 'chat'}>
                    <RegionBoundary name="Agent chat">
                        <AgentChat chat={chat} model={model} files={files} folder={folder} canUseAgent={canUseAgent} />
                    </RegionBoundary>
                </div>
                <div className="agent-panel__view" hidden={rightTab !== 'agent' || agentView !== 'review'}>
                    <RegionBoundary name="Code review">
                        <WorkspaceReview folder={folder} model={model} />
                    </RegionBoundary>
                </div>
                <div className="agent-panel__view" hidden={rightTab !== 'team'}>
                    <RegionBoundary name="Team chat">
                        <TeamChat team={team} files={files} folder={folder} />
                    </RegionBoundary>
                </div>
            </div>
        </div>
    )
}

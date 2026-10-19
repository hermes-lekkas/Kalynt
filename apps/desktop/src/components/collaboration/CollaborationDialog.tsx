/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect } from 'react'
import { Activity, LogIn, UserPlus, Users } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useUiStore } from '../../stores/uiStore'
import { Badge, Dialog, EmptyState, RegionBoundary } from '../ui'
import { useCollaboration } from './hooks/useCollaboration'
import type { CollaborationTab } from './types'
import MemberList from './MemberList'
import MemberDetail from './MemberDetail'
import InviteSection from './InviteSection'
import JoinSection from './JoinSection'
import ActivityFeed from './ActivityFeed'
import './collaboration.css'

const TABS: Array<{ id: CollaborationTab; label: string; Icon: typeof Users; needsWorkspace: boolean }> = [
    { id: 'members', label: 'Members', Icon: Users, needsWorkspace: true },
    { id: 'invite', label: 'Invite', Icon: UserPlus, needsWorkspace: true },
    { id: 'join', label: 'Join a session', Icon: LogIn, needsWorkspace: false },
    { id: 'activity', label: 'Activity', Icon: Activity, needsWorkspace: true }
]

export default function CollaborationDialog() {
    const currentSpace = useAppStore(s => s.currentSpace)
    const { collaborationTab, closeCollaboration } = useUiStore()
    const collab = useCollaboration(currentSpace?.id)
    const tabs = TABS.filter(t => !t.needsWorkspace || currentSpace)

    // Open on the tab that was asked for.
    useEffect(() => {
        const wanted = tabs.some(t => t.id === collaborationTab) ? collaborationTab : 'join'
        collab.setActiveTab(wanted)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [collaborationTab])

    const tab = tabs.some(t => t.id === collab.activeTab) ? collab.activeTab : tabs[0].id
    const status = collab.connectionStatus

    const openSecurity = () => {
        closeCollaboration()
        const app = useAppStore.getState()
        app.setSettingsTab('security')
        app.setShowSettings(true)
    }

    return (
        <Dialog
            open
            size="xl"
            bare
            title={currentSpace ? `People in ${currentSpace.name}` : 'Join a session'}
            onClose={closeCollaboration}
            headerActions={currentSpace ? (
                <Badge tone={status.status === 'connected' && status.peerCount > 0 ? 'success' : status.status === 'connecting' ? 'warning' : 'neutral'}>
                    {status.status === 'connected'
                        ? status.peerCount > 0 ? `${status.peerCount} connected${status.latencyMs > 0 ? `, ${status.latencyMs} ms` : ''}` : 'Only you'
                        : status.status === 'connecting' ? 'Connecting' : 'Offline'}
                </Badge>
            ) : undefined}
        >
            <div className="collab">
                {tabs.length > 1 && (
                    <nav className="collab__nav" aria-label="People">
                        {tabs.map(({ id, label, Icon }) => (
                            <button
                                key={id}
                                type="button"
                                className={`collab__nav-item ${tab === id ? 'is-active' : ''}`}
                                aria-current={tab === id ? 'page' : undefined}
                                onClick={() => { collab.setActiveTab(id); collab.setSelectedMemberId(null) }}
                            >
                                <Icon size={15} aria-hidden />
                                {label}
                                {id === 'activity' && collab.activities.length > 0 && <span className="collab__count">{collab.activities.length}</span>}
                            </button>
                        ))}
                    </nav>
                )}
                <div className="collab__content">
                    <RegionBoundary name="Collaboration" key={tab}>
                        {tab === 'members' && (
                            <div className="collab-members">
                                <MemberList
                                    members={collab.filteredMembers}
                                    selectedMemberId={collab.selectedMemberId}
                                    currentUserId={collab.currentUserId}
                                    searchQuery={collab.searchQuery}
                                    showOffline={collab.showOfflineMembers}
                                    onSelectMember={id => collab.setSelectedMemberId(id === collab.selectedMemberId ? null : id)}
                                    onSearchChange={collab.setSearchQuery}
                                    onToggleOffline={() => collab.setShowOfflineMembers(!collab.showOfflineMembers)}
                                />
                                <div className="collab-members__detail">
                                    {collab.selectedMember ? (
                                        <MemberDetail
                                            member={collab.selectedMember}
                                            currentUserRole={collab.myRole}
                                            isCurrentUser={collab.selectedMember.userId === collab.currentUserId}
                                            onRoleChange={role => collab.handleRoleChange(collab.selectedMember!.userId, role)}
                                            onPermissionChange={perms => collab.handlePermissionChange(collab.selectedMember!.userId, perms)}
                                            onKick={() => collab.handleKick(collab.selectedMember!.userId)}
                                            onBan={reason => collab.handleBan(collab.selectedMember!.userId, reason)}
                                            onUnban={collab.selectedMember.isBanned ? () => collab.handleUnban(collab.selectedMember!.userId) : undefined}
                                        />
                                    ) : (
                                        <EmptyState icon={<Users size={26} />} title="Choose a member" description="See their role and permissions, or remove their access." />
                                    )}
                                </div>
                            </div>
                        )}
                        {tab === 'invite' && currentSpace && (
                            <InviteSection spaceId={currentSpace.id} onGenerateLink={collab.generateInviteLink} onOpenSecurity={openSecurity} />
                        )}
                        {tab === 'join' && (
                            <JoinSection onJoin={collab.handleJoin} isJoining={collab.isJoining} error={collab.joinError} onJoined={closeCollaboration} />
                        )}
                        {tab === 'activity' && (
                            <ActivityFeed activities={collab.activities} members={collab.members} onClear={collab.clearActivities} />
                        )}
                    </RegionBoundary>
                </div>
            </div>
        </Dialog>
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { WorkspaceMember } from '../../types/permissions'
import { Avatar, Checkbox, SearchInput } from '../ui'

interface MemberListProps {
    members: WorkspaceMember[]
    bannedMembers?: WorkspaceMember[]
    selectedMemberId: string | null
    currentUserId: string
    searchQuery: string
    showOffline: boolean
    onSelectMember: (memberId: string) => void
    onSearchChange: (query: string) => void
    onToggleOffline: () => void
}

const ROLE_ORDER = { owner: 0, admin: 1, member: 2, viewer: 3 } as const

export default function MemberList({
    members, bannedMembers = [], selectedMemberId, currentUserId, searchQuery, showOffline, onSelectMember, onSearchChange, onToggleOffline
}: MemberListProps) {
    const sorted = [...members].sort((a, b) =>
        Number(b.isOnline) - Number(a.isOnline) || ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.displayName.localeCompare(b.displayName))

    const hasAny = sorted.length > 0 || bannedMembers.length > 0

    return (
        <div className="member-list">
            <div className="member-list__tools">
                <SearchInput size="sm" value={searchQuery} onChange={onSearchChange} placeholder="Find a member" aria-label="Find a member" />
                <Checkbox checked={!showOffline} onChange={() => onToggleOffline()} label="Online only" />
            </div>
            <div className="member-list__scroll">
                <ul className="member-list__items" aria-label="Members">
                    {sorted.map(member => (
                        <li key={member.userId}>
                            <button
                                type="button"
                                className={`member-item ${selectedMemberId === member.userId ? 'is-selected' : ''} ${member.isBanned ? 'is-banned' : ''}`}
                                aria-current={selectedMemberId === member.userId ? 'true' : undefined}
                                onClick={() => onSelectMember(member.userId)}
                            >
                                <Avatar name={member.displayName} size={28} online={member.isOnline} />
                                <span className="member-item__text">
                                    <span className="member-item__name truncate">
                                        {member.displayName}{member.userId === currentUserId && <span className="member-item__you"> (you)</span>}
                                    </span>
                                    <span className="member-item__role">{member.isBanned ? 'Banned' : member.role}{member.isOnline ? ', online' : ''}</span>
                                </span>
                            </button>
                        </li>
                    ))}
                    {!hasAny && (
                        <li className="member-list__empty">{searchQuery ? `Nobody matches “${searchQuery}”.` : 'Nobody here yet. Invite people to collaborate.'}</li>
                    )}
                </ul>

                {bannedMembers.length > 0 && (
                    <div className="member-list__section">
                        <div className="member-list__heading">Banned ({bannedMembers.length})</div>
                        <ul className="member-list__items" aria-label="Banned members">
                            {bannedMembers.map(member => (
                                <li key={member.userId}>
                                    <button
                                        type="button"
                                        className={`member-item is-banned ${selectedMemberId === member.userId ? 'is-selected' : ''}`}
                                        aria-current={selectedMemberId === member.userId ? 'true' : undefined}
                                        onClick={() => onSelectMember(member.userId)}
                                    >
                                        <Avatar name={member.displayName} size={28} online={false} />
                                        <span className="member-item__text">
                                            <span className="member-item__name truncate">{member.displayName}</span>
                                            <span className="member-item__role truncate">
                                                Banned{member.bannedAt ? ` · ${new Date(member.bannedAt).toLocaleDateString()}` : ''}{member.banReason ? ` · ${member.banReason}` : ''}
                                            </span>
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </div>
    )
}

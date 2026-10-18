/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState } from 'react'
import { Ban, LogOut, Unlock } from 'lucide-react'
import type { MemberPermissions, WorkspaceMember, WorkspaceRole } from '../../types/permissions'
import { canBan, canKick, canManageRole } from '../../types/permissions'
import { Avatar, Badge, Button, Field, Switch, Tabs, TextInput, confirmAction } from '../ui'

interface MemberDetailProps {
    member: WorkspaceMember
    currentUserRole: WorkspaceRole
    isCurrentUser: boolean
    onRoleChange: (role: WorkspaceRole) => void
    onPermissionChange: (permissions: Partial<MemberPermissions>) => void
    onKick: () => void
    onBan: (reason?: string) => void
    onUnban?: () => void
}

const ROLES: Array<{ id: Exclude<WorkspaceRole, 'owner'>; label: string; text: string }> = [
    { id: 'admin', label: 'Admin', text: 'Manages members and settings' },
    { id: 'member', label: 'Member', text: 'Edits, chats and uses the agent' },
    { id: 'viewer', label: 'Viewer', text: 'Reads and chats' }
]

const PERMISSIONS: Array<{ key: keyof Omit<MemberPermissions, 'restrictedPaths'>; label: string }> = [
    { key: 'canEdit', label: 'Edit files' },
    { key: 'canUseAgent', label: 'Use the agent' },
    { key: 'canChat', label: 'Send team messages' },
    { key: 'canManageTasks', label: 'Manage tasks' },
    { key: 'canManageFiles', label: 'Share and remove files' }
]

export default function MemberDetail({
    member, currentUserRole, isCurrentUser, onRoleChange, onPermissionChange, onKick, onBan, onUnban
}: MemberDetailProps) {
    const [banReason, setBanReason] = useState('')
    const canManage = canManageRole(currentUserRole, member.role) && !isCurrentUser
    const kickable = canKick(currentUserRole, member.role) && !isCurrentUser
    const bannable = canBan(currentUserRole, member.role) && !isCurrentUser

    const kick = async () => {
        const ok = await confirmAction({
            title: `Remove ${member.displayName}?`,
            message: 'They are disconnected now and can rejoin with an invite.',
            confirmLabel: 'Remove',
            danger: true
        })
        if (ok) onKick()
    }

    const ban = async () => {
        const ok = await confirmAction({
            title: `Ban ${member.displayName}?`,
            message: 'They are disconnected and can’t rejoin until an owner or admin lifts the ban.',
            confirmLabel: 'Ban',
            danger: true
        })
        if (ok) { onBan(banReason.trim() || undefined); setBanReason('') }
    }

    return (
        <div className="member-detail">
            <header className="member-detail__head">
                <Avatar name={member.displayName} size={44} online={member.isOnline} />
                <div className="member-detail__titles">
                    <h3>{member.displayName}{isCurrentUser && <span className="member-detail__you"> (you)</span>}</h3>
                    <p>Joined {new Date(member.joinedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}{member.isOnline ? ', online now' : ''}</p>
                </div>
                <Badge tone={member.isBanned ? 'danger' : 'neutral'}>
                    {member.isBanned ? 'Banned' : member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                </Badge>
            </header>

            {member.isBanned ? (
                <section className="member-detail__section">
                    <p className="member-detail__note">
                        Banned{member.bannedAt ? ` on ${new Date(member.bannedAt).toLocaleDateString()}` : ''}{member.banReason ? `: ${member.banReason}` : '.'}
                    </p>
                    {onUnban && bannable && <Button icon={<Unlock size={14} />} onClick={onUnban}>Lift ban</Button>}
                </section>
            ) : (
                <>
                    <section className="member-detail__section">
                        <h4>Role</h4>
                        {member.role === 'owner' ? (
                            <p className="member-detail__note">Owners have full control. Ownership can’t be changed here.</p>
                        ) : canManage ? (
                            <Tabs
                                variant="segmented"
                                ariaLabel="Role"
                                value={member.role as Exclude<WorkspaceRole, 'owner'>}
                                onChange={role => onRoleChange(role)}
                                items={ROLES.map(r => ({ id: r.id, label: r.label }))}
                            />
                        ) : (
                            <p className="member-detail__note">{ROLES.find(r => r.id === member.role)?.text}. Only owners and admins can change roles.</p>
                        )}
                    </section>

                    <section className="member-detail__section">
                        <h4>Permissions</h4>
                        <ul className="member-detail__perms">
                            {PERMISSIONS.map(p => (
                                <li key={p.key}>
                                    <span>{p.label}</span>
                                    <Switch label={p.label} checked={member.permissions[p.key]} disabled={!canManage} onChange={v => onPermissionChange({ [p.key]: v })} />
                                </li>
                            ))}
                        </ul>
                    </section>

                    {(kickable || bannable) && (
                        <section className="member-detail__section member-detail__danger">
                            <h4>Remove access</h4>
                            <div className="member-detail__actions">
                                {kickable && <Button variant="secondary" icon={<LogOut size={14} />} onClick={kick}>Remove from workspace</Button>}
                            </div>
                            {bannable && (
                                <Field label="Ban with an optional reason">
                                    {id => (
                                        <div className="member-detail__ban">
                                            <TextInput id={id} value={banReason} placeholder="Reason, shown to admins" onChange={e => setBanReason(e.target.value)} />
                                            <Button variant="danger" icon={<Ban size={14} />} onClick={ban}>Ban</Button>
                                        </div>
                                    )}
                                </Field>
                            )}
                        </section>
                    )}
                </>
            )}
        </div>
    )
}

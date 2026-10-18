/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useAppStore } from '../../stores/appStore'
import { useMemberStore } from '../../stores/memberStore'
import { useUiStore } from '../../stores/uiStore'
import { Avatar, Badge, Button } from '../ui'
import { SettingRow, SettingsPage, SettingsSection } from './parts'

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' }

const ROLE_TEXT: Record<string, string> = {
    owner: 'Owner. You control members, roles and settings.',
    admin: 'Admin. You can manage members and settings.',
    member: 'Member. You can edit, chat and use the agent.',
    viewer: 'Viewer. You can read and chat.'
}

export function MembersSettings({ onClose }: { onClose: () => void }) {
    const currentSpace = useAppStore(s => s.currentSpace)
    const { getMembers, getMyRole } = useMemberStore()
    const openCollaboration = useUiStore(s => s.openCollaboration)
    if (!currentSpace) return null

    const members = getMembers(currentSpace.id)
    const role = getMyRole(currentSpace.id)
    const online = members.filter(m => m.isOnline && !m.isBanned)

    const open = (tab: 'members' | 'invite') => {
        onClose()
        openCollaboration(tab)
    }

    return (
        <SettingsPage title="Members" description={`People with access to ${currentSpace.name}.`}>
            <SettingsSection title="Your access">
                <SettingRow label="Role" description={ROLE_TEXT[role] ?? role} control={<Badge>{ROLE_LABEL[role] ?? role}</Badge>} />
            </SettingsSection>
            <SettingsSection
                title={`${members.length} ${members.length === 1 ? 'member' : 'members'}`}
                description={online.length ? `${online.length} online now.` : 'Nobody else is online right now.'}
                actions={<>
                    <Button size="sm" onClick={() => open('invite')}>Invite people</Button>
                    <Button size="sm" variant="primary" onClick={() => open('members')}>Manage members</Button>
                </>}
            >
                <ul className="member-mini">
                    {members.slice(0, 8).map(m => (
                        <li key={m.userId}>
                            <Avatar name={m.displayName} size={24} online={m.isOnline} />
                            <span className="member-mini__name">{m.displayName}</span>
                            <span className="member-mini__role">{m.isBanned ? 'Banned' : ROLE_LABEL[m.role] ?? m.role}</span>
                        </li>
                    ))}
                    {members.length > 8 && <li className="member-mini__more">and {members.length - 8} more</li>}
                </ul>
            </SettingsSection>
        </SettingsPage>
    )
}

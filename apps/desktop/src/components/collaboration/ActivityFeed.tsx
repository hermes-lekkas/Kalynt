/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Ban, CheckSquare, FileEdit, LogOut, MessageSquare, Shield, UserMinus, UserPlus } from 'lucide-react'
import type { ActivityItem } from './types'
import type { WorkspaceMember } from '../../types/permissions'
import { Button, EmptyState } from '../ui'

type ActivityType = ActivityItem['type']

const ICONS: Record<ActivityType, typeof UserPlus> = {
    join: UserPlus, leave: UserMinus, chat: MessageSquare, edit: FileEdit, file: FileEdit,
    task: CheckSquare, permission: Shield, ban: Ban, kick: LogOut
}

const VERB: Record<ActivityType, string> = {
    join: 'joined', leave: 'left', chat: 'sent a message', edit: 'edited', file: 'shared a file',
    task: 'updated a task', permission: 'changed permissions', ban: 'was banned', kick: 'was removed'
}

function when(ts: number): string {
    const diff = Date.now() - ts
    if (diff < 60_000) return 'Just now'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

interface ActivityFeedProps {
    activities: ActivityItem[]
    members: WorkspaceMember[]
    onClear: () => void
}

export default function ActivityFeed({ activities, members, onClear }: ActivityFeedProps) {
    const nameOf = (a: ActivityItem) => a.userName || members.find(m => m.userId === a.userId)?.displayName || 'Someone'

    if (activities.length === 0) {
        return <EmptyState title="No activity yet" description="Joins, departures, and changes to members appear here while this window is open." />
    }

    return (
        <div className="collab-pane">
            <header className="collab-pane__head collab-pane__head--row">
                <h3>Recent activity</h3>
                <Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>
            </header>
            <ol className="activity">
                {activities.slice(0, 100).map(a => {
                    const Icon = ICONS[a.type] ?? Shield
                    return (
                        <li key={a.id} className={`activity__item activity__item--${a.type}`}>
                            <Icon size={14} className="activity__icon" aria-hidden />
                            <p className="activity__text">
                                <strong>{nameOf(a)}</strong> {VERB[a.type] ?? a.type}{a.details ? `: ${a.details}` : ''}
                            </p>
                            <time className="activity__time">{when(a.timestamp)}</time>
                        </li>
                    )
                })}
            </ol>
        </div>
    )
}

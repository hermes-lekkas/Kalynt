/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useMemo } from 'react'
import { Users } from 'lucide-react'
import { useYDoc, useAwareness } from '../../hooks/useYjs'
import { useUiStore } from '../../stores/uiStore'
import { Avatar } from '../ui'

interface PeerState {
    user?: { id?: string; name?: string }
}

const MAX_FACES = 3

/** People connected to this workspace right now; opens the team dialog. */
export function PeersIndicator({ spaceId }: { spaceId: string }) {
    const { provider } = useYDoc(spaceId)
    const { users, localClientId } = useAwareness(provider)
    const openCollaboration = useUiStore(s => s.openCollaboration)

    const peers = useMemo(() => {
        const seen = new Map<string, string>()
        users.forEach((state: PeerState, clientId: number) => {
            if (clientId === localClientId) return
            const name = state.user?.name || 'Guest'
            seen.set(state.user?.id || `${name}-${clientId}`, name)
        })
        return Array.from(seen.entries()).map(([id, name]) => ({ id, name }))
    }, [users, localClientId])

    const label = peers.length === 0
        ? 'No one else is connected. Invite people'
        : `${peers.length} ${peers.length === 1 ? 'person' : 'people'} connected: ${peers.map(p => p.name).join(', ')}`

    return (
        <button
            type="button"
            className="peers-indicator"
            onClick={() => openCollaboration(peers.length === 0 ? 'invite' : 'members')}
            title={label}
            aria-label={label}
        >
            {peers.length === 0 ? (
                <>
                    <Users size={15} aria-hidden />
                    <span className="peers-indicator__text">Invite</span>
                </>
            ) : (
                <>
                    <span className="peers-indicator__faces">
                        {peers.slice(0, MAX_FACES).map(peer => (
                            <Avatar key={peer.id} name={peer.name} size={22} />
                        ))}
                    </span>
                    {peers.length > MAX_FACES && <span className="peers-indicator__text">+{peers.length - MAX_FACES}</span>}
                </>
            )}
        </button>
    )
}

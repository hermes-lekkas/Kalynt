/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Member Store - Workspace member management with roles and permissions
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
    WorkspaceRole,
    WorkspaceMember,
    MemberPermissions,
    DEFAULT_PERMISSIONS,
    canManageRole,
    canKick,
    canBan,
    ModerationAction
} from '../types/permissions'

// Storage limits to prevent localStorage overflow
const MAX_SPACES_PERSISTED = 20
const MAX_MEMBERS_PER_SPACE = 100

function hasLocalStorage(): boolean {
    return typeof localStorage !== 'undefined'
}

// Generate a stable user ID for this device
function getOrCreateUserId(): string {
    if (hasLocalStorage()) {
        const stored = localStorage.getItem('kalynt-user-id')
        if (stored) return stored

        const newId = crypto.randomUUID()
        localStorage.setItem('kalynt-user-id', newId)
        return newId
    }
    return crypto.randomUUID()
}

// Get display name
function getDisplayName(): string {
    if (hasLocalStorage()) {
        return localStorage.getItem('kalynt-display-name') || 'Anonymous User'
    }
    return 'Anonymous User'
}

export interface SpaceMemberInfo {
    ownerId: string               // User who created the space
    members: WorkspaceMember[]    // Active members
    bannedUsers: string[]         // Banned user IDs
    bannedMembers: WorkspaceMember[] // Durable banned member records for moderation / Lift ban
    pendingActions: ModerationAction[]  // Actions to broadcast
}

export interface MemberState {
    userId: string                          // Current user's ID
    displayName: string                     // Current user's display name
    spaceMembers: Record<string, SpaceMemberInfo>  // spaceId -> members

    // Actions
    setDisplayName: (name: string) => void
    initializeSpace: (spaceId: string) => void
    setSpaceOwner: (spaceId: string, ownerId: string) => void

    // Member management
    addMember: (spaceId: string, member: WorkspaceMember) => void
    removeMember: (spaceId: string, userId: string) => void
    updateMemberRole: (spaceId: string, userId: string, role: WorkspaceRole) => void
    updateMemberPermissions: (spaceId: string, userId: string, permissions: Partial<MemberPermissions>) => void

    // Moderation
    kickMember: (spaceId: string, targetUserId: string, reason?: string) => boolean
    banMember: (spaceId: string, targetUserId: string, reason?: string) => boolean
    unbanMember: (spaceId: string, targetUserId: string) => boolean
    isUserBanned: (spaceId: string, userId: string) => boolean

    // Getters
    getMyRole: (spaceId: string) => WorkspaceRole
    getMember: (spaceId: string, userId: string) => WorkspaceMember | undefined
    getMembers: (spaceId: string) => WorkspaceMember[]
    canIManage: (spaceId: string, targetUserId: string) => boolean
    getMyPermissions: (spaceId: string) => MemberPermissions

    // Action queue
    popPendingAction: (spaceId: string) => ModerationAction | undefined
}

export const useMemberStore = create<MemberState>()(
    persist(
        (set, get) => ({
            userId: getOrCreateUserId(),
            displayName: getDisplayName(),
            spaceMembers: {},

            setDisplayName: (name) => {
                if (hasLocalStorage()) {
                    localStorage.setItem('kalynt-display-name', name)
                }
                const { spaceMembers, userId } = get()

                // Update display name in all existing memberships
                const updatedSpaces: Record<string, SpaceMemberInfo> = {}
                Object.entries(spaceMembers).forEach(([spaceId, info]) => {
                    updatedSpaces[spaceId] = {
                        ...info,
                        members: info.members.map(m =>
                            m.userId === userId
                                ? { ...m, displayName: name }
                                : m
                        )
                    }
                })

                set({ displayName: name, spaceMembers: updatedSpaces })
            },

            initializeSpace: (spaceId) => {
                const { spaceMembers, userId, displayName } = get()

                if (!spaceMembers[spaceId]) {
                    // Create new space membership - creator is owner
                    const ownerMember: WorkspaceMember = {
                        userId: userId,
                        displayName,
                        role: 'owner',
                        permissions: { ...DEFAULT_PERMISSIONS.owner },
                        joinedAt: Date.now(),
                        isOnline: true,
                        isBanned: false
                    }

                    set({
                        spaceMembers: {
                            ...spaceMembers,
                            [spaceId]: {
                                ownerId: userId,
                                members: [ownerMember],
                                bannedUsers: [],
                                bannedMembers: [],
                                pendingActions: []
                            }
                        }
                    })
                }
            },

            setSpaceOwner: (spaceId, ownerId) => {
                const { spaceMembers } = get()
                const space = spaceMembers[spaceId]

                if (space) {
                    set({
                        spaceMembers: {
                            ...spaceMembers,
                            [spaceId]: { ...space, ownerId }
                        }
                    })
                }
            },

            addMember: (spaceId, member) => {
                const { spaceMembers } = get()
                const space = spaceMembers[spaceId]

                if (space) {
                    // Don't add if banned
                    if (space.bannedUsers.includes(member.userId)) {
                        console.warn('[Members] User is banned:', member.userId)
                        return
                    }

                    // BUG-050: Max members enforcement
                    if (space.members.length >= MAX_MEMBERS_PER_SPACE) {
                        console.warn('[Members] Max members reached for space:', spaceId)
                        return
                    }

                    // Don't add duplicates
                    if (space.members.find(m => m.userId === member.userId)) {
                        return
                    }

                    set({
                        spaceMembers: {
                            ...spaceMembers,
                            [spaceId]: {
                                ...space,
                                members: [...space.members, member]
                            }
                        }
                    })
                }
            },

            removeMember: (spaceId, userId) => {
                const { spaceMembers } = get()
                const space = spaceMembers[spaceId]

                if (space) {
                    set({
                        spaceMembers: {
                            ...spaceMembers,
                            [spaceId]: {
                                ...space,
                                members: space.members.filter(m => m.userId !== userId)
                            }
                        }
                    })
                }
            },

            updateMemberRole: (spaceId, userId, role) => {
                const { spaceMembers, canIManage } = get()
                const space = spaceMembers[spaceId]

                if (!space || !canIManage(spaceId, userId)) return

                // Validate role
                const validRoles: WorkspaceRole[] = ['admin', 'member', 'viewer']
                if (!validRoles.includes(role)) {
                    console.error('[Members] Invalid role:', role)
                    return
                }

                set({
                    spaceMembers: {
                        ...spaceMembers,
                        [spaceId]: {
                            ...space,
                            members: space.members.map(m =>
                                m.userId === userId
                                    ? { ...m, role, permissions: { ...DEFAULT_PERMISSIONS[role] } }
                                    : m
                            )
                        }
                    }
                })
            },

            updateMemberPermissions: (spaceId, userId, permissions) => {
                const { spaceMembers, canIManage } = get()
                const space = spaceMembers[spaceId]

                if (!space || !canIManage(spaceId, userId)) return

                set({
                    spaceMembers: {
                        ...spaceMembers,
                        [spaceId]: {
                            ...space,
                            members: space.members.map(m =>
                                m.userId === userId
                                    ? { ...m, permissions: { ...m.permissions, ...permissions } }
                                    : m
                            )
                        }
                    }
                })
            },

            kickMember: (spaceId, targetUserId, _reason) => {
                const { spaceMembers, userId, getMyRole, getMember } = get()
                const space = spaceMembers[spaceId]
                const myRole = getMyRole(spaceId)
                const target = getMember(spaceId, targetUserId)

                if (!space || !target || !canKick(myRole, target.role)) {
                    return false
                }

                // Add kick action to pending
                const kickAction: ModerationAction = {
                    type: 'kick',
                    targetUserId,
                    initiatorId: userId,
                    timestamp: Date.now()
                }

                set({
                    spaceMembers: {
                        ...spaceMembers,
                        [spaceId]: {
                            ...space,
                            members: space.members.filter(m => m.userId !== targetUserId),
                            pendingActions: [...space.pendingActions, kickAction]
                        }
                    }
                })

                console.log('[Members] Kicked user:', targetUserId)
                return true
            },

            banMember: (spaceId, targetUserId, reason) => {
                const { spaceMembers, userId, getMyRole, getMember } = get()
                const space = spaceMembers[spaceId]
                const myRole = getMyRole(spaceId)
                const target = getMember(spaceId, targetUserId)

                if (!space || !canBan(myRole, target?.role || 'member')) {
                    return false
                }

                const now = Date.now()

                // Add ban action to pending
                const banAction: ModerationAction = {
                    type: 'ban',
                    targetUserId,
                    initiatorId: userId,
                    reason,
                    timestamp: now
                }

                const bannedEntry: WorkspaceMember = {
                    userId: targetUserId,
                    displayName: target?.displayName || targetUserId,
                    role: target?.role || 'member',
                    permissions: target?.permissions || { ...DEFAULT_PERMISSIONS.viewer },
                    joinedAt: target?.joinedAt || now,
                    isOnline: false,
                    isBanned: true,
                    bannedAt: now,
                    bannedBy: userId,
                    banReason: reason
                }

                const existingBanned = space.bannedMembers ?? []
                const nextBannedMembers = [
                    bannedEntry,
                    ...existingBanned.filter(m => m.userId !== targetUserId)
                ]

                set({
                    spaceMembers: {
                        ...spaceMembers,
                        [spaceId]: {
                            ...space,
                            members: space.members.filter(m => m.userId !== targetUserId),
                            bannedUsers: Array.from(new Set([...space.bannedUsers, targetUserId])),
                            bannedMembers: nextBannedMembers,
                            pendingActions: [...space.pendingActions, banAction]
                        }
                    }
                })

                console.log('[Members] Banned user:', targetUserId, reason)
                return true
            },

            unbanMember: (spaceId, targetUserId) => {
                const { spaceMembers, userId, getMyRole } = get()
                const space = spaceMembers[spaceId]
                const myRole = getMyRole(spaceId)

                if (!space || !['owner', 'admin'].includes(myRole)) {
                    return false
                }

                const unbanAction: ModerationAction = {
                    type: 'unban',
                    targetUserId,
                    initiatorId: userId,
                    timestamp: Date.now()
                }

                set({
                    spaceMembers: {
                        ...spaceMembers,
                        [spaceId]: {
                            ...space,
                            bannedUsers: space.bannedUsers.filter(id => id !== targetUserId),
                            bannedMembers: (space.bannedMembers ?? []).filter(m => m.userId !== targetUserId),
                            pendingActions: [...space.pendingActions, unbanAction]
                        }
                    }
                })

                console.log('[Members] Unbanned user:', targetUserId)
                return true
            },

            isUserBanned: (spaceId, userId) => {
                const { spaceMembers } = get()
                const space = spaceMembers[spaceId]
                if (!space) return false

                // BUG-049: Consistent check across both list and member flags
                const fromList = space.bannedUsers.includes(userId)
                const fromMember = space.members.find(m => m.userId === userId)?.isBanned || false
                return fromList || fromMember
            },

            getMyRole: (spaceId) => {
                const { spaceMembers, userId } = get()
                const space = spaceMembers[spaceId]

                if (!space) return 'member'
                if (space.ownerId === userId) return 'owner'

                const member = space.members.find(m => m.userId === userId)
                return member?.role || 'member'
            },

            getMember: (spaceId, userId) => {
                const { spaceMembers } = get()
                const space = spaceMembers[spaceId]
                return space?.members.find(m => m.userId === userId)
            },

            getMembers: (spaceId) => {
                const { spaceMembers } = get()
                return spaceMembers[spaceId]?.members || []
            },

            canIManage: (spaceId, targetUserId) => {
                const { getMyRole, getMember } = get()
                const myRole = getMyRole(spaceId)
                const target = getMember(spaceId, targetUserId)

                if (!target) return false
                return canManageRole(myRole, target.role)
            },

            getMyPermissions: (spaceId) => {
                const { spaceMembers, userId } = get()
                const space = spaceMembers[spaceId]

                if (!space) return DEFAULT_PERMISSIONS.member

                const member = space.members.find(m => m.userId === userId)
                return member?.permissions || DEFAULT_PERMISSIONS.member
            },

            popPendingAction: (spaceId) => {
                const { spaceMembers } = get()
                const space = spaceMembers[spaceId]

                if (!space || space.pendingActions.length === 0) return undefined

                const [action, ...rest] = space.pendingActions
                set({
                    spaceMembers: {
                        ...spaceMembers,
                        [spaceId]: { ...space, pendingActions: rest }
                    }
                })

                return action
            }
        }),
        {
            name: 'kalynt-members',
            partialize: (state) => {
                // Limit storage size by keeping only recent spaces
                const spaceIds = Object.keys(state.spaceMembers)
                let limitedSpaceMembers = state.spaceMembers

                if (spaceIds.length > MAX_SPACES_PERSISTED) {
                    // Sort by most recent activity (newest first)
                    const sorted = spaceIds.sort((a, b) => {
                        const aMembers = state.spaceMembers[a]?.members || []
                        const bMembers = state.spaceMembers[b]?.members || []

                        // Safe max calculation without spread
                        const aLatest = aMembers.reduce((max, m) => Math.max(max, m.joinedAt || 0), 0)
                        const bLatest = bMembers.reduce((max, m) => Math.max(max, m.joinedAt || 0), 0)

                        return bLatest - aLatest
                    })

                    // Keep only the most recent spaces
                    const toKeep = sorted.slice(0, MAX_SPACES_PERSISTED)
                    limitedSpaceMembers = Object.fromEntries(
                        toKeep.map(id => [id, state.spaceMembers[id]])
                    )

                    console.log(`[Members] Evicted ${spaceIds.length - MAX_SPACES_PERSISTED} old spaces from storage`)
                }

                // Also limit members per space
                const clampedSpaceMembers: Record<string, typeof state.spaceMembers[string]> = {}
                for (const [spaceId, spaceInfo] of Object.entries(limitedSpaceMembers)) {
                    clampedSpaceMembers[spaceId] = {
                        ...spaceInfo,
                        members: spaceInfo.members.slice(0, MAX_MEMBERS_PER_SPACE),
                        bannedMembers: (spaceInfo.bannedMembers ?? []).slice(0, MAX_MEMBERS_PER_SPACE),
                        pendingActions: [] // Don't persist pending actions
                    }
                }

                return {
                    userId: state.userId,
                    displayName: state.displayName,
                    spaceMembers: clampedSpaceMembers
                }
            }
        }
    )
)

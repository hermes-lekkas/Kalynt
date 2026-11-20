/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useMemberStore } from '../../../stores/memberStore'
import { useAppStore } from '../../../stores/appStore'
import { p2pService, normalizeRoomId } from '../../../services/p2pService'
import { memberSyncService } from '../../../services/memberSyncService'
import { getRoomPassword, setRoomPassword } from '../../../services/roomPasswordStore'
import { initializeRoomEncryption } from '../../../services/encryptedProvider'
import { getSpaceDocument } from '../../../hooks/useYjs'
import type { ActivityItem, ConnectionDiagnostics, CollaborationTab } from '../types'
import type { WorkspaceRole, MemberPermissions } from '../../../types/permissions'
import { DEFAULT_PERMISSIONS, canKick, canBan } from '../../../types/permissions'

const MAX_ACTIVITY_ITEMS = 100

export function useCollaboration(spaceId: string | undefined) {
  // UI State
  const [activeTab, setActiveTab] = useState<CollaborationTab>('members')
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showOfflineMembers, setShowOfflineMembers] = useState(true)

  // Connection State
  const [connectionStatus, setConnectionStatus] = useState<ConnectionDiagnostics>({
    status: 'disconnected',
    peerCount: 0,
    signalingState: 'disconnected',
    iceServers: 0,
    turnEnabled: false,
    latencyMs: 0,
    bytesReceived: 0,
    bytesSent: 0
  })

  // Activity Feed
  const [activities, setActivities] = useState<ActivityItem[]>([])
  const activityIdRef = useRef(0)
  const recentJoinTimestampsRef = useRef<Map<string, number>>(new Map())

  // Join State
  const [isJoining, setIsJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)

  // Subscribe reactively to `spaceMembers[spaceId]` state (not stable action refs)
  const spaceInfo = useMemberStore(s => (spaceId ? s.spaceMembers[spaceId] : undefined))
  const currentUserId = useMemberStore(s => s.userId)
  const currentUserName = useMemberStore(s => s.displayName)

  const connectedPeers = useAppStore(s => s.connectedPeers)
  const currentSpace = useAppStore(s => s.currentSpace)
  const spaces = useAppStore(s => s.spaces)

  const members = useMemo(() => spaceInfo?.members ?? [], [spaceInfo])

  const myRole = useMemo<WorkspaceRole>(() => {
    if (!spaceId || !spaceInfo) return 'member'
    if (spaceInfo.ownerId === currentUserId) return 'owner'
    return spaceInfo.members.find(m => m.userId === currentUserId)?.role ?? 'member'
  }, [spaceId, spaceInfo, currentUserId])

  const myPermissions = useMemo<MemberPermissions | null>(() => {
    if (!spaceId) return null
    if (!spaceInfo) return DEFAULT_PERMISSIONS.member
    return spaceInfo.members.find(m => m.userId === currentUserId)?.permissions ?? DEFAULT_PERMISSIONS[myRole]
  }, [spaceId, spaceInfo, currentUserId, myRole])

  const isAdmin = myRole === 'owner' || myRole === 'admin'

  const filteredMembers = useMemo(() => {
    let result = members

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      result = result.filter(m =>
        m.displayName.toLowerCase().includes(query) ||
        m.userId.toLowerCase().includes(query)
      )
    }

    if (!showOfflineMembers) {
      result = result.filter(m => m.isOnline)
    }

    return result
  }, [members, searchQuery, showOfflineMembers])

  const selectedMember = useMemo(() => {
    if (!selectedMemberId) return null
    return members.find(m => m.userId === selectedMemberId) || null
  }, [selectedMemberId, members])

  const updateConnectionStatus = useCallback(() => {
    if (!spaceId || !currentSpace) return

    const info = p2pService.getConnectionInfo(spaceId)
    const stats = p2pService.getStats(spaceId)

    setConnectionStatus({
      status: info.connected ? 'connected' : 'disconnected',
      peerCount: info.peerCount,
      signalingState: info.signalingState,
      iceServers: info.iceServers,
      turnEnabled: info.turnEnabled,
      latencyMs: stats.averageLatency,
      bytesReceived: stats.totalBytesReceived,
      bytesSent: stats.totalBytesSent
    })
  }, [spaceId, currentSpace])

  useEffect(() => {
    if (!spaceId) return

    updateConnectionStatus()
    const interval = setInterval(updateConnectionStatus, 2000)

    return () => clearInterval(interval)
  }, [spaceId, updateConnectionStatus])

  const addActivity = useCallback((activity: Omit<ActivityItem, 'id'>) => {
    setActivities(prev => {
      const newActivity: ActivityItem = {
        ...activity,
        id: `activity-${++activityIdRef.current}`
      }
      return [newActivity, ...prev].slice(0, MAX_ACTIVITY_ITEMS)
    })
  }, [])

  const clearActivities = useCallback(() => {
    setActivities([])
    recentJoinTimestampsRef.current.clear()
  }, [])

  const handleRoleChange = useCallback(async (targetUserId: string, role: WorkspaceRole) => {
    if (!spaceId) return false

    try {
      const success = memberSyncService.updateMemberRole(spaceId, targetUserId, role)
      if (success) {
        addActivity({
          type: 'permission',
          userId: currentUserId,
          userName: currentUserName,
          timestamp: Date.now(),
          details: `Changed role to ${role}`,
          metadata: { targetUserId, newRole: role }
        })
      }
      return success
    } catch (error) {
      console.error('[Collaboration] Failed to change role:', error)
      return false
    }
  }, [spaceId, currentUserId, currentUserName, addActivity])

  const handlePermissionChange = useCallback(async (
    targetUserId: string,
    permissions: Partial<MemberPermissions>
  ) => {
    if (!spaceId) return false

    try {
      return memberSyncService.updateMemberPermissions(spaceId, targetUserId, permissions)
    } catch (error) {
      console.error('[Collaboration] Failed to change permissions:', error)
      return false
    }
  }, [spaceId])

  const handleKick = useCallback(async (targetUserId: string) => {
    if (!spaceId) return false

    const target = members.find(m => m.userId === targetUserId)
    if (!target || !canKick(myRole, target.role)) return false

    try {
      const success = await memberSyncService.kickMember(spaceId, targetUserId)
      if (success) {
        addActivity({
          type: 'kick',
          userId: currentUserId,
          userName: currentUserName,
          timestamp: Date.now(),
          details: `Removed ${target.displayName}`,
          metadata: { targetUserId, targetName: target.displayName }
        })
      }
      return success
    } catch (error) {
      console.error('[Collaboration] Failed to kick member:', error)
      return false
    }
  }, [spaceId, members, myRole, currentUserId, currentUserName, addActivity])

  const handleBan = useCallback(async (targetUserId: string, reason?: string) => {
    if (!spaceId) return false

    const target = members.find(m => m.userId === targetUserId)
    if (!target || !canBan(myRole, target.role)) return false

    try {
      const success = await memberSyncService.banMember(spaceId, targetUserId, reason)
      if (success) {
        addActivity({
          type: 'ban',
          userId: currentUserId,
          userName: currentUserName,
          timestamp: Date.now(),
          details: `Banned ${target.displayName}${reason ? `: ${reason}` : ''}`,
          metadata: { targetUserId, targetName: target.displayName, reason }
        })
      }
      return success
    } catch (error) {
      console.error('[Collaboration] Failed to ban member:', error)
      return false
    }
  }, [spaceId, members, myRole, currentUserId, currentUserName, addActivity])

  const handleUnban = useCallback(async (targetUserId: string) => {
    if (!spaceId) return false

    try {
      return await memberSyncService.unbanMember(spaceId, targetUserId)
    } catch (error) {
      console.error('[Collaboration] Failed to unban member:', error)
      return false
    }
  }, [spaceId])

  // Invite actions — use consistent normalized room code matching JoinSection and p2pService
  const generateInviteLink = useCallback(() => {
    if (!spaceId || !currentSpace) return null

    const normalizedCode = normalizeRoomId(spaceId)
    const link = p2pService.generateRoomLink(normalizedCode, undefined, currentSpace.name)
    return {
      url: link,
      code: normalizedCode,
      useCount: 0
    }
  }, [spaceId, currentSpace])

  // Join workspace (supports both invite links and room codes with consistent normalization)
  const handleJoin = useCallback(async (input: string, password?: string) => {
    setIsJoining(true)
    setJoinError(null)

    try {
      const trimmed = input.trim()
      const parsed = p2pService.parseRoomLink(trimmed)

      let roomId: string
      let spaceName = 'Shared Space'
      let effectivePassword = password

      if (parsed) {
        roomId = normalizeRoomId(parsed.roomId)
        spaceName = parsed.spaceName || 'Shared Space'
        effectivePassword = password ?? parsed.password
      } else if (trimmed.length > 0 && trimmed.length <= 50 && !/\s/.test(trimmed)) {
        roomId = normalizeRoomId(trimmed)
      } else {
        throw new Error('Invalid link or code')
      }

      if (effectivePassword) {
        await setRoomPassword(roomId, effectivePassword)
        await initializeRoomEncryption(roomId, effectivePassword)
      }

      const existing = spaces.find(s => normalizeRoomId(s.id) === roomId)
      if (existing) {
        useAppStore.getState().setCurrentSpace(existing)
      } else {
        const newSpace = useAppStore.getState().createSpace(spaceName, roomId)
        useAppStore.getState().setCurrentSpace(newSpace)
      }
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : 'Failed to join')
      throw error
    } finally {
      setIsJoining(false)
    }
  }, [spaces])

  const testConnection = useCallback(async () => {
    try {
      return await p2pService.testConnectivity()
    } catch (error) {
      console.error('[Collaboration] Connection test failed:', error)
      throw error
    }
  }, [])

  // Reconnect while preserving the active Y.Doc, room password, user awareness, and room listeners
  const reconnect = useCallback(async () => {
    if (!spaceId) return

    const password = (await getRoomPassword(spaceId)) ?? undefined
    const doc = getSpaceDocument(spaceId)
    await p2pService.reconnect(spaceId, password, doc)
    updateConnectionStatus()
  }, [spaceId, updateConnectionStatus])

  // Subscribe via multi-subscriber `addRoomListener` so we never clobber `useYjs` or other listeners
  useEffect(() => {
    if (!spaceId) return
    recentJoinTimestampsRef.current.clear()

    const handlePeersChange = (peers: { id: string; name: string; color: string }[]) => {
      const now = Date.now()
      peers.forEach(peer => {
        const lastJoined = recentJoinTimestampsRef.current.get(peer.id)
        if (!lastJoined || now - lastJoined >= 60000) {
          recentJoinTimestampsRef.current.set(peer.id, now)
          addActivity({
            type: 'join',
            userId: peer.id,
            userName: peer.name,
            timestamp: now,
            details: 'Joined the workspace'
          })
        }
      })
    }

    return p2pService.addRoomListener(spaceId, {
      onPeers: handlePeersChange
    })
  }, [spaceId, addActivity])

  return {
    // State
    activeTab,
    selectedMemberId,
    searchQuery,
    showOfflineMembers,
    connectionStatus,
    members,
    filteredMembers,
    selectedMember,
    peers: connectedPeers,
    activities,
    isJoining,
    joinError,
    myRole,
    myPermissions,
    isAdmin,
    currentUserId,
    currentUserName,

    // Actions
    setActiveTab,
    setSelectedMemberId,
    setSearchQuery,
    setShowOfflineMembers,
    addActivity,
    clearActivities,

    // Member actions
    handleRoleChange,
    handlePermissionChange,
    handleKick,
    handleBan,
    handleUnban,

    // Invite
    generateInviteLink,

    // Join
    handleJoin,

    // Connection
    testConnection,
    reconnect,
    updateConnectionStatus
  }
}

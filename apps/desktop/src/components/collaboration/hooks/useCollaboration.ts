/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useMemberStore } from '../../../stores/memberStore'
import { useAppStore } from '../../../stores/appStore'
import { useNotificationStore } from '../../../stores/notificationStore'
import { p2pService, normalizeRoomId } from '../../../services/p2pService'
import { memberSyncService } from '../../../services/memberSyncService'
import {
  clearRoomPassword,
  getRoomPassword,
  setRoomPassword,
  setVolatileRoomPassword
} from '../../../services/roomPasswordStore'
import { disableRoomEncryption, initializeRoomEncryption } from '../../../services/encryptedProvider'
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
  const bannedMembers = useMemo(() => spaceInfo?.bannedMembers ?? [], [spaceInfo])

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

  // Banned members remain locatable regardless of the "Online only" filter so owners/admins can always lift a ban.
  const filteredBannedMembers = useMemo(() => {
    if (!searchQuery.trim()) return bannedMembers
    const query = searchQuery.toLowerCase()
    return bannedMembers.filter(m =>
      m.displayName.toLowerCase().includes(query) ||
      m.userId.toLowerCase().includes(query) ||
      (m.banReason?.toLowerCase().includes(query) ?? false)
    )
  }, [bannedMembers, searchQuery])

  const selectedMember = useMemo(() => {
    if (!selectedMemberId) return null
    return (
      members.find(m => m.userId === selectedMemberId) ||
      bannedMembers.find(m => m.userId === selectedMemberId) ||
      null
    )
  }, [selectedMemberId, members, bannedMembers])

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
        useNotificationStore.getState().addNotification(`Banned ${target.displayName}`, 'info')
      }
      return success
    } catch (error) {
      console.error('[Collaboration] Failed to ban member:', error)
      return false
    }
  }, [spaceId, members, myRole, currentUserId, currentUserName, addActivity])

  const handleUnban = useCallback(async (targetUserId: string) => {
    if (!spaceId) return false

    const target = bannedMembers.find(m => m.userId === targetUserId)
    const targetName = target?.displayName || targetUserId

    try {
      const success = await memberSyncService.unbanMember(spaceId, targetUserId)
      if (success) {
        addActivity({
          type: 'permission',
          userId: currentUserId,
          userName: currentUserName,
          timestamp: Date.now(),
          details: `Lifted ban for ${targetName}`,
          metadata: { targetUserId, targetName }
        })
        useNotificationStore.getState().addNotification(`Lifted ban for ${targetName}`, 'success')
        setSelectedMemberId(prev => (prev === targetUserId ? null : prev))
      }
      return success
    } catch (error) {
      console.error('[Collaboration] Failed to unban member:', error)
      return false
    }
  }, [spaceId, bannedMembers, currentUserId, currentUserName, addActivity])

  // Invite actions — use consistent normalized room code matching JoinSection and p2pService
  const generateInviteLink = useCallback((options?: { passwordProtected?: boolean }) => {
    if (!spaceId || !currentSpace) return null

    const normalizedCode = normalizeRoomId(spaceId)
    const link = p2pService.generateRoomLink(normalizedCode, undefined, currentSpace.name, {
      passwordProtected: options?.passwordProtected
    })
    return {
      url: link,
      code: normalizedCode,
      useCount: 0
    }
  }, [spaceId, currentSpace])

  // Join workspace (supports invite links & room codes, verifies password against online peers)
  const handleJoin = useCallback(async (input: string, password?: string) => {
    setIsJoining(true)
    setJoinError(null)

    try {
      const trimmed = input.trim()
      const parsed = p2pService.parseRoomLink(trimmed)

      let roomId: string
      let spaceName = 'Shared Space'
      let effectivePassword = password?.trim() ? password : undefined
      let passwordProtected = false

      if (parsed) {
        roomId = normalizeRoomId(parsed.roomId)
        spaceName = parsed.spaceName || 'Shared Space'
        effectivePassword = effectivePassword ?? parsed.password
        passwordProtected = Boolean(parsed.passwordProtected)
      } else if (trimmed.length > 0 && trimmed.length <= 50 && !/\s/.test(trimmed)) {
        roomId = normalizeRoomId(trimmed)
      } else {
        throw new Error('Invalid link or code')
      }

      if (passwordProtected && !effectivePassword) {
        throw new Error('This workspace requires a room password.')
      }

      const wasAlreadyCurrent = Boolean(currentSpace && normalizeRoomId(currentSpace.id) === roomId)
      const doc = getSpaceDocument(roomId)

      if (effectivePassword) {
        await initializeRoomEncryption(roomId, effectivePassword)
        if (p2pService.isConnected(roomId)) {
          await p2pService.reconnect(roomId, effectivePassword, doc)
        } else {
          p2pService.connect(roomId, doc, effectivePassword)
        }
      } else {
        disableRoomEncryption(roomId)
        if (p2pService.isConnected(roomId)) {
          await p2pService.reconnect(roomId, null, doc)
        } else {
          p2pService.connect(roomId, doc, undefined)
        }
      }

      const auth = await p2pService.waitForRoomAuth(roomId, 1500)
      if (auth.status === 'auth-failed' || auth.status === 'password-required') {
        if (!wasAlreadyCurrent) {
          p2pService.disconnect(roomId)
        }
        disableRoomEncryption(roomId)
        await clearRoomPassword(roomId)
        throw new Error(
          auth.reason ||
          (auth.status === 'password-required'
            ? 'This workspace requires a room password.'
            : 'Incorrect room password. Check the password and try again.')
        )
      }

      if (effectivePassword) {
        try {
          await setRoomPassword(roomId, effectivePassword)
        } catch {
          setVolatileRoomPassword(roomId, effectivePassword)
        }
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
  }, [spaces, currentSpace])

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
      updateConnectionStatus()
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
      onPeers: handlePeersChange,
      onProvider: () => updateConnectionStatus(),
      onAuthChange: () => updateConnectionStatus()
    })
  }, [spaceId, addActivity, updateConnectionStatus])

  return {
    // State
    activeTab,
    selectedMemberId,
    searchQuery,
    showOfflineMembers,
    connectionStatus,
    members,
    bannedMembers,
    filteredMembers,
    filteredBannedMembers,
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

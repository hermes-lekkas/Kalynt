/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useMemberStore } from '../../../stores/memberStore'
import { useAppStore } from '../../../stores/appStore'
import { p2pService } from '../../../services/p2pService'
import { memberSyncService } from '../../../services/memberSyncService'
import { setRoomPassword } from '../../../services/roomPasswordStore'
import { collabEngine } from '../../../services/collabEngine'
import type { ActivityItem, ConnectionDiagnostics, CollaborationTab } from '../types'
import type { WorkspaceRole, MemberPermissions } from '../../../types/permissions'
import { canKick, canBan } from '../../../types/permissions'

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
  
  // Join State
  const [isJoining, setIsJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)

  // Get store data
  const {
    getMembers,
    getMyRole,
    getMyPermissions,
    userId: currentUserId,
    displayName: currentUserName
  } = useMemberStore()

  const { connectedPeers, currentSpace, spaces } = useAppStore()

  // Memoized data
  const members = useMemo(() => {
    if (!spaceId) return []
    return getMembers(spaceId)
  }, [spaceId, getMembers])

  const myRole = useMemo(() => {
    if (!spaceId) return 'member' as WorkspaceRole
    return getMyRole(spaceId)
  }, [spaceId, getMyRole])

  const myPermissions = useMemo(() => {
    if (!spaceId) return null
    return getMyPermissions(spaceId)
  }, [spaceId, getMyPermissions])

  const isAdmin = myRole === 'owner' || myRole === 'admin'

  // Filter members based on search query
  const filteredMembers = useMemo(() => {
    let result = members
    
    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      result = result.filter(m => 
        m.displayName.toLowerCase().includes(query) ||
        m.userId.toLowerCase().includes(query)
      )
    }
    
    // Filter offline members
    if (!showOfflineMembers) {
      result = result.filter(m => m.isOnline)
    }
    
    return result
  }, [members, searchQuery, showOfflineMembers])

  // Get selected member details
  const selectedMember = useMemo(() => {
    if (!selectedMemberId) return null
    return members.find(m => m.userId === selectedMemberId) || null
  }, [selectedMemberId, members])

  // Connection status updates
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

  // Poll connection status
  useEffect(() => {
    if (!spaceId) return
    
    updateConnectionStatus()
    const interval = setInterval(updateConnectionStatus, 2000)
    
    return () => clearInterval(interval)
  }, [spaceId, updateConnectionStatus])

  // Activity logging
  const addActivity = useCallback((activity: Omit<ActivityItem, 'id'>) => {
    setActivities(prev => {
      const newActivity: ActivityItem = {
        ...activity,
        id: `activity-${++activityIdRef.current}`
      }
      const updated = [newActivity, ...prev].slice(0, MAX_ACTIVITY_ITEMS)
      return updated
    })
  }, [])

  // Clear activities
  const clearActivities = useCallback(() => {
    setActivities([])
  }, [])

  // Member actions
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

  // Invite actions
  const generateInviteLink = useCallback(() => {
    if (!spaceId || !currentSpace) return null
    
    const link = p2pService.generateRoomLink(spaceId, undefined, currentSpace.name)
    return {
      url: link,
      code: spaceId.toUpperCase(),
      useCount: 0
    }
  }, [spaceId, currentSpace])

  // Join workspace
  const handleJoin = useCallback(async (input: string, password?: string) => {
    setIsJoining(true)
    setJoinError(null)
    
    try {
      const parsed = p2pService.parseRoomLink(input)
      
      if (parsed) {
        if (password) {
          await setRoomPassword(parsed.roomId, password)
        }
        
        const existing = spaces.find(s => s.id === parsed.roomId)
        if (existing) {
          useAppStore.getState().setCurrentSpace(existing)
        } else {
          const spaceName = parsed.spaceName || 'Shared Space'
          const newSpace = useAppStore.getState().createSpace(spaceName, parsed.roomId)
          useAppStore.getState().setCurrentSpace(newSpace)
        }
        
        return
      }
      
      // Try as room code
      if (input.trim().length > 0 && input.trim().length <= 50) {
        const roomId = input.trim().toLowerCase()
        const existing = spaces.find(s => s.id === roomId)
        if (existing) {
          useAppStore.getState().setCurrentSpace(existing)
          return
        }
        
        const newSpace = useAppStore.getState().createSpace('Shared Space', roomId)
        useAppStore.getState().setCurrentSpace(newSpace)
        return
      }
      
      throw new Error('Invalid link or code')
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : 'Failed to join')
      throw error
    } finally {
      setIsJoining(false)
    }
  }, [spaces])

  // Test connection
  const testConnection = useCallback(async () => {
    try {
      const result = await p2pService.testConnectivity()
      return result
    } catch (error) {
      console.error('[Collaboration] Connection test failed:', error)
      throw error
    }
  }, [])

  // Reconnect
  const reconnect = useCallback(() => {
    if (!spaceId) return
    
    // Disconnect and reconnect
    p2pService.disconnect(spaceId)
    
    // Get Yjs doc and reconnect
    const doc = collabEngine.getDocument(spaceId)
    if (doc) {
      p2pService.connect(spaceId, doc)
    }
    
    updateConnectionStatus()
  }, [spaceId, updateConnectionStatus])

  // Listen for peer join/leave
  useEffect(() => {
    if (!spaceId) return
    
    const handlePeersChange = (peers: { id: string; name: string; color: string }[]) => {
      // Add activity for new peers
      peers.forEach(peer => {
        const isNew = !activities.some(a => 
          a.type === 'join' && a.userId === peer.id && 
          Date.now() - a.timestamp < 60000
        )
        
        if (isNew) {
          addActivity({
            type: 'join',
            userId: peer.id,
            userName: peer.name,
            timestamp: Date.now(),
            details: 'Joined the workspace'
          })
        }
      })
    }
    
    p2pService.setRoomCallbacks(spaceId, {
      onPeers: handlePeersChange
    })
    
    return () => {
      p2pService.setRoomCallbacks(spaceId, {})
    }
  }, [spaceId, addActivity, activities])

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

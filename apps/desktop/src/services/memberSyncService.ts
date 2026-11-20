/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Member Sync Service - P2P synchronization of member data via Yjs
// SECURITY FIX V-004: Encrypt moderation actions in awareness channel & reject plaintext downgrade
// SECURITY FIX V-005: Cryptographic ECDSA ownership proofs (no unkeyed SHA-256)
// SECURITY FIX V-006: Peer authentication & strict role/permission moderation authorization
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import {
    WorkspaceRole,
    WorkspaceMember,
    MemberPermissions,
    DEFAULT_PERMISSIONS,
    ModerationAction,
    canKick,
    canBan,
    canManageRole
} from '../types/permissions'
import { useMemberStore } from '../stores/memberStore'
import { useAppStore } from '../stores/appStore'
import { useNotificationStore } from '../stores/notificationStore'
import { useUiStore } from '../stores/uiStore'
import { p2pService } from './p2pService'
import { securityLog } from './auditLogService'
import {
    encryptRoomMessage,
    decryptRoomMessage,
    disableRoomEncryption,
    getRoomEncryptionState,
    isRoomEncryptionReady
} from './encryptedProvider'
import {
    initializeLocalIdentity,
    getLocalIdentity,
    registerPeer,
    isPeerTrusted,
    createIdentityAnnouncement,
    signPayload,
    verifyPayloadSignature,
    cleanupRoom as cleanupPeerAuth
} from './peerAuthService'

const OWNER_PROOF_VERSION = 'ecdsa-p256-v1'
const MAX_ACTION_AGE_MS = 5 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 60 * 1000

interface SignedModerationEnvelope {
    action: ModerationAction
    peerId: string
    publicKey: string
    signature: string
}

interface AwarenessState {
    user?: {
        id: string
        name: string
        role?: WorkspaceRole
    }
    moderation?: ModerationAction | SignedModerationEnvelope
    encryptedModeration?: string // Base64 AES-GCM encrypted SignedModerationEnvelope
    peerIdentity?: {
        type: 'identity'
        peerId: string
        publicKey: string
        timestamp: number
    }
}

interface VerifiedOwnerInfo {
    ownerId: string
    ownerPeerId: string
    ownerPublicKey: string
    ownerTimestamp: number
}

// Serializable member data for Y.Map
interface SyncedMember {
    userId: string
    displayName: string
    role: WorkspaceRole
    permissions: MemberPermissions
    joinedAt: number
    isBanned: boolean
    bannedAt?: number
    bannedBy?: string
    banReason?: string
    peerId?: string
    publicKey?: string
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
    const CHUNK = 0x8000
    let binary = ''
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
    }
    return btoa(binary)
}

function base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}

function buildOwnerProofPayload(spaceId: string, ownerId: string, timestamp: string, peerId: string): string {
    return `kalynt-owner-v1:${spaceId}:${ownerId}:${timestamp}:${peerId}`
}

function buildModerationPayload(spaceId: string, action: ModerationAction): string {
    const reason = action.type === 'ban' ? (action.reason ?? '') : ''
    return `kalynt-mod-v1:${spaceId}:${action.type}:${action.targetUserId}:${action.initiatorId}:${action.timestamp}:${reason}`
}

function isSignedModerationEnvelope(value: unknown): value is SignedModerationEnvelope {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Partial<SignedModerationEnvelope>
    return (
        !!candidate.action &&
        typeof candidate.action === 'object' &&
        typeof candidate.peerId === 'string' &&
        typeof candidate.publicKey === 'string' &&
        typeof candidate.signature === 'string'
    )
}

function isEncryptedRoom(spaceId: string): boolean {
    const state = getRoomEncryptionState(spaceId)
    return isRoomEncryptionReady(spaceId) || state?.enabled === true
}

async function encryptModerationPayload(
    spaceId: string,
    payload: SignedModerationEnvelope
): Promise<string | null> {
    if (!isRoomEncryptionReady(spaceId)) {
        return null
    }
    try {
        const data = new TextEncoder().encode(JSON.stringify(payload))
        const encrypted = await encryptRoomMessage(spaceId, data)
        return uint8ArrayToBase64(encrypted)
    } catch (e) {
        console.error('[MemberSync] Failed to encrypt moderation action:', e)
        return null
    }
}

async function decryptModerationPayload(
    spaceId: string,
    encryptedData: string
): Promise<SignedModerationEnvelope | ModerationAction | null> {
    if (!isRoomEncryptionReady(spaceId)) {
        return null
    }
    try {
        const encrypted = base64ToUint8Array(encryptedData)
        const decrypted = await decryptRoomMessage(spaceId, encrypted)
        return JSON.parse(new TextDecoder().decode(decrypted)) as SignedModerationEnvelope | ModerationAction
    } catch (e) {
        console.error('[MemberSync] Failed to decrypt moderation action:', e)
        return null
    }
}

class MemberSyncService {
    private spaceDocs: Map<string, Y.Doc> = new Map()
    private spaceAwareness: Map<string, Awareness> = new Map()
    private unsubscribers: Map<string, () => void> = new Map()
    private verifiedOwners: Map<string, VerifiedOwnerInfo> = new Map()
    private processingActions: Set<string> = new Set()
    private handledRemoteActions: Map<string, Set<string>> = new Map()

    constructor() {
        // Process pending moderation actions queued through useMemberStore
        useMemberStore.subscribe((state) => {
            Object.entries(state.spaceMembers).forEach(([spaceId, spaceInfo]) => {
                if (spaceInfo.pendingActions.length > 0) {
                    const action = spaceInfo.pendingActions[0]
                    const actionKey = `${spaceId}:${action.type}:${action.targetUserId}:${action.timestamp}`

                    if (this.processingActions.has(actionKey)) {
                        return
                    }

                    this.processingActions.add(actionKey)

                    this.processAction(spaceId, action)
                        .catch((error) => {
                            console.error('[MemberSync] Failed to process action:', error)
                        })
                        .finally(() => {
                            this.processingActions.delete(actionKey)
                        })
                }
            })
        })
    }

    private async processAction(spaceId: string, action: ModerationAction) {
        const store = useMemberStore.getState()

        let success = false
        switch (action.type) {
            case 'kick':
                success = await this.kickMember(spaceId, action.targetUserId)
                break
            case 'ban':
                success = await this.banMember(spaceId, action.targetUserId, action.reason)
                break
            case 'unban':
                success = await this.unbanMember(spaceId, action.targetUserId)
                break
        }

        if (store.popPendingAction(spaceId)) {
            if (success) {
                console.log('[MemberSync] Processed pending action:', action.type)
            } else {
                console.warn('[MemberSync] Failed to process action:', action.type)
            }
        }
    }

    /**
     * Verify the ECDSA ownership proof recorded in `metadata` Y.Map.
     * Rejects unkeyed SHA-256 or unsigned ownership claims.
     */
    private async verifyOwnerProof(
        spaceId: string,
        ownerRef: Y.Map<string>
    ): Promise<VerifiedOwnerInfo | null> {
        const ownerId = ownerRef.get('ownerId')
        const ownerTimestamp = ownerRef.get('ownerTimestamp')
        const ownerPeerId = ownerRef.get('ownerPeerId')
        const ownerPublicKey = ownerRef.get('ownerPublicKey')
        const ownerSignature = ownerRef.get('ownerSignature')
        const ownerProofVersion = ownerRef.get('ownerProofVersion')

        if (
            !ownerId ||
            !ownerTimestamp ||
            !ownerPeerId ||
            !ownerPublicKey ||
            !ownerSignature ||
            ownerProofVersion !== OWNER_PROOF_VERSION
        ) {
            return null
        }

        const parsedTimestamp = Number(ownerTimestamp)
        if (!Number.isFinite(parsedTimestamp) || parsedTimestamp <= 0) {
            return null
        }

        const payload = buildOwnerProofPayload(spaceId, ownerId, ownerTimestamp, ownerPeerId)
        const valid = await verifyPayloadSignature(payload, ownerSignature, ownerPublicKey, ownerPeerId)
        if (!valid) {
            securityLog.peerRejected(ownerPeerId, spaceId, 'invalid_owner_ecdsa_proof')
            console.warn('[MemberSync] Rejected forged/invalid ECDSA owner proof for space:', spaceId)
            return null
        }

        await registerPeer(spaceId, ownerPeerId, ownerPublicKey)
        return {
            ownerId,
            ownerPeerId,
            ownerPublicKey,
            ownerTimestamp: parsedTimestamp
        }
    }

    private async refreshVerifiedOwner(spaceId: string, ownerRef: Y.Map<string>): Promise<VerifiedOwnerInfo | null> {
        const verified = await this.verifyOwnerProof(spaceId, ownerRef)
        const existing = this.verifiedOwners.get(spaceId)

        if (!verified) {
            return existing ?? null
        }

        // Preserve earliest valid owner claim to prevent hostile takeover on sync race
        if (!existing || verified.ownerTimestamp < existing.ownerTimestamp || verified.ownerId === existing.ownerId) {
            this.verifiedOwners.set(spaceId, verified)
            return verified
        }

        console.warn('[MemberSync] Ignored later competing owner claim from:', verified.ownerId)
        return existing
    }

    private getResolvedRole(spaceId: string, doc: Y.Doc, userId: string): WorkspaceRole | null {
        const verifiedOwner = this.verifiedOwners.get(spaceId)
        if (verifiedOwner && verifiedOwner.ownerId === userId) {
            return 'owner'
        }
        const membersMap = doc.getMap<SyncedMember>('members')
        const member = membersMap.get(userId)
        if (!member) return null
        // Never trust a self-asserted 'owner' role in membersMap without a verified owner proof
        if (member.role === 'owner') {
            return verifiedOwner?.ownerId === userId ? 'owner' : 'member'
        }
        return member.role
    }

    /**
     * Initialize member sync for a space with ECDSA identity and verified ownership.
     */
    async initializeSpace(
        spaceId: string,
        doc: Y.Doc,
        awareness: Awareness,
        userId: string,
        displayName: string
    ): Promise<void> {
        if (this.spaceDocs.has(spaceId)) {
            console.log('[MemberSync] Already initialized for space:', spaceId)
            return
        }

        console.log('[MemberSync] Initializing for space:', spaceId)

        this.spaceDocs.set(spaceId, doc)
        this.spaceAwareness.set(spaceId, awareness)
        this.handledRemoteActions.set(spaceId, new Set())

        let localIdentity = getLocalIdentity()
        try {
            localIdentity = await initializeLocalIdentity()
            if (localIdentity) {
                console.log('[MemberSync] Local peer identity:', localIdentity.peerId.substring(0, 8) + '...')
            }
        } catch (e) {
            console.error('[MemberSync] Failed to initialize peer identity:', e)
        }

        const membersMap = doc.getMap<SyncedMember>('members')
        const bannedMap = doc.getMap<boolean>('banned')
        const ownerRef = doc.getMap<string>('metadata')

        // Bail if cleaned up while awaiting identity init
        if (this.spaceDocs.get(spaceId) !== doc) return

        // Check if user is banned
        if (bannedMap.get(userId)) {
            console.warn('[MemberSync] User is banned from this space!')
            this.handleBanned(spaceId)
            return
        }

        // Verify existing owner proof or create a real ECDSA-signed ownership claim
        const existingOwnerId = ownerRef.get('ownerId')
        let verifiedOwner: VerifiedOwnerInfo | null = null

        if (!existingOwnerId) {
            const timestamp = Date.now().toString()
            const peerId = localIdentity?.peerId
            if (peerId) {
                const payload = buildOwnerProofPayload(spaceId, userId, timestamp, peerId)
                const signed = await signPayload(payload)
                if (signed) {
                    doc.transact(() => {
                        ownerRef.set('ownerId', userId)
                        ownerRef.set('ownerTimestamp', timestamp)
                        ownerRef.set('ownerPeerId', signed.peerId)
                        ownerRef.set('ownerPublicKey', signed.publicKey)
                        ownerRef.set('ownerSignature', signed.signature)
                        ownerRef.set('ownerProofVersion', OWNER_PROOF_VERSION)
                    })
                    verifiedOwner = {
                        ownerId: userId,
                        ownerPeerId: signed.peerId,
                        ownerPublicKey: signed.publicKey,
                        ownerTimestamp: Number(timestamp)
                    }
                    this.verifiedOwners.set(spaceId, verifiedOwner)
                    await registerPeer(spaceId, signed.peerId, signed.publicKey, displayName)
                    console.log('[MemberSync] Set as owner with ECDSA proof:', userId)
                }
            }
        } else {
            verifiedOwner = await this.refreshVerifiedOwner(spaceId, ownerRef)
            if (!verifiedOwner) {
                console.warn('[MemberSync] Existing owner record failed ECDSA verification for space:', spaceId)
            }
        }

        if (this.spaceDocs.get(spaceId) !== doc) return

        const effectiveOwnerId = verifiedOwner?.ownerId || ''
        const isOwner = effectiveOwnerId === userId
        const existingMember = membersMap.get(userId)
        const existingRole = existingMember?.role === 'owner' && !isOwner ? 'member' : existingMember?.role
        const role: WorkspaceRole = isOwner ? 'owner' : (existingRole || 'member')

        if (!existingMember || (localIdentity && existingMember.peerId !== localIdentity.peerId)) {
            doc.transact(() => {
                membersMap.set(userId, {
                    userId,
                    displayName: existingMember?.displayName || displayName,
                    role,
                    permissions: existingMember?.permissions || { ...DEFAULT_PERMISSIONS[role] },
                    joinedAt: existingMember?.joinedAt || Date.now(),
                    isBanned: false,
                    peerId: localIdentity?.peerId,
                    publicKey: localIdentity?.publicKey
                })
            })
            console.log('[MemberSync] Registered local member:', userId, role)
        }

        awareness.setLocalStateField('user', {
            id: userId,
            name: displayName,
            role
        })

        const identityAnnouncement = createIdentityAnnouncement()
        if (identityAnnouncement) {
            awareness.setLocalStateField('peerIdentity', identityAnnouncement)
            console.log('[MemberSync] Announced peer identity')
        }

        const memberObserver = () => {
            const ownerId = this.verifiedOwners.get(spaceId)?.ownerId || ''
            this.syncMembersToStore(spaceId, membersMap, bannedMap, ownerId)
        }
        const ownerObserver = () => {
            void this.refreshVerifiedOwner(spaceId, ownerRef).then((owner) => {
                if (this.spaceDocs.get(spaceId) !== doc) return
                this.syncMembersToStore(spaceId, membersMap, bannedMap, owner?.ownerId || '')
            })
        }

        membersMap.observe(memberObserver)
        bannedMap.observe(memberObserver)
        ownerRef.observe(ownerObserver)

        const awarenessHandler = async ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
            const states = awareness.getStates() as Map<number, AwarenessState>

            if (removed.length > 0) {
                console.log('[MemberSync] Peers disconnected:', removed.length)
            }

            for (const clientId of [...added, ...updated]) {
                if (clientId === awareness.clientID) continue
                const state = states.get(clientId)
                if (!state) continue

                // Register peer ECDSA identity
                if (state.peerIdentity) {
                    const { peerId, publicKey, timestamp } = state.peerIdentity
                    const now = Date.now()
                    const isFresh =
                        typeof timestamp === 'number' &&
                        now - timestamp < MAX_ACTION_AGE_MS &&
                        timestamp - now < MAX_FUTURE_SKEW_MS

                    if (isFresh && peerId && publicKey) {
                        if (!isPeerTrusted(spaceId, peerId)) {
                            const registered = await registerPeer(
                                spaceId,
                                peerId,
                                publicKey,
                                state.user?.name
                            )
                            if (registered) {
                                console.log('[MemberSync] Registered peer:', peerId.substring(0, 8))
                            }
                        }
                    } else if (added.includes(clientId)) {
                        console.warn('[MemberSync] Rejected stale peer identity from:', peerId?.substring(0, 8))
                    }
                }

                const encryptedRoom = isEncryptedRoom(spaceId)

                // Encrypted moderation path
                if (state.encryptedModeration) {
                    if (!isRoomEncryptionReady(spaceId)) {
                        console.warn('[MemberSync] Cannot verify encrypted moderation before room key is ready')
                        continue
                    }
                    const decrypted = await decryptModerationPayload(spaceId, state.encryptedModeration)
                    if (decrypted) {
                        await this.verifyAndHandleModeration(spaceId, decrypted, state, doc, userId, true)
                    } else {
                        securityLog.peerRejected(state.peerIdentity?.peerId || 'unknown', spaceId, 'moderation_decrypt_failed')
                    }
                    continue
                }

                // Plaintext moderation path — strictly REJECTED in encrypted rooms
                if (state.moderation) {
                    if (encryptedRoom) {
                        securityLog.peerRejected(
                            state.peerIdentity?.peerId || 'unknown',
                            spaceId,
                            'plaintext_moderation_in_encrypted_room'
                        )
                        console.warn('[MemberSync] Rejected plaintext moderation action in encrypted room')
                        continue
                    }
                    await this.verifyAndHandleModeration(spaceId, state.moderation, state, doc, userId, false)
                }
            }

            // Refresh online presence in store whenever awareness changes
            if (added.length > 0 || updated.length > 0 || removed.length > 0) {
                const ownerId = this.verifiedOwners.get(spaceId)?.ownerId || ''
                this.syncMembersToStore(spaceId, membersMap, bannedMap, ownerId)
            }
        }
        awareness.on('change', awarenessHandler)

        // Initial reactive store sync
        this.syncMembersToStore(spaceId, membersMap, bannedMap, effectiveOwnerId)

        this.unsubscribers.set(spaceId, () => {
            membersMap.unobserve(memberObserver)
            bannedMap.unobserve(memberObserver)
            ownerRef.unobserve(ownerObserver)
            awareness.off('change', awarenessHandler)
        })

        console.log('[MemberSync] Initialization complete for:', spaceId)
    }

    /**
     * Sync Y.Map members to Zustand store using IMMUTABLE setState updates
     * so subscribed React components always re-render on P2P changes.
     */
    private syncMembersToStore(
        spaceId: string,
        membersMap: Y.Map<SyncedMember>,
        bannedMap: Y.Map<boolean>,
        ownerId: string
    ): void {
        const members: WorkspaceMember[] = []
        membersMap.forEach((member) => {
            const safeRole: WorkspaceRole =
                member.userId === ownerId
                    ? 'owner'
                    : member.role === 'owner'
                        ? 'member'
                        : member.role
            members.push({
                ...member,
                role: safeRole,
                isOnline: this.isUserOnline(spaceId, member.userId)
            })
        })

        const bannedUsers: string[] = []
        bannedMap.forEach((isBanned, userId) => {
            if (isBanned) bannedUsers.push(userId)
        })

        useMemberStore.setState((state) => {
            const currentInfo = state.spaceMembers[spaceId]
            return {
                spaceMembers: {
                    ...state.spaceMembers,
                    [spaceId]: {
                        ownerId,
                        members,
                        bannedUsers,
                        pendingActions: currentInfo?.pendingActions ?? []
                    }
                }
            }
        })
    }

    private isUserOnline(spaceId: string, userId: string): boolean {
        const awareness = this.spaceAwareness.get(spaceId)
        if (!awareness) return false

        const states = awareness.getStates() as Map<number, AwarenessState>
        for (const [, state] of states) {
            if (state.user?.id === userId) return true
        }
        return false
    }

    /**
     * Cryptographically authenticate the moderation sender before checking
     * role/permission authorization in `handleModerationAction`.
     */
    private async verifyAndHandleModeration(
        spaceId: string,
        rawPayload: SignedModerationEnvelope | ModerationAction,
        senderState: AwarenessState,
        doc: Y.Doc,
        myUserId: string,
        wasEncrypted: boolean
    ): Promise<void> {
        if (!isSignedModerationEnvelope(rawPayload)) {
            securityLog.peerRejected(
                senderState.peerIdentity?.peerId || 'unknown',
                spaceId,
                'unsigned_moderation_action'
            )
            console.warn('[MemberSync] Rejected unsigned moderation action')
            return
        }

        const { action, peerId, publicKey, signature } = rawPayload
        if (!action?.type || !action.targetUserId || !action.initiatorId || typeof action.timestamp !== 'number') {
            return
        }

        // Deduplicate already-processed remote actions
        const dedupKey = `${action.type}:${action.initiatorId}:${action.targetUserId}:${action.timestamp}`
        const handled = this.handledRemoteActions.get(spaceId)
        if (handled?.has(dedupKey)) return

        // Verify timestamp freshness
        const now = Date.now()
        if (now - action.timestamp > MAX_ACTION_AGE_MS || action.timestamp - now > MAX_FUTURE_SKEW_MS) {
            console.warn('[MemberSync] Rejected stale moderation action from:', action.initiatorId)
            return
        }

        // Verify sender's awareness user/identity matches the signed moderation claims
        if (senderState.user?.id && senderState.user.id !== action.initiatorId) {
            securityLog.peerRejected(peerId, spaceId, 'moderation_initiator_mismatch')
            console.warn('[MemberSync] Rejected moderation with mismatched initiatorId')
            return
        }
        if (senderState.peerIdentity?.peerId && senderState.peerIdentity.peerId !== peerId) {
            securityLog.peerRejected(peerId, spaceId, 'moderation_peer_id_mismatch')
            console.warn('[MemberSync] Rejected moderation with mismatched peerId')
            return
        }

        // Verify ECDSA signature and peerId binding
        const canonicalPayload = buildModerationPayload(spaceId, action)
        const signatureValid = await verifyPayloadSignature(canonicalPayload, signature, publicKey, peerId)
        if (!signatureValid) {
            securityLog.peerRejected(peerId, spaceId, 'invalid_moderation_signature')
            console.warn('[MemberSync] Rejected moderation action with invalid ECDSA signature')
            return
        }

        // In encrypted rooms, sender must also be registered/trusted via peerAuth
        if (wasEncrypted && !isPeerTrusted(spaceId, peerId)) {
            const registered = await registerPeer(spaceId, peerId, publicKey, senderState.user?.name)
            if (!registered) {
                securityLog.peerRejected(peerId, spaceId, 'untrusted_moderation_peer')
                return
            }
        }

        // Ensure signing key matches the registered owner/member identity
        const ownerRef = doc.getMap<string>('metadata')
        const verifiedOwner = this.verifiedOwners.get(spaceId) || await this.refreshVerifiedOwner(spaceId, ownerRef)
        const membersMap = doc.getMap<SyncedMember>('members')
        const initiatorMember = membersMap.get(action.initiatorId)

        if (verifiedOwner && action.initiatorId === verifiedOwner.ownerId) {
            if (verifiedOwner.ownerPeerId !== peerId || verifiedOwner.ownerPublicKey !== publicKey) {
                securityLog.peerRejected(peerId, spaceId, 'owner_key_impersonation')
                console.warn('[MemberSync] Rejected moderation impersonating workspace owner')
                return
            }
        } else if (initiatorMember?.peerId && initiatorMember.peerId !== peerId) {
            securityLog.peerRejected(peerId, spaceId, 'member_key_impersonation')
            console.warn('[MemberSync] Rejected moderation with key not matching initiator member')
            return
        }

        handled?.add(dedupKey)
        if (handled && handled.size > 500) {
            const first = handled.values().next().value
            if (first !== undefined) handled.delete(first)
        }

        this.handleModerationAction(spaceId, action, doc, myUserId)
    }

    /**
     * Enforce strict role/permission authorization before acting on any moderation event.
     * Guests, viewers, members, or unverified peers can NEVER kick/ban an admin or owner,
     * and nobody can ever kick or ban the workspace owner.
     */
    private handleModerationAction(
        spaceId: string,
        action: ModerationAction,
        doc: Y.Doc,
        myUserId: string
    ): void {
        const verifiedOwner = this.verifiedOwners.get(spaceId)
        const verifiedOwnerId = verifiedOwner?.ownerId || null
        const initiatorRole = this.getResolvedRole(spaceId, doc, action.initiatorId)

        if (!initiatorRole) {
            securityLog.peerRejected(action.initiatorId, spaceId, 'moderation_unknown_initiator')
            console.warn('[MemberSync] Rejected moderation from unknown initiator:', action.initiatorId)
            return
        }

        const targetRole: WorkspaceRole =
            verifiedOwnerId && action.targetUserId === verifiedOwnerId
                ? 'owner'
                : this.getResolvedRole(spaceId, doc, action.targetUserId) || 'member'

        if (action.type === 'kick') {
            if (
                action.initiatorId === action.targetUserId ||
                targetRole === 'owner' ||
                (verifiedOwnerId !== null && action.targetUserId === verifiedOwnerId) ||
                !canKick(initiatorRole, targetRole)
            ) {
                securityLog.peerRejected(action.initiatorId, spaceId, 'unauthorized_kick')
                console.warn(
                    `[MemberSync] Rejected unauthorized kick: ${action.initiatorId} (${initiatorRole}) -> ${action.targetUserId} (${targetRole})`
                )
                return
            }
        } else if (action.type === 'ban') {
            if (
                action.initiatorId === action.targetUserId ||
                targetRole === 'owner' ||
                (verifiedOwnerId !== null && action.targetUserId === verifiedOwnerId) ||
                !canBan(initiatorRole, targetRole)
            ) {
                securityLog.peerRejected(action.initiatorId, spaceId, 'unauthorized_ban')
                console.warn(
                    `[MemberSync] Rejected unauthorized ban: ${action.initiatorId} (${initiatorRole}) -> ${action.targetUserId} (${targetRole})`
                )
                return
            }
        } else if (action.type === 'unban') {
            if (initiatorRole !== 'owner' && initiatorRole !== 'admin') {
                securityLog.peerRejected(action.initiatorId, spaceId, 'unauthorized_unban')
                console.warn(`[MemberSync] Rejected unauthorized unban from ${action.initiatorId} (${initiatorRole})`)
                return
            }
        } else {
            return
        }

        console.log('[MemberSync] Applying authorized moderation action:', action.type, 'by', initiatorRole)

        if (action.targetUserId === myUserId) {
            if (action.type === 'kick') {
                console.warn('[MemberSync] Removed from workspace by authorized moderator')
                this.handleKicked(spaceId)
            } else if (action.type === 'ban') {
                console.warn('[MemberSync] Banned from workspace by authorized moderator')
                doc.transact(() => {
                    const bannedMap = doc.getMap<boolean>('banned')
                    bannedMap.set(myUserId, true)
                })
                this.handleBanned(spaceId, action.reason)
            }
        }

        if (action.type === 'unban') {
            doc.transact(() => {
                const bannedMap = doc.getMap<boolean>('banned')
                bannedMap.delete(action.targetUserId)
            })
        }
    }

    /**
     * Leave the space cleanly without blocking `alert()` or `window.location.reload()`.
     */
    private leaveRemovedSpace(spaceId: string): void {
        this.cleanup(spaceId)
        p2pService.disconnect(spaceId)
        disableRoomEncryption(spaceId)

        const ui = useUiStore.getState()
        ui.closeCollaboration()

        const app = useAppStore.getState()
        if (app.currentSpace?.id === spaceId) {
            app.setCurrentSpace(null)
        }
    }

    private handleKicked(spaceId: string): void {
        useNotificationStore.getState().addNotification(
            'You have been removed from this workspace.',
            'warning',
            8000
        )
        this.leaveRemovedSpace(spaceId)
    }

    private handleBanned(spaceId: string, reason?: string): void {
        const suffix = reason ? ` Reason: ${reason}` : ''
        useNotificationStore.getState().addNotification(
            `You have been banned from this workspace.${suffix}`,
            'error',
            10000
        )
        this.leaveRemovedSpace(spaceId)
    }

    private async broadcastModerationAction(
        spaceId: string,
        awareness: Awareness,
        action: ModerationAction
    ): Promise<boolean> {
        const canonical = buildModerationPayload(spaceId, action)
        const signed = await signPayload(canonical)
        if (!signed) {
            console.error('[MemberSync] Cannot sign moderation action without peer identity')
            return false
        }

        const envelope: SignedModerationEnvelope = {
            action,
            peerId: signed.peerId,
            publicKey: signed.publicKey,
            signature: signed.signature
        }

        if (isEncryptedRoom(spaceId)) {
            const encrypted = await encryptModerationPayload(spaceId, envelope)
            if (!encrypted) {
                console.error('[MemberSync] Refusing to send plaintext moderation in encrypted room')
                return false
            }
            awareness.setLocalStateField('encryptedModeration', encrypted)
            awareness.setLocalStateField('moderation', null)
        } else {
            awareness.setLocalStateField('moderation', envelope)
            awareness.setLocalStateField('encryptedModeration', null)
        }

        setTimeout(() => {
            if (this.spaceAwareness.get(spaceId) !== awareness) return
            awareness.setLocalStateField('moderation', null)
            awareness.setLocalStateField('encryptedModeration', null)
        }, 1000)

        return true
    }

    async kickMember(spaceId: string, targetUserId: string): Promise<boolean> {
        const awareness = this.spaceAwareness.get(spaceId)
        const doc = this.spaceDocs.get(spaceId)
        const store = useMemberStore.getState()

        if (!awareness || !doc) {
            console.error('[MemberSync] No awareness/doc for space:', spaceId)
            return false
        }

        const myUserId = store.userId
        const myRole = this.getResolvedRole(spaceId, doc, myUserId)
        const targetRole = this.getResolvedRole(spaceId, doc, targetUserId) || 'member'
        if (!myRole || myUserId === targetUserId || !canKick(myRole, targetRole)) {
            console.warn('[MemberSync] Local kick blocked: insufficient permissions')
            return false
        }

        const kickAction: ModerationAction = {
            type: 'kick',
            targetUserId,
            initiatorId: myUserId,
            timestamp: Date.now()
        }

        const sent = await this.broadcastModerationAction(spaceId, awareness, kickAction)
        if (!sent) return false

        doc.transact(() => {
            const membersMap = doc.getMap<SyncedMember>('members')
            membersMap.delete(targetUserId)
        })

        console.log('[MemberSync] Kicked member:', targetUserId)
        return true
    }

    async banMember(spaceId: string, targetUserId: string, reason?: string): Promise<boolean> {
        const awareness = this.spaceAwareness.get(spaceId)
        const doc = this.spaceDocs.get(spaceId)
        const store = useMemberStore.getState()

        if (!awareness || !doc) {
            console.error('[MemberSync] No awareness/doc for space:', spaceId)
            return false
        }

        const myUserId = store.userId
        const myRole = this.getResolvedRole(spaceId, doc, myUserId)
        const targetRole = this.getResolvedRole(spaceId, doc, targetUserId) || 'member'
        if (!myRole || myUserId === targetUserId || !canBan(myRole, targetRole)) {
            console.warn('[MemberSync] Local ban blocked: insufficient permissions')
            return false
        }

        const banAction: ModerationAction = {
            type: 'ban',
            targetUserId,
            initiatorId: myUserId,
            reason,
            timestamp: Date.now()
        }

        const sent = await this.broadcastModerationAction(spaceId, awareness, banAction)
        if (!sent) return false

        doc.transact(() => {
            const bannedMap = doc.getMap<boolean>('banned')
            const membersMap = doc.getMap<SyncedMember>('members')
            bannedMap.set(targetUserId, true)
            membersMap.delete(targetUserId)
        })

        console.log('[MemberSync] Banned member:', targetUserId, reason)
        return true
    }

    async unbanMember(spaceId: string, targetUserId: string): Promise<boolean> {
        const doc = this.spaceDocs.get(spaceId)
        const awareness = this.spaceAwareness.get(spaceId)
        const store = useMemberStore.getState()

        if (!doc) {
            console.error('[MemberSync] No doc for space:', spaceId)
            return false
        }

        const myUserId = store.userId
        const myRole = this.getResolvedRole(spaceId, doc, myUserId)
        if (myRole !== 'owner' && myRole !== 'admin') {
            console.warn('[MemberSync] Local unban blocked: insufficient permissions')
            return false
        }

        if (awareness) {
            const unbanAction: ModerationAction = {
                type: 'unban',
                targetUserId,
                initiatorId: myUserId,
                timestamp: Date.now()
            }
            const sent = await this.broadcastModerationAction(spaceId, awareness, unbanAction)
            if (!sent) return false
        }

        doc.transact(() => {
            const bannedMap = doc.getMap<boolean>('banned')
            bannedMap.delete(targetUserId)
        })

        console.log('[MemberSync] Unbanned member:', targetUserId)
        return true
    }

    updateMemberRole(spaceId: string, targetUserId: string, role: WorkspaceRole): boolean {
        const doc = this.spaceDocs.get(spaceId)
        if (!doc) {
            console.error('[MemberSync] No doc for space:', spaceId)
            return false
        }

        const myUserId = useMemberStore.getState().userId
        const myRole = this.getResolvedRole(spaceId, doc, myUserId)
        const targetRole = this.getResolvedRole(spaceId, doc, targetUserId)
        if (
            !myRole ||
            !targetRole ||
            role === 'owner' ||
            targetRole === 'owner' ||
            myUserId === targetUserId ||
            !canManageRole(myRole, targetRole)
        ) {
            console.warn('[MemberSync] Role change blocked: insufficient permissions')
            return false
        }

        doc.transact(() => {
            const membersMap = doc.getMap<SyncedMember>('members')
            const member = membersMap.get(targetUserId)
            if (member) {
                membersMap.set(targetUserId, {
                    ...member,
                    role,
                    permissions: { ...DEFAULT_PERMISSIONS[role] }
                })
            }
        })

        console.log('[MemberSync] Updated role:', targetUserId, role)
        return true
    }

    updateMemberPermissions(
        spaceId: string,
        targetUserId: string,
        permissions: Partial<MemberPermissions>
    ): boolean {
        const doc = this.spaceDocs.get(spaceId)
        if (!doc) {
            console.error('[MemberSync] No doc for space:', spaceId)
            return false
        }

        const myUserId = useMemberStore.getState().userId
        const myRole = this.getResolvedRole(spaceId, doc, myUserId)
        const targetRole = this.getResolvedRole(spaceId, doc, targetUserId)
        if (
            !myRole ||
            !targetRole ||
            targetRole === 'owner' ||
            myUserId === targetUserId ||
            !canManageRole(myRole, targetRole)
        ) {
            console.warn('[MemberSync] Permission update blocked: insufficient permissions')
            return false
        }

        doc.transact(() => {
            const membersMap = doc.getMap<SyncedMember>('members')
            const member = membersMap.get(targetUserId)
            if (member) {
                membersMap.set(targetUserId, {
                    ...member,
                    permissions: { ...member.permissions, ...permissions }
                })
            }
        })

        console.log('[MemberSync] Updated permissions:', targetUserId, permissions)
        return true
    }

    getMemberPermissions(spaceId: string, userId: string): MemberPermissions {
        const doc = this.spaceDocs.get(spaceId)
        if (!doc) {
            return DEFAULT_PERMISSIONS.member
        }

        const membersMap = doc.getMap<SyncedMember>('members')
        const member = membersMap.get(userId)

        return member?.permissions || DEFAULT_PERMISSIONS.member
    }

    isUserBanned(spaceId: string, userId: string): boolean {
        const doc = this.spaceDocs.get(spaceId)
        if (!doc) return false

        const bannedMap = doc.getMap<boolean>('banned')
        return bannedMap.get(userId) || false
    }

    getOnlineUsers(spaceId: string): string[] {
        const awareness = this.spaceAwareness.get(spaceId)
        if (!awareness) return []

        const online: string[] = []
        const states = awareness.getStates() as Map<number, AwarenessState>
        states.forEach(state => {
            if (state.user?.id) {
                online.push(state.user.id)
            }
        })
        return online
    }

    cleanup(spaceId: string): void {
        const unsubscribe = this.unsubscribers.get(spaceId)
        if (unsubscribe) {
            unsubscribe()
            this.unsubscribers.delete(spaceId)
        }

        cleanupPeerAuth(spaceId)

        this.spaceDocs.delete(spaceId)
        this.spaceAwareness.delete(spaceId)
        this.verifiedOwners.delete(spaceId)
        this.handledRemoteActions.delete(spaceId)

        console.log('[MemberSync] Cleaned up:', spaceId)
    }
}

export const memberSyncService = new MemberSyncService()

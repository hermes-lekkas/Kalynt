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
import { p2pService, normalizeRoomId } from './p2pService'
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

// Durable signed ban record persisted in doc.getMap('bannedRecords')
export interface BannedMemberRecord {
    userId: string
    displayName: string
    role: WorkspaceRole
    joinedAt: number
    bannedAt: number
    bannedBy: string
    bannedByName?: string
    reason?: string
    initiatorPeerId: string
    initiatorPublicKey: string
    signature: string
}

export function buildBanRecordPayload(
    spaceId: string,
    record: Pick<BannedMemberRecord, 'userId' | 'bannedBy' | 'bannedAt' | 'reason'>
): string {
    return `kalynt-ban-record-v1:${normalizeRoomId(spaceId)}:${record.userId}:${record.bannedBy}:${record.bannedAt}:${record.reason ?? ''}`
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
    private spaceAwarenessCleanups: Map<string, () => void> = new Map()
    private spaceLocalUsers: Map<string, { userId: string; displayName: string }> = new Map()
    private unsubscribers: Map<string, () => void> = new Map()
    private verifiedOwners: Map<string, VerifiedOwnerInfo> = new Map()
    private processingActions: Set<string> = new Set()
    private handledRemoteActions: Map<string, Set<string>> = new Map()
    private banningInProgress: Set<string> = new Set()

    private resolveSpaceKey(spaceId: string): string {
        if (this.spaceDocs.has(spaceId)) return spaceId
        const normalized = normalizeRoomId(spaceId)
        for (const existing of this.spaceDocs.keys()) {
            if (normalizeRoomId(existing) === normalized) return existing
        }
        return spaceId
    }

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

    private async verifyBanRecord(
        spaceId: string,
        doc: Y.Doc,
        record: BannedMemberRecord
    ): Promise<boolean> {
        if (
            !record ||
            typeof record.userId !== 'string' ||
            typeof record.bannedBy !== 'string' ||
            typeof record.bannedAt !== 'number' ||
            typeof record.initiatorPeerId !== 'string' ||
            typeof record.initiatorPublicKey !== 'string' ||
            typeof record.signature !== 'string'
        ) {
            return false
        }

        const ownerRef = doc.getMap<string>('metadata')
        const verifiedOwner = this.verifiedOwners.get(spaceId) || await this.refreshVerifiedOwner(spaceId, ownerRef)
        if (verifiedOwner && record.userId === verifiedOwner.ownerId) {
            return false
        }

        const payload = buildBanRecordPayload(spaceId, record)
        const sigValid = await verifyPayloadSignature(
            payload,
            record.signature,
            record.initiatorPublicKey,
            record.initiatorPeerId
        )
        if (!sigValid) {
            securityLog.peerRejected(record.initiatorPeerId, spaceId, 'invalid_ban_record_signature')
            return false
        }

        let initiatorRole: WorkspaceRole | null = null
        if (verifiedOwner && record.bannedBy === verifiedOwner.ownerId) {
            if (
                verifiedOwner.ownerPeerId !== record.initiatorPeerId ||
                verifiedOwner.ownerPublicKey !== record.initiatorPublicKey
            ) {
                securityLog.peerRejected(record.initiatorPeerId, spaceId, 'ban_record_owner_impersonation')
                return false
            }
            initiatorRole = 'owner'
        } else {
            const membersMap = doc.getMap<SyncedMember>('members')
            const initiatorMember = membersMap.get(record.bannedBy)
            if (initiatorMember?.peerId && initiatorMember.peerId !== record.initiatorPeerId) {
                securityLog.peerRejected(record.initiatorPeerId, spaceId, 'ban_record_member_impersonation')
                return false
            }
            initiatorRole = this.getResolvedRole(spaceId, doc, record.bannedBy)
        }

        if (!initiatorRole) return false
        const targetRole: WorkspaceRole = record.role === 'owner' ? 'member' : (record.role || 'member')
        return canBan(initiatorRole, targetRole)
    }

    private async enforceLocalBanIfNeeded(
        spaceId: string,
        doc: Y.Doc,
        userId: string
    ): Promise<boolean> {
        if (this.banningInProgress.has(spaceId)) return true
        if (this.spaceDocs.get(spaceId) !== doc) return false

        const ownerRef = doc.getMap<string>('metadata')
        const verifiedOwner = this.verifiedOwners.get(spaceId) || await this.refreshVerifiedOwner(spaceId, ownerRef)
        if (verifiedOwner?.ownerId === userId) {
            return false
        }

        const bannedMap = doc.getMap<boolean>('banned')
        const bannedRecordsMap = doc.getMap<BannedMemberRecord>('bannedRecords')
        const record = bannedRecordsMap.get(userId)
        const flagged = Boolean(bannedMap.get(userId))

        if (!record && !flagged) return false

        if (record) {
            const valid = await this.verifyBanRecord(spaceId, doc, record)
            if (!valid) {
                console.warn('[MemberSync] Ignored invalid/unauthorized durable ban record for:', userId)
                return false
            }
        }

        // Re-check after async verification in case space closed or ban was lifted
        if (this.spaceDocs.get(spaceId) !== doc || this.banningInProgress.has(spaceId)) return false
        if (!bannedMap.get(userId) && !bannedRecordsMap.get(userId)) return false

        this.banningInProgress.add(spaceId)
        console.warn('[MemberSync] Enforcing durable ban for local user:', userId)
        this.handleBanned(spaceId, record?.reason)
        return true
    }

    private attachAwareness(
        spaceId: string,
        doc: Y.Doc,
        awareness: Awareness,
        userId: string,
        displayName: string
    ): void {
        const prevCleanup = this.spaceAwarenessCleanups.get(spaceId)
        if (prevCleanup) {
            prevCleanup()
            this.spaceAwarenessCleanups.delete(spaceId)
        }

        this.spaceAwareness.set(spaceId, awareness)

        const membersMap = doc.getMap<SyncedMember>('members')
        const bannedMap = doc.getMap<boolean>('banned')
        const bannedRecordsMap = doc.getMap<BannedMemberRecord>('bannedRecords')
        const role = this.getResolvedRole(spaceId, doc, userId) || 'member'

        awareness.setLocalStateField('user', {
            id: userId,
            name: displayName,
            role
        })

        const identityAnnouncement = createIdentityAnnouncement()
        if (identityAnnouncement) {
            awareness.setLocalStateField('peerIdentity', identityAnnouncement)
        }

        const awarenessHandler = async ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
            if (this.spaceAwareness.get(spaceId) !== awareness) return
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
                this.syncMembersToStore(spaceId, membersMap, bannedMap, bannedRecordsMap, ownerId)
            }
        }

        awareness.on('change', awarenessHandler)
        this.spaceAwarenessCleanups.set(spaceId, () => {
            try {
                awareness.off('change', awarenessHandler)
            } catch {
                // Ignore if awareness already destroyed
            }
        })
    }

    /**
     * Rebind live Awareness after a WebrtcProvider reconnect (e.g. room password change)
     * so presence and moderation actions stay connected to the active provider.
     */
    updateAwareness(spaceId: string, awareness: Awareness): void {
        const key = this.resolveSpaceKey(spaceId)
        const doc = this.spaceDocs.get(key)
        const localUser = this.spaceLocalUsers.get(key)
        if (!doc || !localUser) return
        if (this.spaceAwareness.get(key) === awareness) return

        this.attachAwareness(key, doc, awareness, localUser.userId, localUser.displayName)
        const membersMap = doc.getMap<SyncedMember>('members')
        const bannedMap = doc.getMap<boolean>('banned')
        const bannedRecordsMap = doc.getMap<BannedMemberRecord>('bannedRecords')
        const ownerId = this.verifiedOwners.get(key)?.ownerId || ''
        this.syncMembersToStore(key, membersMap, bannedMap, bannedRecordsMap, ownerId)
        console.log('[MemberSync] Updated awareness binding for space:', key)
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
        const existingKey = this.resolveSpaceKey(spaceId)
        if (this.spaceDocs.has(existingKey)) {
            if (this.spaceAwareness.get(existingKey) !== awareness) {
                this.updateAwareness(existingKey, awareness)
            }
            console.log('[MemberSync] Already initialized for space:', existingKey)
            return
        }

        console.log('[MemberSync] Initializing for space:', spaceId)

        this.spaceDocs.set(spaceId, doc)
        this.spaceAwareness.set(spaceId, awareness)
        this.spaceLocalUsers.set(spaceId, { userId, displayName })
        this.handledRemoteActions.set(spaceId, new Set())
        this.banningInProgress.delete(spaceId)

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
        const bannedRecordsMap = doc.getMap<BannedMemberRecord>('bannedRecords')
        const ownerRef = doc.getMap<string>('metadata')

        // Bail if cleaned up while awaiting identity init
        if (this.spaceDocs.get(spaceId) !== doc) return

        // Verify existing owner proof or create a real ECDSA-signed ownership claim
        const existingOwnerId = ownerRef.get('ownerId')
        let verifiedOwner: VerifiedOwnerInfo | null = null

        if (!existingOwnerId) {
            // If already durably banned before claiming ownership, enforce ban immediately
            if (bannedMap.get(userId) || bannedRecordsMap.get(userId)) {
                const enforced = await this.enforceLocalBanIfNeeded(spaceId, doc, userId)
                if (enforced) return
            }

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

        // Enforce durable ban on startup/rejoin (never blocks the verified owner)
        if (verifiedOwner?.ownerId !== userId && (bannedMap.get(userId) || bannedRecordsMap.get(userId))) {
            const enforced = await this.enforceLocalBanIfNeeded(spaceId, doc, userId)
            if (enforced) return
        }

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

        const memberObserver = () => {
            if (this.spaceDocs.get(spaceId) !== doc) return
            const ownerId = this.verifiedOwners.get(spaceId)?.ownerId || ''
            this.syncMembersToStore(spaceId, membersMap, bannedMap, bannedRecordsMap, ownerId)
            if (ownerId !== userId && (bannedMap.get(userId) || bannedRecordsMap.get(userId))) {
                void this.enforceLocalBanIfNeeded(spaceId, doc, userId)
            }
        }
        const ownerObserver = () => {
            void this.refreshVerifiedOwner(spaceId, ownerRef).then((owner) => {
                if (this.spaceDocs.get(spaceId) !== doc) return
                const ownerId = owner?.ownerId || ''
                this.syncMembersToStore(spaceId, membersMap, bannedMap, bannedRecordsMap, ownerId)
                if (ownerId !== userId && (bannedMap.get(userId) || bannedRecordsMap.get(userId))) {
                    void this.enforceLocalBanIfNeeded(spaceId, doc, userId)
                }
            })
        }

        membersMap.observe(memberObserver)
        bannedMap.observe(memberObserver)
        bannedRecordsMap.observe(memberObserver)
        ownerRef.observe(ownerObserver)

        // Attach to whichever awareness is currently latest (may have swapped while awaiting identity init)
        const activeAwareness = this.spaceAwareness.get(spaceId) || awareness
        this.attachAwareness(spaceId, doc, activeAwareness, userId, displayName)

        // Initial reactive store sync
        this.syncMembersToStore(spaceId, membersMap, bannedMap, bannedRecordsMap, effectiveOwnerId)

        this.unsubscribers.set(spaceId, () => {
            membersMap.unobserve(memberObserver)
            bannedMap.unobserve(memberObserver)
            bannedRecordsMap.unobserve(memberObserver)
            ownerRef.unobserve(ownerObserver)
            const cleanupAwareness = this.spaceAwarenessCleanups.get(spaceId)
            if (cleanupAwareness) {
                cleanupAwareness()
                this.spaceAwarenessCleanups.delete(spaceId)
            }
        })

        console.log('[MemberSync] Initialization complete for:', spaceId)
    }

    /**
     * Sync Y.Map members and durable banned records to Zustand store using IMMUTABLE setState updates
     * so subscribed React components always re-render on P2P changes.
     */
    private syncMembersToStore(
        spaceId: string,
        membersMap: Y.Map<SyncedMember>,
        bannedMap: Y.Map<boolean>,
        bannedRecordsMap: Y.Map<BannedMemberRecord>,
        ownerId: string
    ): void {
        const bannedUsersSet = new Set<string>()
        bannedMap.forEach((isBanned, uid) => {
            if (isBanned && uid !== ownerId) bannedUsersSet.add(uid)
        })
        bannedRecordsMap.forEach((record, uid) => {
            if (record && uid !== ownerId) bannedUsersSet.add(uid)
        })

        const members: WorkspaceMember[] = []
        membersMap.forEach((member) => {
            if (bannedUsersSet.has(member.userId) && member.userId !== ownerId) return
            const safeRole: WorkspaceRole =
                member.userId === ownerId
                    ? 'owner'
                    : member.role === 'owner'
                        ? 'member'
                        : member.role
            members.push({
                ...member,
                role: safeRole,
                isBanned: false,
                isOnline: this.isUserOnline(spaceId, member.userId)
            })
        })

        const bannedMembersById = new Map<string, WorkspaceMember>()
        bannedRecordsMap.forEach((record, uid) => {
            if (!record || uid === ownerId) return
            const safeRole: WorkspaceRole = record.role === 'owner' ? 'member' : (record.role || 'member')
            bannedMembersById.set(uid, {
                userId: record.userId || uid,
                displayName: record.displayName || uid,
                role: safeRole,
                permissions: { ...DEFAULT_PERMISSIONS.viewer },
                joinedAt: record.joinedAt || record.bannedAt || Date.now(),
                isOnline: false,
                isBanned: true,
                bannedAt: record.bannedAt,
                bannedBy: record.bannedByName || record.bannedBy,
                banReason: record.reason
            })
        })
        bannedUsersSet.forEach((uid) => {
            if (bannedMembersById.has(uid)) return
            const staleMember = membersMap.get(uid)
            bannedMembersById.set(uid, {
                userId: uid,
                displayName: staleMember?.displayName || uid,
                role: staleMember?.role === 'owner' ? 'member' : (staleMember?.role || 'member'),
                permissions: staleMember?.permissions || { ...DEFAULT_PERMISSIONS.viewer },
                joinedAt: staleMember?.joinedAt || Date.now(),
                isOnline: false,
                isBanned: true,
                bannedAt: staleMember?.bannedAt,
                bannedBy: staleMember?.bannedBy,
                banReason: staleMember?.banReason
            })
        })

        const bannedMembers = Array.from(bannedMembersById.values()).sort(
            (a, b) => (b.bannedAt ?? 0) - (a.bannedAt ?? 0)
        )
        const bannedUsers = Array.from(bannedUsersSet)

        useMemberStore.setState((state) => {
            const currentInfo = state.spaceMembers[spaceId]
            return {
                spaceMembers: {
                    ...state.spaceMembers,
                    [spaceId]: {
                        ownerId,
                        members,
                        bannedUsers,
                        bannedMembers,
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
                const bannedRecordsMap = doc.getMap<BannedMemberRecord>('bannedRecords')
                bannedMap.delete(action.targetUserId)
                bannedRecordsMap.delete(action.targetUserId)
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
        const key = this.resolveSpaceKey(spaceId)
        const awareness = this.spaceAwareness.get(key)
        const doc = this.spaceDocs.get(key)
        const store = useMemberStore.getState()

        if (!awareness || !doc) {
            console.error('[MemberSync] No awareness/doc for space:', spaceId)
            return false
        }

        const myUserId = store.userId
        const myRole = this.getResolvedRole(key, doc, myUserId)
        const targetRole = this.getResolvedRole(key, doc, targetUserId) || 'member'
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

        const sent = await this.broadcastModerationAction(key, awareness, kickAction)
        if (!sent) return false

        doc.transact(() => {
            const membersMap = doc.getMap<SyncedMember>('members')
            membersMap.delete(targetUserId)
        })

        console.log('[MemberSync] Kicked member:', targetUserId)
        return true
    }

    async banMember(spaceId: string, targetUserId: string, reason?: string): Promise<boolean> {
        const key = this.resolveSpaceKey(spaceId)
        const awareness = this.spaceAwareness.get(key)
        const doc = this.spaceDocs.get(key)
        const store = useMemberStore.getState()

        if (!awareness || !doc) {
            console.error('[MemberSync] No awareness/doc for space:', spaceId)
            return false
        }

        const myUserId = store.userId
        const myRole = this.getResolvedRole(key, doc, myUserId)
        const targetRole = this.getResolvedRole(key, doc, targetUserId) || 'member'
        if (!myRole || myUserId === targetUserId || !canBan(myRole, targetRole)) {
            console.warn('[MemberSync] Local ban blocked: insufficient permissions')
            return false
        }

        const bannedAt = Date.now()
        const membersMap = doc.getMap<SyncedMember>('members')
        const targetMember = membersMap.get(targetUserId)

        const banRecordPayload = buildBanRecordPayload(key, {
            userId: targetUserId,
            bannedBy: myUserId,
            bannedAt,
            reason
        })
        const signedRecord = await signPayload(banRecordPayload)
        if (!signedRecord) {
            console.error('[MemberSync] Cannot sign durable ban record without peer identity')
            return false
        }

        const banRecord: BannedMemberRecord = {
            userId: targetUserId,
            displayName: targetMember?.displayName || targetUserId,
            role: targetMember?.role === 'owner' ? 'member' : (targetMember?.role || 'member'),
            joinedAt: targetMember?.joinedAt || bannedAt,
            bannedAt,
            bannedBy: myUserId,
            bannedByName: store.displayName,
            reason,
            initiatorPeerId: signedRecord.peerId,
            initiatorPublicKey: signedRecord.publicKey,
            signature: signedRecord.signature
        }

        const banAction: ModerationAction = {
            type: 'ban',
            targetUserId,
            initiatorId: myUserId,
            reason,
            timestamp: bannedAt
        }

        const sent = await this.broadcastModerationAction(key, awareness, banAction)
        if (!sent) return false

        doc.transact(() => {
            const bannedMap = doc.getMap<boolean>('banned')
            const bannedRecordsMap = doc.getMap<BannedMemberRecord>('bannedRecords')
            bannedMap.set(targetUserId, true)
            bannedRecordsMap.set(targetUserId, banRecord)
            membersMap.delete(targetUserId)
        })

        console.log('[MemberSync] Banned member:', targetUserId, reason)
        return true
    }

    async unbanMember(spaceId: string, targetUserId: string): Promise<boolean> {
        const key = this.resolveSpaceKey(spaceId)
        const doc = this.spaceDocs.get(key)
        const awareness = this.spaceAwareness.get(key)
        const store = useMemberStore.getState()

        if (!doc) {
            console.error('[MemberSync] No doc for space:', spaceId)
            return false
        }

        const myUserId = store.userId
        const myRole = this.getResolvedRole(key, doc, myUserId)
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
            const sent = await this.broadcastModerationAction(key, awareness, unbanAction)
            if (!sent) return false
        }

        doc.transact(() => {
            const bannedMap = doc.getMap<boolean>('banned')
            const bannedRecordsMap = doc.getMap<BannedMemberRecord>('bannedRecords')
            bannedMap.delete(targetUserId)
            bannedRecordsMap.delete(targetUserId)
        })

        console.log('[MemberSync] Unbanned member:', targetUserId)
        return true
    }

    updateMemberRole(spaceId: string, targetUserId: string, role: WorkspaceRole): boolean {
        const key = this.resolveSpaceKey(spaceId)
        const doc = this.spaceDocs.get(key)
        if (!doc) {
            console.error('[MemberSync] No doc for space:', spaceId)
            return false
        }

        const myUserId = useMemberStore.getState().userId
        const myRole = this.getResolvedRole(key, doc, myUserId)
        const targetRole = this.getResolvedRole(key, doc, targetUserId)
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
        const key = this.resolveSpaceKey(spaceId)
        const doc = this.spaceDocs.get(key)
        if (!doc) {
            console.error('[MemberSync] No doc for space:', spaceId)
            return false
        }

        const myUserId = useMemberStore.getState().userId
        const myRole = this.getResolvedRole(key, doc, myUserId)
        const targetRole = this.getResolvedRole(key, doc, targetUserId)
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
        const key = this.resolveSpaceKey(spaceId)
        const doc = this.spaceDocs.get(key)
        if (!doc) {
            return DEFAULT_PERMISSIONS.member
        }

        const membersMap = doc.getMap<SyncedMember>('members')
        const member = membersMap.get(userId)

        return member?.permissions || DEFAULT_PERMISSIONS.member
    }

    isUserBanned(spaceId: string, userId: string): boolean {
        const key = this.resolveSpaceKey(spaceId)
        const doc = this.spaceDocs.get(key)
        if (!doc) return false

        const bannedMap = doc.getMap<boolean>('banned')
        const bannedRecordsMap = doc.getMap<BannedMemberRecord>('bannedRecords')
        return Boolean(bannedMap.get(userId) || bannedRecordsMap.get(userId))
    }

    getOnlineUsers(spaceId: string): string[] {
        const key = this.resolveSpaceKey(spaceId)
        const awareness = this.spaceAwareness.get(key)
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
        const key = this.resolveSpaceKey(spaceId)
        const unsubscribe = this.unsubscribers.get(key)
        if (unsubscribe) {
            unsubscribe()
            this.unsubscribers.delete(key)
        }

        const awarenessCleanup = this.spaceAwarenessCleanups.get(key)
        if (awarenessCleanup) {
            awarenessCleanup()
            this.spaceAwarenessCleanups.delete(key)
        }

        cleanupPeerAuth(key)

        this.spaceDocs.delete(key)
        this.spaceAwareness.delete(key)
        this.spaceLocalUsers.delete(key)
        this.verifiedOwners.delete(key)
        this.handledRemoteActions.delete(key)
        this.banningInProgress.delete(key)

        console.log('[MemberSync] Cleaned up:', key)
    }
}

export const memberSyncService = new MemberSyncService()

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// SECURITY FIX V-007: Update Integrity Service
// Provides fail-closed HMAC-SHA256 verification for Yjs updates to prevent tampering
// and replay attacks, deriving HMAC keys cleanly without exporting non-extractable keys.

import { getLocalPeerId } from './peerAuthService'
import { encryptionService, deriveDeterministicRoomSalt } from './encryptionService'

// HMAC key derived from room master secret via HKDF
const roomHmacKeys = new Map<string, CryptoKey>()

// Update history for replay attack detection (roomId -> Set<packetHash>)
const updateHistory = new Map<string, Set<string>>()

// Max history entries per room (to prevent memory bloat)
const MAX_HISTORY_SIZE = 10000

const MAX_AGE_MS = 5 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 60 * 1000

// Update source tracking for audit
export interface UpdateSource {
    peerId: string
    timestamp: number
    updateHash: string
    verified: boolean
}

const recentUpdates = new Map<string, UpdateSource[]>() // roomId -> sources

function normalizeRoomId(roomId: string): string {
    return roomId.trim().toLowerCase()
}

function ensureRoomTracking(keyId: string): void {
    if (!updateHistory.has(keyId)) {
        updateHistory.set(keyId, new Set())
    }
    if (!recentUpdates.has(keyId)) {
        recentUpdates.set(keyId, [])
    }
}

/**
 * Derive or bind an HMAC-SHA256 key for a room without ever calling
 * `crypto.subtle.exportKey` on a non-extractable key.
 *
 * Accepts:
 * - a room password string (derives via PBKDF2 -> HKDF using deterministic or provided salt)
 * - raw key material (`Uint8Array`)
 * - an `HKDF` `CryptoKey` with `deriveKey` usage, or an existing `HMAC` `CryptoKey`
 * - an extractable `CryptoKey` (only exported when `key.extractable === true`)
 * - a non-extractable room `CryptoKey` already derived via `encryptionService` (reuses its paired HKDF HMAC key)
 */
export async function deriveHmacKey(
    roomId: string,
    keyOrMaterial: CryptoKey | Uint8Array | string,
    existingSalt?: Uint8Array
): Promise<CryptoKey> {
    const keyId = normalizeRoomId(roomId)

    if (typeof keyOrMaterial === 'string') {
        return initializeFromPassword(keyId, keyOrMaterial, existingSalt)
    }

    const salt = existingSalt && existingSalt.length >= 16
        ? new Uint8Array(existingSalt.slice(0, 16))
        : await deriveDeterministicRoomSalt(keyId)

    if (keyOrMaterial instanceof Uint8Array) {
        const hkdfKey = await crypto.subtle.importKey(
            'raw',
            keyOrMaterial as BufferSource,
            'HKDF',
            false,
            ['deriveKey']
        )
        const hmacKey = await crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                salt: salt as BufferSource,
                info: new TextEncoder().encode(`kalynt:e2ee:v1:hmac:${keyId}`),
                hash: 'SHA-256'
            },
            hkdfKey,
            { name: 'HMAC', hash: 'SHA-256', length: 256 },
            false,
            ['sign', 'verify']
        )
        setHmacKey(keyId, hmacKey)
        return hmacKey
    }

    // CryptoKey branch: never attempt exportKey on non-extractable keys
    if (keyOrMaterial.algorithm.name === 'HMAC') {
        setHmacKey(keyId, keyOrMaterial)
        return keyOrMaterial
    }

    if (keyOrMaterial.algorithm.name === 'HKDF' && keyOrMaterial.usages.includes('deriveKey')) {
        const hmacKey = await crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                salt: salt as BufferSource,
                info: new TextEncoder().encode(`kalynt:e2ee:v1:hmac:${keyId}`),
                hash: 'SHA-256'
            },
            keyOrMaterial,
            { name: 'HMAC', hash: 'SHA-256', length: 256 },
            false,
            ['sign', 'verify']
        )
        setHmacKey(keyId, hmacKey)
        return hmacKey
    }

    // Reuse paired non-extractable HMAC key if encryptionService already derived it for this room
    const pairedHmacKey = encryptionService.getRoomHmacKey(keyId) || roomHmacKeys.get(keyId)
    if (pairedHmacKey) {
        setHmacKey(keyId, pairedHmacKey)
        return pairedHmacKey
    }

    if (!keyOrMaterial.extractable) {
        throw new Error(
            '[Integrity] Cannot derive HMAC key from a non-extractable CryptoKey. ' +
            'Use initializeFromPassword(roomId, password, salt) or pass HKDF key material.'
        )
    }

    // Explicit extractable key compatibility path
    const rawMaterial = await crypto.subtle.exportKey('raw', keyOrMaterial)
    return deriveHmacKey(keyId, new Uint8Array(rawMaterial), salt)
}

/**
 * Set HMAC key directly (when key is already derived via encryptionService HKDF)
 */
export function setHmacKey(roomId: string, key: CryptoKey): void {
    const keyId = normalizeRoomId(roomId)
    roomHmacKeys.set(keyId, key)
    ensureRoomTracking(keyId)
}

/**
 * Initialize HMAC key from password + deterministic/shared room salt via PBKDF2->HKDF.
 */
export async function initializeFromPassword(
    roomId: string,
    password: string,
    existingSalt?: Uint8Array
): Promise<CryptoKey> {
    const keyId = normalizeRoomId(roomId)
    const { hmacKey } = await encryptionService.deriveRoomKeys(keyId, password, existingSalt)
    roomHmacKeys.set(keyId, hmacKey)
    updateHistory.set(keyId, new Set())
    recentUpdates.set(keyId, [])

    console.log('[Integrity] Initialized for room:', keyId.substring(0, 8))
    return hmacKey
}

/**
 * Create signed update with HMAC
 * Format: [timestamp (8 bytes)][peerId length (1 byte)][peerId][HMAC (32 bytes)][original update]
 */
export async function signUpdate(
    roomId: string,
    update: Uint8Array
): Promise<Uint8Array> {
    const keyId = normalizeRoomId(roomId)
    const hmacKey = roomHmacKeys.get(keyId)
    if (!hmacKey) {
        // No HMAC key - return unsigned update
        return update
    }

    const peerId = (getLocalPeerId() || 'unknown').slice(0, 64)
    const peerIdBytes = new TextEncoder().encode(peerId)
    const timestamp = Date.now()

    const timestampBytes = new Uint8Array(8)
    const view = new DataView(timestampBytes.buffer)
    view.setBigUint64(0, BigInt(timestamp), false) // Big-endian

    const dataToSign = new Uint8Array(
        timestampBytes.length + peerIdBytes.length + update.length
    )
    dataToSign.set(timestampBytes, 0)
    dataToSign.set(peerIdBytes, timestampBytes.length)
    dataToSign.set(update, timestampBytes.length + peerIdBytes.length)

    const signature = await crypto.subtle.sign('HMAC', hmacKey, dataToSign)
    const hmacBytes = new Uint8Array(signature)

    const signedUpdate = new Uint8Array(
        8 + 1 + peerIdBytes.length + 32 + update.length
    )

    let offset = 0
    signedUpdate.set(timestampBytes, offset)
    offset += 8

    signedUpdate[offset] = peerIdBytes.length
    offset += 1

    signedUpdate.set(peerIdBytes, offset)
    offset += peerIdBytes.length

    signedUpdate.set(hmacBytes, offset)
    offset += 32

    signedUpdate.set(update, offset)

    return signedUpdate
}

/**
 * Verify and extract update from signed payload.
 * Fails CLOSED (returns null) whenever integrity verification is enabled for
 * the room and the packet is missing a valid header, stale, tampered, or replayed.
 */
export async function verifyUpdate(
    roomId: string,
    signedUpdate: Uint8Array
): Promise<{
    update: Uint8Array
    peerId: string
    timestamp: number
    verified: boolean
} | null> {
    const keyId = normalizeRoomId(roomId)
    const hmacKey = roomHmacKeys.get(keyId)

    // Integrity verification is disabled for this room
    if (!hmacKey) {
        return {
            update: signedUpdate,
            peerId: 'unknown',
            timestamp: Date.now(),
            verified: false
        }
    }

    // Fail closed: minimum signed frame is 8 (ts) + 1 (len) + 1 (peerId) + 32 (hmac) + 1 (payload) = 43 bytes
    if (signedUpdate.length < 43) {
        console.warn('[Integrity] Rejecting undersized unsigned packet for room:', keyId.substring(0, 8))
        return null
    }

    let offset = 0

    const timestampBytes = signedUpdate.slice(offset, offset + 8)
    const view = new DataView(timestampBytes.buffer, timestampBytes.byteOffset, 8)
    const timestamp = Number(view.getBigUint64(0, false))
    offset += 8

    const peerIdLength = signedUpdate[offset]
    offset += 1

    if (peerIdLength === 0 || peerIdLength > 64 || offset + peerIdLength + 32 > signedUpdate.length) {
        console.warn('[Integrity] Rejecting malformed update header for room:', keyId.substring(0, 8))
        return null
    }

    const peerIdBytes = signedUpdate.slice(offset, offset + peerIdLength)
    const peerId = new TextDecoder().decode(peerIdBytes)
    offset += peerIdLength

    const receivedHmac = signedUpdate.slice(offset, offset + 32)
    offset += 32

    const update = signedUpdate.slice(offset)

    // Verify timestamp freshness (reject stale or far-future timestamps)
    const now = Date.now()
    if (!Number.isFinite(timestamp) || now - timestamp > MAX_AGE_MS || timestamp - now > MAX_FUTURE_SKEW_MS) {
        console.warn('[Integrity] Rejecting stale/out-of-window update from:', peerId.substring(0, 8))
        return null
    }

    // Reconstruct signed data
    const dataToVerify = new Uint8Array(
        timestampBytes.length + peerIdBytes.length + update.length
    )
    dataToVerify.set(timestampBytes, 0)
    dataToVerify.set(peerIdBytes, timestampBytes.length)
    dataToVerify.set(update, timestampBytes.length + peerIdBytes.length)

    // Verify HMAC
    try {
        const valid = await crypto.subtle.verify(
            'HMAC',
            hmacKey,
            receivedHmac,
            dataToVerify
        )

        if (!valid) {
            console.warn('[Integrity] HMAC verification failed for update from:', peerId.substring(0, 8))
            return null
        }
    } catch (e) {
        console.error('[Integrity] HMAC verification error:', e)
        return null
    }

    // Check for replay attack using full signed packet metadata + payload
    const packetHash = await hashUpdate(dataToVerify)
    const history = updateHistory.get(keyId)
    if (history) {
        if (history.has(packetHash)) {
            console.warn('[Integrity] Replay attack detected - duplicate update from:', peerId.substring(0, 8))
            return null
        }

        if (history.size >= MAX_HISTORY_SIZE) {
            const toRemove = Math.floor(MAX_HISTORY_SIZE * 0.1)
            const entries = Array.from(history)
            for (let i = 0; i < toRemove; i++) {
                history.delete(entries[i])
            }
        }
        history.add(packetHash)
    }

    logUpdateSource(keyId, {
        peerId,
        timestamp,
        updateHash: packetHash,
        verified: true
    })

    return { update, peerId, timestamp, verified: true }
}

/**
 * Check if update has valid integrity header layout (without full verification)
 */
export function hasIntegrityHeader(data: Uint8Array): boolean {
    if (data.length < 43) return false
    const peerIdLength = data[8]
    return peerIdLength > 0 && peerIdLength <= 64 && 9 + peerIdLength + 32 <= data.length
}

async function hashUpdate(update: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', update as BufferSource)
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .substring(0, 32)
}

function logUpdateSource(roomId: string, source: UpdateSource): void {
    const sources = recentUpdates.get(roomId) || []
    if (sources.length >= 100) {
        sources.shift()
    }
    sources.push(source)
    recentUpdates.set(roomId, sources)
}

export function getRecentUpdates(roomId: string): UpdateSource[] {
    return recentUpdates.get(normalizeRoomId(roomId)) || []
}

export function cleanupRoom(roomId: string): void {
    const keyId = normalizeRoomId(roomId)
    roomHmacKeys.delete(keyId)
    updateHistory.delete(keyId)
    recentUpdates.delete(keyId)
    console.log('[Integrity] Cleaned up room:', keyId.substring(0, 8))
}

export function isIntegrityEnabled(roomId: string): boolean {
    return roomHmacKeys.has(normalizeRoomId(roomId))
}

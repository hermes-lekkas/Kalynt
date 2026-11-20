/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Encrypted WebRTC Provider - Encrypts/decrypts binary updates with AES-256-GCM
// and HMAC-SHA256 integrity verification, unified with encryptionService's
// deterministic room salt + PBKDF2->HKDF key derivation.

import * as Y from 'yjs'
import { encryptionService, deriveDeterministicRoomSalt } from './encryptionService'
import {
    signUpdate,
    verifyUpdate,
    setHmacKey,
    cleanupRoom as cleanupIntegrity,
    isIntegrityEnabled,
    hasIntegrityHeader
} from './updateIntegrityService'

const ALGORITHM = 'AES-GCM'
export const ENCRYPTED_REMOTE_ORIGIN = 'kalynt-encrypted-remote'

// Cached derived AES keys (never raw passwords)
const derivedKeys = new Map<string, CryptoKey>()
const roomSalts = new Map<string, Uint8Array>()

function normalizeRoomId(roomId: string): string {
    return roomId.trim().toLowerCase()
}

async function hashPassword(password: string): Promise<string> {
    const data = new TextEncoder().encode(password)
    const hash = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .substring(0, 16)
}

/**
 * Derive room AES-256-GCM key using the unified deterministic room salt
 * (or an explicit shared salt when provided).
 */
export async function deriveRoomKey(
    roomId: string,
    password: string,
    existingSalt?: Uint8Array
): Promise<{ key: CryptoKey; salt: Uint8Array }> {
    const keyId = normalizeRoomId(roomId)
    const salt = existingSalt && existingSalt.length >= 16
        ? new Uint8Array(existingSalt.slice(0, 16))
        : (roomSalts.get(keyId) || await deriveDeterministicRoomSalt(keyId))

    const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('')
    const cacheKey = `${keyId}:${saltHex}:${await hashPassword(password)}`
    const cached = derivedKeys.get(cacheKey)
    if (cached) return { key: cached, salt }

    const bundle = await encryptionService.deriveRoomKeys(keyId, password, salt)
    derivedKeys.set(cacheKey, bundle.aesKey)
    roomSalts.set(keyId, bundle.salt)
    return { key: bundle.aesKey, salt: bundle.salt }
}

export function getRoomSalt(roomId: string): Uint8Array | undefined {
    const keyId = normalizeRoomId(roomId)
    return roomSalts.get(keyId) || encryptionService.getRoomSalt(keyId)
}

export function setRoomSalt(roomId: string, salt: Uint8Array): void {
    roomSalts.set(normalizeRoomId(roomId), new Uint8Array(salt.slice(0, 16)))
}

/**
 * Encrypt binary update with AES-256-GCM.
 * Output format: [iv (12 bytes)][ciphertext + 16-byte GCM auth tag]
 */
export async function encryptUpdate(update: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
        { name: ALGORITHM, iv },
        key,
        update as BufferSource
    )

    const result = new Uint8Array(12 + encrypted.byteLength)
    result.set(iv, 0)
    result.set(new Uint8Array(encrypted), 12)
    return result
}

/**
 * Decrypt binary update with AES-256-GCM.
 */
export async function decryptUpdate(encryptedData: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
    const iv = encryptedData.slice(0, 12)
    const ciphertext = encryptedData.slice(12)

    const decrypted = await crypto.subtle.decrypt(
        { name: ALGORITHM, iv },
        key,
        ciphertext
    )

    return new Uint8Array(decrypted)
}

export interface RoomEncryptionState {
    enabled: boolean
    key: CryptoKey | null
    pendingKey: Promise<CryptoKey> | null
}

const roomStates = new Map<string, RoomEncryptionState>()

/**
 * Initialize encryption and HMAC integrity verification for a room.
 * Synchronizes the exact same deterministic key bundle across `encryptedProvider`,
 * `encryptionService`, and `updateIntegrityService`.
 */
export async function initializeRoomEncryption(
    roomId: string,
    password: string,
    existingSalt?: Uint8Array
): Promise<Uint8Array> {
    const keyId = normalizeRoomId(roomId)
    const state: RoomEncryptionState = {
        enabled: true,
        key: null,
        pendingKey: null
    }
    roomStates.set(keyId, state)

    const derivePromise = (async () => {
        const salt = await encryptionService.setRoomKey(keyId, password, existingSalt)
        const aesKey = encryptionService.getRoomKey(keyId)
        const hmacKey = encryptionService.getRoomHmacKey(keyId)
        if (!aesKey || !hmacKey) {
            throw new Error('Failed to derive room encryption keys')
        }
        return { aesKey, hmacKey, salt }
    })()

    state.pendingKey = derivePromise.then(r => r.aesKey)

    try {
        const { aesKey, hmacKey, salt } = await derivePromise
        // Only commit if this state is still the active state for the room
        if (roomStates.get(keyId) === state) {
            state.key = aesKey
            state.pendingKey = null
            roomSalts.set(keyId, salt)
            setHmacKey(keyId, hmacKey)
        }
        console.log(`[Encryption] Room ${keyId} encryption and integrity initialized`)
        return salt
    } catch (error) {
        if (roomStates.get(keyId) === state) {
            state.pendingKey = null
        }
        throw error
    }
}

/**
 * Disable encryption and clear all keys/integrity state for a room.
 */
export function disableRoomEncryption(roomId: string): void {
    const keyId = normalizeRoomId(roomId)
    roomStates.delete(keyId)
    roomSalts.delete(keyId)
    for (const cacheKey of Array.from(derivedKeys.keys())) {
        if (cacheKey.startsWith(`${keyId}:`)) {
            derivedKeys.delete(cacheKey)
        }
    }
    cleanupIntegrity(keyId)
    encryptionService.clearRoomKey(keyId)
    console.log(`[Encryption] Room ${keyId} encryption disabled`)
}

export function getRoomEncryptionState(roomId: string): RoomEncryptionState | null {
    return roomStates.get(normalizeRoomId(roomId)) || null
}

export function isRoomEncryptionReady(roomId: string): boolean {
    const state = roomStates.get(normalizeRoomId(roomId))
    return state?.enabled === true && state?.key !== null
}

/**
 * Sign (HMAC-SHA256) and encrypt (AES-256-GCM) an outgoing room message.
 */
export async function encryptRoomMessage(
    roomId: string,
    data: Uint8Array
): Promise<Uint8Array> {
    const keyId = normalizeRoomId(roomId)
    const state = roomStates.get(keyId)
    if (!state?.enabled) {
        return data
    }
    if (!state.key) throw new Error('Room encryption is not ready')

    try {
        let dataToEncrypt = data
        if (isIntegrityEnabled(keyId)) {
            dataToEncrypt = await signUpdate(keyId, data)
        }
        return await encryptUpdate(dataToEncrypt, state.key)
    } catch (e) {
        console.error('[Encryption] Failed to encrypt:', e)
        throw new Error('Encryption failed')
    }
}

/**
 * Decrypt (AES-256-GCM) and verify (HMAC-SHA256) an incoming room message.
 */
export async function decryptRoomMessage(
    roomId: string,
    data: Uint8Array
): Promise<Uint8Array> {
    const keyId = normalizeRoomId(roomId)
    const state = roomStates.get(keyId)

    if (!state?.enabled) {
        return data
    }
    if (!state.key) throw new Error('Room encryption is not ready')

    try {
        // AES-GCM IVs are random: every first-byte value, including zero, is
        // valid. Encrypted rooms always authenticate; never accept plaintext downgrades.
        if (data.length < 12 + 16) throw new Error('Invalid encrypted message')
        const decrypted = await decryptUpdate(data, state.key)

        if (isIntegrityEnabled(keyId) && hasIntegrityHeader(decrypted)) {
            const verified = await verifyUpdate(keyId, decrypted)
            if (!verified || !verified.verified) {
                console.error('[Encryption] Integrity verification failed - rejecting update')
                throw new Error('Integrity verification failed')
            }
            return verified.update
        }

        return decrypted
    } catch (e) {
        console.error('[Encryption] Failed to decrypt:', e)
        throw new Error('Decryption failed - wrong key?')
    }
}

/**
 * Encrypt a Yjs document update for transmission over an untrusted channel.
 */
export async function encodeEncryptedUpdate(
    roomId: string,
    update: Uint8Array
): Promise<Uint8Array> {
    return encryptRoomMessage(roomId, update)
}

/**
 * Decrypt, verify integrity, and apply a remote encrypted Yjs update to a Y.Doc.
 */
export async function applyEncryptedUpdate(
    roomId: string,
    doc: Y.Doc,
    encryptedUpdate: Uint8Array,
    origin: unknown = ENCRYPTED_REMOTE_ORIGIN
): Promise<void> {
    const plainUpdate = await decryptRoomMessage(roomId, encryptedUpdate)
    Y.applyUpdate(doc, plainUpdate, origin)
}

export interface EncryptedDocOptions {
    /** Invoked with each AES-GCM encrypted (+ HMAC signed) local Yjs update. */
    onEncryptedUpdate?: (encrypted: Uint8Array, origin: unknown) => void
    /** Invoked if encrypting a local update fails (never silently falls back to plaintext). */
    onError?: (error: Error) => void
}

/**
 * Wrap a Y.Doc with real update encryption interception when `onEncryptedUpdate`
 * is provided, or verify active encryption readiness for y-webrtc key delegation.
 */
export function createEncryptedDoc(
    roomId: string,
    baseDoc?: Y.Doc,
    options?: EncryptedDocOptions
): Y.Doc {
    const keyId = normalizeRoomId(roomId)
    const doc = baseDoc || new Y.Doc()
    const state = roomStates.get(keyId)

    if (state?.enabled && !state.key && !state.pendingKey) {
        throw new Error(`Room encryption for ${keyId} is enabled but has no derived key`)
    }

    if (options?.onEncryptedUpdate) {
        const updateHandler = (update: Uint8Array, origin: unknown) => {
            if (origin === ENCRYPTED_REMOTE_ORIGIN) return

            const currentState = roomStates.get(keyId)
            const run = async () => {
                if (currentState?.enabled && !currentState.key && currentState.pendingKey) {
                    await currentState.pendingKey
                }
                const payload = await encryptRoomMessage(keyId, update)
                options.onEncryptedUpdate?.(payload, origin)
            }

            run().catch(err => {
                const error = err instanceof Error ? err : new Error(String(err))
                console.error(`[Encryption] Failed to encrypt doc update for ${keyId}:`, error)
                options.onError?.(error)
            })
        }

        doc.on('update', updateHandler)
        doc.on('destroy', () => {
            doc.off('update', updateHandler)
        })
    }

    return doc
}

/**
 * LRU Cache with size limit and TTL cleanup for decrypted data.
 */
export class LRUCache<K, V> {
    private readonly cache = new Map<K, { value: V; timestamp: number }>()
    private readonly maxSize: number
    private readonly ttlMs: number
    private cleanupInterval: ReturnType<typeof setInterval> | null = null

    constructor(maxSize: number = 1000, ttlMs: number = 2 * 60 * 1000) {
        this.maxSize = maxSize
        this.ttlMs = ttlMs
        this.startBackgroundCleanup()
    }

    private startBackgroundCleanup(): void {
        if (this.cleanupInterval) return

        this.cleanupInterval = setInterval(() => {
            this.clearExpired()
        }, 30 * 1000)
        const maybeTimer = this.cleanupInterval as unknown as { unref?: () => void }
        maybeTimer.unref?.()
    }

    clearExpired(): number {
        const now = Date.now()
        let expiredCount = 0

        for (const [key, entry] of this.cache) {
            if (now - entry.timestamp > this.ttlMs) {
                this.cache.delete(key)
                expiredCount++
            }
        }

        if (expiredCount > 0) {
            console.log(`[LRUCache] Cleared ${expiredCount} expired entries`)
        }
        return expiredCount
    }

    get(key: K): V | undefined {
        const entry = this.cache.get(key)
        if (!entry) return undefined

        if (Date.now() - entry.timestamp > this.ttlMs) {
            this.cache.delete(key)
            return undefined
        }

        this.cache.delete(key)
        this.cache.set(key, { ...entry, timestamp: Date.now() })

        return entry.value
    }

    set(key: K, value: V): void {
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value
            if (firstKey !== undefined) {
                this.cache.delete(firstKey)
            }
        }

        this.cache.set(key, { value, timestamp: Date.now() })
    }

    has(key: K): boolean {
        return this.get(key) !== undefined
    }

    clear(): void {
        this.cache.clear()
    }

    size(): number {
        return this.cache.size
    }

    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval)
            this.cleanupInterval = null
        }
        this.cache.clear()
    }
}

// Export singleton cache for message decryption
export const decryptionCache = new LRUCache<string, string>(1000, 5 * 60 * 1000)

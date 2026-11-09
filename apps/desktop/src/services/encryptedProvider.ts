/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Encrypted WebRTC Provider - Encrypts Yjs updates at the network layer
// This wraps y-webrtc to encrypt/decrypt binary update messages
// SECURITY FIX V-007: Added HMAC integrity verification for updates

import * as Y from 'yjs'
import {
    signUpdate,
    verifyUpdate,
    initializeFromPassword as initIntegrity,
    cleanupRoom as cleanupIntegrity,
    isIntegrityEnabled,
    hasIntegrityHeader
} from './updateIntegrityService'

// Encryption key storage (derived keys, never raw passwords)
const derivedKeys = new Map<string, CryptoKey>()

// Encryption config
const ALGORITHM = 'AES-GCM'
const KEY_LENGTH = 256
const PBKDF2_ITERATIONS = 100000

// SECURITY FIX V-003: Store salts for rooms
const roomSalts = new Map<string, Uint8Array>()

/**
 * Derive encryption key from password using PBKDF2
 * SECURITY FIX V-003: Use random salt combined with roomId for proper entropy
 * Key is derived once and cached - never store raw password
 */
export async function deriveRoomKey(
    roomId: string,
    password: string,
    existingSalt?: Uint8Array
): Promise<{ key: CryptoKey; salt: Uint8Array }> {
    // Generate or use existing salt
    let salt: Uint8Array
    if (existingSalt && existingSalt.length >= 16) {
        salt = existingSalt.slice(0, 16)
    } else {
        // Check if we have a cached salt for this room
        const cachedSalt = roomSalts.get(roomId)
        if (cachedSalt) {
            salt = cachedSalt
        } else {
            // SECURITY FIX V-003: Generate random salt XOR'd with roomId hash
            const randomSalt = crypto.getRandomValues(new Uint8Array(16))
            const roomIdHash = await crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(roomId)
            )
            const roomIdBytes = new Uint8Array(roomIdHash).slice(0, 16)
            salt = new Uint8Array(16)
            for (let i = 0; i < 16; i++) {
                salt[i] = randomSalt[i] ^ roomIdBytes[i]
            }
            roomSalts.set(roomId, salt)
        }
    }

    // Check cache with salt included in key
    const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('')
    const cacheKey = `${roomId}:${saltHex}:${await hashPassword(password)}`
    const cached = derivedKeys.get(cacheKey)
    if (cached) return { key: cached, salt }

    // Import password as key material
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits', 'deriveKey']
    )

    // Derive AES key
    const key = await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt as BufferSource,
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: ALGORITHM, length: KEY_LENGTH },
        false, // not extractable - more secure
        ['encrypt', 'decrypt']
    )

    derivedKeys.set(cacheKey, key)
    roomSalts.set(roomId, salt)
    return { key, salt }
}

/**
 * Get salt for a room (for sharing with peers)
 */
export function getRoomSalt(roomId: string): Uint8Array | undefined {
    return roomSalts.get(roomId)
}

/**
 * Set salt for a room (when receiving from peer/owner)
 */
export function setRoomSalt(roomId: string, salt: Uint8Array): void {
    roomSalts.set(roomId, salt)
}

/**
 * Hash password for cache key (not for storage)
 */
async function hashPassword(password: string): Promise<string> {
    const data = new TextEncoder().encode(password)
    const hash = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .substring(0, 16) // Truncate for cache key
}

/**
 * Encrypt Yjs update (binary data) - SYNCHRONOUS after key is derived
 * Uses streaming encryption for real-time updates
 */
export async function encryptUpdate(update: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
    // Generate random IV (12 bytes for GCM)
    const iv = crypto.getRandomValues(new Uint8Array(12))

    // Encrypt the update
    const encrypted = await crypto.subtle.encrypt(
        { name: ALGORITHM, iv },
        key,
        update as BufferSource
    )

    // Combine: [iv (12 bytes)][encrypted data]
    const result = new Uint8Array(12 + encrypted.byteLength)
    result.set(iv, 0)
    result.set(new Uint8Array(encrypted), 12)

    return result
}

/**
 * Decrypt Yjs update (binary data)
 */
export async function decryptUpdate(encryptedData: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
    // Extract IV (first 12 bytes)
    const iv = encryptedData.slice(0, 12)
    const ciphertext = encryptedData.slice(12)

    // Decrypt
    const decrypted = await crypto.subtle.decrypt(
        { name: ALGORITHM, iv },
        key,
        ciphertext
    )

    return new Uint8Array(decrypted)
}

/**
 * Encryption state for a room
 */
interface RoomEncryptionState {
    enabled: boolean
    key: CryptoKey | null
    pendingKey: Promise<CryptoKey> | null
}

const roomStates = new Map<string, RoomEncryptionState>()

/**
 * Initialize encryption for a room
 * SECURITY FIX V-003: Returns salt for sharing with peers
 * SECURITY FIX V-007: Also initializes HMAC integrity verification
 */
export async function initializeRoomEncryption(
    roomId: string,
    password: string,
    existingSalt?: Uint8Array
): Promise<Uint8Array> {
    const state: RoomEncryptionState = {
        enabled: true,
        key: null,
        pendingKey: null
    }
    roomStates.set(roomId, state)

    // Derive key in background
    const keyPromise = deriveRoomKey(roomId, password, existingSalt)
    state.pendingKey = keyPromise.then(r => r.key)
    const result = await keyPromise
    state.key = result.key
    state.pendingKey = null

    // SECURITY FIX V-007: Initialize integrity verification
    try {
        await initIntegrity(roomId, password)
        console.log(`[Encryption] Room ${roomId} integrity verification initialized`)
    } catch (e) {
        console.error('[Encryption] Failed to initialize integrity:', e)
    }

    console.log(`[Encryption] Room ${roomId} encryption initialized`)
    return result.salt
}

/**
 * Disable encryption for a room
 * SECURITY FIX V-007: Also cleanup integrity verification state
 */
export function disableRoomEncryption(roomId: string): void {
    roomStates.delete(roomId)
    // SECURITY FIX V-007: Cleanup integrity state
    cleanupIntegrity(roomId)
    console.log(`[Encryption] Room ${roomId} encryption disabled`)
}

/**
 * Get encryption state for a room
 */
export function getRoomEncryptionState(roomId: string): RoomEncryptionState | null {
    return roomStates.get(roomId) || null
}

/**
 * Check if room has encryption ready (key derived)
 */
export function isRoomEncryptionReady(roomId: string): boolean {
    const state = roomStates.get(roomId)
    return state?.enabled === true && state?.key !== null
}

/**
 * Encrypt outgoing message for a room
 * SECURITY FIX V-007: Also signs message with HMAC for integrity
 */
export async function encryptRoomMessage(
    roomId: string,
    data: Uint8Array
): Promise<Uint8Array> {
    const state = roomStates.get(roomId)
    if (!state?.enabled) {
        return data // Return unencrypted if not enabled
    }
    if (!state.key) throw new Error('Room encryption is not ready')

    try {
        // SECURITY FIX V-007: Sign the data before encryption
        let dataToEncrypt = data
        if (isIntegrityEnabled(roomId)) {
            dataToEncrypt = await signUpdate(roomId, data)
        }
        return await encryptUpdate(dataToEncrypt, state.key)
    } catch (e) {
        console.error('[Encryption] Failed to encrypt:', e)
        throw new Error('Encryption failed')
    }
}

/**
 * Decrypt incoming message for a room
 * SECURITY FIX V-007: Also verifies HMAC integrity after decryption
 */
export async function decryptRoomMessage(
    roomId: string,
    data: Uint8Array
): Promise<Uint8Array> {
    const state = roomStates.get(roomId)

    // If encryption not enabled, return as-is
    if (!state?.enabled) {
        return data
    }
    if (!state.key) throw new Error('Room encryption is not ready')

    try {
        // AES-GCM IVs are random: every first-byte value, including zero, is
        // valid. Encrypted rooms always authenticate; do not guess whether a
        // packet is plaintext from its contents or accept a legacy downgrade.
        if (data.length < 12 + 16) throw new Error('Invalid encrypted message')
        const decrypted = await decryptUpdate(data, state.key)

        // SECURITY FIX V-007: Verify integrity if enabled
        if (isIntegrityEnabled(roomId) && hasIntegrityHeader(decrypted)) {
            const verified = await verifyUpdate(roomId, decrypted)
            if (!verified) {
                console.error('[Encryption] Integrity verification failed - rejecting update')
                throw new Error('Integrity verification failed')
            }
            if (!verified.verified) {
                console.warn('[Encryption] Update not verified (legacy peer?):', verified.peerId)
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
 * Create encrypted document with update interception
 * This wraps a Y.Doc to encrypt/decrypt updates
 */
export function createEncryptedDoc(roomId: string, baseDoc?: Y.Doc): Y.Doc {
    const doc = baseDoc || new Y.Doc()
    const state = roomStates.get(roomId)

    if (state?.enabled && state.key) {
        // Note: Full encryption happens at the y-webrtc provider level
        // This doc instance will have its updates encrypted before network transmission
        console.log('[Encryption] Created encrypted doc wrapper for', roomId)
    }

    return doc
}

/**
 * LRU Cache with size limit for decrypted data
 * SECURITY FIX V-008: Added background TTL cleanup and shorter TTL
 */
export class LRUCache<K, V> {
    private readonly cache = new Map<K, { value: V; timestamp: number }>()
    private readonly maxSize: number
    private readonly ttlMs: number
    private cleanupInterval: ReturnType<typeof setInterval> | null = null

    // SECURITY FIX V-008: Reduced default TTL to 2 minutes for security
    constructor(maxSize: number = 1000, ttlMs: number = 2 * 60 * 1000) {
        this.maxSize = maxSize
        this.ttlMs = ttlMs

        // SECURITY FIX V-008: Start background cleanup every 30 seconds
        this.startBackgroundCleanup()
    }

    /**
     * SECURITY FIX V-008: Background cleanup of expired entries
     */
    private startBackgroundCleanup(): void {
        if (this.cleanupInterval) return

        this.cleanupInterval = setInterval(() => {
            this.clearExpired()
        }, 30 * 1000) // Run every 30 seconds
    }

    /**
     * SECURITY FIX V-008: Clear all expired entries proactively
     */
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

        // Check TTL
        if (Date.now() - entry.timestamp > this.ttlMs) {
            this.cache.delete(key)
            return undefined
        }

        // Move to end (most recently used)
        this.cache.delete(key)
        this.cache.set(key, { ...entry, timestamp: Date.now() })

        return entry.value
    }

    set(key: K, value: V): void {
        // Remove oldest if at capacity
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

    /**
     * SECURITY FIX V-008: Stop background cleanup (call on app shutdown)
     */
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

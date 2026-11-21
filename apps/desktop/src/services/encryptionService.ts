/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Encryption Service - E2E encryption for P2P communication
// Uses Web Crypto API with deterministic room salt + PBKDF2->HKDF key separation
// so all peers joining with the same roomId & password derive the exact same
// non-extractable AES-256-GCM encryption key and HMAC-SHA256 integrity key.
import { securityLog } from './auditLogService'

export interface EncryptedPayload {
    iv: string // Base64 initialization vector
    data: string // Base64 encrypted data
    // Note: For AES-GCM, the authentication tag is embedded in the ciphertext
    // returned by crypto.subtle.encrypt, so we don't need a separate tag field
}

export interface KeyPair {
    publicKey: CryptoKey
    privateKey: CryptoKey
}

export interface EncryptionConfig {
    algorithm: 'AES-GCM' | 'AES-CBC'
    keyLength: 128 | 256
    pbkdf2Iterations: number
}

export interface RoomKeyBundle {
    aesKey: CryptoKey
    hmacKey: CryptoKey
    salt: Uint8Array
    /** Non-secret 16-byte key-confirmation tag used to verify peers share the same room key. */
    keyCheck: string
}

/** Room encryption protocol version (v2.0 = 1/unspecified, v2.1+ deterministic PBKDF2->HKDF = 2). */
export const ROOM_ENCRYPTION_PROTOCOL_VERSION = 2

type KeyChangeListener = (roomId: string, hasKey: boolean) => void

const DEFAULT_CONFIG: EncryptionConfig = {
    algorithm: 'AES-GCM',
    keyLength: 256,
    pbkdf2Iterations: 100000
}

// Maximum number of room keys to keep in memory (LRU eviction)
const MAX_ROOM_KEYS = 50
// SECURITY FIX V-008: Key expiration timeout (10 minutes of inactivity)
const KEY_EXPIRATION_MS = 10 * 60 * 1000

const SALT_DOMAIN = 'kalynt:e2ee:v1:salt:'
const AES_INFO_PREFIX = 'kalynt:e2ee:v1:aes-gcm:'
const HMAC_INFO_PREFIX = 'kalynt:e2ee:v1:hmac:'
const KEY_CHECK_PREFIX = 'kalynt:e2ee:v2:key-check:'

function normalizeRoomKeyId(roomId: string): string {
    return roomId.trim().toLowerCase()
}

/**
 * Derive a deterministic 16-byte room salt from the normalized roomId.
 * Every peer joining the same room with the same password computes the exact
 * same salt without race-prone salt exchange or random divergence, while still
 * domain-separating keys across different rooms.
 */
export async function deriveDeterministicRoomSalt(roomId: string): Promise<Uint8Array> {
    const normalized = normalizeRoomKeyId(roomId)
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${SALT_DOMAIN}${normalized}`)
    )
    return new Uint8Array(digest).slice(0, 16)
}

class EncryptionService {
    private config: EncryptionConfig = DEFAULT_CONFIG
    private roomKeys: Map<string, CryptoKey> = new Map()
    private roomHmacKeys: Map<string, CryptoKey> = new Map()
    private roomSalts: Map<string, Uint8Array> = new Map()
    private roomKeyChecks: Map<string, string> = new Map()
    private keyAccessOrder: string[] = [] // Track access order for LRU eviction
    private keyAccessTimes: Map<string, number> = new Map()
    private keyChangeListeners: Set<KeyChangeListener> = new Set()
    private cleanupInterval: ReturnType<typeof setInterval> | null = null

    constructor() {
        this.startKeyExpirationCheck()
    }

    private startKeyExpirationCheck(): void {
        if (this.cleanupInterval) return

        this.cleanupInterval = setInterval(() => {
            this.clearExpiredKeys()
        }, 60 * 1000)
        // Do not keep Node test runners alive because of background expiry checks
        const maybeTimer = this.cleanupInterval as unknown as { unref?: () => void }
        maybeTimer.unref?.()
    }

    clearExpiredKeys(): number {
        const now = Date.now()
        let expiredCount = 0

        for (const [roomId, lastAccess] of this.keyAccessTimes) {
            if (now - lastAccess > KEY_EXPIRATION_MS) {
                this.roomKeys.delete(roomId)
                this.roomHmacKeys.delete(roomId)
                this.roomSalts.delete(roomId)
                this.roomKeyChecks.delete(roomId)
                this.keyAccessTimes.delete(roomId)
                this.keyAccessOrder = this.keyAccessOrder.filter(id => id !== roomId)
                this.notifyKeyChange(roomId, false)
                expiredCount++
                console.log(`[Encryption] Expired key for room ${roomId} (inactive)`)
            }
        }

        return expiredCount
    }

    setConfig(config: Partial<EncryptionConfig>) {
        this.config = { ...this.config, ...config }
    }

    onKeyChange(listener: KeyChangeListener): () => void {
        this.keyChangeListeners.add(listener)
        return () => {
            this.keyChangeListeners.delete(listener)
        }
    }

    private notifyKeyChange(roomId: string, hasKey: boolean): void {
        this.keyChangeListeners.forEach(listener => {
            try {
                listener(roomId, hasKey)
            } catch (error) {
                console.error('[Encryption] Error in key change listener:', error)
            }
        })
    }

    // Generate a random non-extractable encryption key
    async generateKey(): Promise<CryptoKey> {
        return crypto.subtle.generateKey(
            {
                name: this.config.algorithm,
                length: this.config.keyLength
            },
            false,
            ['encrypt', 'decrypt']
        )
    }

    // Derive standalone AES key from password + optional salt
    async deriveKeyFromPassword(password: string, salt?: Uint8Array): Promise<{ key: CryptoKey; salt: Uint8Array }> {
        const useSalt = salt || crypto.getRandomValues(new Uint8Array(16))

        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(password),
            'PBKDF2',
            false,
            ['deriveBits', 'deriveKey']
        )

        const key = await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: useSalt as BufferSource,
                iterations: this.config.pbkdf2Iterations,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: this.config.algorithm, length: this.config.keyLength } as AesDerivedKeyParams,
            false,
            ['encrypt', 'decrypt'] as KeyUsage[]
        )

        return { key, salt: useSalt }
    }

    /**
     * Derive both the non-extractable AES-256-GCM encryption key and the
     * non-extractable HKDF HMAC-SHA256 integrity key from (password, salt)
     * in a single PBKDF2 pass followed by domain-separated HKDF expansion.
     */
    async deriveRoomKeys(
        roomId: string,
        password: string,
        existingSalt?: Uint8Array
    ): Promise<RoomKeyBundle> {
        const normalizedRoomId = normalizeRoomKeyId(roomId)
        const salt = existingSalt && existingSalt.length >= 16
            ? new Uint8Array(existingSalt.slice(0, 16))
            : await deriveDeterministicRoomSalt(normalizedRoomId)

        const passwordMaterial = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(password),
            'PBKDF2',
            false,
            ['deriveBits']
        )

        // Derive 256-bit master secret once via PBKDF2
        const masterBits = await crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                salt: salt as BufferSource,
                iterations: this.config.pbkdf2Iterations,
                hash: 'SHA-256'
            },
            passwordMaterial,
            256
        )

        // Import master secret as non-extractable HKDF key for domain-separated subkeys
        const hkdfMaster = await crypto.subtle.importKey(
            'raw',
            masterBits,
            'HKDF',
            false,
            ['deriveKey']
        )

        const encoder = new TextEncoder()
        const [aesKey, hmacKey] = await Promise.all([
            crypto.subtle.deriveKey(
                {
                    name: 'HKDF',
                    hash: 'SHA-256',
                    salt: salt as BufferSource,
                    info: encoder.encode(`${AES_INFO_PREFIX}${normalizedRoomId}`)
                },
                hkdfMaster,
                { name: this.config.algorithm, length: this.config.keyLength } as AesDerivedKeyParams,
                false,
                ['encrypt', 'decrypt']
            ),
            crypto.subtle.deriveKey(
                {
                    name: 'HKDF',
                    hash: 'SHA-256',
                    salt: salt as BufferSource,
                    info: encoder.encode(`${HMAC_INFO_PREFIX}${normalizedRoomId}`)
                },
                hkdfMaster,
                { name: 'HMAC', hash: 'SHA-256', length: 256 },
                false,
                ['sign', 'verify']
            )
        ])

        const checkSig = await crypto.subtle.sign(
            'HMAC',
            hmacKey,
            encoder.encode(`${KEY_CHECK_PREFIX}${normalizedRoomId}`)
        )
        const keyCheck = this.uint8ArrayToBase64(new Uint8Array(checkSig).slice(0, 16))

        return { aesKey, hmacKey, salt, keyCheck }
    }

    // Generate RSA key pair for peer-to-peer key exchange
    async generateKeyPair(): Promise<KeyPair> {
        const keyPair = await crypto.subtle.generateKey(
            {
                name: 'RSA-OAEP',
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: 'SHA-256'
            },
            true,
            ['encrypt', 'decrypt']
        )

        return {
            publicKey: keyPair.publicKey,
            privateKey: keyPair.privateKey
        }
    }

    async exportPublicKey(publicKey: CryptoKey): Promise<string> {
        const exported = await crypto.subtle.exportKey('spki', publicKey)
        return this.arrayBufferToBase64(exported)
    }

    async importPublicKey(base64Key: string): Promise<CryptoKey> {
        const keyData = this.base64ToArrayBuffer(base64Key)
        return crypto.subtle.importKey(
            'spki',
            keyData,
            { name: 'RSA-OAEP', hash: 'SHA-256' },
            true,
            ['encrypt']
        )
    }

    async encryptSessionKey(sessionKey: CryptoKey, peerPublicKey: CryptoKey): Promise<string> {
        const rawKey = await crypto.subtle.exportKey('raw', sessionKey)
        const encrypted = await crypto.subtle.encrypt(
            { name: 'RSA-OAEP' },
            peerPublicKey,
            rawKey
        )
        return this.arrayBufferToBase64(encrypted)
    }

    async decryptSessionKey(encryptedKey: string, privateKey: CryptoKey): Promise<CryptoKey> {
        const keyData = this.base64ToArrayBuffer(encryptedKey)
        const rawKey = await crypto.subtle.decrypt(
            { name: 'RSA-OAEP' },
            privateKey,
            keyData
        )
        return crypto.subtle.importKey(
            'raw',
            rawKey,
            { name: this.config.algorithm, length: this.config.keyLength },
            false,
            ['encrypt', 'decrypt']
        )
    }

    async encrypt(data: string | Uint8Array, key: CryptoKey): Promise<EncryptedPayload> {
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const encodedData = typeof data === 'string'
            ? new TextEncoder().encode(data)
            : data

        const encrypted = await crypto.subtle.encrypt(
            { name: this.config.algorithm, iv: iv as BufferSource },
            key,
            encodedData as BufferSource
        )

        return {
            iv: this.uint8ArrayToBase64(iv),
            data: this.arrayBufferToBase64(encrypted)
        }
    }

    async decrypt(payload: EncryptedPayload, key: CryptoKey): Promise<Uint8Array> {
        const iv = this.base64ToArrayBuffer(payload.iv)
        const data = this.base64ToArrayBuffer(payload.data)

        const decrypted = await crypto.subtle.decrypt(
            { name: this.config.algorithm, iv: new Uint8Array(iv) },
            key,
            data
        )

        return new Uint8Array(decrypted)
    }

    async decryptToString(payload: EncryptedPayload, key: CryptoKey): Promise<string> {
        const decrypted = await this.decrypt(payload, key)
        return new TextDecoder().decode(decrypted)
    }

    /**
     * Derive and cache room AES-256-GCM + HKDF HMAC keys using a deterministic
     * room salt (or an explicit shared salt when provided).
     */
    async setRoomKey(roomId: string, password: string, existingSalt?: Uint8Array): Promise<Uint8Array> {
        const keyId = normalizeRoomKeyId(roomId)

        while (this.roomKeys.size >= MAX_ROOM_KEYS && this.keyAccessOrder.length > 0) {
            const oldestRoomId = this.keyAccessOrder.shift()
            if (oldestRoomId && oldestRoomId !== keyId) {
                this.roomKeys.delete(oldestRoomId)
                this.roomHmacKeys.delete(oldestRoomId)
                this.roomSalts.delete(oldestRoomId)
                this.roomKeyChecks.delete(oldestRoomId)
                this.keyAccessTimes.delete(oldestRoomId)
                console.log(`[Encryption] Evicted key for room ${oldestRoomId} (LRU)`)
            }
        }

        try {
            const { aesKey, hmacKey, salt, keyCheck } = await this.deriveRoomKeys(keyId, password, existingSalt)
            this.roomKeys.set(keyId, aesKey)
            this.roomHmacKeys.set(keyId, hmacKey)
            this.roomSalts.set(keyId, salt)
            this.roomKeyChecks.set(keyId, keyCheck)

            this.keyAccessOrder = this.keyAccessOrder.filter(id => id !== keyId)
            this.keyAccessOrder.push(keyId)
            this.keyAccessTimes.set(keyId, Date.now())

            securityLog.encryptionEnabled(keyId, { saltLength: salt.length })
            this.notifyKeyChange(keyId, true)
            if (keyId !== roomId) this.notifyKeyChange(roomId, true)

            return salt
        } catch (error) {
            securityLog.encryptionFailed(keyId, String(error))
            throw error
        }
    }

    getRoomSalt(roomId: string): Uint8Array | undefined {
        return this.roomSalts.get(normalizeRoomKeyId(roomId))
    }

    async setRoomKeyWithSalt(roomId: string, password: string, salt: Uint8Array): Promise<void> {
        await this.setRoomKey(roomId, password, salt)
    }

    getRoomKey(roomId: string): CryptoKey | undefined {
        const keyId = normalizeRoomKeyId(roomId)
        if (this.roomKeys.has(keyId)) {
            this.keyAccessOrder = this.keyAccessOrder.filter(id => id !== keyId)
            this.keyAccessOrder.push(keyId)
            this.keyAccessTimes.set(keyId, Date.now())
        }
        return this.roomKeys.get(keyId)
    }

    getRoomHmacKey(roomId: string): CryptoKey | undefined {
        const keyId = normalizeRoomKeyId(roomId)
        if (this.roomHmacKeys.has(keyId)) {
            this.keyAccessTimes.set(keyId, Date.now())
        }
        return this.roomHmacKeys.get(keyId)
    }

    getRoomKeyCheck(roomId: string): string | undefined {
        return this.roomKeyChecks.get(normalizeRoomKeyId(roomId))
    }

    hasRoomKey(roomId: string): boolean {
        return this.roomKeys.has(normalizeRoomKeyId(roomId))
    }

    removeRoomKey(roomId: string): void {
        const keyId = normalizeRoomKeyId(roomId)
        const existed = this.roomKeys.has(keyId) || this.roomHmacKeys.has(keyId)
        this.roomKeys.delete(keyId)
        this.roomHmacKeys.delete(keyId)
        this.roomSalts.delete(keyId)
        this.roomKeyChecks.delete(keyId)
        this.keyAccessTimes.delete(keyId)
        this.keyAccessOrder = this.keyAccessOrder.filter(id => id !== keyId)
        if (existed) {
            this.notifyKeyChange(keyId, false)
            if (keyId !== roomId) this.notifyKeyChange(roomId, false)
        }
    }

    /** Alias for removeRoomKey for callers clearing a room's encryption key. */
    clearRoomKey(roomId: string): void {
        this.removeRoomKey(roomId)
    }

    clearAllRoomKeys(): void {
        const ids = Array.from(this.roomKeys.keys())
        this.roomKeys.clear()
        this.roomHmacKeys.clear()
        this.roomSalts.clear()
        this.roomKeyChecks.clear()
        this.keyAccessTimes.clear()
        this.keyAccessOrder = []
        ids.forEach(id => this.notifyKeyChange(id, false))
    }

    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval)
            this.cleanupInterval = null
        }
        this.clearAllRoomKeys()
        this.keyChangeListeners.clear()
    }

    async encryptForRoom(roomId: string, data: string): Promise<EncryptedPayload | null> {
        const key = this.getRoomKey(roomId)
        if (!key) return null
        return this.encrypt(data, key)
    }

    async decryptFromRoom(roomId: string, payload: EncryptedPayload): Promise<string | null> {
        const key = this.getRoomKey(roomId)
        if (!key) return null
        try {
            return await this.decryptToString(payload, key)
        } catch (e) {
            console.error('Decryption failed:', e)
            return null
        }
    }

    generateSecureId(length: number = 32): string {
        const bytes = crypto.getRandomValues(new Uint8Array(length))
        return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    }

    async hash(data: string | Uint8Array): Promise<string> {
        const encodedData = typeof data === 'string'
            ? new TextEncoder().encode(data)
            : data
        const hashBuffer = await crypto.subtle.digest('SHA-256', encodedData as BufferSource)
        return this.arrayBufferToBase64(hashBuffer)
    }

    async verifyHash(data: string | Uint8Array, expectedHash: string): Promise<boolean> {
        const actualHash = await this.hash(data)
        return actualHash === expectedHash
    }

    private uint8ArrayToBase64(bytes: Uint8Array): string {
        const CHUNK = 0x8000
        let binary = ''
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
        }
        return btoa(binary)
    }

    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        return this.uint8ArrayToBase64(new Uint8Array(buffer))
    }

    private base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i)
        }
        return bytes.buffer
    }
}

// Singleton
export const encryptionService = new EncryptionService()

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// SECURITY FIX V-006: Peer Authentication Service
// Provides cryptographic identity verification for P2P peers using ECDSA (P-256).
// Private keys are stored in Electron safeStorage when available (never plaintext
// localStorage in Electron), falling back cleanly only in web/non-Electron shim.

export interface PeerIdentity {
    peerId: string
    publicKey: string // Base64 encoded SPKI public key
    displayName?: string
    createdAt: number
    verified: boolean
}

export interface SignedMessage {
    data: string // Base64 encoded data
    signature: string // Base64 encoded signature
    peerId: string
    timestamp: number
}

// Public identity metadata (peerId + publicKey only; never privateKey in Electron)
const IDENTITY_STORAGE_KEY = 'kalynt-peer-identity'
// OS keychain key for private key in Electron safeStorage
const PRIVATE_KEY_SAFE_STORAGE_KEY = 'kalynt_peer_private_key'
// Web-mode-only fallback storage key (never written in Electron)
const WEB_PRIVATE_KEY_STORAGE_KEY = 'kalynt-peer-private-key-web'

interface SafeStorageResult {
    success?: boolean
    value?: string | null
    error?: string
}

// Trusted peers cache (verified in current session)
const trustedPeers = new Map<string, PeerIdentity>()

// Room-specific peer registries
const roomPeers = new Map<string, Map<string, PeerIdentity>>()

// Local key pair (generated once, persisted)
let localKeyPair: CryptoKeyPair | null = null
let localPeerId: string | null = null
let localPublicKeyBase64: string | null = null
let initPromise: Promise<PeerIdentity> | null = null

function hasLocalStorage(): boolean {
    return typeof localStorage !== 'undefined'
}

function getSafeStorage() {
    return typeof window !== 'undefined' ? window.electronAPI?.safeStorage : undefined
}

function isWebShimEnvironment(): boolean {
    if (typeof window === 'undefined') return false
    const api = window.electronAPI as { platform?: string; safeStorage?: unknown } | undefined
    return !api || !api.safeStorage || api.platform === 'browser'
}

async function readPrivateKeyFromSecureStore(): Promise<string | null> {
    const safe = getSafeStorage()
    if (!safe) return null
    try {
        const res: SafeStorageResult | undefined = await safe.get(PRIVATE_KEY_SAFE_STORAGE_KEY)
        if (res?.success && typeof res.value === 'string' && res.value) {
            return res.value
        }
    } catch (error) {
        console.warn('[PeerAuth] Failed to read private key from safeStorage:', error)
    }
    return null
}

async function writePrivateKeyToSecureStore(exportedPrivate: string): Promise<boolean> {
    const safe = getSafeStorage()
    if (!safe) return false
    try {
        const res: SafeStorageResult | undefined = await safe.set({
            key: PRIVATE_KEY_SAFE_STORAGE_KEY,
            value: exportedPrivate
        })
        return res?.success === true
    } catch (error) {
        console.warn('[PeerAuth] Failed to write private key to safeStorage:', error)
        return false
    }
}

/**
 * Generate a unique peer ID from public key (first 16 bytes of SHA-256(SPKI))
 */
async function generatePeerIdFromKey(publicKey: CryptoKey): Promise<string> {
    const exported = await crypto.subtle.exportKey('spki', publicKey)
    const hash = await crypto.subtle.digest('SHA-256', exported)
    const bytes = new Uint8Array(hash)
    return Array.from(bytes.slice(0, 16))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey(
        {
            name: 'ECDSA',
            namedCurve: 'P-256'
        },
        true,
        ['sign', 'verify']
    )
}

async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
    const exported = await crypto.subtle.exportKey('spki', publicKey)
    return arrayBufferToBase64(exported)
}

async function exportPrivateKey(privateKey: CryptoKey): Promise<string> {
    const exported = await crypto.subtle.exportKey('pkcs8', privateKey)
    return arrayBufferToBase64(exported)
}

async function importPublicKey(base64Key: string): Promise<CryptoKey> {
    const keyData = base64ToArrayBuffer(base64Key)
    return crypto.subtle.importKey(
        'spki',
        keyData,
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['verify']
    )
}

async function importPrivateKey(base64Key: string): Promise<CryptoKey> {
    const keyData = base64ToArrayBuffer(base64Key)
    return crypto.subtle.importKey(
        'pkcs8',
        keyData,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign']
    )
}

async function signData(data: Uint8Array, privateKey: CryptoKey): Promise<Uint8Array> {
    const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        data as BufferSource
    )
    return new Uint8Array(signature)
}

async function verifySignature(
    data: Uint8Array,
    signature: Uint8Array,
    publicKey: CryptoKey
): Promise<boolean> {
    try {
        return await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            publicKey,
            signature as BufferSource,
            data as BufferSource
        )
    } catch (e) {
        console.error('[PeerAuth] Signature verification failed:', e)
        return false
    }
}

/**
 * Initialize local peer identity.
 * Loads from safeStorage (migrating any legacy plaintext localStorage private key)
 * or generates a new ECDSA P-256 identity.
 */
export async function initializeLocalIdentity(): Promise<PeerIdentity> {
    if (localKeyPair && localPeerId && localPublicKeyBase64) {
        return {
            peerId: localPeerId,
            publicKey: localPublicKeyBase64,
            createdAt: Date.now(),
            verified: true
        }
    }

    if (initPromise) return initPromise

    initPromise = doInitializeLocalIdentity().finally(() => {
        initPromise = null
    })
    return initPromise
}

async function doInitializeLocalIdentity(): Promise<PeerIdentity> {
    // 1. Try to load existing identity
    try {
        if (hasLocalStorage()) {
            const stored = localStorage.getItem(IDENTITY_STORAGE_KEY)
            if (stored) {
                const parsed = JSON.parse(stored) as {
                    publicKey?: string
                    privateKey?: string
                    peerId?: string
                }
                const { publicKey, peerId } = parsed
                let privateKeyBase64 = await readPrivateKeyFromSecureStore()

                // Migrate legacy plaintext privateKey out of localStorage into safeStorage
                if (typeof parsed.privateKey === 'string' && parsed.privateKey) {
                    if (!privateKeyBase64) {
                        const migrated = await writePrivateKeyToSecureStore(parsed.privateKey)
                        privateKeyBase64 = parsed.privateKey
                        if (migrated) {
                            localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify({
                                publicKey,
                                peerId
                            }))
                            console.log('[PeerAuth] Migrated ECDSA private key to safeStorage')
                        } else if (isWebShimEnvironment()) {
                            localStorage.setItem(WEB_PRIVATE_KEY_STORAGE_KEY, parsed.privateKey)
                            localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify({
                                publicKey,
                                peerId
                            }))
                        }
                    } else {
                        // Already in safeStorage: strip legacy plaintext privateKey from localStorage
                        localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify({
                            publicKey,
                            peerId
                        }))
                    }
                }

                // Web-only fallback when safeStorage is unavailable
                if (!privateKeyBase64 && isWebShimEnvironment()) {
                    privateKeyBase64 = localStorage.getItem(WEB_PRIVATE_KEY_STORAGE_KEY)
                }

                if (publicKey && privateKeyBase64 && peerId) {
                    const pubKey = await importPublicKey(publicKey)
                    const expectedPeerId = await generatePeerIdFromKey(pubKey)
                    if (expectedPeerId === peerId) {
                        const privKey = await importPrivateKey(privateKeyBase64)
                        localKeyPair = { publicKey: pubKey, privateKey: privKey }
                        localPeerId = peerId
                        localPublicKeyBase64 = publicKey
                        console.log('[PeerAuth] Loaded existing identity:', peerId.substring(0, 8) + '...')
                        return {
                            peerId,
                            publicKey,
                            createdAt: Date.now(),
                            verified: true
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[PeerAuth] Failed to load stored identity, generating new one:', e)
    }

    // 2. Generate new ECDSA P-256 identity
    const generated = await generateKeyPair()
    const newPeerId = await generatePeerIdFromKey(generated.publicKey)
    const newPublicKeyBase64 = await exportPublicKey(generated.publicKey)
    const exportedPrivate = await exportPrivateKey(generated.privateKey)

    // Re-import private key as non-extractable for in-memory runtime safety
    const nonExtractablePrivate = await importPrivateKey(exportedPrivate)
    localKeyPair = { publicKey: generated.publicKey, privateKey: nonExtractablePrivate }
    localPeerId = newPeerId
    localPublicKeyBase64 = newPublicKeyBase64

    // Persist private key securely in safeStorage; never write plaintext privateKey in Electron
    const savedSecurely = await writePrivateKeyToSecureStore(exportedPrivate)
    if (hasLocalStorage()) {
        if (savedSecurely) {
            localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify({
                publicKey: newPublicKeyBase64,
                peerId: newPeerId
            }))
            localStorage.removeItem(WEB_PRIVATE_KEY_STORAGE_KEY)
        } else if (isWebShimEnvironment()) {
            localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify({
                publicKey: newPublicKeyBase64,
                peerId: newPeerId
            }))
            localStorage.setItem(WEB_PRIVATE_KEY_STORAGE_KEY, exportedPrivate)
        } else {
            console.warn('[PeerAuth] safeStorage unavailable in desktop runtime; keeping ECDSA key ephemeral in memory only')
        }
    }

    console.log('[PeerAuth] Generated new identity:', newPeerId.substring(0, 8) + '...')

    return {
        peerId: newPeerId,
        publicKey: newPublicKeyBase64,
        createdAt: Date.now(),
        verified: true
    }
}

export function getLocalIdentity(): PeerIdentity | null {
    if (!localPeerId || !localPublicKeyBase64) return null
    return {
        peerId: localPeerId,
        publicKey: localPublicKeyBase64,
        createdAt: Date.now(),
        verified: true
    }
}

export function getLocalPeerId(): string | null {
    return localPeerId
}

/**
 * Sign an arbitrary canonical string payload (e.g., ownership proof or moderation action)
 * with the local ECDSA P-256 private key.
 */
export async function signPayload(payload: string): Promise<{
    signature: string
    peerId: string
    publicKey: string
} | null> {
    if (!localKeyPair || !localPeerId || !localPublicKeyBase64) {
        await initializeLocalIdentity()
    }
    if (!localKeyPair || !localPeerId || !localPublicKeyBase64) {
        console.error('[PeerAuth] Local identity not initialized')
        return null
    }

    const bytes = new TextEncoder().encode(payload)
    const signature = await signData(bytes, localKeyPair.privateKey)
    return {
        signature: uint8ArrayToBase64(signature),
        peerId: localPeerId,
        publicKey: localPublicKeyBase64
    }
}

/**
 * Verify an ECDSA P-256 signature over a canonical string payload against
 * a Base64 SPKI public key (and optionally verify that the public key hashes
 * to `expectedPeerId`).
 */
export async function verifyPayloadSignature(
    payload: string,
    signatureBase64: string,
    publicKeyBase64: string,
    expectedPeerId?: string
): Promise<boolean> {
    if (!payload || !signatureBase64 || !publicKeyBase64) return false
    try {
        const pubKey = await importPublicKey(publicKeyBase64)
        if (expectedPeerId) {
            const derivedPeerId = await generatePeerIdFromKey(pubKey)
            if (derivedPeerId !== expectedPeerId) {
                console.warn('[PeerAuth] Public key does not match claimed peerId')
                return false
            }
        }
        const dataBytes = new TextEncoder().encode(payload)
        const signatureBytes = new Uint8Array(base64ToArrayBuffer(signatureBase64))
        return await verifySignature(dataBytes, signatureBytes, pubKey)
    } catch (e) {
        console.error('[PeerAuth] Payload signature verification error:', e)
        return false
    }
}

/**
 * Sign a message for broadcast
 */
export async function signMessage(data: Uint8Array): Promise<SignedMessage | null> {
    if (!localKeyPair || !localPeerId) {
        console.error('[PeerAuth] Local identity not initialized')
        return null
    }

    const signature = await signData(data, localKeyPair.privateKey)

    return {
        data: uint8ArrayToBase64(data),
        signature: uint8ArrayToBase64(signature),
        peerId: localPeerId,
        timestamp: Date.now()
    }
}

/**
 * Verify and extract message from signed payload
 */
export async function verifyMessage(
    signedMessage: SignedMessage,
    roomId?: string
): Promise<{ valid: boolean; data: Uint8Array | null; peerId: string }> {
    const { data, signature, peerId, timestamp } = signedMessage

    const MAX_AGE_MS = 5 * 60 * 1000
    const MAX_FUTURE_SKEW_MS = 60 * 1000
    const now = Date.now()
    if (now - timestamp > MAX_AGE_MS || timestamp - now > MAX_FUTURE_SKEW_MS) {
        console.warn('[PeerAuth] Rejecting stale message from:', peerId.substring(0, 8))
        return { valid: false, data: null, peerId }
    }

    const peerIdentity = roomId
        ? roomPeers.get(roomId)?.get(peerId)
        : trustedPeers.get(peerId)

    if (!peerIdentity) {
        console.warn('[PeerAuth] Unknown peer:', peerId.substring(0, 8))
        return { valid: false, data: null, peerId }
    }

    try {
        const publicKey = await importPublicKey(peerIdentity.publicKey)
        const dataBytes = new Uint8Array(base64ToArrayBuffer(data))
        const signatureBytes = new Uint8Array(base64ToArrayBuffer(signature))

        const valid = await verifySignature(dataBytes, signatureBytes, publicKey)

        if (!valid) {
            console.warn('[PeerAuth] Invalid signature from:', peerId.substring(0, 8))
            return { valid: false, data: null, peerId }
        }

        return { valid: true, data: dataBytes, peerId }
    } catch (e) {
        console.error('[PeerAuth] Verification error:', e)
        return { valid: false, data: null, peerId }
    }
}

/**
 * Register a peer's identity for a room
 */
export async function registerPeer(
    roomId: string,
    peerId: string,
    publicKey: string,
    displayName?: string
): Promise<boolean> {
    try {
        const key = await importPublicKey(publicKey)
        const expectedPeerId = await generatePeerIdFromKey(key)
        if (expectedPeerId !== peerId) {
            console.warn('[PeerAuth] Peer ID mismatch - possible spoofing attempt')
            return false
        }
    } catch (e) {
        console.error('[PeerAuth] Invalid public key format:', e)
        return false
    }

    if (!roomPeers.has(roomId)) {
        roomPeers.set(roomId, new Map())
    }

    const existingPeer = roomPeers.get(roomId)!.get(peerId)
    if (existingPeer) {
        return true
    }

    const identity: PeerIdentity = {
        peerId,
        publicKey,
        displayName,
        createdAt: Date.now(),
        verified: true
    }

    roomPeers.get(roomId)!.set(peerId, identity)
    trustedPeers.set(peerId, identity)

    console.log('[PeerAuth] Registered peer:', peerId.substring(0, 8), 'for room:', roomId.substring(0, 8))
    return true
}

export function unregisterPeer(roomId: string, peerId: string): void {
    roomPeers.get(roomId)?.delete(peerId)
    let inOtherRoom = false
    for (const [rid, peers] of roomPeers) {
        if (rid !== roomId && peers.has(peerId)) {
            inOtherRoom = true
            break
        }
    }
    if (!inOtherRoom) {
        trustedPeers.delete(peerId)
    }
}

export function getRoomPeers(roomId: string): PeerIdentity[] {
    const peers = roomPeers.get(roomId)
    return peers ? Array.from(peers.values()) : []
}

export function isPeerTrusted(roomId: string, peerId: string): boolean {
    return roomPeers.get(roomId)?.has(peerId) || false
}

export function cleanupRoom(roomId: string): void {
    const peers = roomPeers.get(roomId)
    if (peers) {
        for (const peerId of peers.keys()) {
            unregisterPeer(roomId, peerId)
        }
        roomPeers.delete(roomId)
    }
}

export function createIdentityAnnouncement(): {
    type: 'identity'
    peerId: string
    publicKey: string
    timestamp: number
} | null {
    if (!localPeerId || !localPublicKeyBase64) return null
    return {
        type: 'identity',
        peerId: localPeerId,
        publicKey: localPublicKeyBase64,
        timestamp: Date.now()
    }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
    const CHUNK = 0x8000
    let binary = ''
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
    }
    return btoa(binary)
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    return uint8ArrayToBase64(new Uint8Array(buffer))
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes.buffer
}

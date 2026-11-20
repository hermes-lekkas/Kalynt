/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// P2P Service - WebRTC peer-to-peer networking with signaling
import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc'
import { logger } from '../utils/logger'
import { p2pLog, securityLog } from './auditLogService'

export interface PeerInfo {
    id: string
    name: string
    color: string
    lastSeen: number
    isOnline: boolean
}

export interface TurnSettings {
    url: string
    username: string
    credential: string
}

export interface P2PConfig {
    signalingServers: string[]
    iceServers: RTCIceServer[]
    maxPeers: number
    password?: string
    // Enable broadcast discovery for LAN connections
    enableBroadcast?: boolean
    // Connection retry settings for flaky networks
    maxRetries?: number
    retryDelayMs?: number
}

export interface P2PStats {
    connectedPeers: number
    totalBytesReceived: number
    totalBytesSent: number
    averageLatency: number
}

type ConnectionCallback = (peerId: string, connected: boolean) => void
type SyncCallback = (synced: boolean) => void
type PeersCallback = (peers: PeerInfo[]) => void

export interface RoomCallbacks {
    onConnection?: ConnectionCallback
    onSync?: SyncCallback
    onPeers?: PeersCallback
}

interface SafeStorageResult {
    success?: boolean
    value?: string | null
    error?: string
}

interface SignalingConnLike {
    url?: string
    connected?: boolean
    connect?: () => void
    send?: (msg: Record<string, unknown>) => void
}

const TURN_SAFE_STORAGE_KEY = 'kalynt_turn_settings'
const TURN_LEGACY_LOCAL_KEY = 'kalynt-turn-settings'

const EMPTY_TURN: TurnSettings = { url: '', username: '', credential: '' }

/**
 * Normalize a room ID / room code so invite links, typed room codes, WebRTC
 * room topics, and lookups always agree on casing regardless of user input.
 */
export function normalizeRoomId(input: string): string {
    return input.trim().toLowerCase()
}

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

function parseTurnJson(raw: string | null | undefined): TurnSettings {
    if (!raw) return { ...EMPTY_TURN }
    try {
        const parsed = JSON.parse(raw) as Partial<TurnSettings>
        return {
            url: typeof parsed?.url === 'string' ? parsed.url.trim() : '',
            username: typeof parsed?.username === 'string' ? parsed.username.trim() : '',
            credential: typeof parsed?.credential === 'string' ? parsed.credential : ''
        }
    } catch {
        return { ...EMPTY_TURN }
    }
}

function readLegacyTurnFromLocalStorage(): TurnSettings {
    if (!hasLocalStorage()) return { ...EMPTY_TURN }
    try {
        return parseTurnJson(localStorage.getItem(TURN_LEGACY_LOCAL_KEY))
    } catch {
        return { ...EMPTY_TURN }
    }
}

function buildIceServers(turnOverride?: Partial<TurnSettings>): RTCIceServer[] {
    const servers: RTCIceServer[] = [
        // Google STUN servers for NAT traversal (discovers public IP)
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // Cloudflare STUN — privacy-focused alternative (no logging policy)
        { urls: 'stun:stun.cloudflare.com:3478' },
        // OpenRelay STUN - public STUN server
        { urls: 'stun:openrelay.metered.ca:80' }
    ]

    const customTurnUrl = (turnOverride?.url ?? '') || (import.meta.env?.VITE_TURN_URL as string | undefined) || ''
    const customTurnUsername = (turnOverride?.username ?? '') || (import.meta.env?.VITE_TURN_USERNAME as string | undefined) || ''
    const customTurnCredential = (turnOverride?.credential ?? '') || (import.meta.env?.VITE_TURN_CREDENTIAL as string | undefined) || ''

    if (customTurnUrl && customTurnUsername && customTurnCredential) {
        servers.push({
            urls: customTurnUrl,
            username: customTurnUsername,
            credential: customTurnCredential
        })
        if (!customTurnUrl.includes('transport=tcp')) {
            servers.push({
                urls: `${customTurnUrl}?transport=tcp`,
                username: customTurnUsername,
                credential: customTurnCredential
            })
        }
    }

    return servers
}

function nowMonotonicMs(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()
}

const DEFAULT_CONFIG: P2PConfig = {
    signalingServers: [
        // Primary: Built-in signaling server started by Electron main process
        'ws://localhost:4444',
        // Fallback: Public signaling server bundled with y-webrtc
        'wss://y-webrtc-eu.fly.dev',
        ...(import.meta.env?.VITE_SIGNALING_URL ? [import.meta.env.VITE_SIGNALING_URL as string] : [])
    ],
    iceServers: buildIceServers(readLegacyTurnFromLocalStorage()),
    maxPeers: 15,
    enableBroadcast: true,
    maxRetries: 3,
    retryDelayMs: 15000
}

// SECURITY FIX V-009: Rate limiting configuration
const RATE_LIMIT_CONFIG = {
    maxMessagesPerSecond: 50,
    maxConnectionsPerMinute: 10,
    burstAllowance: 20,
    banDurationMs: 60 * 1000
}

class PeerRateLimiter {
    private messageCounters: Map<string, { count: number; resetTime: number }> = new Map()
    private connectionCounters: Map<string, { count: number; resetTime: number }> = new Map()
    private bannedPeers: Map<string, number> = new Map()

    isBanned(peerId: string): boolean {
        const banExpiry = this.bannedPeers.get(peerId)
        if (!banExpiry) return false

        if (Date.now() > banExpiry) {
            this.bannedPeers.delete(peerId)
            return false
        }
        return true
    }

    checkMessageRate(peerId: string): boolean {
        if (this.isBanned(peerId)) return false

        const now = Date.now()
        const counter = this.messageCounters.get(peerId)

        if (!counter || now > counter.resetTime) {
            this.messageCounters.set(peerId, {
                count: 1,
                resetTime: now + 1000
            })
            return true
        }

        counter.count++

        if (counter.count > RATE_LIMIT_CONFIG.maxMessagesPerSecond + RATE_LIMIT_CONFIG.burstAllowance) {
            console.warn(`[P2P] Rate limiting peer ${peerId}: ${counter.count} messages/sec`)
            this.banPeer(peerId)
            return false
        }

        return true
    }

    checkConnectionRate(peerId: string): boolean {
        if (this.isBanned(peerId)) return false

        const now = Date.now()
        const counter = this.connectionCounters.get(peerId)

        if (!counter || now > counter.resetTime) {
            this.connectionCounters.set(peerId, {
                count: 1,
                resetTime: now + 60000
            })
            return true
        }

        counter.count++

        if (counter.count > RATE_LIMIT_CONFIG.maxConnectionsPerMinute) {
            console.warn(`[P2P] Connection rate limiting peer ${peerId}`)
            this.banPeer(peerId)
            return false
        }

        return true
    }

    private banPeer(peerId: string): void {
        this.bannedPeers.set(peerId, Date.now() + RATE_LIMIT_CONFIG.banDurationMs)
        console.warn(`[P2P] Peer ${peerId} banned for ${RATE_LIMIT_CONFIG.banDurationMs / 1000}s`)
    }

    clear(): void {
        this.messageCounters.clear()
        this.connectionCounters.clear()
        this.bannedPeers.clear()
    }

    cleanup(): void {
        const now = Date.now()
        for (const [peerId, banExpiry] of this.bannedPeers) {
            if (now > banExpiry) this.bannedPeers.delete(peerId)
        }
        for (const [peerId, counter] of this.messageCounters) {
            if (now > counter.resetTime + 5000) this.messageCounters.delete(peerId)
        }
        for (const [peerId, counter] of this.connectionCounters) {
            if (now > counter.resetTime + 60000) this.connectionCounters.delete(peerId)
        }
    }
}

const peerRateLimiter = new PeerRateLimiter()

class P2PService {
    private providers: Map<string, WebrtcProvider> = new Map()
    private roomPasswords: Map<string, string | undefined> = new Map()
    private config: P2PConfig = DEFAULT_CONFIG
    private localUser: { name: string; color: string } = { name: 'Anonymous', color: '#3b82f6' }

    // Legacy single-slot per-room callbacks (preserved for backwards compatibility)
    private roomCallbacks: Map<string, RoomCallbacks> = new Map()
    // Multi-subscriber room listeners so independent hooks never clobber one another
    private roomListeners: Map<string, Set<RoomCallbacks>> = new Map()

    private rateLimiter = peerRateLimiter
    private cleanupIntervalId: ReturnType<typeof setInterval> | null = null
    private isDestroyed = false

    // Stats tracking + cleanup handles per room
    private roomStats: Map<string, {
        bytesReceived: number
        bytesSent: number
        lastPingTime: number
        latencies: number[]
    }> = new Map()
    private statsCleanups: Map<string, () => void> = new Map()

    // Bounded signaling retry tracking per room
    private retryAttempts: Map<string, number> = new Map()
    private retryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

    // In-memory cache of TURN settings (loaded from safeStorage when available)
    private cachedTurnSettings: TurnSettings = readLegacyTurnFromLocalStorage()
    private turnLoadPromise: Promise<TurnSettings> | null = null

    constructor() {
        this.cleanupIntervalId = setInterval(() => {
            if (this.isDestroyed) return
            this.rateLimiter.cleanup()
        }, 30000)
        const maybeTimer = this.cleanupIntervalId as unknown as { unref?: () => void }
        maybeTimer.unref?.()

        // Hydrate / migrate TURN credentials from safeStorage in background
        this.loadTurnSettings().catch(() => undefined)
    }

    destroy(): void {
        this.isDestroyed = true

        if (this.cleanupIntervalId) {
            clearInterval(this.cleanupIntervalId)
            this.cleanupIntervalId = null
        }
        this.disconnectAll()
        this.rateLimiter.clear()
    }

    setConfig(config: Partial<P2PConfig>) {
        this.config = { ...this.config, ...config }
    }

    setLocalUser(name: string, color: string) {
        this.localUser = { name, color }
        this.providers.forEach(provider => {
            provider.awareness.setLocalStateField('user', this.localUser)
        })
    }

    /**
     * Subscribe to room events without clobbering other subscribers.
     * Returns an unsubscribe function that removes only this listener.
     */
    addRoomListener(roomId: string, callbacks: RoomCallbacks): () => void {
        let listeners = this.roomListeners.get(roomId)
        if (!listeners) {
            listeners = new Set()
            this.roomListeners.set(roomId, listeners)
        }
        listeners.add(callbacks)

        return () => {
            const current = this.roomListeners.get(roomId)
            if (!current) return
            current.delete(callbacks)
            if (current.size === 0) {
                this.roomListeners.delete(roomId)
            }
        }
    }

    /** Backwards-compatible single-slot room callback setter. Prefer `addRoomListener`. */
    setRoomCallbacks(roomId: string, callbacks: RoomCallbacks) {
        if (!callbacks.onConnection && !callbacks.onSync && !callbacks.onPeers) {
            this.roomCallbacks.delete(roomId)
            return
        }
        this.roomCallbacks.set(roomId, callbacks)
    }

    // Legacy: set global default callbacks
    setCallbacks(
        onConnection: ConnectionCallback,
        onSync: SyncCallback,
        onPeers: PeersCallback
    ) {
        this.roomCallbacks.set('__default__', { onConnection, onSync, onPeers })
    }

    private emitRoomEvent(roomId: string, invoke: (cb: RoomCallbacks) => void): void {
        const listeners = this.roomListeners.get(roomId)
        if (listeners) {
            listeners.forEach(cb => {
                try {
                    invoke(cb)
                } catch (err) {
                    console.error(`[P2P] Error in room listener for ${roomId}:`, err)
                }
            })
        }

        const legacy = this.roomCallbacks.get(roomId) || this.roomCallbacks.get('__default__')
        if (legacy) {
            try {
                invoke(legacy)
            } catch (err) {
                console.error(`[P2P] Error in legacy room callback for ${roomId}:`, err)
            }
        }
    }

    private clearRetryTimer(roomId: string): void {
        const timer = this.retryTimers.get(roomId)
        if (timer) {
            clearTimeout(timer)
            this.retryTimers.delete(roomId)
        }
    }

    /**
     * Reconnect signaling channels ONLY (without destroying the WebrtcProvider,
     * wiping callbacks, or disrupting the Y.Doc) with bounded exponential backoff.
     */
    private scheduleSignalingRetry(roomId: string, provider: WebrtcProvider, roomName: string): void {
        const maxRetries = this.config.maxRetries ?? 3
        if (maxRetries <= 0) return

        this.clearRetryTimer(roomId)

        const currentAttempt = this.retryAttempts.get(roomId) || 0
        if (currentAttempt >= maxRetries) return

        const baseDelay = Math.max(2000, this.config.retryDelayMs ?? 15000)
        const delayMs = Math.min(baseDelay * Math.pow(2, currentAttempt), 60000)

        const timer = setTimeout(() => {
            this.retryTimers.delete(roomId)
            if (this.isDestroyed || this.providers.get(roomId) !== provider) return

            const peerCount = this.getPeerCount(roomId)
            if (peerCount > 0) {
                this.retryAttempts.delete(roomId)
                return
            }

            const attempt = this.retryAttempts.get(roomId) || 0
            if (attempt >= maxRetries) return

            this.retryAttempts.set(roomId, attempt + 1)
            console.log(`[P2P] No peers connected yet, refreshing signaling... (${attempt + 1}/${maxRetries})`)

            this.refreshSignalingOnly(provider, roomName)

            if (attempt + 1 < maxRetries) {
                this.scheduleSignalingRetry(roomId, provider, roomName)
            }
        }, delayMs)

        const maybeTimer = timer as unknown as { unref?: () => void }
        maybeTimer.unref?.()
        this.retryTimers.set(roomId, timer)
    }

    private refreshSignalingOnly(provider: WebrtcProvider, roomName: string): void {
        try {
            const internal = provider as unknown as {
                signalingConns?: SignalingConnLike[]
                room?: { peerId?: string } | null
            }
            const conns = internal.signalingConns

            if (!Array.isArray(conns) || conns.length === 0) {
                provider.connect()
                return
            }

            let reconnectedAny = false
            for (const conn of conns) {
                if (!conn.connected && typeof conn.connect === 'function') {
                    conn.connect()
                    reconnectedAny = true
                } else if (conn.connected && typeof conn.send === 'function') {
                    conn.send({ type: 'subscribe', topics: [roomName] })
                    reconnectedAny = true
                }
            }

            if (!reconnectedAny) {
                provider.disconnect()
                internal.signalingConns = []
                provider.connect()
            }
        } catch (err) {
            console.warn(`[P2P] Signaling refresh failed for ${roomName}:`, err)
        }
    }

    connect(roomId: string, doc: Y.Doc, password?: string): WebrtcProvider | null {
        if (this.providers.has(roomId)) {
            if (password !== undefined) {
                this.roomPasswords.set(roomId, password)
            }
            return this.providers.get(roomId)!
        }

        try {
            const normalizedRoom = normalizeRoomId(roomId)
            const roomName = `kalynt-${normalizedRoom}`
            const connectionPassword = password ?? this.roomPasswords.get(roomId) ?? this.config.password
            const enableBroadcast = this.config.enableBroadcast ?? false
            const iceServers = buildIceServers(this.cachedTurnSettings)

            const provider = new WebrtcProvider(roomName, doc, {
                signaling: this.config.signalingServers,
                password: connectionPassword,
                maxConns: this.config.maxPeers,
                filterBcConns: !enableBroadcast,
                peerOpts: {
                    config: {
                        iceServers
                    }
                }
            })

            provider.awareness.setLocalStateField('user', this.localUser)

            provider.on('synced', ({ synced }: { synced: boolean }) => {
                this.emitRoomEvent(roomId, cb => cb.onSync?.(synced))
                if (synced) {
                    p2pLog.connected(roomId, this.getPeerCount(roomId))
                }
            })

            provider.on('peers', ({ added, removed }: { added: string[]; removed: string[] }) => {
                if (added.length > 0) {
                    this.clearRetryTimer(roomId)
                    this.retryAttempts.delete(roomId)
                }

                added.forEach(id => {
                    if (!this.rateLimiter.checkConnectionRate(id)) {
                        logger.p2p.warn('Peer connection rate limited:', { peerId: id })
                        securityLog.rateLimitTriggered(id, 'connection')
                        return
                    }
                    p2pLog.peerJoined(id, roomId)
                    this.emitRoomEvent(roomId, cb => cb.onConnection?.(id, true))
                })
                removed.forEach(id => {
                    p2pLog.peerLeft(id, roomId)
                    this.emitRoomEvent(roomId, cb => cb.onConnection?.(id, false))
                })
                this.updatePeerList(provider, roomId)
            })

            this.providers.set(roomId, provider)
            this.roomPasswords.set(roomId, connectionPassword)

            this.roomStats.set(roomId, {
                bytesReceived: 0,
                bytesSent: 0,
                lastPingTime: Date.now(),
                latencies: []
            })

            this.setupStatsTracking(provider, roomId)
            this.scheduleSignalingRetry(roomId, provider, roomName)

            return provider
        } catch (err) {
            console.error(`[P2P] Failed to create provider for room ${roomId}:`, err)
            return null
        }
    }

    private teardownProvider(roomId: string, options: { preserveListeners: boolean; preservePassword: boolean }): Promise<void> {
        this.clearRetryTimer(roomId)

        const statsCleanup = this.statsCleanups.get(roomId)
        if (statsCleanup) {
            statsCleanup()
            this.statsCleanups.delete(roomId)
        }

        const provider = this.providers.get(roomId)
        let destroyDone: Promise<void> = Promise.resolve()
        if (provider) {
            const keyPromise = (provider as unknown as { key?: PromiseLike<unknown> }).key
            provider.destroy()
            this.providers.delete(roomId)
            this.roomStats.delete(roomId)
            p2pLog.disconnected(roomId)
            if (keyPromise) {
                destroyDone = Promise.resolve(keyPromise).then(() => undefined, () => undefined)
            }
        }

        this.retryAttempts.delete(roomId)
        if (!options.preserveListeners) {
            this.roomCallbacks.delete(roomId)
            this.roomListeners.delete(roomId)
        }
        if (!options.preservePassword) {
            this.roomPasswords.delete(roomId)
        }

        return destroyDone
    }

    disconnect(roomId: string) {
        void this.teardownProvider(roomId, { preserveListeners: false, preservePassword: false })
    }

    disconnectAll() {
        for (const roomId of Array.from(this.providers.keys())) {
            void this.teardownProvider(roomId, { preserveListeners: false, preservePassword: false })
        }
        this.retryTimers.forEach(timer => clearTimeout(timer))
        this.retryTimers.clear()
        this.statsCleanups.forEach(cleanup => cleanup())
        this.statsCleanups.clear()
        this.providers.clear()
        this.roomCallbacks.clear()
        this.roomListeners.clear()
        this.roomPasswords.clear()
        this.roomStats.clear()
        this.retryAttempts.clear()
    }

    /**
     * Reconnect a room cleanly while preserving its Y.Doc, room password,
     * local user awareness, and all registered room listeners.
     * Pass `null` as `fallbackPassword` to explicitly clear the room password
     * (e.g. when turning encryption off); omit or pass `undefined` to preserve
     * the currently active room password.
     */
    async reconnect(roomId: string, fallbackPassword?: string | null, fallbackDoc?: Y.Doc): Promise<WebrtcProvider | null> {
        const existingProvider = this.providers.get(roomId)
        const doc = existingProvider?.doc ?? fallbackDoc
        if (!doc) return null

        const password = fallbackPassword === null
            ? undefined
            : (fallbackPassword ?? this.roomPasswords.get(roomId))
        await this.teardownProvider(roomId, { preserveListeners: true, preservePassword: fallbackPassword !== null })
        // Give y-webrtc's async destroy microtask a tick to release the room name
        await new Promise(resolve => setTimeout(resolve, 20))
        if (this.isDestroyed) return null
        return this.connect(roomId, doc, password)
    }

    private updatePeerList(_provider: WebrtcProvider, roomId: string) {
        const peers = this.getConnectedPeers(roomId)
        this.emitRoomEvent(roomId, cb => cb.onPeers?.(peers))
    }

    getConnectedPeers(roomId: string): PeerInfo[] {
        const provider = this.providers.get(roomId)
        if (!provider) return []

        const peers: PeerInfo[] = []
        const now = Date.now()

        provider.awareness.getStates().forEach((state, clientId) => {
            if (clientId !== provider.awareness.clientID) {
                const user = state.user as { name?: string; color?: string } | undefined
                peers.push({
                    id: String(clientId),
                    name: user?.name || 'Anonymous',
                    color: user?.color || '#888',
                    lastSeen: now,
                    isOnline: true
                })
            }
        })

        return peers
    }

    getPeerCount(roomId: string): number {
        return this.getConnectedPeers(roomId).length
    }

    isConnected(roomId: string): boolean {
        return this.providers.has(roomId)
    }

    getProvider(roomId: string): WebrtcProvider | undefined {
        return this.providers.get(roomId)
    }

    // SECURITY FIX V-002: Use URL fragment (#) instead of query string (?)
    generateRoomLink(roomId: string, password?: string, spaceName?: string): string {
        const normalized = normalizeRoomId(roomId)
        const base = `kalynt://join/${normalized}`

        const params: string[] = []
        if (password) {
            params.push(`p=${encodeURIComponent(password)}`)
        }
        if (spaceName) {
            params.push(`n=${encodeURIComponent(spaceName)}`)
        }

        if (params.length > 0) {
            return `${base}#${params.join('&')}`
        }
        return base
    }

    // Parse a room link (supports both kalynt and legacy collabforge)
    parseRoomLink(link: string): { roomId: string; password?: string; spaceName?: string } | null {
        try {
            const url = new URL(link)
            const rawRoomId = url.pathname.split('/').pop()

            let password: string | undefined
            let spaceName: string | undefined

            if (url.hash) {
                const hashParams = new URLSearchParams(url.hash.slice(1))
                password = hashParams.get('p') || undefined
                spaceName = hashParams.get('n') || undefined
            }

            if (!password) {
                password = url.searchParams.get('p') || undefined
                if (password) {
                    logger.p2p.warn('Room link uses insecure query string for password - please regenerate link')
                }
            }

            if (rawRoomId) {
                return { roomId: normalizeRoomId(rawRoomId), password, spaceName }
            }
        } catch (error) {
            logger.p2p.debug('Failed to parse room link as URL, trying regex', { link, error })
            const roomMatch = /(?:kalynt|collabforge):\/\/join\/([^?#]+)/.exec(link)
            if (roomMatch) {
                const fragmentMatch = /#(?:[^&]*&)*p=([^&]+)/.exec(link)
                const queryMatch = /[?&]p=([^&#]+)/.exec(link)
                const nameMatch = /[#&]n=([^&]+)/.exec(link)

                let password: string | undefined
                let spaceName: string | undefined

                if (fragmentMatch) {
                    password = decodeURIComponent(fragmentMatch[1])
                } else if (queryMatch) {
                    password = decodeURIComponent(queryMatch[1])
                    logger.p2p.warn('Room link uses insecure query string for password')
                }

                if (nameMatch) {
                    spaceName = decodeURIComponent(nameMatch[1])
                }

                return {
                    roomId: normalizeRoomId(roomMatch[1]),
                    password,
                    spaceName
                }
            }
        }
        return null
    }

    /**
     * Set up stats tracking with leak-free cleanup, local-clock round-trip RTT
     * ping/pong (no cross-clock skew), and accurate sent vs received byte counters.
     */
    private setupStatsTracking(provider: WebrtcProvider, roomId: string) {
        const previousCleanup = this.statsCleanups.get(roomId)
        if (previousCleanup) previousCleanup()

        const stats = this.roomStats.get(roomId)
        if (!stats) return

        let pingSeq = 0
        // seq -> local monotonic timestamp (ms)
        const pendingPings = new Map<number, number>()
        // remoteClientId -> last ping seq we echoed in pong
        const lastEchoedPing = new Map<number, number>()
        // remoteClientId -> last ping seq we recorded RTT for
        const lastMeasuredPing = new Map<number, number>()

        const pingInterval = setInterval(() => {
            if (!this.providers.has(roomId) || this.providers.get(roomId) !== provider) {
                clearInterval(pingInterval)
                return
            }

            pingSeq += 1
            const sentMono = nowMonotonicMs()
            pendingPings.set(pingSeq, sentMono)
            stats.lastPingTime = Date.now()

            // Prune stale pings older than 30s
            for (const [id, ts] of pendingPings) {
                if (sentMono - ts > 30000) {
                    pendingPings.delete(id)
                }
            }

            provider.awareness.setLocalStateField('ping', { id: pingSeq })
        }, 5000)
        const maybePing = pingInterval as unknown as { unref?: () => void }
        maybePing.unref?.()

        const awarenessHandler = () => {
            const states = provider.awareness.getStates()
            const localClientId = provider.awareness.clientID
            const localKey = String(localClientId)
            const localState = provider.awareness.getLocalState() as { pong?: Record<string, number> } | null
            let nextPong: Record<string, number> | null = null

            states.forEach((state, clientId) => {
                if (clientId === localClientId || !state) return

                // 1. Echo peer's ping id in our pong map (only when changed)
                const remotePingId = typeof state.ping === 'object' && state.ping !== null
                    ? (state.ping as { id?: unknown }).id
                    : undefined
                if (typeof remotePingId === 'number' && lastEchoedPing.get(clientId) !== remotePingId) {
                    lastEchoedPing.set(clientId, remotePingId)
                    if (!nextPong) {
                        nextPong = { ...(localState?.pong || {}) }
                    }
                    nextPong[String(clientId)] = remotePingId
                }

                // 2. Measure true local-clock round-trip latency from peer's pong
                const remotePong = state.pong as Record<string, unknown> | undefined
                const echoedId = remotePong ? remotePong[localKey] : undefined
                if (
                    typeof echoedId === 'number' &&
                    lastMeasuredPing.get(clientId) !== echoedId
                ) {
                    const sentMono = pendingPings.get(echoedId)
                    if (sentMono !== undefined) {
                        lastMeasuredPing.set(clientId, echoedId)
                        const rtt = Math.max(1, Math.round(nowMonotonicMs() - sentMono))
                        if (stats.latencies.length >= 10) {
                            stats.latencies.shift()
                        }
                        stats.latencies.push(rtt)
                    }
                }
            })

            if (nextPong) {
                provider.awareness.setLocalStateField('pong', nextPong)
            }
        }
        provider.awareness.on('change', awarenessHandler)

        const doc = provider.doc
        const docUpdateHandler = (update: Uint8Array, origin: unknown) => {
            const internalRoom = (provider as unknown as { room?: unknown }).room
            const isRemote =
                (internalRoom !== undefined && origin === internalRoom) ||
                origin === provider ||
                (typeof origin === 'object' &&
                    origin !== null &&
                    'provider' in origin &&
                    (origin as { provider?: unknown }).provider === provider)

            if (isRemote) {
                stats.bytesReceived += update.byteLength
            } else {
                // Skip local IndexedDB hydration updates when counting outgoing bytes
                const isPersistenceLoad =
                    typeof origin === 'object' &&
                    origin !== null &&
                    'db' in origin &&
                    'doc' in origin
                if (!isPersistenceLoad) {
                    stats.bytesSent += update.byteLength
                }
            }
        }
        doc.on('update', docUpdateHandler)

        this.statsCleanups.set(roomId, () => {
            clearInterval(pingInterval)
            try {
                provider.awareness.off('change', awarenessHandler)
            } catch {
                // Ignore if awareness already destroyed
            }
            try {
                doc.off('update', docUpdateHandler)
            } catch {
                // Ignore if doc already destroyed
            }
            pendingPings.clear()
            lastEchoedPing.clear()
            lastMeasuredPing.clear()
        })
    }

    getStats(roomId: string): P2PStats {
        const stats = this.roomStats.get(roomId)
        const avgLatency = stats && stats.latencies.length > 0
            ? Math.round(stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length)
            : 0

        return {
            connectedPeers: this.getPeerCount(roomId),
            totalBytesReceived: stats?.bytesReceived || 0,
            totalBytesSent: stats?.bytesSent || 0,
            averageLatency: avgLatency
        }
    }

    /**
     * Load TURN settings from OS-backed safeStorage when available, automatically
     * migrating any legacy plaintext localStorage credentials into safeStorage.
     */
    async loadTurnSettings(): Promise<TurnSettings & { isConfigured: boolean }> {
        if (!this.turnLoadPromise) {
            this.turnLoadPromise = (async () => {
                const safe = getSafeStorage()
                let resolved: TurnSettings | null = null

                if (safe) {
                    try {
                        const res: SafeStorageResult | undefined = await safe.get(TURN_SAFE_STORAGE_KEY)
                        if (res?.success && typeof res.value === 'string' && res.value) {
                            resolved = parseTurnJson(res.value)
                            // Remove any leftover legacy plaintext copy
                            if (hasLocalStorage()) {
                                localStorage.removeItem(TURN_LEGACY_LOCAL_KEY)
                            }
                        }
                    } catch (error) {
                        console.warn('[P2P] Failed to load TURN settings from safeStorage:', error)
                    }
                }

                if (!resolved) {
                    const legacy = readLegacyTurnFromLocalStorage()
                    if (legacy.url || legacy.username || legacy.credential) {
                        resolved = legacy
                        if (safe) {
                            try {
                                const saved: SafeStorageResult | undefined = await safe.set({
                                    key: TURN_SAFE_STORAGE_KEY,
                                    value: JSON.stringify(legacy)
                                })
                                if (saved?.success && hasLocalStorage()) {
                                    localStorage.removeItem(TURN_LEGACY_LOCAL_KEY)
                                    console.log('[P2P] Migrated TURN credentials to safeStorage')
                                }
                            } catch {
                                // Keep working; next start will retry migration
                            }
                        }
                    } else {
                        resolved = { ...EMPTY_TURN }
                    }
                }

                this.cachedTurnSettings = resolved
                return resolved
            })().finally(() => {
                this.turnLoadPromise = null
            })
        }

        const settings = await this.turnLoadPromise
        const isConfigured = !!(settings.url && settings.username && settings.credential)
        return { ...settings, isConfigured }
    }

    /**
     * Save TURN settings securely via safeStorage (falling back cleanly to
     * localStorage only in web/non-Electron shim).
     */
    async saveTurnSettings(settings: TurnSettings): Promise<{ secure: boolean }> {
        const cleaned: TurnSettings = {
            url: settings.url.trim(),
            username: settings.username.trim(),
            credential: settings.credential
        }
        const isEmpty = !cleaned.url && !cleaned.username && !cleaned.credential
        const safe = getSafeStorage()

        if (isEmpty) {
            this.cachedTurnSettings = { ...EMPTY_TURN }
            if (safe) {
                await safe.delete(TURN_SAFE_STORAGE_KEY).catch(() => undefined)
            }
            if (hasLocalStorage()) {
                localStorage.removeItem(TURN_LEGACY_LOCAL_KEY)
            }
            return { secure: true }
        }

        if (safe) {
            try {
                const res: SafeStorageResult | undefined = await safe.set({
                    key: TURN_SAFE_STORAGE_KEY,
                    value: JSON.stringify(cleaned)
                })
                if (res?.success) {
                    this.cachedTurnSettings = cleaned
                    if (hasLocalStorage()) {
                        localStorage.removeItem(TURN_LEGACY_LOCAL_KEY)
                    }
                    return { secure: true }
                }
            } catch (error) {
                console.warn('[P2P] Failed to store TURN settings in safeStorage:', error)
            }
        }

        if (isWebShimEnvironment()) {
            this.cachedTurnSettings = cleaned
            if (hasLocalStorage()) {
                localStorage.setItem(TURN_LEGACY_LOCAL_KEY, JSON.stringify(cleaned))
            }
            return { secure: false }
        }

        throw new Error('TURN credentials could not be saved to secure storage.')
    }

    // Reconnect all active providers with updated ICE settings while preserving
    // room passwords, Y.Docs, and registered room listeners.
    async refreshTurnSettings(): Promise<void> {
        await this.loadTurnSettings()
        console.log('[P2P] TURN settings refreshed; reconnecting active rooms')

        const connectedRoomIds = Array.from(this.providers.keys())
        await Promise.all(
            connectedRoomIds.map(roomId => this.reconnect(roomId))
        )
    }

    // Synchronous read of current TURN settings for initial UI state
    getTurnSettings(): { url: string; username: string; credential: string; isConfigured: boolean } {
        const turnSettings = this.cachedTurnSettings
        const isConfigured = !!(turnSettings.url && turnSettings.username && turnSettings.credential)
        return { ...turnSettings, isConfigured }
    }

    /**
     * Test ICE connectivity purely in memory — accepts optional unsaved TURN
     * overrides without ever mutating localStorage or safeStorage.
     */
    async testConnectivity(overrideTurn?: Partial<TurnSettings>): Promise<{
        stun: boolean
        turn: boolean
        candidates: { type: string; protocol: string; address?: string }[]
        error?: string
    }> {
        const result = {
            stun: false,
            turn: false,
            candidates: [] as { type: string; protocol: string; address?: string }[]
        }

        try {
            const effectiveTurn = overrideTurn !== undefined ? overrideTurn : this.cachedTurnSettings
            const pc = new RTCPeerConnection({ iceServers: buildIceServers(effectiveTurn) })

            pc.createDataChannel('test')

            const gatheringComplete = new Promise<void>((resolve) => {
                const timeout = setTimeout(() => resolve(), 30000)

                pc.onicecandidate = (event) => {
                    if (event.candidate) {
                        const candidate = event.candidate
                        result.candidates.push({
                            type: candidate.type || 'unknown',
                            protocol: candidate.protocol || 'unknown',
                            address: candidate.address || undefined
                        })

                        if (candidate.type === 'srflx') {
                            result.stun = true
                        } else if (candidate.type === 'relay') {
                            result.turn = true
                        }
                    } else {
                        clearTimeout(timeout)
                        resolve()
                    }
                }

                pc.onicegatheringstatechange = () => {
                    if (pc.iceGatheringState === 'complete') {
                        clearTimeout(timeout)
                        resolve()
                    }
                }
            })

            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            await gatheringComplete

            pc.close()

            logger.p2p.info('ICE connectivity test complete', result)
            return result
        } catch (error) {
            logger.p2p.error('ICE connectivity test failed', { error })
            return { ...result, error: String(error) }
        }
    }

    getConnectionInfo(roomId: string): {
        connected: boolean
        peerCount: number
        signalingState: string
        iceServers: number
        turnEnabled: boolean
    } {
        const provider = this.providers.get(roomId)
        const iceServers = buildIceServers(this.cachedTurnSettings)
        const hasTurn = iceServers.some(server =>
            (typeof server.urls === 'string' ? server.urls : server.urls?.[0])?.startsWith('turn:')
        )

        return {
            connected: !!provider,
            peerCount: provider ? this.getPeerCount(roomId) : 0,
            signalingState: provider ? 'connected' : 'disconnected',
            iceServers: iceServers.length,
            turnEnabled: hasTurn
        }
    }

    isPeerAllowed(peerId: string): boolean {
        return !this.rateLimiter.isBanned(peerId)
    }

    checkPeerMessageRate(peerId: string): boolean {
        return this.rateLimiter.checkMessageRate(peerId)
    }
}

export const p2pService = new P2PService()
export default p2pService

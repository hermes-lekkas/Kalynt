/**
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Persistent Audit Logging Service
 *
 * This service provides persistent security event logging for compliance
 * and security monitoring. Events are stored in IndexedDB with automatic
 * rotation and export capabilities.
 */

export type AuditEventType = 
    | 'security'      // Security-related events (encryption, auth)
    | 'p2p'          // P2P network events (connect, disconnect)
    | 'file'         // File system operations
    | 'agent'        // AI agent actions
    | 'user'         // User actions
    | 'system'       // System events
    | 'error'        // Errors and failures

export interface AuditEvent {
    id: string
    timestamp: number
    type: AuditEventType
    category: string
    action: string
    userId?: string
    peerId?: string
    roomId?: string
    details?: Record<string, any>
    severity: 'info' | 'warning' | 'error' | 'critical'
    source: string // Component that generated the event
}

export interface AuditQuery {
    startTime?: number
    endTime?: number
    types?: AuditEventType[]
    severity?: ('info' | 'warning' | 'error' | 'critical')[]
    roomId?: string
    peerId?: string
    limit?: number
    offset?: number
}

const DB_NAME = 'kalynt-audit-logs'
const DB_VERSION = 1
const STORE_NAME = 'events'
const MAX_LOG_AGE_DAYS = 30 // Auto-delete logs older than 30 days
// const MAX_LOGS_COUNT = 10000 // Maximum number of logs to keep

class AuditLogService {
    private db: IDBDatabase | null = null
    private initPromise: Promise<void> | null = null
    private inMemoryQueue: AuditEvent[] = []
    private flushInterval: ReturnType<typeof setInterval> | null = null
    private onlineHandler: (() => void) | null = null

    async initialize(): Promise<void> {
        if (this.initPromise) return this.initPromise
        
        this.initPromise = this.doInitialize()
        return this.initPromise
    }

    private async doInitialize(): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION)

            request.onerror = () => reject(request.error)
            request.onsuccess = () => {
                this.db = request.result
                this.startFlushInterval()
                this.cleanupOldLogs()
                resolve()
            }

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result
                
                // Create object store with indexes
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
                    store.createIndex('timestamp', 'timestamp', { unique: false })
                    store.createIndex('type', 'type', { unique: false })
                    store.createIndex('severity', 'severity', { unique: false })
                    store.createIndex('roomId', 'roomId', { unique: false })
                    store.createIndex('peerId', 'peerId', { unique: false })
                }
            }
        })
    }

    private startFlushInterval(): void {
        if (this.flushInterval) {
            clearInterval(this.flushInterval)
        }
        // Flush in-memory queue every 5 seconds
        this.flushInterval = setInterval(() => {
            void this.flushQueue()
        }, 5000)

        // Handle online status without leaking duplicate listeners
        if (typeof window !== 'undefined' && !this.onlineHandler) {
            this.onlineHandler = () => {
                void this.flushQueue()
            }
            window.addEventListener('online', this.onlineHandler)
        }
    }

    private async flushQueue(): Promise<void> {
        if (!this.db || this.inMemoryQueue.length === 0) return

        const events = [...this.inMemoryQueue]
        this.inMemoryQueue = []

        try {
            const transaction = this.db.transaction([STORE_NAME], 'readwrite')
            const store = transaction.objectStore(STORE_NAME)

            for (const event of events) {
                store.put(event)
            }

            await new Promise<void>((resolve, reject) => {
                transaction.oncomplete = () => resolve()
                transaction.onerror = () => reject(transaction.error)
            })
        } catch (error) {
            // Put events back in queue on error
            this.inMemoryQueue.unshift(...events)
            console.error('[AuditLog] Failed to flush queue:', error)
        }
    }

    async log(
        type: AuditEventType,
        category: string,
        action: string,
        severity: 'info' | 'warning' | 'error' | 'critical' = 'info',
        details?: Record<string, any>,
        context?: { userId?: string; peerId?: string; roomId?: string }
    ): Promise<void> {
        const event: AuditEvent = {
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            type,
            category,
            action,
            severity,
            details,
            source: this.getCallerInfo(),
            ...context
        }

        // Always log to console for immediate visibility
        this.logToConsole(event)

        // Add to in-memory queue for batch writing
        this.inMemoryQueue.push(event)

        // If critical, flush immediately
        if (severity === 'critical') {
            await this.flushQueue()
        }

        // Keep queue size bounded
        if (this.inMemoryQueue.length > 100) {
            this.inMemoryQueue = this.inMemoryQueue.slice(-100)
        }
    }

    private logToConsole(event: AuditEvent): void {
        const timestamp = new Date(event.timestamp).toISOString()
        const message = `[AUDIT] ${timestamp} [${event.severity.toUpperCase()}] ${event.type}:${event.category}:${event.action}`
        
        switch (event.severity) {
            case 'critical':
                console.error(message, event.details)
                break
            case 'error':
                console.error(message, event.details)
                break
            case 'warning':
                console.warn(message, event.details)
                break
            default:
                console.log(message, event.details)
        }
    }

    private getCallerInfo(): string {
        const stack = new Error().stack
        if (!stack) return 'unknown'

        // Parse stack trace to find caller
        const lines = stack.split('\n')
        // Skip Error, log, and getCallerInfo lines
        for (let i = 3; i < lines.length; i++) {
            const line = lines[i]
            if (line.includes('auditLogService')) continue
            
            // Extract function name and file
            const match = line.match(/at\s+(\S+)\s+\(([^:]+):/)
            if (match) {
                return `${match[1]} (${match[2].split('/').pop()})`
            }
        }
        return 'unknown'
    }

    async query(query: AuditQuery = {}): Promise<{ events: AuditEvent[]; total: number }> {
        await this.initialize()
        if (!this.db) return { events: [], total: 0 }

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const request = store.index('timestamp').openCursor(null, 'prev')
            
            const events: AuditEvent[] = []
            let total = 0
            let skipped = 0
            const offset = query.offset || 0
            const limit = query.limit || 100

            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result

                if (!cursor) {
                    resolve({ events, total })
                    return
                }

                const auditEvent = cursor.value as AuditEvent

                // Apply filters
                if (query.startTime && auditEvent.timestamp < query.startTime) {
                    cursor.continue()
                    return
                }
                if (query.endTime && auditEvent.timestamp > query.endTime) {
                    cursor.continue()
                    return
                }
                if (query.types && !query.types.includes(auditEvent.type)) {
                    cursor.continue()
                    return
                }
                if (query.severity && !query.severity.includes(auditEvent.severity)) {
                    cursor.continue()
                    return
                }
                if (query.roomId && auditEvent.roomId !== query.roomId) {
                    cursor.continue()
                    return
                }
                if (query.peerId && auditEvent.peerId !== query.peerId) {
                    cursor.continue()
                    return
                }

                total++

                // Pagination
                if (skipped < offset) {
                    skipped++
                } else if (events.length < limit) {
                    events.push(auditEvent)
                }

                cursor.continue()
            }

            request.onerror = () => reject(request.error)
        })
    }

    async exportToJSON(query: AuditQuery = {}): Promise<string> {
        const { events } = await this.query({ ...query, limit: 10000 })
        return JSON.stringify(events, null, 2)
    }

    async clear(): Promise<void> {
        await this.initialize()
        if (!this.db) return

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([STORE_NAME], 'readwrite')
            const store = transaction.objectStore(STORE_NAME)
            const request = store.clear()

            request.onsuccess = () => resolve()
            request.onerror = () => reject(request.error)
        })
    }

    private async cleanupOldLogs(): Promise<void> {
        if (!this.db) return

        const cutoffTime = Date.now() - (MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000)

        try {
            const transaction = this.db.transaction([STORE_NAME], 'readwrite')
            const store = transaction.objectStore(STORE_NAME)
            const index = store.index('timestamp')
            const range = IDBKeyRange.upperBound(cutoffTime)
            const request = index.openCursor(range)

            let deleted = 0
            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result
                if (cursor) {
                    store.delete(cursor.primaryKey)
                    deleted++
                    cursor.continue()
                } else {
                    if (deleted > 0) {
                        console.log(`[AuditLog] Cleaned up ${deleted} old log entries`)
                    }
                }
            }
        } catch (error) {
            console.error('[AuditLog] Failed to cleanup old logs:', error)
        }
    }

    async getStats(): Promise<{ total: number; byType: Record<AuditEventType, number>; bySeverity: Record<string, number> }> {
        await this.initialize()
        if (!this.db) return { total: 0, byType: {} as any, bySeverity: {} }

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const request = store.count()

            request.onsuccess = () => {
                const total = request.result
                // For detailed stats, we'd need to iterate - simplified for now
                resolve({ 
                    total, 
                    byType: {} as Record<AuditEventType, number>,
                    bySeverity: {}
                })
            }
            request.onerror = () => reject(request.error)
        })
    }

    destroy(): void {
        if (this.flushInterval) {
            clearInterval(this.flushInterval)
            this.flushInterval = null
        }
        if (typeof window !== 'undefined' && this.onlineHandler) {
            window.removeEventListener('online', this.onlineHandler)
            this.onlineHandler = null
        }
        void this.flushQueue() // Final flush
        if (this.db) {
            this.db.close()
            this.db = null
        }
        this.initPromise = null
    }
}

// Singleton instance
export const auditLogService = new AuditLogService()

// Convenience methods for common event types
export const securityLog = {
    encryptionEnabled: (roomId: string, details?: any) => 
        auditLogService.log('security', 'encryption', 'enabled', 'info', { roomId, ...details }),
    
    encryptionFailed: (roomId: string, error: string) =>
        auditLogService.log('security', 'encryption', 'failed', 'error', { roomId, error }),
    
    peerAuthenticated: (peerId: string, roomId: string) =>
        auditLogService.log('security', 'auth', 'peer_authenticated', 'info', { peerId, roomId }),
    
    peerRejected: (peerId: string, roomId: string, reason: string) =>
        auditLogService.log('security', 'auth', 'peer_rejected', 'warning', { peerId, roomId, reason }),
    
    rateLimitTriggered: (peerId: string, action: string) =>
        auditLogService.log('security', 'rate_limit', 'triggered', 'warning', { peerId, action }),
    
    integrityViolation: (roomId: string, peerId: string, details: any) =>
        auditLogService.log('security', 'integrity', 'violation', 'critical', { roomId, peerId, ...details })
}

export const p2pLog = {
    connected: (roomId: string, peerCount: number) =>
        auditLogService.log('p2p', 'connection', 'connected', 'info', { roomId, peerCount }),
    
    disconnected: (roomId: string) =>
        auditLogService.log('p2p', 'connection', 'disconnected', 'info', { roomId }),
    
    peerJoined: (peerId: string, roomId: string) =>
        auditLogService.log('p2p', 'peer', 'joined', 'info', { peerId, roomId }),
    
    peerLeft: (peerId: string, roomId: string) =>
        auditLogService.log('p2p', 'peer', 'left', 'info', { peerId, roomId }),
    
    syncError: (roomId: string, error: string) =>
        auditLogService.log('p2p', 'sync', 'error', 'error', { roomId, error })
}

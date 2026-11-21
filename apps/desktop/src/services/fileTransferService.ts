/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// P2P File Transfer Service - Single canonical Y.Doc with WebRTC-friendly chunking & SHA-256 verification
import * as Y from 'yjs'
import { getSpaceDocument } from '../hooks/useYjs'
import { normalizeRoomId, p2pService, type PeerInfo } from './p2pService'
import { useNotificationStore } from '../stores/notificationStore'

export type TransferTier = 'small' | 'medium' | 'large'

export type FileTransferState =
    | 'local-only'
    | 'sending'
    | 'receiving'
    | 'incomplete'
    | 'ready'

export interface SharedFile {
    id: string
    name: string
    size: number
    type: string
    uploadedAt: number
    uploadedBy: string
    ownerId: string
    tier: TransferTier
    // For inline small files (<= 64 KiB): full Base64 content. For larger files: chunk references.
    content?: string
    chunkCount?: number
    /** Lowercase hex SHA-256 of raw file bytes, verified on download. */
    checksum?: string
    /** True once the uploader finishes writing all chunks into the shared Y.Doc. */
    uploadComplete?: boolean
    /** Derived runtime fields populated on read. */
    isLocal: boolean
    receivedChunks?: number
    totalChunks?: number
    transferState?: FileTransferState
}

export interface FileChunk {
    fileId: string
    index: number
    data: string // Base64
}

export interface AssembleFileResult {
    ok: boolean
    bytes?: Uint8Array
    checksum?: string
    error?: string
    missingChunks?: number[]
}

export type FileTransferCallback = (files: SharedFile[]) => void
export type PeersCallback = (peers: PeerInfo[]) => void
export type ProgressCallback = (fileId: string, progress: number) => void

// Tier size limits
const TIER_LIMITS = {
    small: 5 * 1024 * 1024,      // 5MB
    medium: 50 * 1024 * 1024,    // 50MB
    large: 200 * 1024 * 1024     // 200MB
}

// WebRTC-friendly 64 KiB chunks so 6 MiB+ transfers sync reliably over SCTP DataChannels.
export const FILE_CHUNK_SIZE = 64 * 1024
export const MAX_FILE_CHUNKS = 4096
const PERSISTENT_USER_ID_KEY = 'kalynt-user-id'

function getOrCreatePersistentUserId(): string {
    try {
        if (typeof localStorage !== 'undefined') {
            const stored = localStorage.getItem(PERSISTENT_USER_ID_KEY)
            if (stored) return stored
            const created = crypto.randomUUID()
            localStorage.setItem(PERSISTENT_USER_ID_KEY, created)
            return created
        }
    } catch {
        // Fallback when localStorage is unavailable
    }
    return crypto.randomUUID()
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
    const STEP = 0x8000
    let binary = ''
    for (let i = 0; i < bytes.length; i += STEP) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + STEP, bytes.length)))
    }
    return btoa(binary)
}

/**
 * Decode a single Base64 chunk cleanly into raw bytes.
 * Decoding each chunk independently avoids Base64 padding corruption when
 * chunk lengths are not multiples of 3 bytes.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
    let totalLength = 0
    for (const chunk of chunks) {
        totalLength += chunk.byteLength
    }
    const merged = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
    }
    return merged
}

export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
    return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
}

function isYDocLike(value: unknown): value is Y.Doc {
    return typeof value === 'object' && value !== null && typeof (value as Y.Doc).getMap === 'function'
}

export class FileTransferService {
    private doc: Y.Doc | null = null
    private roomId: string | null = null
    private localUserId: string = getOrCreatePersistentUserId()
    private onFilesChange: FileTransferCallback | null = null
    private onPeersChange: PeersCallback | null = null
    private onProgress: ProgressCallback | null = null
    private initialized: boolean = false
    private initSequence: number = 0
    private currentPeers: PeerInfo[] = []
    private inFlightUploads: Set<string> = new Set()

    private observedFilesMap: Y.Map<SharedFile> | null = null
    private observedChunksMap: Y.Map<FileChunk> | null = null
    private filesObserver: (() => void) | null = null
    private chunksObserver: (() => void) | null = null
    private roomListenerUnsub: (() => void) | null = null

    /**
     * Bind FileTransferService to the room's canonical live Y.Doc.
     * Pass the live `Y.Doc` from `useYDoc(spaceId)` directly (or a room/doc string,
     * which falls back to `getSpaceDocument`, never a detached `collabEngine` doc).
     */
    init(roomId: string, docOrId?: Y.Doc | string) {
        const normalizedRoomId = normalizeRoomId(roomId)
        const targetDoc = isYDocLike(docOrId)
            ? docOrId
            : getSpaceDocument(typeof docOrId === 'string' && docOrId.trim() ? docOrId : normalizedRoomId)

        if (this.initialized && this.roomId === normalizedRoomId && this.doc === targetDoc) {
            this.seedCurrentState()
            return
        }

        if (this.initialized) {
            this.destroy()
        }

        this.initSequence += 1
        this.roomId = normalizedRoomId
        this.doc = targetDoc
        this.initialized = true
        this.currentPeers = p2pService.getConnectedPeers(normalizedRoomId)

        const filesMap = this.getFilesMap()
        if (filesMap) {
            const observer = () => {
                if (this.initialized && this.doc === targetDoc) this.notifyFilesChange()
            }
            filesMap.observe(observer)
            this.observedFilesMap = filesMap
            this.filesObserver = observer
        }

        const chunksMap = this.getChunksMap()
        if (chunksMap) {
            const observer = () => {
                if (this.initialized && this.doc === targetDoc) this.notifyFilesChange()
            }
            chunksMap.observe(observer)
            this.observedChunksMap = chunksMap
            this.chunksObserver = observer
        }

        this.roomListenerUnsub = p2pService.addRoomListener(normalizedRoomId, {
            onPeers: (peers) => {
                this.currentPeers = peers
                this.onPeersChange?.(peers)
                if (this.initialized && this.doc === targetDoc) {
                    this.notifyFilesChange()
                }
            }
        })

        this.seedCurrentState()
        console.log('[FileTransfer] Initialized on canonical Y.Doc for room:', normalizedRoomId)
    }

    private seedCurrentState() {
        if (!this.initialized || !this.roomId) return
        this.currentPeers = p2pService.getConnectedPeers(this.roomId)
        this.onPeersChange?.(this.currentPeers)
        this.notifyFilesChange()
    }

    destroy() {
        this.initialized = false
        this.initSequence += 1
        this.inFlightUploads.clear()

        if (this.observedFilesMap && this.filesObserver) {
            try {
                this.observedFilesMap.unobserve(this.filesObserver)
            } catch {
                // Ignore if doc already destroyed
            }
        }
        this.observedFilesMap = null
        this.filesObserver = null

        if (this.observedChunksMap && this.chunksObserver) {
            try {
                this.observedChunksMap.unobserve(this.chunksObserver)
            } catch {
                // Ignore if doc already destroyed
            }
        }
        this.observedChunksMap = null
        this.chunksObserver = null

        if (this.roomListenerUnsub) {
            this.roomListenerUnsub()
            this.roomListenerUnsub = null
        }

        this.currentPeers = []
        this.doc = null
        this.roomId = null
    }

    setCallbacks(onFiles: FileTransferCallback, onPeers: PeersCallback, onProgress?: ProgressCallback) {
        this.onFilesChange = onFiles
        this.onPeersChange = onPeers
        this.onProgress = onProgress || null
        if (this.initialized) {
            this.seedCurrentState()
        }
    }

    setLocalUserIdForTest(userId: string) {
        this.localUserId = userId
    }

    private getFilesMap(): Y.Map<SharedFile> | null {
        if (!this.doc || !this.initialized) return null
        return this.doc.getMap<SharedFile>('shared-files')
    }

    private getChunksMap(): Y.Map<FileChunk> | null {
        if (!this.doc || !this.initialized) return null
        return this.doc.getMap<FileChunk>('file-chunks')
    }

    private countReceivedChunks(file: SharedFile, chunksMap: Y.Map<FileChunk> | null): number {
        if (file.content && !file.chunkCount) return 1
        const total = file.chunkCount ?? 0
        if (total <= 0 || !chunksMap) return 0
        let received = 0
        for (let i = 0; i < total; i++) {
            if (chunksMap.has(`${file.id}-${i}`)) {
                received++
            }
        }
        return received
    }

    private computeTransferState(file: SharedFile, isLocal: boolean, receivedChunks: number, totalChunks: number): FileTransferState {
        const peerCount = this.getPeers().length
        const isChunked = Boolean(file.chunkCount && file.chunkCount > 0)
        const hasAllData = isChunked
            ? receivedChunks >= totalChunks && totalChunks > 0
            : Boolean(file.content)

        if (isLocal) {
            if (this.inFlightUploads.has(file.id)) {
                return 'sending'
            }
            if (!hasAllData || file.uploadComplete === false) {
                return 'incomplete'
            }
            return peerCount > 0 ? 'ready' : 'local-only'
        }

        if (hasAllData) {
            return 'ready'
        }

        return peerCount > 0 ? 'receiving' : 'incomplete'
    }

    private enrichFile(file: SharedFile, chunksMap: Y.Map<FileChunk> | null): SharedFile {
        const isLocal = file.ownerId === this.localUserId
        const totalChunks = file.chunkCount && file.chunkCount > 0 ? file.chunkCount : 1
        const receivedChunks = this.countReceivedChunks(file, chunksMap)
        const transferState = this.computeTransferState(file, isLocal, receivedChunks, totalChunks)
        return {
            ...file,
            isLocal,
            receivedChunks,
            totalChunks,
            transferState
        }
    }

    private notifyFilesChange() {
        if (!this.onFilesChange || !this.initialized) return
        this.onFilesChange(this.getFiles())
    }

    determineTier(fileSize: number, requestedTier: TransferTier): TransferTier {
        if (fileSize <= TIER_LIMITS.small) return 'small'
        if (fileSize <= TIER_LIMITS.medium) return requestedTier === 'small' ? 'medium' : requestedTier
        if (fileSize <= TIER_LIMITS.large) return 'large'

        throw new Error(`File size ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds maximum of 200MB`)
    }

    getTierInfo(tier: TransferTier): { label: string; maxSize: string; description: string } {
        switch (tier) {
            case 'small':
                return { label: 'Quick', maxSize: '5MB', description: 'Fast sync (≤5MB)' }
            case 'medium':
                return { label: 'Standard', maxSize: '50MB', description: 'Chunked transfer (≤50MB)' }
            case 'large':
                return { label: 'Large', maxSize: '200MB', description: 'Chunked transfer (≤200MB)' }
        }
    }

    async shareFile(
        file: File | { name: string; size: number; type: string; arrayBuffer: () => Promise<ArrayBuffer> },
        uploaderName: string,
        requestedTier: TransferTier = 'small'
    ): Promise<{ success: boolean; fileId?: string; actualTier?: TransferTier; checksum?: string; error?: string }> {
        if (!this.doc || !this.initialized) return { success: false, error: 'Not initialized' }

        if (!file) return { success: false, error: 'No file provided' }
        if (file.size < 0) return { success: false, error: 'Invalid file size' }
        if (file.size === 0) return { success: false, error: 'Cannot upload empty file' }

        const MAX_FILE_SIZE = 200 * 1024 * 1024
        if (file.size > MAX_FILE_SIZE) {
            return {
                success: false,
                error: `File size ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds maximum of 200MB`
            }
        }

        const estimatedStorage = file.size * 1.4
        if (estimatedStorage > 50 * 1024 * 1024) {
            console.warn('[FileTransfer] Large file may exceed browser storage limits')
        }

        const startSequence = this.initSequence
        const fileId = crypto.randomUUID()

        try {
            const actualTier = this.determineTier(file.size, requestedTier)
            const rawBuffer = await file.arrayBuffer()
            if (!this.initialized || this.initSequence !== startSequence) {
                return { success: false, error: 'File transfer was reset during upload' }
            }

            const bytes = new Uint8Array(rawBuffer)
            const checksum = await computeSha256Hex(bytes)

            if (!this.initialized || this.initSequence !== startSequence) {
                return { success: false, error: 'File transfer was reset during upload' }
            }

            const filesMap = this.getFilesMap()
            if (!filesMap) return { success: false, error: 'Not initialized' }

            if (bytes.byteLength <= FILE_CHUNK_SIZE) {
                const content = uint8ArrayToBase64(bytes)
                const sharedFile: SharedFile = {
                    id: fileId,
                    name: file.name,
                    size: bytes.byteLength,
                    type: file.type || 'application/octet-stream',
                    uploadedAt: Date.now(),
                    uploadedBy: uploaderName,
                    ownerId: this.localUserId,
                    tier: actualTier,
                    content,
                    checksum,
                    uploadComplete: true,
                    isLocal: true
                }

                filesMap.set(fileId, sharedFile)
                this.onProgress?.(fileId, 100)
            } else {
                const totalChunks = Math.ceil(bytes.byteLength / FILE_CHUNK_SIZE)
                if (totalChunks > MAX_FILE_CHUNKS) {
                    throw new Error(`File would create ${totalChunks} chunks, maximum is ${MAX_FILE_CHUNKS}. Try a smaller file.`)
                }

                this.inFlightUploads.add(fileId)
                const sharedFile: SharedFile = {
                    id: fileId,
                    name: file.name,
                    size: bytes.byteLength,
                    type: file.type || 'application/octet-stream',
                    uploadedAt: Date.now(),
                    uploadedBy: uploaderName,
                    ownerId: this.localUserId,
                    tier: actualTier,
                    chunkCount: totalChunks,
                    checksum,
                    uploadComplete: false,
                    isLocal: true
                }

                filesMap.set(fileId, sharedFile)

                const chunksMap = this.getChunksMap()
                if (!chunksMap) {
                    this.inFlightUploads.delete(fileId)
                    return { success: false, error: 'Not initialized' }
                }

                for (let i = 0; i < totalChunks; i++) {
                    if (!this.initialized || this.initSequence !== startSequence) {
                        this.inFlightUploads.delete(fileId)
                        return { success: false, error: 'Upload cancelled before completion' }
                    }

                    const start = i * FILE_CHUNK_SIZE
                    const end = Math.min(start + FILE_CHUNK_SIZE, bytes.byteLength)
                    const slice = bytes.subarray(start, end)
                    const data = uint8ArrayToBase64(slice)

                    chunksMap.set(`${fileId}-${i}`, {
                        fileId,
                        index: i,
                        data
                    })

                    this.onProgress?.(fileId, Math.round(((i + 1) / totalChunks) * 100))

                    // Yield between chunk writes so WebRTC DataChannels flush and the UI stays responsive on 6 MiB+ files.
                    await new Promise<void>(resolve => setTimeout(resolve, i % 4 === 3 ? 12 : 0))
                }

                this.inFlightUploads.delete(fileId)
                if (this.initialized && this.initSequence === startSequence) {
                    filesMap.set(fileId, {
                        ...sharedFile,
                        uploadComplete: true
                    })
                }
            }

            console.log(`[FileTransfer] Shared file (${actualTier}, sha256=${checksum.slice(0, 12)}):`, file.name)
            return { success: true, fileId, actualTier, checksum }
        } catch (err) {
            this.inFlightUploads.delete(fileId)
            console.error('[FileTransfer] Failed to share file:', err)
            return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
    }

    removeFile(fileId: string, isAdmin: boolean = false): boolean {
        if (!this.doc || !this.initialized) return false

        const filesMap = this.getFilesMap()
        if (!filesMap) return false
        const file = filesMap.get(fileId)

        if (file && (file.ownerId === this.localUserId || isAdmin)) {
            this.doc.transact(() => {
                if (file.chunkCount) {
                    const chunksMap = this.getChunksMap()
                    if (chunksMap) {
                        for (let i = 0; i < file.chunkCount; i++) {
                            chunksMap.delete(`${fileId}-${i}`)
                        }
                    }
                }
                filesMap.delete(fileId)
            })
            console.log(`[FileTransfer] Removed file (${isAdmin ? 'Admin' : 'Owner'}):`, fileId)
            return true
        }

        return false
    }

    clearAllFiles(): boolean {
        if (!this.doc || !this.initialized) return false

        const filesMap = this.getFilesMap()
        const chunksMap = this.getChunksMap()
        if (!filesMap) return false

        this.doc.transact(() => {
            if (chunksMap) {
                chunksMap.clear()
            }
            filesMap.clear()
        })
        console.log('[FileTransfer] Cleared all files')
        return true
    }

    /**
     * Reassemble raw bytes for a shared file and verify size + SHA-256 integrity.
     */
    async assembleFileBytes(file: SharedFile): Promise<AssembleFileResult> {
        let fileBytes: Uint8Array

        if (file.content && !file.chunkCount) {
            fileBytes = base64ToUint8Array(file.content)
        } else if (file.chunkCount && file.chunkCount > 0) {
            const chunksMap = this.getChunksMap()
            if (!chunksMap) {
                return { ok: false, error: 'File transfer is not initialized.' }
            }

            const missingChunks: number[] = []
            const decodedChunks: Uint8Array[] = []
            for (let i = 0; i < file.chunkCount; i++) {
                const chunk = chunksMap.get(`${file.id}-${i}`)
                if (!chunk) {
                    missingChunks.push(i)
                    continue
                }
                decodedChunks.push(base64ToUint8Array(chunk.data))
                this.onProgress?.(file.id, Math.round(((i + 1) / file.chunkCount) * 100))
            }

            if (missingChunks.length > 0) {
                return {
                    ok: false,
                    missingChunks,
                    error: `Missing ${missingChunks.length} of ${file.chunkCount} chunks. Transfer is incomplete.`
                }
            }

            fileBytes = concatUint8Arrays(decodedChunks)
        } else {
            return { ok: false, error: 'File content is not available.' }
        }

        if (file.size > 0 && fileBytes.byteLength !== file.size) {
            return {
                ok: false,
                error: `File size mismatch (expected ${file.size} bytes, got ${fileBytes.byteLength} bytes).`
            }
        }

        const checksum = await computeSha256Hex(fileBytes)
        if (file.checksum && checksum !== file.checksum) {
            return {
                ok: false,
                checksum,
                error: 'File integrity check failed (SHA-256 mismatch).'
            }
        }

        return { ok: true, bytes: fileBytes, checksum }
    }

    async downloadFile(file: SharedFile): Promise<{ success: boolean; error?: string }> {
        try {
            const assembled = await this.assembleFileBytes(file)
            if (!assembled.ok || !assembled.bytes) {
                const msg = assembled.error || 'Transfer is incomplete.'
                useNotificationStore.getState().addNotification(msg, 'error')
                return { success: false, error: msg }
            }

            const blob = new Blob([assembled.bytes as BlobPart], { type: file.type })
            const url = window.URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = file.name
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            window.URL.revokeObjectURL(url)

            return { success: true }
        } catch (err) {
            console.error('[FileTransfer] Download failed:', err)
            const msg = err instanceof Error ? err.message : String(err)
            return { success: false, error: msg }
        }
    }

    getFiles(): SharedFile[] {
        if (!this.doc || !this.initialized) return []

        const filesMap = this.getFilesMap()
        if (!filesMap) return []
        const chunksMap = this.getChunksMap()
        const files: SharedFile[] = []

        filesMap.forEach((file) => {
            files.push(this.enrichFile(file, chunksMap))
        })

        return files.sort((a, b) => b.uploadedAt - a.uploadedAt)
    }

    getPeers(): PeerInfo[] {
        if (!this.roomId) return []
        const live = p2pService.getConnectedPeers(this.roomId)
        return live.length > 0 ? live : this.currentPeers
    }

    getLocalUserId(): string {
        return this.localUserId
    }
}

export const fileTransferService = new FileTransferService()

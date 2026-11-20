/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// P2P File Transfer Service - Tiered transfer with chunking
import * as Y from 'yjs'
import { collabEngine } from './collabEngine'
import { p2pService, PeerInfo } from './p2pService'
import { useNotificationStore } from '../stores/notificationStore'

export type TransferTier = 'small' | 'medium' | 'large'

export interface SharedFile {
    id: string
    name: string
    size: number
    type: string
    uploadedAt: number
    uploadedBy: string
    ownerId: string
    tier: TransferTier
    // For small files: full content. For medium/large: chunk references
    content?: string
    chunkCount?: number
    isLocal: boolean
}

export interface FileChunk {
    fileId: string
    index: number
    data: string // Base64
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

// 256KB chunks (each chunk is decoded independently into Uint8Array on reassembly)
const CHUNK_SIZE = 256 * 1024
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

/**
 * Decode a single Base64 chunk cleanly into raw bytes.
 * Decoding each chunk independently avoids Base64 padding corruption when
 * CHUNK_SIZE is not a multiple of 3 bytes.
 */
function base64ToUint8Array(base64: string): Uint8Array {
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

class FileTransferService {
    private docId: string | null = null
    private roomId: string | null = null
    private localUserId: string = getOrCreatePersistentUserId()
    private onFilesChange: FileTransferCallback | null = null
    private onPeersChange: PeersCallback | null = null
    private onProgress: ProgressCallback | null = null
    private initialized: boolean = false
    private initSequence: number = 0
    private initTimer: ReturnType<typeof setTimeout> | null = null
    private ownsP2PConnection: boolean = false

    private observedFilesMap: Y.Map<SharedFile> | null = null
    private observedChunksMap: Y.Map<FileChunk> | null = null
    private filesObserver: (() => void) | null = null
    private chunksObserver: (() => void) | null = null
    private roomListenerUnsub: (() => void) | null = null

    init(roomId: string, docId: string) {
        if (this.initialized && this.roomId === roomId && this.docId === docId) return

        // Clean up any previous room before re-initializing
        if (this.initialized) {
            this.destroy()
        }

        const currentSequence = ++this.initSequence

        this.roomId = roomId
        this.docId = docId
        this.initialized = true

        // Only tear down the room P2P connection on destroy if we created it
        this.ownsP2PConnection = !p2pService.getProvider(roomId)

        const provider = collabEngine.connectP2P(docId, roomId)
        if (!provider) {
            console.error('[FileTransfer] Failed to connect P2P, file sharing may not work')
        }

        this.initTimer = setTimeout(() => {
            this.initTimer = null
            if (!this.initialized || this.docId !== docId || this.initSequence !== currentSequence) {
                console.log('[FileTransfer] Skipping stale observer setup')
                return
            }

            const filesMap = this.getFilesMap()
            if (filesMap) {
                const observer = () => {
                    if (this.initialized && this.docId) this.notifyFilesChange()
                }
                filesMap.observe(observer)
                this.observedFilesMap = filesMap
                this.filesObserver = observer
            }

            const chunksMap = this.getChunksMap()
            if (chunksMap) {
                const observer = () => {
                    if (this.initialized && this.docId) this.notifyFilesChange()
                }
                chunksMap.observe(observer)
                this.observedChunksMap = chunksMap
                this.chunksObserver = observer
            }

            this.notifyFilesChange()
        }, 0)

        this.roomListenerUnsub = p2pService.addRoomListener(roomId, {
            onPeers: (peers) => this.onPeersChange?.(peers)
        })

        console.log('[FileTransfer] Initialized for room:', roomId)
    }

    destroy() {
        this.initialized = false
        this.initSequence += 1

        if (this.initTimer) {
            clearTimeout(this.initTimer)
            this.initTimer = null
        }

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

        if (this.roomId && this.ownsP2PConnection) {
            collabEngine.disconnectP2P(this.roomId)
        }
        this.ownsP2PConnection = false
        this.docId = null
        this.roomId = null
    }

    setCallbacks(onFiles: FileTransferCallback, onPeers: PeersCallback, onProgress?: ProgressCallback) {
        this.onFilesChange = onFiles
        this.onPeersChange = onPeers
        this.onProgress = onProgress || null
    }

    private getFilesMap(): Y.Map<SharedFile> | null {
        if (!this.docId || !this.initialized) return null
        return collabEngine.getMap<SharedFile>(this.docId, 'shared-files')
    }

    private getChunksMap(): Y.Map<FileChunk> | null {
        if (!this.docId || !this.initialized) return null
        return collabEngine.getMap<FileChunk>(this.docId, 'file-chunks')
    }

    private notifyFilesChange() {
        if (!this.onFilesChange || !this.initialized) return

        const filesMap = this.getFilesMap()
        if (!filesMap) return

        const files: SharedFile[] = []

        filesMap.forEach((file) => {
            files.push({
                ...file,
                isLocal: file.ownerId === this.localUserId
            })
        })

        files.sort((a, b) => b.uploadedAt - a.uploadedAt)
        this.onFilesChange(files)
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
                return { label: 'Quick', maxSize: '5MB', description: 'Instant sync (≤5MB)' }
            case 'medium':
                return { label: 'Standard', maxSize: '50MB', description: 'Chunked transfer (≤50MB)' }
            case 'large':
                return { label: 'Large', maxSize: '200MB', description: 'Streaming (≤200MB)' }
        }
    }

    async shareFile(file: File, uploaderName: string, requestedTier: TransferTier = 'small'): Promise<{ success: boolean; actualTier?: TransferTier; error?: string }> {
        if (!this.docId) return { success: false, error: 'Not initialized' }

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

        try {
            const actualTier = this.determineTier(file.size, requestedTier)
            const fileId = crypto.randomUUID()

            if (actualTier === 'small') {
                const content = await this.fileToBase64(file)
                const sharedFile: SharedFile = {
                    id: fileId,
                    name: file.name,
                    size: file.size,
                    type: file.type || 'application/octet-stream',
                    uploadedAt: Date.now(),
                    uploadedBy: uploaderName,
                    ownerId: this.localUserId,
                    tier: actualTier,
                    content,
                    isLocal: true
                }

                const filesMap = this.getFilesMap()
                if (!filesMap) return { success: false, error: 'Not initialized' }
                filesMap.set(fileId, sharedFile)
            } else {
                const chunks = await this.splitFileIntoChunks(file, fileId)

                const sharedFile: SharedFile = {
                    id: fileId,
                    name: file.name,
                    size: file.size,
                    type: file.type || 'application/octet-stream',
                    uploadedAt: Date.now(),
                    uploadedBy: uploaderName,
                    ownerId: this.localUserId,
                    tier: actualTier,
                    chunkCount: chunks.length,
                    isLocal: true
                }

                const filesMap = this.getFilesMap()
                if (!filesMap) return { success: false, error: 'Not initialized' }
                filesMap.set(fileId, sharedFile)

                const chunksMap = this.getChunksMap()
                if (chunksMap) {
                    for (let i = 0; i < chunks.length; i++) {
                        chunksMap.set(`${fileId}-${i}`, chunks[i])
                        this.onProgress?.(fileId, ((i + 1) / chunks.length) * 100)

                        if (actualTier === 'large' && i % 10 === 0) {
                            await new Promise(r => setTimeout(r, 50))
                        }
                    }
                }
            }

            console.log(`[FileTransfer] Shared file (${actualTier}):`, file.name)
            return { success: true, actualTier }
        } catch (err) {
            console.error('[FileTransfer] Failed to share file:', err)
            return { success: false, error: String(err) }
        }
    }

    private async splitFileIntoChunks(file: File, fileId: string): Promise<FileChunk[]> {
        const chunks: FileChunk[] = []
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

        const MAX_CHUNKS = 1000
        if (totalChunks > MAX_CHUNKS) {
            throw new Error(`File would create ${totalChunks} chunks, maximum is ${MAX_CHUNKS}. Try a smaller file.`)
        }

        for (let i = 0; i < totalChunks; i++) {
            try {
                const start = i * CHUNK_SIZE
                const end = Math.min(start + CHUNK_SIZE, file.size)
                const blob = file.slice(start, end)
                const data = await this.blobToBase64(blob)

                if (!data || data.length === 0) {
                    throw new Error(`Failed to encode chunk ${i}: empty data`)
                }

                chunks.push({
                    fileId,
                    index: i,
                    data
                })

                if (i % 10 === 0 && i > 0) {
                    await new Promise(resolve => setTimeout(resolve, 0))
                }
            } catch (error) {
                throw new Error(`Failed to process chunk ${i}: ${error}`)
            }
        }

        return chunks
    }

    private blobToBase64(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader()
            const timeout = setTimeout(() => {
                reader.abort()
                reject(new Error('Blob read timeout (10s)'))
            }, 10000)

            reader.readAsDataURL(blob)
            reader.onload = () => {
                clearTimeout(timeout)
                try {
                    const result = reader.result as string
                    if (!result || !result.includes(',')) {
                        reject(new Error('Invalid blob data'))
                        return
                    }
                    resolve(result.split(',')[1])
                } catch (error) {
                    reject(new Error(`Failed to process blob: ${error}`))
                }
            }
            reader.onerror = () => {
                clearTimeout(timeout)
                reject(new Error(`BlobReader error: ${reader.error?.message || 'unknown'}`))
            }
            reader.onabort = () => {
                clearTimeout(timeout)
                reject(new Error('Blob read aborted'))
            }
        })
    }

    removeFile(fileId: string, isAdmin: boolean = false): boolean {
        if (!this.docId || !this.initialized) return false

        const filesMap = this.getFilesMap()
        if (!filesMap) return false
        const file = filesMap.get(fileId)

        if (file && (file.ownerId === this.localUserId || isAdmin)) {
            if (file.chunkCount) {
                const chunksMap = this.getChunksMap()
                if (chunksMap) {
                    for (let i = 0; i < file.chunkCount; i++) {
                        chunksMap.delete(`${fileId}-${i}`)
                    }
                }
            }

            filesMap.delete(fileId)
            console.log(`[FileTransfer] Removed file (${isAdmin ? 'Admin' : 'Owner'}):`, fileId)
            return true
        }

        return false
    }

    clearAllFiles(): boolean {
        if (!this.docId || !this.initialized) return false

        const filesMap = this.getFilesMap()
        const chunksMap = this.getChunksMap()
        if (!filesMap) return false

        if (chunksMap) {
            chunksMap.clear()
        }

        filesMap.clear()
        console.log('[FileTransfer] Cleared all files')
        return true
    }

    async downloadFile(file: SharedFile): Promise<boolean> {
        try {
            let fileBytes: Uint8Array

            if (file.tier === 'small' && file.content) {
                fileBytes = base64ToUint8Array(file.content)
            } else if (file.chunkCount) {
                const chunksMap = this.getChunksMap()
                if (!chunksMap) {
                    useNotificationStore.getState().addNotification('File transfer is not initialized.', 'error')
                    return false
                }

                // Decode each Base64 chunk independently into raw bytes, then concatenate
                const decodedChunks: Uint8Array[] = []
                for (let i = 0; i < file.chunkCount; i++) {
                    const chunk = chunksMap.get(`${file.id}-${i}`)
                    if (!chunk) {
                        useNotificationStore.getState().addNotification(
                            `Missing chunk ${i + 1}/${file.chunkCount}. Transfer may be incomplete.`,
                            'error'
                        )
                        return false
                    }
                    decodedChunks.push(base64ToUint8Array(chunk.data))
                    this.onProgress?.(file.id, ((i + 1) / file.chunkCount) * 100)
                }

                fileBytes = concatUint8Arrays(decodedChunks)
            } else {
                useNotificationStore.getState().addNotification('File content is not available.', 'error')
                return false
            }

            const blob = new Blob([fileBytes as BlobPart], { type: file.type })
            const url = window.URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = file.name
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            window.URL.revokeObjectURL(url)

            return true
        } catch (err) {
            console.error('[FileTransfer] Download failed:', err)
            return false
        }
    }

    getFiles(): SharedFile[] {
        if (!this.docId || !this.initialized) return []

        const filesMap = this.getFilesMap()
        if (!filesMap) return []
        const files: SharedFile[] = []

        filesMap.forEach((file) => {
            files.push({
                ...file,
                isLocal: file.ownerId === this.localUserId
            })
        })

        return files.sort((a, b) => b.uploadedAt - a.uploadedAt)
    }

    getPeers(): PeerInfo[] {
        if (!this.roomId) return []
        return p2pService.getConnectedPeers(this.roomId)
    }

    private fileToBase64(file: File): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader()
            const timeout = setTimeout(() => {
                reader.abort()
                reject(new Error('File read timeout (30s)'))
            }, 30000)

            reader.readAsDataURL(file)
            reader.onload = () => {
                clearTimeout(timeout)
                try {
                    const result = reader.result as string
                    if (!result || !result.includes(',')) {
                        reject(new Error('Invalid FileReader result'))
                        return
                    }
                    resolve(result.split(',')[1])
                } catch (error) {
                    reject(new Error(`Failed to process file data: ${error}`))
                }
            }
            reader.onerror = () => {
                clearTimeout(timeout)
                reject(new Error(`FileReader error: ${reader.error?.message || 'unknown error'}`))
            }
            reader.onabort = () => {
                clearTimeout(timeout)
                reject(new Error('File read aborted'))
            }
        })
    }

    getLocalUserId(): string {
        return this.localUserId
    }
}

export const fileTransferService = new FileTransferService()

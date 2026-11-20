/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Collaborative Editing Engine - Enhanced Yjs wrapper with advanced features
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebrtcProvider } from 'y-webrtc'
import { p2pService } from './p2pService'

export interface CursorPosition {
    clientId: number
    user: { name: string; color: string }
    anchor: number
    head: number
    selection?: { from: number; to: number }
}

export interface EditOperation {
    id: string
    type: 'insert' | 'delete' | 'format' | 'undo' | 'redo'
    position: number
    content?: string
    length?: number
    format?: Record<string, any>
    timestamp: number
    userId: string
}

export interface DocumentSnapshot {
    id: string
    docId: string
    timestamp: number
    userId: string
    label?: string
    state: Uint8Array
}

export interface CollabConfig {
    enableHistory: boolean
    maxHistoryItems: number
    autoSaveInterval: number
    enablePresence: boolean
}

const DEFAULT_CONFIG: CollabConfig = {
    enableHistory: true,
    maxHistoryItems: 50,
    autoSaveInterval: 5000,
    enablePresence: true
}

/**
 * Apply minimal prefix/suffix diff to a Y.Text so snapshot restores produce
 * real forward CRDT edits (instead of a no-op Y.applyUpdate of stale state).
 */
function applyTextDiff(yText: Y.Text, target: string): void {
    const current = yText.toString()
    if (current === target) return

    let prefix = 0
    const minLen = Math.min(current.length, target.length)
    while (prefix < minLen && current.charCodeAt(prefix) === target.charCodeAt(prefix)) {
        prefix++
    }

    let currentSuffix = current.length
    let targetSuffix = target.length
    while (
        currentSuffix > prefix &&
        targetSuffix > prefix &&
        current.charCodeAt(currentSuffix - 1) === target.charCodeAt(targetSuffix - 1)
    ) {
        currentSuffix--
        targetSuffix--
    }

    const deleteLen = currentSuffix - prefix
    const insertStr = target.slice(prefix, targetSuffix)

    if (deleteLen > 0) {
        yText.delete(prefix, deleteLen)
    }
    if (insertStr.length > 0) {
        yText.insert(prefix, insertStr)
    }
}

class CollaborativeEngine {
    private docs: Map<string, Y.Doc> = new Map()
    private docRooms: Map<string, string> = new Map()
    private persistence: Map<string, IndexeddbPersistence> = new Map()
    private undoManagers: Map<string, Y.UndoManager> = new Map()
    private snapshots: Map<string, DocumentSnapshot[]> = new Map()

    private config: CollabConfig = DEFAULT_CONFIG
    private creationLocks: Set<string> = new Set()

    // Callbacks
    private onUpdate: ((docId: string, update: Uint8Array) => void) | null = null
    private onCursor: ((docId: string, cursors: CursorPosition[]) => void) | null = null
    private onStats: ((docId: string, stats: any) => void) | null = null

    setConfig(config: Partial<CollabConfig>) {
        this.config = { ...this.config, ...config }
    }

    setCallbacks(
        onUpdate: (docId: string, update: Uint8Array) => void,
        onCursor: (docId: string, cursors: CursorPosition[]) => void,
        onStats?: (docId: string, stats: any) => void
    ) {
        this.onUpdate = onUpdate
        this.onCursor = onCursor
        this.onStats = onStats || null
    }

    getDocument(docId: string): Y.Doc {
        if (!/^[a-zA-Z0-9_\-./]+$/.test(docId)) {
            throw new Error(`Invalid docId format: ${docId}`)
        }

        if (this.docs.has(docId)) {
            return this.docs.get(docId)!
        }

        if (this.creationLocks.has(docId)) {
            throw new Error(`Document ${docId} is being initialized`)
        }

        this.creationLocks.add(docId)

        try {
            const doc = new Y.Doc()
            this.docs.set(docId, doc)

            const persistence = new IndexeddbPersistence(docId, doc)
            this.persistence.set(docId, persistence)

            const editorText = doc.getText('editor-content')
            const undoManager = new Y.UndoManager(editorText, {
                captureTimeout: 500
            })
            this.undoManagers.set(docId, undoManager)

            doc.on('update', (update: Uint8Array, _origin: unknown) => {
                try {
                    this.onUpdate?.(docId, update)
                    this.onStats?.(docId, this.getStats(docId, this.docRooms.get(docId)))
                } catch (error) {
                    console.error(`[CollabEngine] Error in update handler for ${docId}:`, error)
                }
            })

            return doc
        } finally {
            this.creationLocks.delete(docId)
        }
    }

    destroyDocument(docId: string) {
        const roomId = this.docRooms.get(docId) || docId
        this.disconnectP2P(roomId)
        this.docRooms.delete(docId)

        const persistence = this.persistence.get(docId)
        if (persistence) {
            persistence.destroy()
            this.persistence.delete(docId)
        }

        const undoManager = this.undoManagers.get(docId)
        if (undoManager) {
            undoManager.destroy()
            this.undoManagers.delete(docId)
        }

        const doc = this.docs.get(docId)
        if (doc) {
            doc.destroy()
            this.docs.delete(docId)
        }

        this.snapshots.delete(docId)
    }

    connectP2P(docId: string, roomId: string, password?: string): WebrtcProvider | null {
        try {
            const doc = this.getDocument(docId)
            this.docRooms.set(docId, roomId)

            let provider = p2pService.getProvider(roomId)
            if (provider) {
                return provider
            }

            provider = p2pService.connect(roomId, doc, password) as WebrtcProvider
            if (!provider) return null

            provider.on('synced', (event: { synced: boolean }) => {
                console.log(`[CollabEngine] P2P sync for ${docId}:`, event.synced ? 'synced' : 'syncing')
            })

            if (this.config.enablePresence) {
                provider.awareness.on('change', () => {
                    try {
                        const cursors = this.getCursors(docId, roomId)
                        this.onCursor?.(docId, cursors)
                        this.onStats?.(docId, this.getStats(docId, roomId))
                    } catch (error) {
                        console.error(`[CollabEngine] Error in awareness handler for ${docId}:`, error)
                    }
                })
            }

            return provider
        } catch (error) {
            console.error(`[CollabEngine] Failed to connect P2P for ${docId}:`, error)
            return null
        }
    }

    disconnectP2P(roomId: string) {
        p2pService.disconnect(roomId)
    }

    getText(docId: string, name: string = 'editor-content'): Y.Text {
        const doc = this.getDocument(docId)
        return doc.getText(name)
    }

    getArray<T>(docId: string, name: string): Y.Array<T> {
        const doc = this.getDocument(docId)
        return doc.getArray<T>(name)
    }

    getMap<T>(docId: string, name: string): Y.Map<T> {
        const doc = this.getDocument(docId)
        return doc.getMap<T>(name)
    }

    undo(docId: string): boolean {
        const manager = this.undoManagers.get(docId)
        if (manager && manager.canUndo()) {
            manager.undo()
            return true
        }
        return false
    }

    redo(docId: string): boolean {
        const manager = this.undoManagers.get(docId)
        if (manager && manager.canRedo()) {
            manager.redo()
            return true
        }
        return false
    }

    canUndo(docId: string): boolean {
        return this.undoManagers.get(docId)?.canUndo() || false
    }

    canRedo(docId: string): boolean {
        return this.undoManagers.get(docId)?.canRedo() || false
    }

    createSnapshot(docId: string, userId: string, label?: string): DocumentSnapshot {
        const doc = this.docs.get(docId)
        if (!doc) throw new Error('Document not found')

        const snapshot: DocumentSnapshot = {
            id: crypto.randomUUID(),
            docId,
            timestamp: Date.now(),
            userId,
            label,
            state: Y.encodeStateAsUpdate(doc)
        }

        if (!this.snapshots.has(docId)) {
            this.snapshots.set(docId, [])
        }
        const snaps = this.snapshots.get(docId)!
        snaps.push(snapshot)

        const limit = this.config.maxHistoryItems
        if (snaps.length > limit) {
            snaps.splice(0, snaps.length - limit)
        }

        return snapshot
    }

    getSnapshots(docId: string): DocumentSnapshot[] {
        return this.snapshots.get(docId) || []
    }

    /**
     * Restore a snapshot onto the current live Y.Doc by materializing the
     * snapshot into a temporary Y.Doc and diffing/replacing each shared type
     * in a single transaction so CRDT peers receive genuine forward edits.
     */
    restoreSnapshot(docId: string, snapshotId: string): boolean {
        const snaps = this.snapshots.get(docId)
        const snapshot = snaps?.find(s => s.id === snapshotId)

        if (!snapshot) return false

        const doc = this.docs.get(docId)
        if (!doc) return false

        // Create backup before restore
        this.createSnapshot(docId, 'system', 'Auto-backup before restore')

        const tempDoc = new Y.Doc()
        try {
            Y.applyUpdate(tempDoc, snapshot.state)

            doc.transact(() => {
                // Ensure primary editor text is always restored
                const editorText = doc.getText('editor-content')
                applyTextDiff(editorText, tempDoc.getText('editor-content').toString())

                // Diff/replace all other initialized shared types on the live doc
                doc.share.forEach((sharedType, key) => {
                    if (key === 'editor-content') return

                    if (sharedType instanceof Y.Text) {
                        applyTextDiff(sharedType, tempDoc.getText(key).toString())
                    } else if (sharedType instanceof Y.Array) {
                        const targetItems = tempDoc.getArray(key).toArray()
                        if (sharedType.length > 0) {
                            sharedType.delete(0, sharedType.length)
                        }
                        if (targetItems.length > 0) {
                            sharedType.insert(0, targetItems)
                        }
                    } else if (sharedType instanceof Y.Map) {
                        const targetMap = tempDoc.getMap(key)
                        const targetKeys = new Set<string>()
                        targetMap.forEach((value, mapKey) => {
                            targetKeys.add(mapKey)
                            sharedType.set(mapKey, value)
                        })
                        for (const existingKey of Array.from(sharedType.keys())) {
                            if (!targetKeys.has(existingKey)) {
                                sharedType.delete(existingKey)
                            }
                        }
                    }
                })
            }, 'snapshot-restore')

            return true
        } catch (error) {
            console.error('[Collab] Failed to restore snapshot:', error)
            return false
        } finally {
            tempDoc.destroy()
        }
    }

    getCursors(docId: string, roomId?: string): CursorPosition[] {
        const provider = p2pService.getProvider(roomId || this.docRooms.get(docId) || docId)
        if (!provider || !provider.connected) return []

        const cursors: CursorPosition[] = []
        provider.awareness.getStates().forEach((state, clientId) => {
            if (clientId !== provider.awareness.clientID && state.cursor) {
                cursors.push({
                    clientId,
                    user: state.user || { name: 'Anonymous', color: '#888' },
                    anchor: state.cursor.anchor,
                    head: state.cursor.head,
                    selection: state.cursor.selection
                })
            }
        })
        return cursors
    }

    setCursor(docId: string, anchor: number, head: number, roomId?: string) {
        const provider = p2pService.getProvider(roomId || this.docRooms.get(docId) || docId)
        if (provider) {
            provider.awareness.setLocalStateField('cursor', { anchor, head })
        }
    }

    setLocalUser(docId: string, name: string, color: string, roomId?: string) {
        const provider = p2pService.getProvider(roomId || this.docRooms.get(docId) || docId)
        if (provider) {
            provider.awareness.setLocalStateField('user', { name, color })
        }
    }

    mergeDocuments(targetDocId: string, sourceDocId: string): void {
        if (targetDocId === sourceDocId) {
            console.warn('[Collab] Attempted to merge document with itself')
            return
        }

        const target = this.docs.get(targetDocId)
        const source = this.docs.get(sourceDocId)

        if (!target || !source) throw new Error('Documents not found')

        const sourceState = Y.encodeStateAsUpdate(source)
        Y.applyUpdate(target, sourceState)
    }

    exportState(docId: string): Uint8Array | null {
        const doc = this.docs.get(docId)
        if (!doc) return null
        return Y.encodeStateAsUpdate(doc)
    }

    importState(docId: string, state: Uint8Array): void {
        const doc = this.getDocument(docId)
        Y.applyUpdate(doc, state)
    }

    getStats(docId: string, roomId?: string): {
        textLength: number
        taskCount: number
        messageCount: number
        snapshotCount: number
        peerCount: number
    } {
        const doc = this.docs.get(docId)
        const provider = p2pService.getProvider(roomId || this.docRooms.get(docId) || docId)

        return {
            textLength: doc?.getText('editor-content').length || 0,
            taskCount: doc?.getArray('tasks').length || 0,
            messageCount: doc?.getArray('messages').length || 0,
            snapshotCount: this.snapshots.get(docId)?.length || 0,
            peerCount: provider ? Math.max(0, provider.awareness.getStates().size - 1) : 0
        }
    }
}

export const collabEngine = new CollaborativeEngine()

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebrtcProvider } from 'y-webrtc'
import { memberSyncService } from '../services/memberSyncService'
import { useMemberStore } from '../stores/memberStore'
import { p2pService, normalizeRoomId } from '../services/p2pService'
import { getRoomPassword } from '../services/roomPasswordStore'
import { encryptionService } from '../services/encryptionService'
import {
    initializeRoomEncryption,
    disableRoomEncryption,
    isRoomEncryptionReady
} from '../services/encryptedProvider'

// Store for Yjs documents per space
const documents = new Map<string, Y.Doc>()
const persistences = new Map<string, IndexeddbPersistence>()
// Reference counting for cleanup
const refCounts = new Map<string, number>()

interface CleanupCapable {
    _cleanup?: () => void
}

/**
 * Get or create a Yjs document for a space
 */
export function getSpaceDocument(spaceId: string): Y.Doc {
    let doc = documents.get(spaceId)

    if (!doc) {
        doc = new Y.Doc()
        documents.set(spaceId, doc)

        try {
            const persistence = new IndexeddbPersistence(`kalynt-${spaceId}`, doc)
            persistences.set(spaceId, persistence)

            const onError = (error: unknown) => {
                console.error(`[CRDT] IndexedDB error for space ${spaceId}:`, error)
                if (error && typeof error === 'object' && 'name' in error && (error as { name: string }).name === 'QuotaExceededError') {
                    console.warn('Storage quota exceeded!')
                }
            }

            const onSynced = () => {
                console.log(`[CRDT] Space ${spaceId} synced from IndexedDB`)
            }

            persistence.on('error', onError)
            persistence.on('synced', onSynced)

            ;(persistence as unknown as CleanupCapable)._cleanup = () => {
                persistence.off('synced', onSynced)
                persistence.off('error', onError)
            }
        } catch (error) {
            console.error('[CRDT] Failed to initialize persistence:', error)
        }
    }

    return doc
}

/**
 * Connect a space to P2P network with optional encryption
 */
export function connectSpace(spaceId: string, password?: string): WebrtcProvider {
    let provider = p2pService.getProvider(spaceId)

    if (!provider) {
        const doc = getSpaceDocument(spaceId)
        provider = p2pService.connect(spaceId, doc, password) as WebrtcProvider
        console.log(`[P2P] Connected to space ${spaceId} via p2pService`)
    }

    return provider
}

/**
 * Disconnect from a space (provider only, keeps doc for potential reconnection)
 */
export function disconnectSpace(spaceId: string): void {
    p2pService.disconnect(spaceId)
}

/**
 * Completely destroy a space's resources (called only when refCount reaches 0).
 */
export function destroySpace(spaceId: string): void {
    // Clean up member sync & encryption synchronously once no consumers remain
    memberSyncService.cleanup(spaceId)
    disableRoomEncryption(spaceId)

    disconnectSpace(spaceId)

    const persistence = persistences.get(spaceId)
    if (persistence) {
        try {
            (persistence as unknown as CleanupCapable)._cleanup?.()
            persistence.destroy()
        } catch (err) {
            console.warn(`[CRDT] Error destroying persistence for ${spaceId}:`, err)
        }
        persistences.delete(spaceId)
    }

    const doc = documents.get(spaceId)
    if (doc) {
        doc.destroy()
        documents.delete(spaceId)
    }

    refCounts.delete(spaceId)

    console.log(`[CRDT] Destroyed all resources for space ${spaceId}`)
}

function refSpace(spaceId: string): void {
    refCounts.set(spaceId, (refCounts.get(spaceId) || 0) + 1)
}

function unrefSpace(spaceId: string): void {
    const count = refCounts.get(spaceId) || 0
    if (count <= 1) {
        destroySpace(spaceId)
    } else {
        refCounts.set(spaceId, count - 1)
    }
}

/**
 * Hook to use a Yjs document for a space.
 * Uses deterministic room salt + PBKDF2->HKDF key derivation so all peers with
 * the same room password derive identical keys without random-salt divergence,
 * and guards teardown with ref-counting so sibling hooks stay connected.
 */
export function useYDoc(spaceId: string | null) {
    const [doc, setDoc] = useState<Y.Doc | null>(null)
    const [provider, setProvider] = useState<WebrtcProvider | null>(null)
    const [synced, setSynced] = useState(false)
    const [peerCount, setPeerCount] = useState(0)
    const [encrypted, setEncrypted] = useState(false)

    const setupInstanceRef = useRef<{
        spaceId: string
        provider: WebrtcProvider | null
        peerListener: (() => void) | null
        persistence: IndexeddbPersistence | null
        persistenceSyncListener: (() => void) | null
    } | null>(null)

    useEffect(() => {
        if (!spaceId) {
            setDoc(null)
            setProvider(null)
            setSynced(false)
            setPeerCount(0)
            setEncrypted(false)
            return
        }

        let cancelled = false
        let didRef = false

        const updatePeers = (targetProvider: WebrtcProvider) => {
            const awareness = targetProvider.awareness
            if (!awareness || cancelled) return

            const currentIds = Array.from(awareness.getStates().keys())
            const count = currentIds.filter(id => id !== awareness.clientID).length
            setPeerCount(count)
        }

        const normalizedSpaceId = normalizeRoomId(spaceId)
        const unsubKeyChange = encryptionService.onKeyChange((changedRoomId, hasKey) => {
            if (!cancelled && normalizeRoomId(changedRoomId) === normalizedSpaceId) {
                setEncrypted(hasKey)
            }
        })

        const setup = async () => {
            refSpace(spaceId)
            didRef = true

            const passwordValue = (await getRoomPassword(spaceId)) ?? undefined
            if (cancelled) return

            const ydoc = getSpaceDocument(spaceId)
            const yprovider = connectSpace(spaceId, passwordValue)

            setupInstanceRef.current = {
                spaceId,
                provider: yprovider,
                peerListener: null,
                persistence: null,
                persistenceSyncListener: null
            }

            setDoc(ydoc)
            setProvider(yprovider)

            // Derive deterministic room encryption + integrity keys before starting member sync
            // so encrypted moderation and chat are immediately ready without salt divergence.
            if (passwordValue) {
                try {
                    if (!isRoomEncryptionReady(spaceId)) {
                        await initializeRoomEncryption(spaceId, passwordValue)
                    }
                    if (!cancelled) {
                        setEncrypted(true)
                        console.log(`[CRDT] Encryption initialized for space ${spaceId}`)
                    }
                } catch (e) {
                    console.error('[CRDT] Failed to initialize encryption:', e)
                }
            } else {
                setEncrypted(false)
            }

            if (cancelled) return

            const { userId: memberUserId, displayName: memberDisplayName } = useMemberStore.getState()
            void memberSyncService.initializeSpace(
                spaceId,
                ydoc,
                yprovider.awareness,
                memberUserId,
                memberDisplayName
            )
            console.log(`[Members] Initialized P2P sync for space ${spaceId}`)

            const persistence = persistences.get(spaceId)
            if (persistence) {
                if (persistence.synced && !cancelled) {
                    setSynced(true)
                }
                const onPersistenceSynced = () => {
                    if (!cancelled) setSynced(true)
                }
                persistence.on('synced', onPersistenceSynced)
                if (setupInstanceRef.current?.spaceId === spaceId) {
                    setupInstanceRef.current.persistence = persistence
                    setupInstanceRef.current.persistenceSyncListener = onPersistenceSynced
                }
            }

            const listener = () => updatePeers(yprovider)
            if (setupInstanceRef.current?.spaceId === spaceId) {
                setupInstanceRef.current.peerListener = listener
            }
            yprovider.awareness.on('change', listener)

            if (!cancelled) {
                listener()
            }
        }

        void setup()

        return () => {
            cancelled = true
            unsubKeyChange()

            const instance = setupInstanceRef.current
            const currentProvider = instance?.spaceId === spaceId
                ? (instance.provider || p2pService.getProvider(spaceId))
                : p2pService.getProvider(spaceId)
            const currentCallback = instance?.spaceId === spaceId ? instance.peerListener : null

            if (currentProvider && currentCallback) {
                try {
                    currentProvider.awareness.off('change', currentCallback)
                } catch (e) {
                    console.debug('[P2P] Failed to remove peer listener:', e)
                }
            }

            if (instance?.spaceId === spaceId && instance.persistence && instance.persistenceSyncListener) {
                try {
                    instance.persistence.off('synced', instance.persistenceSyncListener)
                } catch {
                    // Ignore if persistence already destroyed
                }
            }

            if (setupInstanceRef.current?.spaceId === spaceId) {
                setupInstanceRef.current = null
            }

            // Ref-count guard: only disables encryption, member sync, and provider
            // when the final subscriber for `spaceId` unmounts.
            if (didRef) {
                unrefSpace(spaceId)
            }
        }
    }, [spaceId])

    return { doc, provider, synced, peerCount, encrypted }
}

/**
 * Hook to use a Yjs Text type
 */
export function useYText(doc: Y.Doc | null, key: string) {
    const [text, setText] = useState('')
    const [yText, setYText] = useState<Y.Text | null>(null)
    const yTextRef = useRef<Y.Text | null>(null)

    useEffect(() => {
        if (!doc) {
            yTextRef.current = null
            setYText(null)
            setText('')
            return
        }

        const shared = doc.getText(key)
        yTextRef.current = shared
        setYText(shared)
        setText(shared.toJSON())

        const observer = () => {
            setText(shared.toJSON())
        }

        shared.observe(observer)
        return () => {
            shared.unobserve(observer)
        }
    }, [doc, key])

    const updateText = useCallback((newText: string) => {
        if (!yTextRef.current || !doc) return

        doc.transact(() => {
            yTextRef.current!.delete(0, yTextRef.current!.length)
            yTextRef.current!.insert(0, newText)
        })
    }, [doc])

    const insertText = useCallback((index: number, content: string) => {
        if (!yTextRef.current) return
        yTextRef.current.insert(index, content)
    }, [])

    const deleteText = useCallback((index: number, length: number) => {
        if (!yTextRef.current) return
        yTextRef.current.delete(index, length)
    }, [])

    return { text, updateText, insertText, deleteText, yText }
}

/**
 * Hook to use a Yjs Array type
 */
export function useYArray<T>(doc: Y.Doc | null, key: string) {
    const [items, setItems] = useState<T[]>([])
    const [yArray, setYArray] = useState<Y.Array<T> | null>(null)
    const yArrayRef = useRef<Y.Array<T> | null>(null)

    useEffect(() => {
        if (!doc) {
            yArrayRef.current = null
            setYArray(null)
            setItems([])
            return
        }

        const shared = doc.getArray<T>(key)
        yArrayRef.current = shared
        setYArray(shared)
        setItems(shared.toArray())

        const observer = () => {
            setItems(shared.toArray())
        }

        shared.observe(observer)
        return () => {
            shared.unobserve(observer)
        }
    }, [doc, key])

    const push = useCallback((item: T) => {
        if (!yArrayRef.current) return
        yArrayRef.current.push([item])
    }, [])

    const insert = useCallback((index: number, item: T) => {
        if (!yArrayRef.current) return
        yArrayRef.current.insert(index, [item])
    }, [])

    const remove = useCallback((index: number) => {
        if (!yArrayRef.current) return
        yArrayRef.current.delete(index, 1)
    }, [])

    const update = useCallback((index: number, item: T) => {
        if (!yArrayRef.current || !doc) return
        doc.transact(() => {
            yArrayRef.current!.delete(index, 1)
            yArrayRef.current!.insert(index, [item])
        })
    }, [doc])

    return { items, push, insert, remove, update, yArray }
}

/**
 * Hook to use a Yjs Map type
 */
export function useYMap<T>(doc: Y.Doc | null, key: string) {
    const [data, setData] = useState<Map<string, T>>(new Map())
    const [yMap, setYMap] = useState<Y.Map<T> | null>(null)
    const yMapRef = useRef<Y.Map<T> | null>(null)

    useEffect(() => {
        if (!doc) {
            yMapRef.current = null
            setYMap(null)
            setData(new Map())
            return
        }

        const shared = doc.getMap<T>(key)
        yMapRef.current = shared
        setYMap(shared)
        setData(new Map(shared.entries()))

        const observer = () => {
            setData(new Map(shared.entries()))
        }

        shared.observe(observer)
        return () => {
            shared.unobserve(observer)
        }
    }, [doc, key])

    const set = useCallback((k: string, value: T) => {
        if (!yMapRef.current) return
        yMapRef.current.set(k, value)
    }, [])

    const remove = useCallback((k: string) => {
        if (!yMapRef.current) return
        yMapRef.current.delete(k)
    }, [])

    const get = useCallback((k: string): T | undefined => {
        return yMapRef.current?.get(k)
    }, [])

    return { data, set, remove, get, yMap }
}

/**
 * Hook for awareness (cursor positions, presence)
 */
export function useAwareness(provider: WebrtcProvider | null) {
    const [users, setUsers] = useState<Map<number, any>>(new Map())

    useEffect(() => {
        if (!provider) {
            setUsers(new Map())
            return
        }

        const updateUsers = () => {
            const states = provider.awareness.getStates()
            setUsers(new Map(states))
        }

        provider.awareness.on('change', updateUsers)
        updateUsers()

        return () => provider.awareness.off('change', updateUsers)
    }, [provider])

    const setLocalState = useCallback((field: string, value: any) => {
        if (!provider) return
        provider.awareness.setLocalStateField(field, value)
    }, [provider])

    return { users, setLocalState, localClientId: provider?.awareness.clientID }
}

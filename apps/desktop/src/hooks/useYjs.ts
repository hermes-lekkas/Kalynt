/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebrtcProvider } from 'y-webrtc'
import { memberSyncService } from '../services/memberSyncService'
import { useMemberStore } from '../stores/memberStore'
import { p2pService, normalizeRoomId, type RoomAuthInfo } from '../services/p2pService'
import { getRoomPassword } from '../services/roomPasswordStore'
import { encryptionService } from '../services/encryptionService'
import {
    initializeRoomEncryption,
    disableRoomEncryption,
    isRoomEncryptionReady
} from '../services/encryptedProvider'

// Store for Yjs documents per normalized space ID
const documents = new Map<string, Y.Doc>()
const persistences = new Map<string, IndexeddbPersistence>()
// Reference counting for cleanup
const refCounts = new Map<string, number>()

const DEFAULT_AUTH_INFO: RoomAuthInfo = {
    status: 'unencrypted',
    incompatiblePeers: 0
}

interface CleanupCapable {
    _cleanup?: () => void
}

/**
 * Get or create the canonical Yjs document for a space
 */
export function getSpaceDocument(spaceId: string): Y.Doc {
    const key = normalizeRoomId(spaceId)
    let doc = documents.get(key)

    if (!doc) {
        doc = new Y.Doc()
        documents.set(key, doc)

        try {
            const persistence = new IndexeddbPersistence(`kalynt-${key}`, doc)
            persistences.set(key, persistence)

            const onError = (error: unknown) => {
                console.error(`[CRDT] IndexedDB error for space ${key}:`, error)
                if (error && typeof error === 'object' && 'name' in error && (error as { name: string }).name === 'QuotaExceededError') {
                    console.warn('Storage quota exceeded!')
                }
            }

            const onSynced = () => {
                console.log(`[CRDT] Space ${key} synced from IndexedDB`)
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
    const key = normalizeRoomId(spaceId)
    let provider = p2pService.getProvider(key)

    if (!provider) {
        const doc = getSpaceDocument(key)
        provider = p2pService.connect(key, doc, password) as WebrtcProvider
        console.log(`[P2P] Connected to space ${key} via p2pService`)
    }

    return provider
}

/**
 * Disconnect from a space (provider only, keeps doc for potential reconnection)
 */
export function disconnectSpace(spaceId: string): void {
    p2pService.disconnect(normalizeRoomId(spaceId))
}

/**
 * Completely destroy a space's resources (called only when refCount reaches 0).
 */
export function destroySpace(spaceId: string): void {
    const key = normalizeRoomId(spaceId)
    // Clean up member sync & encryption synchronously once no consumers remain
    memberSyncService.cleanup(spaceId)
    disableRoomEncryption(key)

    disconnectSpace(key)

    const persistence = persistences.get(key)
    if (persistence) {
        try {
            (persistence as unknown as CleanupCapable)._cleanup?.()
            persistence.destroy()
        } catch (err) {
            console.warn(`[CRDT] Error destroying persistence for ${key}:`, err)
        }
        persistences.delete(key)
    }

    const doc = documents.get(key)
    if (doc) {
        doc.destroy()
        documents.delete(key)
    }

    refCounts.delete(key)

    console.log(`[CRDT] Destroyed all resources for space ${key}`)
}

function refSpace(spaceId: string): void {
    const key = normalizeRoomId(spaceId)
    refCounts.set(key, (refCounts.get(key) || 0) + 1)
}

function unrefSpace(spaceId: string): void {
    const key = normalizeRoomId(spaceId)
    const count = refCounts.get(key) || 0
    if (count <= 1) {
        destroySpace(spaceId)
    } else {
        refCounts.set(key, count - 1)
    }
}

/**
 * Hook to use a Yjs document for a space.
 * Uses deterministic room salt + PBKDF2->HKDF key derivation so all peers with
 * the same room password derive identical keys without random-salt divergence,
 * rebinds awareness cleanly across provider swaps/reconnects, and guards teardown
 * with ref-counting so sibling hooks stay connected.
 */
export function useYDoc(spaceId: string | null) {
    const [doc, setDoc] = useState<Y.Doc | null>(null)
    const [provider, setProvider] = useState<WebrtcProvider | null>(null)
    const [synced, setSynced] = useState(false)
    const [peerCount, setPeerCount] = useState(() => (spaceId ? p2pService.getPeerCount(spaceId) : 0))
    const [encrypted, setEncrypted] = useState(() => (spaceId ? encryptionService.hasRoomKey(spaceId) : false))
    const [authInfo, setAuthInfo] = useState<RoomAuthInfo>(() =>
        spaceId ? p2pService.getRoomAuthInfo(spaceId) : DEFAULT_AUTH_INFO
    )

    const setupInstanceRef = useRef<{
        spaceKey: string
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
            setAuthInfo(DEFAULT_AUTH_INFO)
            return
        }

        let cancelled = false
        let didRef = false
        const normalizedSpaceId = normalizeRoomId(spaceId)

        // Seed immediate presence, encryption, and auth state on mount before async password lookup completes.
        setPeerCount(p2pService.getPeerCount(normalizedSpaceId))
        setAuthInfo(p2pService.getRoomAuthInfo(normalizedSpaceId))
        setEncrypted(encryptionService.hasRoomKey(normalizedSpaceId))

        setupInstanceRef.current = {
            spaceKey: normalizedSpaceId,
            provider: null,
            peerListener: null,
            persistence: null,
            persistenceSyncListener: null
        }

        const updatePeers = (targetProvider: WebrtcProvider | null) => {
            if (cancelled) return
            if (!targetProvider?.awareness) {
                setPeerCount(p2pService.getPeerCount(normalizedSpaceId))
                return
            }
            const currentIds = Array.from(targetProvider.awareness.getStates().keys())
            const count = currentIds.filter(id => id !== targetProvider.awareness.clientID).length
            setPeerCount(count)
        }

        const detachProviderAwareness = () => {
            const instance = setupInstanceRef.current
            if (!instance || instance.spaceKey !== normalizedSpaceId) return
            if (instance.provider && instance.peerListener) {
                try {
                    instance.provider.awareness.off('change', instance.peerListener)
                } catch (e) {
                    console.debug('[P2P] Failed to remove peer listener:', e)
                }
            }
            instance.provider = null
            instance.peerListener = null
        }

        const bindProvider = (nextProvider: WebrtcProvider | null) => {
            if (cancelled) return
            const instance = setupInstanceRef.current
            if (instance?.spaceKey === normalizedSpaceId && instance.provider === nextProvider) {
                if (nextProvider) {
                    updatePeers(nextProvider)
                }
                return
            }

            detachProviderAwareness()
            setProvider(nextProvider)

            if (!nextProvider) {
                setPeerCount(0)
                return
            }

            const listener = () => updatePeers(nextProvider)
            if (instance?.spaceKey === normalizedSpaceId) {
                instance.provider = nextProvider
                instance.peerListener = listener
            }
            nextProvider.awareness.on('change', listener)
            memberSyncService.updateAwareness(spaceId, nextProvider.awareness)
            updatePeers(nextProvider)
        }

        const unsubKeyChange = encryptionService.onKeyChange((changedRoomId, hasKey) => {
            if (!cancelled && normalizeRoomId(changedRoomId) === normalizedSpaceId) {
                setEncrypted(hasKey)
            }
        })

        const unsubRoom = p2pService.addRoomListener(normalizedSpaceId, {
            onProvider: (nextProvider) => {
                bindProvider(nextProvider)
            },
            onPeers: (peers) => {
                if (!cancelled) setPeerCount(peers.length)
            },
            onAuthChange: (nextAuth) => {
                if (!cancelled) setAuthInfo(nextAuth)
            }
        })

        // If a provider is already live for this room, bind it immediately on mount
        const existingProvider = p2pService.getProvider(normalizedSpaceId)
        if (existingProvider) {
            bindProvider(existingProvider)
        }

        const setup = async () => {
            refSpace(normalizedSpaceId)
            didRef = true

            const passwordValue = (await getRoomPassword(normalizedSpaceId)) ?? undefined
            if (cancelled) return

            const ydoc = getSpaceDocument(normalizedSpaceId)
            const yprovider = connectSpace(normalizedSpaceId, passwordValue)

            setDoc(ydoc)
            if (yprovider) {
                bindProvider(yprovider)
            }

            // Derive deterministic room encryption + integrity keys before starting member sync
            // so encrypted moderation and chat are immediately ready without salt divergence.
            if (passwordValue) {
                try {
                    if (!isRoomEncryptionReady(normalizedSpaceId)) {
                        await initializeRoomEncryption(normalizedSpaceId, passwordValue)
                    }
                    if (!cancelled) {
                        setEncrypted(true)
                        console.log(`[CRDT] Encryption initialized for space ${normalizedSpaceId}`)
                    }
                } catch (e) {
                    console.error('[CRDT] Failed to initialize encryption:', e)
                }
            } else {
                setEncrypted(encryptionService.hasRoomKey(normalizedSpaceId))
            }

            if (cancelled) return

            const liveProvider = p2pService.getProvider(normalizedSpaceId) || yprovider
            if (liveProvider) {
                const { userId: memberUserId, displayName: memberDisplayName } = useMemberStore.getState()
                void memberSyncService.initializeSpace(
                    spaceId,
                    ydoc,
                    liveProvider.awareness,
                    memberUserId,
                    memberDisplayName
                )
                console.log(`[Members] Initialized P2P sync for space ${spaceId}`)
            }

            const persistence = persistences.get(normalizedSpaceId)
            if (persistence) {
                if (persistence.synced && !cancelled) {
                    setSynced(true)
                }
                const onPersistenceSynced = () => {
                    if (!cancelled) setSynced(true)
                }
                persistence.on('synced', onPersistenceSynced)
                if (setupInstanceRef.current?.spaceKey === normalizedSpaceId) {
                    setupInstanceRef.current.persistence = persistence
                    setupInstanceRef.current.persistenceSyncListener = onPersistenceSynced
                }
            }

            if (!cancelled) {
                setAuthInfo(p2pService.getRoomAuthInfo(normalizedSpaceId))
                updatePeers(p2pService.getProvider(normalizedSpaceId) ?? yprovider ?? null)
            }
        }

        void setup()

        return () => {
            cancelled = true
            unsubKeyChange()
            unsubRoom()
            detachProviderAwareness()

            const instance = setupInstanceRef.current
            if (instance?.spaceKey === normalizedSpaceId && instance.persistence && instance.persistenceSyncListener) {
                try {
                    instance.persistence.off('synced', instance.persistenceSyncListener)
                } catch {
                    // Ignore if persistence already destroyed
                }
            }

            if (setupInstanceRef.current?.spaceKey === normalizedSpaceId) {
                setupInstanceRef.current = null
            }

            // Ref-count guard: only disables encryption, member sync, and provider
            // when the final subscriber for `spaceId` unmounts.
            if (didRef) {
                unrefSpace(spaceId)
            }
        }
    }, [spaceId])

    return { doc, provider, synced, peerCount, encrypted, authInfo }
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

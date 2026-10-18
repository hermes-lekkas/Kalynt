/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebrtcProvider } from 'y-webrtc'
import { memberSyncService } from '../services/memberSyncService'
import { useMemberStore } from '../stores/memberStore'

import { p2pService } from '../services/p2pService'

// Store for Yjs documents per space
const documents = new Map<string, Y.Doc>()
const persistences = new Map<string, IndexeddbPersistence>()
// Reference counting for cleanup
const refCounts = new Map<string, number>()

// Helper interface for objects with cleanup method
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

        // Set up IndexedDB persistence with quota handling
        try {
            const persistence = new IndexeddbPersistence(`kalynt-${spaceId}`, doc)
            persistences.set(spaceId, persistence)

            const onError = (error: any) => {
                console.error(`[CRDT] IndexedDB error for space ${spaceId}:`, error)
                if (error.name === 'QuotaExceededError') {
                    console.warn('Storage quota exceeded!')
                }
            }

            const onSynced = () => {
                console.log(`[CRDT] Space ${spaceId} synced from IndexedDB`)
            }

            persistence.on('error', onError)
            persistence.on('synced', onSynced)

                // Store cleanup function
                ; (persistence as unknown as CleanupCapable)._cleanup = () => {
                    persistence.off('synced', onSynced)
                    persistence.off('error', onError)
                }
        } catch (error) {
            console.error(`[CRDT] Failed to initialize persistence:`, error)
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
 * Completely destroy a space's resources (use when no components need it)
 */
export function destroySpace(spaceId: string): void {
    // Disconnect provider
    disconnectSpace(spaceId)

    // Destroy persistence
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

    // Destroy document
    const doc = documents.get(spaceId)
    if (doc) {
        doc.destroy()
        documents.delete(spaceId)
    }

    // Clear ref count
    refCounts.delete(spaceId)

    console.log(`[CRDT] Destroyed all resources for space ${spaceId}`)
}

/**
 * Increment reference count for a space
 */
function refSpace(spaceId: string): void {
    refCounts.set(spaceId, (refCounts.get(spaceId) || 0) + 1)
}

/**
 * Decrement reference count and destroy if no refs remain
 */
function unrefSpace(spaceId: string): void {
    const count = refCounts.get(spaceId) || 0
    if (count <= 1) {
        // Last reference, destroy everything
        destroySpace(spaceId)
    } else {
        refCounts.set(spaceId, count - 1)
    }
}

/**
 * Hook to use a Yjs document for a space
 * Integrates with encryption if enabled in space settings
 */
export function useYDoc(spaceId: string | null) {
    const [doc, setDoc] = useState<Y.Doc | null>(null)
    const [provider, setProvider] = useState<WebrtcProvider | null>(null)
    const [synced, setSynced] = useState(false)
    const [peerCount, setPeerCount] = useState(0)
    const [encrypted, setEncrypted] = useState(false)
    const updatePeersRef = useRef<(() => void) | null>(null)
    const saltListenerRef = useRef<((changes: { added: number[] }) => void) | null>(null) // MEMORY LEAK FIX
    const isMountedRef = useRef(true)
    const setupRef = useRef<string | null>(null)
    // FIX BUG-005/006: Track setup instance to prevent race conditions on rapid space switching
    // This pairs the provider with its listeners so cleanup uses the correct references
    const setupInstanceRef = useRef<{
        spaceId: string
        provider: WebrtcProvider | null
        saltListener: ((changes: { added: number[] }) => void) | null
        peerListener: (() => void) | null
    } | null>(null)

    useEffect(() => {
        isMountedRef.current = true

        if (!spaceId) {
            setDoc(null)
            setProvider(null)
            setSynced(false)
            setPeerCount(0)
            setEncrypted(false)
            return
        }

        if (setupRef.current === spaceId) return
        setupRef.current = spaceId

        // Helper to track peers (defined here to avoid deep nesting inside setup)
        const updatePeers = (targetProvider: any) => {
            const awareness = targetProvider.awareness
            if (!awareness || !isMountedRef.current) return

            const currentIds = Array.from(awareness.getStates().keys())
            const count = currentIds.filter(id => id !== awareness.clientID).length
            setPeerCount(count)
        }

        // Main setup - connect first, then initialize encryption with shared salt
        const setup = async () => {
            if (!isMountedRef.current || setupRef.current !== spaceId) return

            // Increment reference count
            refSpace(spaceId)

            const ydoc = getSpaceDocument(spaceId)

            // Fetch password if encryption is enabled
            let passwordValue: string | undefined = undefined
            const settings = localStorage.getItem(`space-settings-${spaceId}`)
            if (settings) {
                try {
                    const parsed = JSON.parse(settings)
                    if (parsed.encryptionEnabled && parsed.roomPassword) {
                        passwordValue = parsed.roomPassword
                    }
                } catch (e) {
                    console.warn('[P2P] Failed to parse settings for encryption:', e)
                }
            }

            // Connect to room first (room name includes password for y-webrtc encryption)
            const yprovider = connectSpace(spaceId, passwordValue)

            // FIX BUG-005/006: Initialize setup instance to track this setup's resources
            setupInstanceRef.current = {
                spaceId,
                provider: yprovider,
                saltListener: null,
                peerListener: null
            }

            setDoc(ydoc)
            setProvider(yprovider)

            if (!isMountedRef.current) return

            // FIX: Initialize member sync IMMEDIATELY after connecting
            // (before the 500ms encryption await so role/permission management starts right away)
            const { userId: memberUserId, displayName: memberDisplayName } = useMemberStore.getState()
            memberSyncService.initializeSpace(
                spaceId,
                ydoc,
                yprovider.awareness,
                memberUserId,
                memberDisplayName
            )
            console.log(`[Members] Initialized P2P sync for space ${spaceId}`)

            // CRITICAL FIX: Initialize encryption AFTER connecting so we can receive salt from peers
            // This fixes the issue where each peer generates different salts and can't decrypt each other's messages
            if (passwordValue) {
                try {
                    const { initializeRoomEncryption, getRoomSalt, setRoomSalt } = await import('../services/encryptedProvider')

                    // Wait a brief moment for awareness to sync with existing peers
                    await new Promise(resolve => setTimeout(resolve, 500))

                    // Check if any existing peer has a salt (they're the room creator)
                    let receivedSalt: Uint8Array | undefined
                    const states = yprovider.awareness.getStates()
                    for (const [clientId, state] of states) {
                        if (clientId !== yprovider.awareness.clientID && state.roomSalt) {
                            receivedSalt = new Uint8Array(state.roomSalt)
                            console.log(`[CRDT] Received encryption salt from peer ${clientId}`)
                            break
                        }
                    }

                    // Initialize encryption with received salt (if any) or generate new
                    if (receivedSalt) {
                        setRoomSalt(spaceId, receivedSalt)
                    }
                    const ourSalt = await initializeRoomEncryption(spaceId, passwordValue, receivedSalt)

                    // Broadcast our salt via awareness for other peers (current and future)
                    yprovider.awareness.setLocalStateField('roomSalt', Array.from(ourSalt))
                    console.log(`[CRDT] Broadcasting encryption salt for space ${spaceId}`)

                    // Listen for salt from peers that join after us (in case we're second to connect)
                    // MEMORY LEAK FIX: Store listener in ref so it can be cleaned up
                    const saltListener = async ({ added }: { added: number[] }) => {
                        if (!isMountedRef.current) return
                        const currentSalt = getRoomSalt(spaceId)

                        for (const clientId of added) {
                            const state = yprovider.awareness.getStates().get(clientId)
                            if (state?.roomSalt && clientId !== yprovider.awareness.clientID) {
                                const peerSalt = new Uint8Array(state.roomSalt)
                                // If we don't have a salt yet, or peer's salt is different, re-initialize
                                // (First peer's salt wins - they're the room creator)
                                if (!currentSalt) {
                                    setRoomSalt(spaceId, peerSalt)
                                    await initializeRoomEncryption(spaceId, passwordValue!, peerSalt)
                                    yprovider.awareness.setLocalStateField('roomSalt', Array.from(peerSalt))
                                    console.log(`[CRDT] Adopted salt from peer ${clientId}`)
                                }
                                break
                            }
                        }
                    }
                    saltListenerRef.current = saltListener // Store for cleanup
                    // FIX BUG-005: Also store in setup instance for proper cleanup
                    if (setupInstanceRef.current) {
                        setupInstanceRef.current.saltListener = saltListener
                    }
                    yprovider.awareness.on('change', saltListener)

                    if (isMountedRef.current) {
                        setEncrypted(true)
                        console.log(`[CRDT] Encryption initialized for space ${spaceId}`)
                    }
                } catch (e) {
                    console.error('[CRDT] Failed to initialize encryption:', e)
                }
            }

            // Track sync state
            const persistence = persistences.get(spaceId)
            if (persistence) {
                // Later subscribers miss the one-time event, so read the current state too.
                if (persistence.synced && isMountedRef.current) setSynced(true)
                persistence.on('synced', () => {
                    if (isMountedRef.current) setSynced(true)
                })
            }

            // Track peer count avoiding deep nesting callback (ESL-040)
            const listener = () => updatePeers(yprovider)
            updatePeersRef.current = listener
            // FIX BUG-005: Store in setup instance for proper cleanup
            if (setupInstanceRef.current) {
                setupInstanceRef.current.peerListener = listener
            }
            yprovider.awareness.on('change', listener)

            // Check again before initial call to avoid state updates on unmounted component
            if (isMountedRef.current && setupRef.current === spaceId) {
                listener()
            }
        }

        setup()

        return () => {
            isMountedRef.current = false
            setupRef.current = null

            // FIX BUG-005/006: Use setup instance to get the correct provider and listeners
            // This prevents race conditions when switching spaces rapidly
            const instance = setupInstanceRef.current
            const instanceProvider = instance?.provider
            const instancePeerListener = instance?.peerListener
            const instanceSaltListener = instance?.saltListener

            // Fallback to refs/state only if setup instance doesn't match
            const currentProvider = instanceProvider || provider || p2pService.getProvider(spaceId)
            const currentCallback = instancePeerListener || updatePeersRef.current
            const currentSaltListener = instanceSaltListener || saltListenerRef.current

            // Cleanup peer listener carefully
            if (currentProvider && currentCallback) {
                try {
                    currentProvider.awareness.off('change', currentCallback)
                } catch (e) {
                    console.debug('[P2P] Failed to remove peer listener:', e)
                }
            }
            updatePeersRef.current = null

            // MEMORY LEAK FIX: Clean up salt listener
            if (currentProvider && currentSaltListener) {
                try {
                    currentProvider.awareness.off('change', currentSaltListener)
                } catch (e) {
                    console.debug('[P2P] Failed to remove salt listener:', e)
                }
            }
            saltListenerRef.current = null
            setupInstanceRef.current = null

            // Clean up encryption state with error handling
            import('../services/encryptedProvider').then(({ disableRoomEncryption }) => {
                disableRoomEncryption(spaceId)
            }).catch(err => {
                console.error('[CRDT] Failed to disable encryption:', err)
            })

            // Clean up member sync
            memberSyncService.cleanup(spaceId)

            // Decrement ref count - will destroy if this was the last user
            unrefSpace(spaceId)
        }
    }, [spaceId])

    return { doc, provider, synced, peerCount, encrypted }
}

/**
 * Hook to use a Yjs Text type
 */
export function useYText(doc: Y.Doc | null, key: string) {
    const [text, setText] = useState('')
    const yTextRef = useRef<Y.Text | null>(null)

    useEffect(() => {
        if (!doc) {
            setText('')
            return
        }

        const yText = doc.getText(key)
        yTextRef.current = yText
        setText(yText.toJSON())

        const observer = () => {
            setText(yText.toJSON())
        }

        yText.observe(observer)
        return () => yText.unobserve(observer)
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

    const yText = useMemo(() => yTextRef.current, [])

    return { text, updateText, insertText, deleteText, yText }
}

/**
 * Hook to use a Yjs Array type
 */
export function useYArray<T>(doc: Y.Doc | null, key: string) {
    const [items, setItems] = useState<T[]>([])
    const yArrayRef = useRef<Y.Array<T> | null>(null)

    useEffect(() => {
        if (!doc) {
            setItems([])
            return
        }

        const yArray = doc.getArray<T>(key)
        yArrayRef.current = yArray
        setItems(yArray.toArray())

        const observer = () => {
            setItems(yArray.toArray())
        }

        yArray.observe(observer)
        return () => yArray.unobserve(observer)
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

    const yArray = useMemo(() => yArrayRef.current, [])

    return { items, push, insert, remove, update, yArray }
}

/**
 * Hook to use a Yjs Map type
 */
export function useYMap<T>(doc: Y.Doc | null, key: string) {
    const [data, setData] = useState<Map<string, T>>(new Map())
    const yMapRef = useRef<Y.Map<T> | null>(null)

    useEffect(() => {
        if (!doc) {
            setData(new Map())
            return
        }

        const yMap = doc.getMap<T>(key)
        yMapRef.current = yMap
        setData(new Map(yMap.entries()))

        const observer = () => {
            setData(new Map(yMap.entries()))
        }

        yMap.observe(observer)
        return () => yMap.unobserve(observer)
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

    const yMap = useMemo(() => yMapRef.current, [])

    return { data, set, remove, get, yMap }
}

/**
 * Hook for awareness (cursor positions, presence)
 */
export function useAwareness(provider: WebrtcProvider | null) {
    const [users, setUsers] = useState<Map<number, any>>(new Map())

    useEffect(() => {
        if (!provider) {
            const reset = async () => {
                setUsers(new Map())
            }
            reset()
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

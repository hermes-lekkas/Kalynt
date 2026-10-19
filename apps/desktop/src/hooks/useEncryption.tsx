/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// useEncryption - Centralized encryption hook for app-wide E2E encryption
// Fixed: Uses LRU cache, network-layer encryption, no raw password storage

import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from 'react'
import {
    isRoomEncryptionReady,
    getRoomEncryptionState,
    LRUCache,
    decryptionCache
} from '../services/encryptedProvider'
import { hasRoomPassword } from '../services/roomPasswordStore'

// Encryption context for the entire app
interface EncryptionContextType {
    isEnabled: boolean
    isReady: boolean
    roomId: string | null
    getEncryptionStatus: () => EncryptionStatus
}

interface EncryptionStatus {
    enabled: boolean
    algorithm: string
    keyStrength: number
    ready: boolean
}

const EncryptionContext = createContext<EncryptionContextType | null>(null)

// Provider component for encryption context
// Note: Actual encryption happens at network layer in encryptedProvider.ts
export function EncryptionProvider({
    children,
    spaceId
}: {
    children: ReactNode
    spaceId: string | null
}) {
    const [isEnabled, setIsEnabled] = useState(false)
    const [isReady, setIsReady] = useState(false)

    // Check encryption state (key is derived in useYjs, not here)
    useEffect(() => {
        if (!spaceId) {
            // Already false by default, but if we need to reset:
            // setIsEnabled(false)
            // setIsReady(false)
            return
        }

        // Clear cache when space changes
        decryptionCache.clear()

        // Check if encryption is configured for this space
        // (only whether a password is stored; key derivation happens in useYjs)
        let cancelled = false
        hasRoomPassword(spaceId).then(enabled => {
            if (cancelled) return
            // Batch updates
            setIsEnabled(enabled)
            setIsReady(true)
        })

        // Re-check when encryption state might change
        const checkReady = () => {
            if (spaceId && isRoomEncryptionReady(spaceId)) {
                setIsEnabled(true)
            }
        }

        // Check periodically until ready
        const interval = setInterval(checkReady, 100)
        setTimeout(() => clearInterval(interval), 5000) // Stop after 5s

        return () => {
            cancelled = true
            clearInterval(interval)
        }
    }, [spaceId])

    // Get encryption status for UI
    const getEncryptionStatus = useCallback((): EncryptionStatus => {
        const state = spaceId ? getRoomEncryptionState(spaceId) : null
        return {
            enabled: state?.enabled ?? false,
            algorithm: 'AES-GCM',
            keyStrength: 256,
            ready: isReady && (state?.key !== null || !isEnabled)
        }
    }, [isEnabled, isReady, spaceId])

    const contextValue: EncryptionContextType = {
        isEnabled,
        isReady,
        roomId: spaceId,
        getEncryptionStatus
    }

    return (
        <EncryptionContext.Provider value={contextValue}>
            {children}
        </EncryptionContext.Provider>
    )
}

// Hook to use encryption context
export function useEncryption() {
    const context = useContext(EncryptionContext)
    if (!context) {
        // Return a no-op encryption context if not inside provider
        return {
            isEnabled: false,
            isReady: true,
            roomId: null,
            getEncryptionStatus: () => ({ enabled: false, algorithm: 'none', keyStrength: 0, ready: true })
        }
    }
    return context
}

// LRU Cache for decrypted messages (re-export for convenience)
export { LRUCache, decryptionCache }

import { Lock, Unlock } from 'lucide-react'

// Encryption badge component for UI
export function EncryptionBadge({ showDetails = false }: { showDetails?: boolean }) {
    const { isEnabled, isReady, getEncryptionStatus
    } = useEncryption()
    const status = getEncryptionStatus()

    if (!isReady) {
        return null
    }

    if (!isEnabled) {
        return showDetails ? (
            <span className="encryption-badge disabled" title="Encryption disabled" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <Unlock size={12} /> Unencrypted
            </span>
        ) : null
    }

    return (
        <span className="encryption-badge enabled" title={`${status.algorithm}-${status.keyStrength}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <Lock size={12} /> {showDetails ? `Encrypted (${status.algorithm})` : 'Encrypted'}
        </span>
    )
}

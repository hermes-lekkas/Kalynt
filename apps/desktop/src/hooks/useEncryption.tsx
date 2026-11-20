/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// useEncryption - Centralized encryption hook for app-wide E2E encryption
// Fixed: Uses LRU cache, network-layer encryption, no raw password storage

import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from 'react'
import { Lock, Unlock } from 'lucide-react'
import {
    isRoomEncryptionReady,
    getRoomEncryptionState,
    LRUCache,
    decryptionCache
} from '../services/encryptedProvider'
import { encryptionService } from '../services/encryptionService'
import { normalizeRoomId } from '../services/p2pService'
import { hasRoomPassword } from '../services/roomPasswordStore'

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

export function EncryptionProvider({
    children,
    spaceId
}: {
    children: ReactNode
    spaceId: string | null
}) {
    const [isEnabled, setIsEnabled] = useState(false)
    const [isReady, setIsReady] = useState(false)

    useEffect(() => {
        decryptionCache.clear()

        if (!spaceId) {
            setIsEnabled(false)
            setIsReady(false)
            return
        }

        let cancelled = false
        const normalizedSpaceId = normalizeRoomId(spaceId)

        hasRoomPassword(spaceId).then(enabled => {
            if (cancelled) return
            setIsEnabled(enabled || isRoomEncryptionReady(spaceId))
            setIsReady(true)
        }).catch(() => {
            if (cancelled) return
            setIsEnabled(false)
            setIsReady(true)
        })

        // React immediately when encryption is toggled on/off in Settings
        const unsubKeyChange = encryptionService.onKeyChange((changedRoomId, hasKey) => {
            if (!cancelled && normalizeRoomId(changedRoomId) === normalizedSpaceId) {
                setIsEnabled(hasKey)
                setIsReady(true)
            }
        })

        const checkReady = () => {
            if (!cancelled && isRoomEncryptionReady(spaceId)) {
                setIsEnabled(true)
            }
        }

        const interval = setInterval(checkReady, 100)
        const timeout = setTimeout(() => clearInterval(interval), 5000)

        return () => {
            cancelled = true
            unsubKeyChange()
            clearInterval(interval)
            clearTimeout(timeout)
        }
    }, [spaceId])

    const getEncryptionStatus = useCallback((): EncryptionStatus => {
        const state = spaceId ? getRoomEncryptionState(spaceId) : null
        return {
            enabled: state?.enabled ?? isEnabled,
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

export function useEncryption() {
    const context = useContext(EncryptionContext)
    if (!context) {
        return {
            isEnabled: false,
            isReady: true,
            roomId: null,
            getEncryptionStatus: () => ({ enabled: false, algorithm: 'none', keyStrength: 0, ready: true })
        }
    }
    return context
}

export { LRUCache, decryptionCache }

export function EncryptionBadge({ showDetails = false }: { showDetails?: boolean }) {
    const { isEnabled, isReady, getEncryptionStatus } = useEncryption()
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

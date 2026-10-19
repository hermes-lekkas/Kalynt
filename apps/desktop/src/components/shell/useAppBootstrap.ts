/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * One-time app start-up work: store initialisation, models directory,
 * auto-update wiring, deep links and the document theme attribute.
 */
import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useUpdateStore } from '../../stores/updateStore'
import { usePerformanceAcceleration } from '../../hooks/usePerformanceAcceleration'
import { setModelsDirectory } from '../../services/modelDownloadService'
import { p2pService } from '../../services/p2pService'
import { markEncryptionEnabled, migrateLegacyRoomPasswords } from '../../services/roomPasswordStore'
import { logger } from '../../utils/logger'

export function useAppBootstrap(): { ready: boolean } {
    const initialize = useAppStore(s => s.initialize)
    const theme = useAppStore(s => s.theme)
    const initializeUpdates = useUpdateStore(s => s.initialize)
    const [ready, setReady] = useState(false)
    usePerformanceAcceleration()

    // Theme lives on <html> so portals and the splash pick it up too.
    useEffect(() => {
        document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
    }, [theme])

    useEffect(() => {
        let cancelled = false
        initialize()
            .catch(error => logger.general.error('Initialization error', error))
            .finally(() => { if (!cancelled) setReady(true) })
        return () => { cancelled = true }
    }, [initialize])

    useEffect(() => {
        window.electronAPI?.getModelsDirectory?.()
            .then((dir: string) => {
                setModelsDirectory(dir)
                logger.general.info('Models directory set', { dir })
            })
            .catch((error: unknown) => logger.general.error('Failed to get models directory', error))
    }, [])

    useEffect(() => {
        initializeUpdates().catch(error => logger.general.error('Failed to initialize auto-update system', error))
    }, [initializeUpdates])

    // Older versions kept room passwords in localStorage; move them to secure storage.
    useEffect(() => { migrateLegacyRoomPasswords() }, [])

    // kalynt:// invite links open (or create) the shared workspace.
    useEffect(() => {
        const join = (url: string) => {
            const parsed = p2pService.parseRoomLink(url)
            if (!parsed) {
                logger.general.warn('Could not parse deep link', { url })
                return
            }
            if (parsed.password) {
                // Never persist the room password from a link.
                markEncryptionEnabled(parsed.roomId)
            }
            const store = useAppStore.getState()
            const existing = store.spaces.find(s => s.id === parsed.roomId)
            store.setCurrentSpace(existing ?? store.createSpace(parsed.spaceName || 'Shared workspace', parsed.roomId))
        }

        const onDomLink = (e: Event) => join((e as CustomEvent<{ url: string }>).detail.url)
        window.addEventListener('kalynt-deep-link', onDomLink)
        const removeIpc = window.electronAPI?.on?.('deep-link', (url: string) => {
            window.dispatchEvent(new CustomEvent('kalynt-deep-link', { detail: { url } }))
        })
        return () => {
            window.removeEventListener('kalynt-deep-link', onDomLink)
            if (typeof removeIpc === 'function') removeIpc()
        }
    }, [])

    return { ready }
}

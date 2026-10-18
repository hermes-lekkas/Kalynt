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
import { aiService, type AIProvider } from '../../services/aiService'
import { logger } from '../../utils/logger'

export function useAppBootstrap(): { ready: boolean } {
    const initialize = useAppStore(s => s.initialize)
    const theme = useAppStore(s => s.theme)
    const apiKeys = useAppStore(s => s.apiKeys)
    const initializeUpdates = useUpdateStore(s => s.initialize)
    const [ready, setReady] = useState(false)
    usePerformanceAcceleration()

    // Theme lives on <html> so portals and the splash pick it up too.
    useEffect(() => {
        document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
    }, [theme])

    // Every AI feature (agent, scan, completions) reads keys from aiService.
    useEffect(() => {
        (['openai', 'anthropic', 'google'] as AIProvider[]).forEach(provider => {
            const key = apiKeys[provider]
            if (key) aiService.setAPIKey(provider, key)
            else aiService.removeAPIKey(provider)
        })
    }, [apiKeys])

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

    // kalynt:// invite links open (or create) the shared workspace.
    useEffect(() => {
        const join = (url: string) => {
            const parsed = p2pService.parseRoomLink(url)
            if (!parsed) {
                logger.general.warn('Could not parse deep link', { url })
                return
            }
            if (parsed.password) {
                // Never persist the room password itself.
                localStorage.setItem(`space-settings-${parsed.roomId}`, JSON.stringify({ encryptionEnabled: true }))
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

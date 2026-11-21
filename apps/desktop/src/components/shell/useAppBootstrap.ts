/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * One-time app start-up work: store initialisation, models directory,
 * auto-update wiring, model listeners, root recovery flush, deep links
 * and live document theme synchronisation.
 */
import { useEffect, useState } from 'react'
import { useAppStore, resolveTheme } from '../../stores/appStore'
import { useModelStore } from '../../stores/modelStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { useUiStore } from '../../stores/uiStore'
import { useUpdateStore } from '../../stores/updateStore'
import { usePerformanceAcceleration } from '../../hooks/usePerformanceAcceleration'
import { flushEditorStates, onRecoveryError } from '../../services/editorRecovery'
import { setModelsDirectory } from '../../services/modelDownloadService'
import { normalizeRoomId, p2pService } from '../../services/p2pService'
import { hasRoomPassword, markEncryptionEnabled, migrateLegacyRoomPasswords, setVolatileRoomPassword } from '../../services/roomPasswordStore'
import { logger } from '../../utils/logger'

export function useAppBootstrap(): { ready: boolean } {
    const initialize = useAppStore(s => s.initialize)
    const theme = useAppStore(s => s.theme)
    const initializeUpdates = useUpdateStore(s => s.initialize)
    const [ready, setReady] = useState(false)
    usePerformanceAcceleration()

    // Theme lives on <html> so portals, splash, and scrollbars stay in sync,
    // including live updates when following the OS colour scheme.
    useEffect(() => {
        const apply = () => {
            const resolved = resolveTheme(theme)
            document.documentElement.dataset.theme = resolved
            useAppStore.getState().setResolvedTheme(resolved)
        }
        apply()
        if (theme !== 'system' || typeof window.matchMedia !== 'function') return
        const mq = window.matchMedia('(prefers-color-scheme: light)')
        mq.addEventListener('change', apply)
        return () => mq.removeEventListener('change', apply)
    }, [theme])

    useEffect(() => {
        let cancelled = false
        initialize()
            .catch(error => logger.general.error('Initialization error', error))
            .finally(() => { if (!cancelled) setReady(true) })
        return () => { cancelled = true }
    }, [initialize])

    // Subscribe to local model lifecycle & download progress IPC events at boot.
    useEffect(() => useModelStore.getState().setupListeners(), [])

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
        return () => {
            useUpdateStore.getState().cleanupListeners()
        }
    }, [initializeUpdates])

    // Older versions kept room passwords in localStorage; move them to secure storage.
    useEffect(() => { migrateLegacyRoomPasswords() }, [])

    // Root beforeunload guard so pending editor recovery drafts flush cleanly
    // even if the user navigated back to HomeScreen before closing the window.
    useEffect(() => {
        const offError = onRecoveryError(message => {
            if (!useAppStore.getState().currentSpace) {
                useNotificationStore.getState().addNotification(`Unsaved editor recovery failed: ${message}`, 'error')
            }
        })
        const onBeforeUnload = (event: BeforeUnloadEvent) => {
            window.dispatchEvent(new Event('kalynt-before-flush-editor'))
            if (!window.electronAPI?.editorState) return
            const result = flushEditorStates()
            if (!result.success) {
                event.preventDefault()
                event.returnValue = ''
                useNotificationStore.getState().addNotification(result.error ?? 'Save your files before closing.', 'error')
            }
        }
        window.addEventListener('beforeunload', onBeforeUnload)
        return () => {
            offError()
            window.removeEventListener('beforeunload', onBeforeUnload)
        }
    }, [])

    // kalynt:// invite links open (or create) the shared workspace, or prompt for a password when required.
    // Wait until app initialization completes so cold-start invites match existing workspaces and never race hydration.
    useEffect(() => {
        if (!ready) return
        const join = async (url: string) => {
            const parsed = p2pService.parseRoomLink(url)
            if (!parsed) {
                logger.general.warn('Could not parse deep link', { url })
                useNotificationStore.getState().addNotification('That invite link could not be opened.', 'warning')
                return
            }

            const normalizedId = normalizeRoomId(parsed.roomId)
            const storedPassword = await hasRoomPassword(normalizedId)

            if (parsed.passwordProtected && !parsed.password && !storedPassword) {
                useUiStore.getState().openJoinInvite({
                    url,
                    roomId: normalizedId,
                    spaceName: parsed.spaceName,
                    passwordProtected: true
                })
                return
            }

            if (parsed.password) {
                // Keep the link password only in volatile in-memory storage (never persisted)
                // so the room decrypts immediately on join.
                setVolatileRoomPassword(normalizedId, parsed.password)
                void markEncryptionEnabled(normalizedId)
            }
            const store = useAppStore.getState()
            const existing = store.spaces.find(s => normalizeRoomId(s.id) === normalizedId)
            store.setCurrentSpace(existing ?? store.createSpace(parsed.spaceName || 'Shared workspace', normalizedId))
        }

        const onDomLink = (e: Event) => {
            void join((e as CustomEvent<{ url: string }>).detail.url)
        }
        window.addEventListener('kalynt-deep-link', onDomLink)
        const removeIpc = window.electronAPI?.on?.('deep-link', (url: string) => {
            window.dispatchEvent(new CustomEvent('kalynt-deep-link', { detail: { url } }))
        })

        // Drain any deep links queued during cold start or macOS open-url before mount.
        void window.electronAPI?.consumePendingDeepLinks?.().then(links => {
            if (!Array.isArray(links)) return
            for (const link of links) {
                if (typeof link === 'string' && link) {
                    void join(link)
                }
            }
        }).catch(err => logger.general.warn('Failed to consume pending deep links', err))

        return () => {
            window.removeEventListener('kalynt-deep-link', onDomLink)
            if (typeof removeIpc === 'function') removeIpc()
        }
    }, [ready])

    return { ready }
}

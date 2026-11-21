/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { logger } from '../utils/logger'

/**
 * Update Store
 * Manages application auto-update state and interactions
 */

export interface UpdateInfo {
    version: string
    releaseNotes?: string
    releaseDate: string
    releaseName?: string
}

export interface DownloadProgress {
    bytesPerSecond: number
    percent: number
    transferred: number
    total: number
}

export type UpdateStatus =
    | 'idle'              // No update operation in progress
    | 'checking'          // Checking for updates
    | 'available'         // Update is available
    | 'not-available'     // No update available
    | 'downloading'       // Downloading update
    | 'downloaded'        // Update downloaded, ready to install
    | 'error'             // Error occurred

interface UpdateState {
    // State
    status: UpdateStatus
    currentVersion: string
    updateInfo: UpdateInfo | null
    downloadProgress: DownloadProgress | null
    error: string | null
    lastChecked: number | null
    showUpdateModal: boolean
    isConfigured: boolean

    // Actions
    setStatus: (status: UpdateStatus) => void
    setUpdateInfo: (info: UpdateInfo | null) => void
    setDownloadProgress: (progress: DownloadProgress | null) => void
    setError: (error: string | null) => void
    setLastChecked: (timestamp: number) => void
    setShowUpdateModal: (show: boolean) => void
    setIsConfigured: (configured: boolean) => void
    setCurrentVersion: (version: string) => void

    // Actions - Update operations
    checkForUpdates: () => Promise<void>
    downloadUpdate: () => Promise<void>
    installUpdate: () => Promise<void>
    dismissUpdate: () => void

    // Initialization & lifecycle
    initialize: () => Promise<void>
    cleanupListeners: () => void
}

let listenerUnsubs: Array<() => void> = []

function trackUnsub(maybeUnsub: unknown) {
    if (typeof maybeUnsub === 'function') {
        listenerUnsubs.push(maybeUnsub as () => void)
    }
}

export const useUpdateStore = create<UpdateState>()(
    persist(
        (set, get) => ({
            // Initial state
            status: 'idle',
            currentVersion: '2.1.0',
            updateInfo: null,
            downloadProgress: null,
            error: null,
            lastChecked: null,
            showUpdateModal: false,
            isConfigured: false,

            // Setters
            setStatus: (status) => set({ status }),
            setUpdateInfo: (updateInfo) => set({ updateInfo }),
            setDownloadProgress: (downloadProgress) => set({ downloadProgress }),
            setError: (error) => set({ error }),
            setLastChecked: (lastChecked) => set({ lastChecked }),
            setShowUpdateModal: (showUpdateModal) => set({ showUpdateModal }),
            setIsConfigured: (isConfigured) => set({ isConfigured }),
            setCurrentVersion: (currentVersion) => set({ currentVersion }),

            // Check for updates
            checkForUpdates: async () => {
                try {
                    set({ status: 'checking', error: null })

                    const result = await window.electronAPI?.update?.checkForUpdates()

                    if (!result?.success) {
                        throw new Error(result?.error || 'Failed to check for updates')
                    }

                    set({ lastChecked: Date.now() })

                    if (result.updateAvailable && result.updateInfo) {
                        set({
                            status: 'available',
                            updateInfo: result.updateInfo,
                            showUpdateModal: true
                        })
                    } else {
                        set({
                            status: 'not-available',
                            updateInfo: null
                        })
                    }
                } catch (error) {
                    logger.general.error('[UpdateStore] Check error', error)
                    set({
                        status: 'error',
                        error: error instanceof Error ? error.message : String(error)
                    })
                }
            },

            // Download update
            downloadUpdate: async () => {
                try {
                    set({ status: 'downloading', error: null, downloadProgress: null })

                    const result = await window.electronAPI?.update?.downloadUpdate()

                    if (!result?.success) {
                        throw new Error(result?.error || 'Failed to download update')
                    }
                } catch (error) {
                    logger.general.error('[UpdateStore] Download error', error)
                    set({
                        status: 'error',
                        error: error instanceof Error ? error.message : String(error),
                        downloadProgress: null
                    })
                }
            },

            // Install update
            installUpdate: async () => {
                try {
                    const result = await window.electronAPI?.update?.installUpdate()

                    if (!result?.success) {
                        throw new Error(result?.error || 'Failed to install update')
                    }
                } catch (error) {
                    logger.general.error('[UpdateStore] Install error', error)
                    set({
                        status: 'error',
                        error: error instanceof Error ? error.message : String(error)
                    })
                }
            },

            // Dismiss update notification
            dismissUpdate: () => {
                set({
                    showUpdateModal: false,
                    status: 'idle',
                    updateInfo: null,
                    downloadProgress: null,
                    error: null
                })
            },

            cleanupListeners: () => {
                const unsubs = listenerUnsubs
                listenerUnsubs = []
                for (const unsub of unsubs) {
                    try {
                        unsub()
                    } catch {
                        // Ignore cleanup errors on already-detached channels.
                    }
                }
            },

            // Initialize update system
            initialize: async () => {
                try {
                    // Detach any prior subscriptions so repeated calls never leak listeners.
                    get().cleanupListeners()

                    const versionResult = await window.electronAPI?.update?.getVersion()
                    if (versionResult?.success && versionResult.version) {
                        set({ currentVersion: versionResult.version })
                    }

                    // Configure GitHub token from safe storage
                    const tokenResult = await window.electronAPI?.safeStorage?.get('github-update-token')
                    if (tokenResult?.success && tokenResult.value) {
                        const configResult = await window.electronAPI?.update?.configureToken(tokenResult.value)
                        if (configResult?.success) {
                            set({ isConfigured: true })
                        }
                    } else {
                        await window.electronAPI?.update?.configureToken('')
                    }

                    const api = window.electronAPI?.update
                    if (!api) return

                    // Guard again in case another initialize() raced across the awaits above.
                    get().cleanupListeners()

                    trackUnsub(api.onUpdateChecking(() => {
                        set({ status: 'checking', error: null })
                    }))

                    trackUnsub(api.onUpdateAvailable((info) => {
                        set({
                            status: 'available',
                            updateInfo: info,
                            showUpdateModal: true,
                            lastChecked: Date.now()
                        })
                    }))

                    trackUnsub(api.onUpdateNotAvailable(() => {
                        set({
                            status: 'not-available',
                            updateInfo: null,
                            lastChecked: Date.now()
                        })
                    }))

                    trackUnsub(api.onDownloadProgress((progress) => {
                        set({
                            status: 'downloading',
                            downloadProgress: progress
                        })
                    }))

                    trackUnsub(api.onUpdateDownloaded((info) => {
                        set({
                            status: 'downloaded',
                            updateInfo: info,
                            downloadProgress: null,
                            showUpdateModal: true
                        })
                    }))

                    trackUnsub(api.onUpdateError((error) => {
                        logger.general.error('[UpdateStore] Update error', error)
                        set({
                            status: 'error',
                            error: error.message,
                            downloadProgress: null
                        })
                    }))
                } catch (error) {
                    logger.general.error('[UpdateStore] Initialization error', error)
                    set({
                        error: error instanceof Error ? error.message : String(error)
                    })
                }
            }
        }),
        {
            name: 'kalynt-update-storage',
            storage: createJSONStorage(() => localStorage),
            partialize: (state) => ({
                lastChecked: state.lastChecked,
                isConfigured: state.isConfigured,
                currentVersion: state.currentVersion
            })
        }
    )
)

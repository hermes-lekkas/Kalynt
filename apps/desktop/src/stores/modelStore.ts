/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Model Store - Track downloaded models and download progress
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
    DownloadedModel,
    DownloadProgress,
    DownloadStatus,
    getModelById
} from '../types/offlineModels'

interface ModelState {
    // Downloaded models
    downloadedModels: Record<string, DownloadedModel>

    // Active downloads
    activeDownloads: Record<string, DownloadProgress>

    // Currently loaded model
    loadedModelId: string | null
    draftModelId: string | null // Speculative decoding model
    isLoading: boolean
    loadError: string | null

    // Actions
    addDownloadedModel: (model: DownloadedModel) => void
    removeDownloadedModel: (modelId: string) => void
    isModelDownloaded: (modelId: string) => boolean
    getDownloadedModel: (modelId: string) => DownloadedModel | undefined

    // Download progress
    startDownload: (modelId: string, totalBytes: number) => void
    updateDownloadProgress: (modelId: string, progress: Partial<DownloadProgress>) => void
    pauseDownload: (modelId: string) => void
    resumeDownload: (modelId: string) => void
    cancelDownload: (modelId: string) => void
    completeDownload: (modelId: string, path: string) => void
    failDownload: (modelId: string, error: string) => void

    // Model loading
    setLoadedModel: (modelId: string | null) => void
    setDraftModelId: (modelId: string | null) => void
    setLoading: (loading: boolean) => void
    setLoadError: (error: string | null) => void

    // Utilities
    getDownloadProgress: (modelId: string) => DownloadProgress | undefined
    getTotalDownloadedSize: () => number
    setupListeners: () => () => void
    verifyDownloadedModels: () => Promise<void>
}

let listenerRefCount = 0
let listenerCleanup: (() => void) | null = null

export const useModelStore = create<ModelState>()(
    persist(
        (set, get) => ({
            downloadedModels: {},
            activeDownloads: {},
            loadedModelId: null,
            draftModelId: null,
            isLoading: false,
            loadError: null,

            setupListeners: () => {
                const api = window.electronAPI as any
                if (!api) return () => { /* Electron API unavailable */ }

                listenerRefCount++
                if (listenerRefCount === 1) {
                    const unsubs: Array<() => void> = []
                    if (api.onDownloadProgress) {
                        const unsub = api.onDownloadProgress((progress: { modelId: string; bytesDownloaded: number; totalBytes: number; speed: number }) => {
                            get().updateDownloadProgress(progress.modelId, {
                                bytesDownloaded: progress.bytesDownloaded,
                                totalBytes: progress.totalBytes,
                                speed: progress.speed
                            })
                        })
                        if (typeof unsub === 'function') unsubs.push(unsub)
                    }

                    if (api.onLLMEvent) {
                        const unsub = api.onLLMEvent((event: { type: string; modelId?: string }) => {
                            if (event.type === 'llm:loaded' && event.modelId) {
                                set({ loadedModelId: event.modelId, isLoading: false, loadError: null })
                            } else if (event.type === 'llm:unloaded') {
                                set({ loadedModelId: null, draftModelId: null, isLoading: false })
                            }
                        })
                        if (typeof unsub === 'function') unsubs.push(unsub)
                    }

                    if (api.getModelStatus) {
                        Promise.resolve(api.getModelStatus()).then((status: { success?: boolean; loaded?: boolean; modelId?: string | null; nativeModelId?: string | null } | undefined) => {
                            if (status?.success) {
                                const activeId = status.modelId ?? status.nativeModelId ?? null
                                set({ loadedModelId: status.loaded ? activeId : null })
                            }
                        }).catch(() => undefined)
                    }

                    listenerCleanup = () => {
                        for (const unsub of unsubs) {
                            try { unsub() } catch { /* ignore listener cleanup errors */ }
                        }
                    }
                }

                let released = false
                return () => {
                    if (released) return
                    released = true
                    listenerRefCount = Math.max(0, listenerRefCount - 1)
                    if (listenerRefCount === 0) {
                        listenerCleanup?.()
                        listenerCleanup = null
                    }
                }
            },

            addDownloadedModel: (model) => {
                set((state) => ({
                    downloadedModels: {
                        ...state.downloadedModels,
                        [model.id]: model
                    }
                }))
                console.log('[ModelStore] Added downloaded model:', model.id)
            },

            removeDownloadedModel: (modelId) => {
                set((state) => {
                    const { [modelId]: _, ...rest } = state.downloadedModels
                    return { downloadedModels: rest }
                })
                console.log('[ModelStore] Removed model:', modelId)
            },

            isModelDownloaded: (modelId) => {
                return !!get().downloadedModels[modelId]
            },

            getDownloadedModel: (modelId) => {
                return get().downloadedModels[modelId]
            },

            startDownload: (modelId, totalBytes) => {
                set((state) => {
                    const existing = state.activeDownloads[modelId]
                    const resuming = existing?.status === 'paused'
                    const progress: DownloadProgress = {
                        modelId,
                        status: 'downloading',
                        bytesDownloaded: resuming ? existing.bytesDownloaded : 0,
                        totalBytes: resuming && existing.totalBytes > 0 ? existing.totalBytes : totalBytes,
                        speed: 0,
                        eta: 0
                    }
                    return {
                        activeDownloads: {
                            ...state.activeDownloads,
                            [modelId]: progress
                        }
                    }
                })
                console.log('[ModelStore] Started download:', modelId)
            },

            updateDownloadProgress: (modelId, progress) => {
                set((state) => {
                    const existing = state.activeDownloads[modelId]
                    if (!existing) return state

                    // Use provided values or fall back to existing
                    const bytesDownloaded = progress.bytesDownloaded ?? existing.bytesDownloaded
                    const totalBytes = progress.totalBytes ?? existing.totalBytes
                    const speed = progress.speed ?? existing.speed

                    // Calculate ETA: remaining bytes / speed (in seconds)
                    const remaining = totalBytes - bytesDownloaded
                    const eta = speed > 0 ? Math.round(remaining / speed) : 0

                    return {
                        activeDownloads: {
                            ...state.activeDownloads,
                            [modelId]: {
                                ...existing,
                                bytesDownloaded,
                                totalBytes,
                                speed,
                                eta,
                                status: existing.status, // Preserve status
                            }
                        }
                    }
                })
            },

            pauseDownload: (modelId) => {
                set((state) => {
                    const existing = state.activeDownloads[modelId]
                    if (!existing) return state

                    return {
                        activeDownloads: {
                            ...state.activeDownloads,
                            [modelId]: { ...existing, status: 'paused' as DownloadStatus }
                        }
                    }
                })
                console.log('[ModelStore] Paused download:', modelId)
            },

            resumeDownload: (modelId) => {
                set((state) => {
                    const existing = state.activeDownloads[modelId]
                    if (!existing) return state

                    return {
                        activeDownloads: {
                            ...state.activeDownloads,
                            [modelId]: { ...existing, status: 'downloading' as DownloadStatus }
                        }
                    }
                })
                console.log('[ModelStore] Resumed download:', modelId)
            },

            cancelDownload: (modelId) => {
                set((state) => {
                    const { [modelId]: _, ...rest } = state.activeDownloads
                    return { activeDownloads: rest }
                })
                console.log('[ModelStore] Cancelled download:', modelId)
            },

            completeDownload: (modelId, path) => {
                const model = getModelById(modelId)
                if (!model) return

                // Add to downloaded models
                const downloadedModel: DownloadedModel = {
                    id: modelId,
                    path,
                    downloadedAt: Date.now(),
                    sizeBytes: model.sizeBytes,
                    verified: true
                }

                set((state) => {
                    const { [modelId]: _, ...rest } = state.activeDownloads
                    return {
                        activeDownloads: rest,
                        downloadedModels: {
                            ...state.downloadedModels,
                            [modelId]: downloadedModel
                        }
                    }
                })
                console.log('[ModelStore] Completed download:', modelId)
            },

            failDownload: (modelId, error) => {
                set((state) => {
                    const existing = state.activeDownloads[modelId]
                    if (!existing) return state

                    return {
                        activeDownloads: {
                            ...state.activeDownloads,
                            [modelId]: {
                                ...existing,
                                status: 'error' as DownloadStatus,
                                error
                            }
                        }
                    }
                })
                console.log('[ModelStore] Download failed:', modelId, error)
            },

            setLoadedModel: (modelId) => {
                set({ loadedModelId: modelId, loadError: null })
                console.log('[ModelStore] Loaded model:', modelId)
            },

            setDraftModelId: (modelId) => {
                set({ draftModelId: modelId })
                console.log('[ModelStore] Set draft model:', modelId)
            },

            setLoading: (loading) => {
                set({ isLoading: loading })
            },

            setLoadError: (error) => {
                set({ loadError: error, isLoading: false })
            },

            getDownloadProgress: (modelId) => {
                return get().activeDownloads[modelId]
            },

            getTotalDownloadedSize: () => {
                const models = get().downloadedModels
                return Object.values(models).reduce((sum, m) => sum + m.sizeBytes, 0)
            },

            verifyDownloadedModels: async () => {
                const models = get().downloadedModels
                const modelIds = Object.keys(models)

                if (modelIds.length === 0) {
                    console.log('[ModelStore] No downloaded models to verify')
                    return
                }

                console.log('[ModelStore] Verifying', modelIds.length, 'downloaded model(s)...')

                const invalidModels: string[] = []

                for (const modelId of modelIds) {
                    const model = models[modelId]
                    if (model && window.electronAPI?.fileExists) {
                        try {
                            const exists = await window.electronAPI.fileExists(model.path)
                            if (!exists) {
                                console.warn('[ModelStore] Model file missing:', model.path)
                                invalidModels.push(modelId)
                            }
                        } catch (err) {
                            console.warn('[ModelStore] Error checking model file:', modelId, err)
                            invalidModels.push(modelId)
                        }
                    }
                }

                // Remove invalid model entries
                if (invalidModels.length > 0) {
                    console.log('[ModelStore] Removing', invalidModels.length, 'invalid model entries:', invalidModels)
                    set((state) => {
                        const newDownloadedModels = { ...state.downloadedModels }
                        for (const modelId of invalidModels) {
                            delete newDownloadedModels[modelId]
                        }
                        return { downloadedModels: newDownloadedModels }
                    })
                } else {
                    console.log('[ModelStore] All downloaded models verified successfully')
                }
            }
        }),
        {
            name: 'kalynt-models',
            partialize: (state) => ({
                downloadedModels: state.downloadedModels
            })
        }
    )
)

// Initialize listeners when the module loads (browser only)
if (typeof window !== 'undefined') {
    useModelStore.getState().setupListeners()
    console.log('[ModelStore] Listeners initialized')

    // Verify downloaded models on startup (async, runs in background)
    // This removes stale entries for models whose files no longer exist
    setTimeout(() => {
        useModelStore.getState().verifyDownloadedModels()
    }, 1000) // Delay to allow electronAPI to be ready
}


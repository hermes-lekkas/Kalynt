/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Model Download Service - Download GGUF models from Hugging Face
import { OfflineModel, getModelById } from '../types/offlineModels'
import { useModelStore } from '../stores/modelStore'

// Models directory path (will be set by Electron main process)
let modelsDirectory = ''

/**
 * Set the models directory path (called from main process)
 */
export function setModelsDirectory(path: string): void {
    modelsDirectory = path
    console.log('[ModelDownload] Models directory:', path)
}

/**
 * Get the models directory path
 */
export function getModelsDirectory(): string {
    return modelsDirectory
}

/**
 * Get full path for a model file
 */
export function getModelPath(model: OfflineModel): string {
    return `${modelsDirectory}/${model.filename}`
}

/**
 * Download controller for cancel/pause
 */
const downloadControllers = new Map<string, AbortController>()

/**
 * Download a model from Hugging Face
 */
export async function downloadModel(modelId: string): Promise<boolean> {
    const model = getModelById(modelId)
    if (!model) {
        console.error('[ModelDownload] Model not found:', modelId)
        return false
    }

    const store = useModelStore.getState()

    // Check if already downloading
    if (store.activeDownloads[modelId]?.status === 'downloading') {
        console.warn('[ModelDownload] Already downloading:', modelId)
        return false
    }

    // Check if already downloaded
    if (store.isModelDownloaded(modelId)) {
        console.warn('[ModelDownload] Already downloaded:', modelId)
        return true
    }

    // Create abort controller
    const controller = new AbortController()
    downloadControllers.set(modelId, controller)

    // Start download tracking
    store.startDownload(modelId, model.sizeBytes)

    try {
        console.log('[ModelDownload] Starting download:', model.name)
        console.log('[ModelDownload] URL:', model.downloadUrl)

        // Use Electron IPC if available, otherwise use fetch (for demo)
        if (window.electronAPI?.downloadModel) {
            // Electron main process handles download
            const result = await window.electronAPI.downloadModel({
                modelId,
                url: model.downloadUrl,
                filename: model.filename,
                expectedSize: model.sizeBytes
            })

            if (result.success && result.path) {
                store.completeDownload(modelId, result.path)
                return true
            } else if (result.paused || result.canceled) {
                // pauseDownload / cancelDownload already updated the store.
                return false
            } else {
                store.failDownload(modelId, result.error || 'Download failed')
                return false
            }
        } else {
            const errorMsg = 'Offline AI is not available in this environment. Please run in the desktop app.'
            console.error('[ModelDownload]', errorMsg)
            store.failDownload(modelId, errorMsg)
            return false
        }
    } catch (error) {
        console.error('[ModelDownload] Error:', error)
        store.failDownload(modelId, error instanceof Error ? error.message : 'Unknown error')
        return false
    } finally {
        downloadControllers.delete(modelId)
    }
}


/**
 * Cancel an active download
 */
export function cancelDownload(modelId: string): void {
    const controller = downloadControllers.get(modelId)
    if (controller) {
        controller.abort()
        downloadControllers.delete(modelId)
    }
    // Stops the transfer in the main process and removes the partial file.
    window.electronAPI?.cancelDownload?.(modelId)?.catch?.(() => undefined)
    useModelStore.getState().cancelDownload(modelId)
    console.log('[ModelDownload] Cancelled:', modelId)
}

/**
 * Pause an active download
 */
export async function pauseDownload(modelId: string): Promise<void> {
    if (window.electronAPI?.pauseDownload) {
        await window.electronAPI.pauseDownload(modelId)
    }
    useModelStore.getState().pauseDownload(modelId)
    console.log('[ModelDownload] Paused:', modelId)
}

/**
 * Resume a paused download
 */
export async function resumeDownload(modelId: string): Promise<void> {
    console.log('[ModelDownload] Resuming:', modelId)

    // Update UI state to show resuming
    useModelStore.getState().resumeDownload(modelId)

    // Trigger actual download (main process will use Range header for partial download)
    const success = await downloadModel(modelId)

    if (!success) {
        // If resume failed, revert to paused status
        useModelStore.getState().pauseDownload(modelId)
        console.error('[ModelDownload] Resume failed for:', modelId)
    } else {
        console.log('[ModelDownload] Successfully resumed:', modelId)
    }
}

/**
 * Delete a downloaded model
 */
export async function deleteModel(modelId: string): Promise<boolean> {
    const store = useModelStore.getState()
    const downloaded = store.getDownloadedModel(modelId)

    if (!downloaded) {
        console.warn('[ModelDownload] Model not downloaded:', modelId)
        return false
    }

    try {
        // Use Electron IPC if available
        if (window.electronAPI?.deleteModel) {
            const result = await window.electronAPI.deleteModel(downloaded.path)
            if (!result?.success) {
                console.error('[ModelDownload] Failed to delete file')
                return false
            }
        }

        // Remove from store
        store.removeDownloadedModel(modelId)
        console.log('[ModelDownload] Deleted:', modelId)
        return true
    } catch (error) {
        console.error('[ModelDownload] Delete error:', error)
        return false
    }
}

/**
 * Check if a model file exists on disk
 */
export async function verifyModelExists(modelId: string): Promise<boolean> {
    const store = useModelStore.getState()
    const downloaded = store.getDownloadedModel(modelId)

    if (!downloaded) return false

    if (window.electronAPI?.fileExists) {
        return await window.electronAPI.fileExists(downloaded.path)
    }

    return false
}

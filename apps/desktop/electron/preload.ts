/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Preload bridge: exposes window.electronAPI to the renderer.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { workspaceApi } from './preload/workspaceApi'
import { toolsApi } from './preload/toolsApi'
import { platformApi } from './preload/platformApi'
import { agentApi } from './preload/agentApi'

contextBridge.exposeInMainWorld('electronAPI', {
    // Platform info
    platform: process.platform,

    // App info
    getAppPath: () => ipcRenderer.invoke('get-app-path'),
    getVersion: () => ipcRenderer.invoke('get-version'),
    getModelsDirectory: () => ipcRenderer.invoke('get-models-directory'),

    // Hardware info
    getHardwareInfo: () => ipcRenderer.invoke('get-hardware-info'),
    // LLM tuning that follows the app-wide performance mode.
    getPerformanceInferenceConfig: () => ipcRenderer.invoke('performance:get-inference-config'),
    getRealTimeStats: () => ipcRenderer.invoke('get-realtime-stats'),

    // File operations
    fileExists: (path: string) => ipcRenderer.invoke('file-exists', path),
    deleteModel: (path: string) => ipcRenderer.invoke('delete-model', path),

    // Model download
    downloadModel: (options: any) => ipcRenderer.invoke('download-model', options),
    cancelDownload: (modelId: string) => ipcRenderer.invoke('cancel-download', modelId),
    pauseDownload: (modelId: string) => ipcRenderer.invoke('pause-download', modelId),
    resumeDownload: (modelId: string) => ipcRenderer.invoke('resume-download', modelId),
    onDownloadProgress: (callback: (progress: { modelId: string; bytesDownloaded: number; totalBytes: number; speed: number }) => void) => {
        const listener = (_event: IpcRendererEvent, data: { modelId: string; bytesDownloaded: number; totalBytes: number; speed: number }) => {
            callback(data)
        }
        ipcRenderer.on('download-progress', listener)
        // Return cleanup function
        return () => {
            ipcRenderer.removeListener('download-progress', listener)
        }
    },

    // LLM Inference
    loadModel: (options: any) => ipcRenderer.invoke('load-model', options),
    unloadModel: () => ipcRenderer.invoke('unload-model'),
    generateCompletion: (options: any) => ipcRenderer.invoke('generate-completion', options),
    generateCompletionStream: (options: any, onToken: (token: string) => void, onComplete: (error?: string) => void) => {
        const requestId = Math.random().toString(36).substring(7)
        const tokenListener = (_event: IpcRendererEvent, data: { requestId: string; token: string }) => {
            if (data.requestId === requestId) onToken(data.token)
        }
        const completeListener = (_event: IpcRendererEvent, data: { requestId: string; error?: string }) => {
            if (data.requestId === requestId) {
                ipcRenderer.removeListener('generate-completion-token', tokenListener)
                ipcRenderer.removeListener('generate-completion-complete', completeListener)
                onComplete(data.error)
            }
        }
        ipcRenderer.on('generate-completion-token', tokenListener)
        ipcRenderer.on('generate-completion-complete', completeListener)
        ipcRenderer.send('generate-completion-stream', { ...options, requestId })
        return requestId
    },
    cancelGeneration: (requestId: string) => ipcRenderer.invoke('cancel-generation', requestId),

    // Speculative Decoding - Draft Model
    loadDraftModel: (options: { modelId: string; path: string }) => ipcRenderer.invoke('load-draft-model', options),
    unloadDraftModel: () => ipcRenderer.invoke('unload-draft-model'),
    getDraftModelStatus: () => ipcRenderer.invoke('get-draft-model-status'),

    // AIME engine state: MemoryGuard (emergency/idle) unloads and load info.
    getModelStatus: () => ipcRenderer.invoke('get-model-status'),
    onLLMEvent: (callback: (event: { type: 'llm:loaded' | 'llm:unloaded'; modelId?: string; reason?: 'low-memory' | 'idle'; contextSize?: number; estimatedRamMB?: number; contextCapped?: boolean }) => void) => {
        const listener = (channel: string) => (_event: IpcRendererEvent, data: any) => callback({ type: channel, ...data })
        const loaded = listener('llm:loaded')
        const unloaded = listener('llm:unloaded')
        ipcRenderer.on('llm:loaded', loaded)
        ipcRenderer.on('llm:unloaded', unloaded)
        return () => {
            ipcRenderer.removeListener('llm:loaded', loaded)
            ipcRenderer.removeListener('llm:unloaded', unloaded)
        }
    },


    // ==========================================
    // Shell Integration
    // ==========================================
    shell: {
        openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
        showItemInFolder: (path: string) => ipcRenderer.invoke('shell:showItemInFolder', path)
    },

    // ==========================================
    // Window Controls
    // ==========================================
    minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
    maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
    closeWindow: () => ipcRenderer.invoke('close-window'),

    // ==========================================
    // Emergency Controls
    // ==========================================
    nukeProcesses: (level: any) => ipcRenderer.invoke('nuke-processes', level),

    ...workspaceApi,
    ...toolsApi,
    ...platformApi,
    ...agentApi
})

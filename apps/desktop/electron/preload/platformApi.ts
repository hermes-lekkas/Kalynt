/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Secure storage, runtimes, updates, extensions and generic IPC.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { subscribe } from './subscribe'
import type { PerformanceAPI, PerformanceModeValue, SafeStorageAPI } from './types'

export const platformApi = {

    // ==========================================
    // Secure Storage APIs
    // ==========================================
    safeStorage: {
        isAvailable: () => ipcRenderer.invoke('safeStorage:isAvailable'),
        set: (options: { key: string; value: string }) => ipcRenderer.invoke('safeStorage:set', options),
        get: (key: string) => ipcRenderer.invoke('safeStorage:get', key),
        hasKey: (key: string) => ipcRenderer.invoke('safeStorage:hasKey', key),
        delete: (key: string) => ipcRenderer.invoke('safeStorage:delete', key),
        listKeys: () => ipcRenderer.invoke('safeStorage:listKeys')
    } as SafeStorageAPI,

    // ==========================================
    // Runtime Management APIs
    // ==========================================
    runtimeMgmt: {
        check: (runtimeId: any) => ipcRenderer.invoke('runtime:check', runtimeId),
        installable: () => ipcRenderer.invoke('runtime:installable'),
        download: (runtimeId: any) => ipcRenderer.invoke('runtime:download', runtimeId),
        install: (options: any) => ipcRenderer.invoke('runtime:install', options),
        uninstall: (runtimeId: any) => ipcRenderer.invoke('runtime:uninstall', runtimeId),
        downloadAndInstall: (runtimeId: any) => ipcRenderer.invoke('runtime:downloadAndInstall', runtimeId),
        onDownloadProgress: (callback: (data: any) => void) => {
            return subscribe('runtime:download-progress', callback)
        },
        onStatus: (callback: (data: any) => void) => {
            return subscribe('runtime:status', callback)
        },
        onLog: (callback: (data: any) => void) => {
            return subscribe('runtime:log', callback)
        },
        removeListeners: () => {
            ipcRenderer.removeAllListeners('runtime:download-progress')
            ipcRenderer.removeAllListeners('runtime:status')
            ipcRenderer.removeAllListeners('runtime:log')
        }
    },

    // ==========================================
    // Auto-Update APIs
    // ==========================================
    update: {
        configureToken: (token: string) => ipcRenderer.invoke('update:configure-token', token),
        checkForUpdates: () => ipcRenderer.invoke('update:check'),
        downloadUpdate: () => ipcRenderer.invoke('update:download'),
        installUpdate: () => ipcRenderer.invoke('update:install'),
        getVersion: () => ipcRenderer.invoke('update:get-version'),
        getStatus: () => ipcRenderer.invoke('update:get-status'),
        // Events
        onUpdateChecking: (callback: () => void) => {
            return subscribe('update:checking', () => callback())
        },
        onUpdateAvailable: (callback: (info: any) => void) => {
            return subscribe('update:available', callback)
        },
        onUpdateNotAvailable: (callback: (info: any) => void) => {
            return subscribe('update:not-available', callback)
        },
        onDownloadProgress: (callback: (progress: any) => void) => {
            return subscribe('update:download-progress', callback)
        },
        onUpdateDownloaded: (callback: (info: any) => void) => {
            return subscribe('update:downloaded', callback)
        },
        onUpdateError: (callback: (error: any) => void) => {
            return subscribe('update:error', callback)
        },
        removeListeners: () => {
            ipcRenderer.removeAllListeners('update:checking')
            ipcRenderer.removeAllListeners('update:available')
            ipcRenderer.removeAllListeners('update:not-available')
            ipcRenderer.removeAllListeners('update:download-progress')
            ipcRenderer.removeAllListeners('update:downloaded')
            ipcRenderer.removeAllListeners('update:error')
        }
    },


    // ==========================================
    // Extension System APIs
    // ==========================================
    extensions: {
        scan: () => ipcRenderer.invoke('extensions:scan'),
        activate: (id: string) => ipcRenderer.invoke('extensions:activate', id),
        deactivate: (id: string) => ipcRenderer.invoke('extensions:deactivate', id),
        install: (vsixPath: string) => ipcRenderer.invoke('extensions:install', vsixPath),
        uninstall: (id: string) => ipcRenderer.invoke('extensions:uninstall', id),
        list: () => ipcRenderer.invoke('extensions:list'),
        active: () => ipcRenderer.invoke('extensions:active'),
        contributions: () => ipcRenderer.invoke('extensions:contributions'),
        startHost: () => ipcRenderer.invoke('extensions:start-host'),
        stopHost: () => ipcRenderer.invoke('extensions:stop-host'),
        download: (url: string, targetPath: string) => ipcRenderer.invoke('extensions:download', url, targetPath),
        // Events
        onActivated: (callback: (data: { id: string }) => void) => {
            return subscribe('extension:activated', callback)
        },
        onDeactivated: (callback: (data: { id: string }) => void) => {
            return subscribe('extension:deactivated', callback)
        },
        onExtensionActivated: (callback: (data: { id: string }) => void) => {
            return subscribe('extension:activated', callback)
        },
        onExtensionDeactivated: (callback: (data: { id: string }) => void) => {
            return subscribe('extension:deactivated', callback)
        },
        onShowMessage: (callback: (data: { type: string; message: string }) => void) => {
            return subscribe('extension:show-message', callback)
        },
        removeListeners: () => {
            ipcRenderer.removeAllListeners('extension:activated')
            ipcRenderer.removeAllListeners('extension:deactivated')
            ipcRenderer.removeAllListeners('extension:show-message')
        }
    },

    // ==========================================
    // Performance Acceleration APIs
    // ==========================================
    performance: {
        setMode: (mode: PerformanceModeValue) => ipcRenderer.invoke('performance:set-mode', mode),
        getStatus: () => ipcRenderer.invoke('performance:get-status'),
        requestGc: () => ipcRenderer.invoke('performance:request-gc'),
        scanWorkspace: (dirPath?: string) => ipcRenderer.invoke('performance:scan-workspace', dirPath),
        prewarmCache: (dirPath?: string) => ipcRenderer.invoke('performance:prewarm-cache', dirPath),
        testDiskSpeed: () => ipcRenderer.invoke('performance:test-disk-speed'),
        getBootTime: () => ipcRenderer.invoke('performance:get-boot-time'),
        getInferenceConfig: () => ipcRenderer.invoke('performance:get-inference-config'),
        onRequestGc: (callback: () => void) => subscribe('performance:request-gc', () => callback()),
        onSuspendBackgroundTasks: (callback: () => void) => subscribe('performance:suspend-background-tasks', () => callback()),
        onOptimizeMonaco: (callback: (options: Record<string, unknown>) => void) => subscribe('performance:optimize-monaco', callback),
        onDisposeWorkers: (callback: () => void) => subscribe('performance:dispose-workers', () => callback())
    } as PerformanceAPI,

    // ==========================================
    // Generic IPC listener for allowlisted events
    // ==========================================
    on: (channel: string, callback: (...args: any[]) => void) => {
        const validChannels = [
            'deep-link',
            'window:maximized-changed',
            'extension:activated',
            'extension:deactivated',
            'extension:show-message',
            'performance:request-gc',
            'performance:suspend-background-tasks',
            'performance:optimize-monaco',
            'performance:dispose-workers'
        ]
        if (validChannels.includes(channel)) {
            const listener = (_event: IpcRendererEvent, ...args: any[]) => callback(...args)
            ipcRenderer.on(channel, listener)
            return () => {
                ipcRenderer.removeListener(channel, listener)
            }
        }
        return () => {}
    },

    // ==========================================
    // Dialog APIs
    // ==========================================
    dialog: {
        showOpenDialog: (options: any) => ipcRenderer.invoke('dialog:showOpenDialog', options)
    },

    // ==========================================
    // App APIs
    // ==========================================
    app: {
        getPath: (name: string) => ipcRenderer.invoke('app:getPath', name)
    }
}

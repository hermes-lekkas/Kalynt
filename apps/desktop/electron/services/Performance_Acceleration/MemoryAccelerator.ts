/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { app, BrowserWindow } from 'electron'
import * as os from 'node:os'
import { nativeHelperService } from '../native-helper-service'

export enum PerformanceMode {
    BALANCED = 'balanced',
    HIGH_PERFORMANCE = 'high_performance',
    POWER_SAVER = 'power_saver'
}

/**
 * MemoryAccelerator
 * 
 * Optimizes RAM usage across the main and renderer processes.
 * Implements aggressive garbage collection hints and memory pressure handling.
 */
export class MemoryAccelerator {
    private mode: PerformanceMode = PerformanceMode.BALANCED
    private gcTimer: NodeJS.Timeout | null = null
    private checkInterval: number = 15_000 // 15 seconds default (balanced mode)
    private memoryThreshold: number = 0.65 // 65% RAM usage threshold

    constructor() {
        this.init()
    }

    private init() {
        // Listen to OS memory pressure warnings
        app.on('child-process-gone', (event, details) => {
            if (details.reason === 'oom') {
                console.warn('[MemoryAccelerator] A child process went out of memory!')
                this.requestGarbageCollection()
            }
        })

        // Monitor system resources and adjust mode
        this.startMonitoring()
    }

    private startMonitoring() {
        if (this.gcTimer) clearInterval(this.gcTimer)

        this.gcTimer = setInterval(() => {
            this.checkMemoryUsage()
        }, this.checkInterval)
    }

    /**
     * Checks current memory usage and triggers GC if necessary.
     */
    private checkMemoryUsage() {
        const totalMem = os.totalmem()
        const freeMem = os.freemem()
        const usedPercent = (totalMem - freeMem) / totalMem

        if (usedPercent > this.memoryThreshold) {
            this.requestGarbageCollection()
        }

        // If in Power Saver mode, be more aggressive
        if (this.mode === PerformanceMode.POWER_SAVER && usedPercent > 0.6) {
            this.requestGarbageCollection()
        }
    }

    /**
     * Attempts to trigger garbage collection in the main process and all windows.
     */
    public requestGarbageCollection() {
        // Main process GC (requires --expose_gc flag)
        if (typeof globalThis.gc === 'function') {
            try {
                globalThis.gc()
                console.log('[MemoryAccelerator] Main process GC triggered.')
            } catch (e) {
                console.error('[MemoryAccelerator] Failed to trigger main GC:', e)
            }
        }

        // Trigger GC and worker disposal in all renderer processes via IPC
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send('performance:request-gc')
                win.webContents.send('performance:dispose-workers')
            }
        }

        // RAM: Also trim the Swift native helper process (macOS)
        if (process.platform === 'darwin' && nativeHelperService.isAvailable()) {
            nativeHelperService.request('memory-trim').catch(() => { /* ignore */ })
        }
    }

    /**
     * Notifies renderers to pause non-essential background tasks (file
     * indexing, heavy AI pre-loading). Called when memory runs critically low.
     */
    public suspendBackgroundTasks() {
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send('performance:suspend-background-tasks')
            }
        }
    }

    /**
     * Sets the performance mode of the application.
     */
    public setPerformanceMode(mode: PerformanceMode) {
        this.mode = mode
        console.log(`[MemoryAccelerator] Performance mode set to: ${mode}`)

        switch (mode) {
            case PerformanceMode.HIGH_PERFORMANCE:
                this.checkInterval = 30_000 // 30s — less frequent, prioritize compute
                this.memoryThreshold = 0.85
                break
            case PerformanceMode.BALANCED:
                this.checkInterval = 15_000 // 15s
                this.memoryThreshold = 0.65
                break
            case PerformanceMode.POWER_SAVER:
                this.checkInterval = 10_000 // 10s — aggressive
                this.memoryThreshold = 0.4
                this.requestGarbageCollection()
                break
        }

        this.startMonitoring()
    }

    /**
     * Optimizes Monaco Editor settings by sending a configuration update to renderers.
     */
    public optimizeMonaco(win: BrowserWindow) {
        win.webContents.send('performance:optimize-monaco', {
            maxTokenizationLineLength: 10000,
            stopRenderingLineAfter: 5000,
            folding: this.mode !== PerformanceMode.POWER_SAVER,
            minimap: { enabled: this.mode !== PerformanceMode.POWER_SAVER },
            scrollbar: {
                useShadows: false,
                verticalHasArrows: false,
                horizontalHasArrows: false,
                vertical: 'visible',
                horizontal: 'visible',
                verticalScrollbarSize: 10,
                horizontalScrollbarSize: 10
            }
        })
    }

    public getStatus() {
        const metrics = app.getAppMetrics()
        let totalWorkingSetSize = 0
        let totalPrivateMemory = 0

        for (const metric of metrics) {
            totalWorkingSetSize += metric.memory.workingSetSize
            totalPrivateMemory += (metric.memory.privateBytes || 0)
        }

        // workingSetSize is typically considered the best equivalent to RSS for Chromium processes
        return {
            mode: this.mode,
            rss: Math.round(totalWorkingSetSize / 1024), // converting KB to MB
            // keeping extra data just in case needed later, though not actively used by FE right now
            totalPrivateBytes: Math.round(totalPrivateMemory / 1024),
        }
    }

    public dispose() {
        if (this.gcTimer) clearInterval(this.gcTimer)
    }
}

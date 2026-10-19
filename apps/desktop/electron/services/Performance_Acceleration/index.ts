/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { app, ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { MemoryAccelerator, PerformanceMode } from './MemoryAccelerator'
import { IOAccelerator } from './IOAccelerator'
import { ComputeAccelerator } from './ComputeAccelerator'
import { BuildAccelerator } from './BuildAccelerator'

/**
 * PerformanceAccelerationService
 * 
 * The central orchestrator for the Kalynt Performance Acceleration system.
 * It manages individual accelerators and provides a unified IPC interface.
 */
class PerformanceAccelerationService {
    public memory: MemoryAccelerator
    public io: IOAccelerator
    public compute: ComputeAccelerator
    public build: BuildAccelerator
    
    private isInitialized: boolean = false

    constructor() {
        this.memory = new MemoryAccelerator()
        this.io = new IOAccelerator()
        this.compute = new ComputeAccelerator()
        // BuildAccelerator will be initialized when app is ready (requires userData)
        this.build = null!
    }

    public init() {
        if (this.isInitialized) return
        
        const userDataPath = app.getPath('userData')
        this.build = new BuildAccelerator(userDataPath)
        
        this.registerHandlers()
        this.isInitialized = true
        console.log('[PerformanceAcceleration] Service initialized.')
    }

    private registerHandlers() {
        // Mode control
        ipcMain.handle('performance:set-mode', (_, mode: PerformanceMode) => {
            this.setMode(mode)
            return { success: true, mode }
        })

        ipcMain.handle('performance:get-status', () => {
            return {
                memory: this.memory.getStatus(),
                platform: process.platform,
                arch: process.arch
            }
        })

        // Memory optimizations
        ipcMain.handle('performance:request-gc', () => {
            this.memory.requestGarbageCollection()
            return { success: true }
        })

        // IO optimizations
        ipcMain.handle('performance:scan-workspace', async (_, path: string) => {
            return this.io.scanDirectory(path)
        })

        ipcMain.handle('performance:prewarm-cache', async (_, path: string) => {
            await this.io.prewarmCache(path)
            return { success: true }
        })

        ipcMain.handle('performance:test-disk-speed', async () => {
            const tempDir = app.getPath('temp')
            const testFile = path.join(tempDir, `kalynt_perf_test_${Date.now()}.tmp`)
            const data = Buffer.alloc(1024 * 1024 * 10, 'A') // 10MB test data

            try {
                // Write test
                const writeStart = performance.now()
                fs.writeFileSync(testFile, data)
                const writeEnd = performance.now()
                const writeTime = (writeEnd - writeStart) / 1000
                const writeSpeed = 10 / writeTime

                // Read test
                const readStart = performance.now()
                fs.readFileSync(testFile)
                const readEnd = performance.now()
                const readTime = (readEnd - readStart) / 1000
                const readSpeed = 10 / readTime

                // Cleanup
                fs.unlinkSync(testFile)

                return { read: readSpeed, write: writeSpeed }
            } catch (_e) {
                console.error('[PerformanceAcceleration] Disk test failed:', _e)
                if (fs.existsSync(testFile)) fs.unlinkSync(testFile)
                return { read: 0, write: 0 }
            }
        })

        // Compute optimizations
        ipcMain.handle('performance:get-inference-config', () => {
            return this.compute.getInferenceOptimization()
        })

        // Monitoring for window creation to apply optimizations
        app.on('browser-window-created', (_, win) => {
            this.memory.optimizeMonaco(win)
        })
    }

    public setMode(mode: PerformanceMode) {
        this.memory.setPerformanceMode(mode)
        this.compute.setPerformanceMode(mode)
    }

    public dispose() {
        this.memory.dispose()
    }
}

export const performanceAcceleration = new PerformanceAccelerationService()
export { PerformanceMode }

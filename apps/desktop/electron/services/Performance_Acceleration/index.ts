/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { app, ipcMain } from 'electron'
import crypto from 'node:crypto'
import * as fs from 'fs'
import * as path from 'path'
import { MemoryAccelerator, PerformanceMode } from './MemoryAccelerator'
import { IOAccelerator } from './IOAccelerator'
import { ComputeAccelerator } from './ComputeAccelerator'
import { BuildAccelerator } from './BuildAccelerator'
import { validatePath } from '../../utils/pathValidator'

const VALID_MODES = new Set<string>(Object.values(PerformanceMode))

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
    private getWorkspacePath: () => string | null = () => null

    constructor() {
        this.memory = new MemoryAccelerator()
        this.io = new IOAccelerator()
        this.compute = new ComputeAccelerator()
        // BuildAccelerator will be initialized when app is ready (requires userData)
        this.build = null!
    }

    public init(getWorkspacePath?: () => string | null) {
        if (getWorkspacePath) {
            this.getWorkspacePath = getWorkspacePath
        }
        if (this.isInitialized) return

        const userDataPath = app.getPath('userData')
        this.build = new BuildAccelerator(userDataPath)

        this.registerHandlers()
        this.isInitialized = true
        console.log('[PerformanceAcceleration] Service initialized.')
    }

    private resolveWorkspaceDir(requestedPath?: string): string {
        const workspace = this.getWorkspacePath()
        if (!workspace) {
            throw new Error('No workspace open')
        }
        return requestedPath ? validatePath(workspace, requestedPath) : path.resolve(workspace)
    }

    private registerHandlers() {
        // Mode control
        ipcMain.handle('performance:set-mode', (_, mode: PerformanceMode) => {
            if (typeof mode !== 'string' || !VALID_MODES.has(mode)) {
                return { success: false, error: 'Invalid performance mode' }
            }
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

        // IO optimizations (restricted to active workspace)
        ipcMain.handle('performance:scan-workspace', async (_, dirPath?: string) => {
            const safePath = this.resolveWorkspaceDir(dirPath)
            return this.io.scanDirectory(safePath)
        })

        ipcMain.handle('performance:prewarm-cache', async (_, dirPath?: string) => {
            try {
                const safePath = this.resolveWorkspaceDir(dirPath)
                await this.io.prewarmCache(safePath)
                return { success: true }
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) }
            }
        })

        ipcMain.handle('performance:test-disk-speed', async () => {
            const tempDir = app.getPath('temp')
            const testFile = path.join(tempDir, `kalynt_perf_test_${process.pid}_${crypto.randomUUID()}.tmp`)
            const data = Buffer.alloc(1024 * 1024 * 10, 'A') // 10MB test data

            try {
                // Write test
                const writeStart = performance.now()
                await fs.promises.writeFile(testFile, data)
                const writeEnd = performance.now()
                const writeTime = Math.max((writeEnd - writeStart) / 1000, 0.001)
                const writeSpeed = 10 / writeTime

                // Read test
                const readStart = performance.now()
                await fs.promises.readFile(testFile)
                const readEnd = performance.now()
                const readTime = Math.max((readEnd - readStart) / 1000, 0.001)
                const readSpeed = 10 / readTime

                return { read: readSpeed, write: writeSpeed }
            } catch (_e) {
                console.error('[PerformanceAcceleration] Disk test failed:', _e)
                return { read: 0, write: 0 }
            } finally {
                await fs.promises.rm(testFile, { force: true }).catch(() => undefined)
            }
        })

        // Compute optimizations
        ipcMain.handle('performance:get-inference-config', () => {
            return this.compute.getInferenceOptimization()
        })

        // Apply Monaco optimizations once each renderer finishes loading (so the IPC isn't dropped).
        app.on('browser-window-created', (_, win) => {
            win.webContents.on('did-finish-load', () => {
                if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
                    this.memory.optimizeMonaco(win)
                }
            })
        })
    }

    public setMode(mode: PerformanceMode) {
        this.memory.setPerformanceMode(mode)
        this.compute.setPerformanceMode(mode)
    }

    public dispose() {
        this.memory.dispose()
        this.io.clearCache()
    }
}

export const performanceAcceleration = new PerformanceAccelerationService()
export { PerformanceMode }

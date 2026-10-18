/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { app } from 'electron'
import path from 'path'
import fs from 'fs'

/**
 * BinaryManager
 * 
 * Manages access to bundled and downloaded platform-specific binaries.
 */
class BinaryManager {
    private binDir: string

    constructor() {
        // Paths:
        // Dev: apps/desktop/bin
        // Prod: Resources/bin
        this.binDir = app.isPackaged 
            ? path.join(process.resourcesPath, 'bin')
            : path.join(app.getAppPath(), 'bin')
            
        this.ensureDir()
    }

    private ensureDir() {
        if (fs.existsSync(this.binDir)) return
        try {
            fs.mkdirSync(this.binDir, { recursive: true })
        } catch {
            // Read-only installs (AppImage mounts, packaged Resources) simply
            // ship no downloadable binaries; getBinaryPath keeps working.
            console.log('[BinaryManager] No writable bin dir; bundled binaries only')
        }
    }

    /**
     * Gets the path to a bundled binary.
     */
    getBinaryPath(name: string): string | null {
        const isWin = process.platform === 'win32'
        const binaryName = isWin ? `${name}.exe` : name
        const fullPath = path.join(this.binDir, binaryName)

        if (fs.existsSync(fullPath)) {
            // Ensure executable permissions on Unix
            if (!isWin) {
                try {
                    fs.chmodSync(fullPath, 0o755)
                } catch (e) {
                    console.warn(`[BinaryManager] Failed to chmod ${name}:`, e)
                }
            }
            return fullPath
        }

        return null
    }

    /**
     * Specialized getter for ripgrep
     */
    getRipgrepPath(): string | null {
        return this.getBinaryPath('rg')
    }

    /**
     * Checks if a binary is available
     */
    hasBinary(name: string): boolean {
        return this.getBinaryPath(name) !== null
    }
}

export const binaryManager = new BinaryManager()

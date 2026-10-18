/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import path from 'node:path'
import fs from 'node:fs'
import * as chokidar from 'chokidar'
import type { BrowserWindow as BrowserWindowType } from 'electron'
import { nativeHelperService } from '../services/native-helper-service'
import { validatePath } from '../utils/pathValidator'
import { searchFolder } from './fs-search'
import { copyFolder } from './fs-backup'

// Stateful maps for file watchers
const watchers = new Map<string, chokidar.FSWatcher>()
const nativeWatchers = new Set<string>() // Track IDs using native watcher

// Folders the explorer never shows and that are far too large to watch.
const WATCH_IGNORED = /(^|[\\/])(\.[^\\/]*|node_modules|__pycache__)([\\/]|$)/

// macOS FSEvents from the native helper. An event names its watcher when the
// helper knows it; otherwise every native watcher is told.
nativeHelperService.on('file-changed', (params: { path: string, flags: number, watcherId?: string }) => {
    const mainWindow = nativeHelperService.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return
    // kFSEventStreamEventFlagItemCreated = 0x100, ItemRemoved = 0x200
    let event: 'add' | 'unlink' | 'change' = 'change'
    if (params.flags & 0x00000100) event = 'add'
    if (params.flags & 0x00000200) event = 'unlink'
    const targets = params.watcherId ? (nativeWatchers.has(params.watcherId) ? [params.watcherId] : []) : [...nativeWatchers]
    for (const id of targets) {
        mainWindow.webContents.send('fs:change', { id, event, path: params.path })
    }
})

export function registerFileSystemHandlers(
    ipcMain: Electron.IpcMain,
    dialog: Electron.Dialog,
    getMainWindow: () => BrowserWindowType | null,
    getCurrentWorkspacePath: () => string | null,
    setCurrentWorkspacePath: (path: string) => void,
    getModelsDir: () => string
) {
    // Set workspace and clear all watchers
    ipcMain.handle('fs:setWorkspace', async (_event, workspacePath: string) => {
        setCurrentWorkspacePath(workspacePath)
        const closePromises: Promise<void>[] = []
        watchers.forEach((watcher) => {
            closePromises.push(watcher.close())
        })
        await Promise.all(closePromises)
        watchers.clear()
        console.log('[Main] Workspace set to:', workspacePath)
        return { success: true }
    })

    // Open folder dialog
    ipcMain.handle('fs:openFolder', async () => {
        const mainWindow = getMainWindow()
        if (!mainWindow) return { success: false, error: 'No main window' }
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory']
        })
        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, canceled: true }
        }
        setCurrentWorkspacePath(result.filePaths[0])
        console.log('[Main] Workspace opened:', result.filePaths[0])
        return { success: true, path: result.filePaths[0] }
    })

    // Check if file exists
    ipcMain.handle('file-exists', async (_event, filePath: string) => {
        try {
            // Try models directory first (essential for absolute paths from model store)
            const MODELS_DIR = getModelsDir()
            try {
                const filename = path.basename(filePath)
                const safeModelPath = validatePath(MODELS_DIR, filename)
                if (fs.existsSync(safeModelPath)) {
                    return true
                }
            } catch {
                // Ignore validation errors for models and fall through
            }

            // Try current workspace
            const currentWorkspacePath = getCurrentWorkspacePath()
            if (currentWorkspacePath) {
                const safePath = validatePath(currentWorkspacePath, filePath)
                return fs.existsSync(safePath)
            }

            return false
        } catch {
            return false
        }
    })

    // Delete model file (restricted to models directory)
    ipcMain.handle('delete-model', async (_event, filePath: string) => {
        try {
            const MODELS_DIR = getModelsDir()
            const safePath = validatePath(MODELS_DIR, filePath)
            if (!safePath.startsWith(MODELS_DIR)) {
                return { success: false, error: 'Access denied: Invalid model path' }
            }
            if (fs.existsSync(safePath)) {
                fs.unlinkSync(safePath)
            }
            return { success: true }
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    // Read directory contents
    ipcMain.handle('fs:readDir', async (_event, dirPath: string) => {
        try {
            const currentWorkspacePath = getCurrentWorkspacePath()
            if (!currentWorkspacePath) {
                return { success: false, error: 'No workspace open' }
            }
            const safePath = validatePath(currentWorkspacePath, dirPath)
            const entries = await fs.promises.readdir(safePath, { withFileTypes: true })
            const items = await Promise.all(entries
                .filter(entry => {
                    const name = entry.name
                    if (name === '.env' || name === '.git' || name === 'node_modules') return false
                    if (name.endsWith('.key') || name.endsWith('.pem')) return false
                    return true
                })
                .map(async entry => {
                    const entryPath = path.join(dirPath, entry.name)
                    let stats = { size: 0, mtimeMs: Date.now() }
                    try {
                        if (entry.isFile()) {
                            const fullPath = path.join(safePath, entry.name)
                            stats = await fs.promises.stat(fullPath)
                        }
                    } catch (error_) {
                        console.error('[Main] Failed to stat file during readDir:', error_)
                    }
                    return {
                        name: entry.name,
                        path: entryPath,
                        isDirectory: entry.isDirectory(),
                        isFile: entry.isFile(),
                        size: stats.size,
                        lastModified: stats.mtimeMs
                    }
                }))
            return { success: true, items }
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    // Read file contents
    ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
        try {
            const currentWorkspacePath = getCurrentWorkspacePath()
            if (!currentWorkspacePath) {
                return { success: false, error: 'No workspace open' }
            }
            const safePath = validatePath(currentWorkspacePath, filePath)
            const content = await fs.promises.readFile(safePath, 'utf-8')
            return { success: true, content }
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    // Read binary file contents (returns Uint8Array)
    ipcMain.handle('fs:readBinaryFile', async (_event, filePath: string) => {
        try {
            // Note: We might need to access node_modules which could be outside current workspace
            // but for now we assume it's within or we'll adjust validation.
            const currentWorkspacePath = getCurrentWorkspacePath()
            if (!currentWorkspacePath) {
                return { success: false, error: 'No workspace open' }
            }
            const safePath = validatePath(currentWorkspacePath, filePath)
            const content = await fs.promises.readFile(safePath)
            return { success: true, content: new Uint8Array(content) }
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    // Get file stats
    ipcMain.handle('fs:stat', async (_event, filePath: string) => {
        try {
            const currentWorkspacePath = getCurrentWorkspacePath()
            if (!currentWorkspacePath) {
                return { success: false, error: 'No workspace open' }
            }
            const safePath = validatePath(currentWorkspacePath, filePath)
            const stats = await fs.promises.stat(safePath)
            return {
                success: true,
                size: stats.size,
                mtimeMs: stats.mtimeMs,
                isDirectory: stats.isDirectory(),
                isFile: stats.isFile()
            }
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    // Write file contents
    ipcMain.handle('fs:writeFile', async (_event, options: { path: string, content: string, encoding?: BufferEncoding }) => {
        try {
            const currentWorkspacePath = getCurrentWorkspacePath()
            if (!currentWorkspacePath) {
                return { success: false, error: 'No workspace open' }
            }
            const safePath = validatePath(currentWorkspacePath, options.path)
            await fs.promises.mkdir(path.dirname(safePath), { recursive: true })
            await fs.promises.writeFile(safePath, options.content, options.encoding || 'utf-8')
            return { success: true }
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    // Create empty file
    ipcMain.handle('fs:createFile', async (_event, filePath: string) => {
        try {
            const currentWorkspacePath = getCurrentWorkspacePath()
            if (!currentWorkspacePath) {
                return { success: false, error: 'No workspace open' }
            }
            const safePath = validatePath(currentWorkspacePath, filePath)
            await fs.promises.mkdir(path.dirname(safePath), { recursive: true })
            // 'wx' fails instead of emptying a file that already exists.
            await fs.promises.writeFile(safePath, '', { encoding: 'utf-8', flag: 'wx' })
            return { success: true }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                return { success: false, error: `${path.basename(filePath)} already exists` }
            }
            return { success: false, error: String(error) }
        }
    })

    // Create directory
    ipcMain.handle('fs:createDir', async (_event, dirPath: string) => {
        try {
            const currentWorkspacePath = getCurrentWorkspacePath()
            if (!currentWorkspacePath) {
                return { success: false, error: 'No workspace open' }
            }
            const safePath = validatePath(currentWorkspacePath, dirPath)
            await fs.promises.mkdir(safePath, { recursive: true })
            return { success: true }
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    // Delete file or directory
    ipcMain.handle('fs:delete', async (_event, itemPath: string) => {
        try {
            const currentWorkspacePath = getCurrentWorkspacePath()
            if (!currentWorkspacePath) {
                return { success: false, error: 'No workspace open' }
            }
            const safePath = validatePath(currentWorkspacePath, itemPath)
            const stat = await fs.promises.stat(safePath)
            if (stat.isDirectory()) {
                await fs.promises.rm(safePath, { recursive: true })
            } else {
                await fs.promises.unlink(safePath)
            }
            return { success: true }
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    // Rename file or directory
    ipcMain.handle('fs:rename', async (_event, options: { oldPath: string, newPath: string }) => {
        try {
            const currentWorkspacePath = getCurrentWorkspacePath()
            if (!currentWorkspacePath) {
                return { success: false, error: 'No workspace open' }
            }
            const safeOld = validatePath(currentWorkspacePath, options.oldPath)
            const safeNew = validatePath(currentWorkspacePath, options.newPath)
            // Never replace something else; a case-only rename points at the same file.
            if (fs.existsSync(safeNew) && fs.realpathSync(safeNew) !== fs.realpathSync(safeOld)) {
                return { success: false, error: `${path.basename(safeNew)} already exists there` }
            }
            await fs.promises.mkdir(path.dirname(safeNew), { recursive: true })
            await fs.promises.rename(safeOld, safeNew)
            return { success: true }
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    // Watch directory for changes
    ipcMain.handle('fs:watchDir', async (_event, options: { id: string, dirPath: string }) => {
        try {
            const currentWorkspacePath = getCurrentWorkspacePath()
            const mainWindow = getMainWindow()
            if (!currentWorkspacePath) {
                return { success: false, error: 'No workspace open' }
            }
            const safePath = validatePath(currentWorkspacePath, options.dirPath)

            // Close existing
            const existingWatcher = watchers.get(options.id)
            if (existingWatcher) {
                await existingWatcher.close()
                watchers.delete(options.id)
            }
            if (nativeWatchers.has(options.id)) {
                if (nativeHelperService.isAvailable()) {
                    await nativeHelperService.request('watch-stop', { watcherId: options.id })
                }
                nativeWatchers.delete(options.id)
            }

            // Prefer Native FSEvents on macOS
            if (process.platform === 'darwin' && nativeHelperService.isAvailable()) {
                try {
                    await nativeHelperService.request('watch-start', { 
                        path: safePath,
                        watcherId: options.id 
                    })
                    nativeWatchers.add(options.id)
                    console.log(`[FS] Using native FSEvents for ${options.id}`)
                    return { success: true, native: true }
                } catch (e) {
                    console.warn('[FS] Native watch failed, falling back to Chokidar:', e)
                }
            }

            // Fallback to Chokidar
            const watcher = chokidar.watch(safePath, {
                // Tested relative to the root so a workspace inside a hidden folder still works.
                ignored: (candidate: string) => {
                    const relative = path.relative(safePath, candidate)
                    return relative !== '' && !relative.startsWith('..') && WATCH_IGNORED.test(relative)
                },
                persistent: true,
                ignoreInitial: true
            })
            watcher.on('error', err => console.warn(`[FS] Watcher ${options.id} error:`, err))
            watcher.on('all', (event, filePath) => {
                if (!mainWindow || mainWindow.isDestroyed()) return
                mainWindow.webContents.send('fs:change', {
                    id: options.id,
                    event,
                    path: filePath
                })
            })
            watchers.set(options.id, watcher)
            return { success: true, native: false }
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    // Unwatch directory
    ipcMain.handle('fs:unwatchDir', async (_event, id: string) => {
        const watcher = watchers.get(id)
        if (watcher) {
            await watcher.close()
            watchers.delete(id)
        }

        if (nativeWatchers.has(id)) {
            if (nativeHelperService.isAvailable()) {
                await nativeHelperService.request('watch-stop', { watcherId: id }).catch((error) => {
                    console.warn(`[FS] Failed to stop native watcher ${id}:`, error)
                })
            }
            nativeWatchers.delete(id)
        }
        return { success: true }
    })

    // NEW: Search files (cross-platform grep-like functionality)
    ipcMain.handle('fs:search', async (_event, options: { 
        searchPath: string
        pattern: string
        filePattern?: string
        maxResults?: number
    }) => {
        try {
            const currentWorkspacePath = getCurrentWorkspacePath()
            if (!currentWorkspacePath) {
                return { success: false, error: 'No workspace open' }
            }
            
            const safePath = validatePath(currentWorkspacePath, options.searchPath || currentWorkspacePath)
            return await searchFolder(safePath, options.pattern, options.filePattern, options.maxResults || 100)
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    // NEW: Backup workspace
    ipcMain.handle('fs:backup', async () => {
        try {
            const currentWorkspace = getCurrentWorkspacePath()
            const mainWindow = getMainWindow()
            if (!currentWorkspace || !mainWindow) return { success: false, error: 'No workspace or window' }

            const { canceled, filePath: destPath } = await dialog.showSaveDialog(mainWindow, {
                title: 'Back up workspace',
                defaultPath: `${path.basename(currentWorkspace)}-backup-${new Date().toISOString().slice(0, 10)}`,
                buttonLabel: 'Back up'
            })

            if (canceled || !destPath) return { success: false, canceled: true }

            const resolvedDest = path.resolve(destPath)
            if (resolvedDest === path.resolve(currentWorkspace) || resolvedDest.startsWith(path.resolve(currentWorkspace) + path.sep)) {
                return { success: false, error: 'Choose a location outside the workspace folder' }
            }
            if (fs.existsSync(resolvedDest) && (await fs.promises.readdir(resolvedDest)).length > 0) {
                return { success: false, error: 'Choose a new or empty folder for the backup' }
            }
            await copyFolder(currentWorkspace, resolvedDest)
            return { success: true, path: destPath }
        } catch (error) {
            console.error('[Main] Backup failed:', error)
            return { success: false, error: String(error) }
        }
    })
}

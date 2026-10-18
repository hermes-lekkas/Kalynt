/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { RuntimeManager } from '../services/runtime-manager'
import { clearBinaryCache } from './code-exec/binaries'

export function registerRuntimeHandlers(ipcMain: Electron.IpcMain, runtimeManager: RuntimeManager) {
    ipcMain.handle('runtime:installable', async () => ({ success: true, runtimes: runtimeManager.installable() }))

    ipcMain.handle('runtime:check', async (_event, runtimeId: string) => {
        try {
            const result = await runtimeManager.checkInstallation(runtimeId)
            return { success: true, ...result }
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    ipcMain.handle('runtime:download', async (event, runtimeId: string) => {
        try {
            const result = await runtimeManager.downloadRuntime(runtimeId, (progress) => {
                if (!event.sender.isDestroyed()) {
                    event.sender.send('runtime:download-progress', {
                        runtimeId,
                        ...progress
                    })
                }
            })
            return result
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    ipcMain.handle('runtime:install', async (_event, options: { runtimeId: string; archivePath: string }) => {
        try {
            const result = await runtimeManager.installRuntime(options.runtimeId, options.archivePath)
            return result
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    ipcMain.handle('runtime:uninstall', async (_event, runtimeId: string) => {
        try {
            const result = await runtimeManager.uninstallRuntime(runtimeId)
            clearBinaryCache()
            return result
        } catch (error) {
            return { success: false, error: String(error) }
        }
    })

    ipcMain.handle('runtime:downloadAndInstall', async (event, runtimeId: string) => {
        try {
            // Helper to send log messages
            const sendLog = (message: string) => {
                if (!event.sender.isDestroyed()) {
                    !event.sender.isDestroyed() && event.sender.send('runtime:log', { runtimeId, message })
                }
            }

            // Download
            sendLog(`[${runtimeId}] Starting download...`)
            !event.sender.isDestroyed() && event.sender.send('runtime:status', { runtimeId, status: 'downloading' })

            const downloadResult = await runtimeManager.downloadRuntime(runtimeId, (progress) => {
                if (!event.sender.isDestroyed()) {
                    event.sender.send('runtime:download-progress', {
                        runtimeId,
                        ...progress
                    })
                }
            }, sendLog)

            if (!downloadResult.success || !downloadResult.path) {
                sendLog(`[${runtimeId}] Download failed: ${downloadResult.error}`)
                !event.sender.isDestroyed() && event.sender.send('runtime:status', { runtimeId, status: 'failed', error: downloadResult.error })
                return downloadResult
            }

            sendLog(`[${runtimeId}] Download complete: ${downloadResult.path}`)

            // Install
            sendLog(`[${runtimeId}] Starting installation...`)
            !event.sender.isDestroyed() && event.sender.send('runtime:status', { runtimeId, status: 'installing' })

            const installResult = await runtimeManager.installRuntime(runtimeId, downloadResult.path, sendLog)

            if (installResult.success) {
                clearBinaryCache()
                sendLog(`[${runtimeId}] Installation complete!`)
                sendLog(`[${runtimeId}] Installed to: ${installResult.installPath}`)
                !event.sender.isDestroyed() && event.sender.send('runtime:status', { runtimeId, status: 'completed' })
            } else {
                sendLog(`[${runtimeId}] Installation failed: ${installResult.error}`)
                !event.sender.isDestroyed() && event.sender.send('runtime:status', { runtimeId, status: 'failed', error: installResult.error })
            }

            return installResult
        } catch (error) {
            const errorMsg = String(error)
            !event.sender.isDestroyed() && event.sender.send('runtime:log', { runtimeId, message: `[${runtimeId}] Error: ${errorMsg}` })
            !event.sender.isDestroyed() && event.sender.send('runtime:status', { runtimeId, status: 'failed', error: errorMsg })
            return { success: false, error: errorMsg }
        }
    })
}

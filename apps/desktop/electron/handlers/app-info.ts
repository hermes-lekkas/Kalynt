/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import path from 'node:path'
import { detectHardwareInfo, getRealTimeStats } from '../services/hardware-service'

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])
const ALLOWED_APP_PATHS = new Set(['temp', 'userData', 'logs', 'downloads', 'documents'] as const)

type AllowedAppPath = 'temp' | 'userData' | 'logs' | 'downloads' | 'documents'

function isAllowedExternalUrl(raw: unknown): string | null {
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    if (!trimmed) return null
    try {
        const parsed = new URL(trimmed)
        if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return null
        if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.hostname) return null
        return parsed.toString()
    } catch {
        return null
    }
}

export function registerAppInfoHandlers(ipcMain: Electron.IpcMain, app: Electron.App, modelsDir: string) {
    ipcMain.handle('get-app-path', () => app.getPath('userData'))

    ipcMain.handle('get-version', () => app.getVersion())

    ipcMain.handle('get-models-directory', () => modelsDir)

    ipcMain.handle('shell:openExternal', async (_event, url: string) => {
        const safeUrl = isAllowedExternalUrl(url)
        if (!safeUrl) {
            console.warn('[AppInfo] Blocked shell:openExternal for disallowed URL:', String(url).slice(0, 120))
            return { success: false, error: 'Only https, http, and mailto links can be opened externally.' }
        }
        const electron = await import('electron')
        await electron.shell.openExternal(safeUrl)
        return { success: true }
    })

    ipcMain.handle('shell:showItemInFolder', async (_event, itemPath: string) => {
        if (typeof itemPath !== 'string' || !itemPath.trim() || !path.isAbsolute(itemPath) || itemPath.includes('\0')) {
            return { success: false, error: 'An absolute path is required.' }
        }
        const electron = await import('electron')
        electron.shell.showItemInFolder(path.resolve(itemPath))
        return { success: true }
    })

    ipcMain.handle('get-hardware-info', async () => {
        return await detectHardwareInfo()
    })

    ipcMain.handle('get-realtime-stats', () => {
        return getRealTimeStats()
    })

    ipcMain.handle('app:getPath', (_event, name: string) => {
        if (typeof name !== 'string' || !ALLOWED_APP_PATHS.has(name as AllowedAppPath)) {
            throw new Error(`Disallowed app path: ${String(name)}`)
        }
        return app.getPath(name as AllowedAppPath)
    })
}

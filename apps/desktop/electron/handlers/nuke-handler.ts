/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { ipcMain } from 'electron'
import { stopEverything } from '../services/shutdown'

/**
 * "Stop all processes" in Settings. Only processes Kalynt started are stopped;
 * other programs on the machine are never touched.
 */
export function registerNukeHandlers() {
    ipcMain.handle('nuke-processes', async (_event, level: 'soft' | 'hard' | 'factory') => {
        if (level === 'soft') return { success: true, message: 'Nothing to stop.' }
        try {
            const report = await stopEverything()
            const total = Object.values(report).reduce((sum, n) => sum + n, 0)
            console.log('[Stop all]', report)
            return { success: true, report, message: total ? `Stopped ${total} process${total === 1 ? '' : 'es'}.` : 'Nothing was running.' }
        } catch (error) {
            console.error('[Stop all] Failed:', error)
            return { success: false, message: error instanceof Error ? error.message : String(error) }
        }
    })
}

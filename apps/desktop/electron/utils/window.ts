/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { BrowserWindow } from 'electron'

/**
 * Sends to the renderer if the window is still alive. Processes keep writing
 * while the window closes, and sending to a destroyed window throws in the
 * main process.
 */
export function sendToWindow(win: BrowserWindow | null | undefined, channel: string, payload: unknown): void {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    try {
        win.webContents.send(channel, payload)
    } catch {
        // The window went away between the check and the send.
    }
}

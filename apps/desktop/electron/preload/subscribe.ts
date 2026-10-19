/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Event subscription helper for the preload bridge.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'

/** Subscribes to a main-process event and returns a function that unsubscribes. */
export function subscribe(channel: string, callback: (data: any) => void): () => void {
    const listener = (_event: IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => {
        ipcRenderer.removeListener(channel, listener)
    }
}

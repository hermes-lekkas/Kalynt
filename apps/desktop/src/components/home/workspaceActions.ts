/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Workspace creation flows shared by the home screen and the command palette.
 */
import { useAppStore, type Space } from '../../stores/appStore'
import { useWorkspaceFolderStore, folderName } from '../../stores/workspaceFolderStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useNotificationStore } from '../../stores/notificationStore'

function notify(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
    useNotificationStore.getState().addNotification(message, type)
}

function enter(space: Space) {
    useLayoutStore.getState().setMainView('code')
    useWorkspaceFolderStore.getState().touch(space.id)
    useAppStore.getState().setCurrentSpace(space)
}

/** Creates a workspace, optionally bound to a folder, and opens it. */
export function createWorkspace(name: string, folder: string | null): Space {
    const space = useAppStore.getState().createSpace(name.trim())
    if (folder) useWorkspaceFolderStore.getState().setFolder(space.id, folder)
    enter(space)
    notify(`Created ${space.name}`, 'success')
    return space
}

export function openWorkspace(space: Space) {
    enter(space)
}

/** Asks the user for a folder. Returns the chosen path, or null if cancelled. */
export async function pickFolder(): Promise<string | null> {
    const result = await window.electronAPI?.fs?.openFolder?.()
    if (result?.success && result.path) return result.path as string
    if (result && !result.canceled && result.error) notify(`Couldn't open the folder: ${result.error}`, 'error')
    return null
}

/**
 * Opens a folder as a workspace: reuses the workspace already bound to that
 * folder, otherwise creates one named after it.
 */
export async function openFolderAsWorkspace(): Promise<void> {
    const folder = await pickFolder()
    if (!folder) return
    const { records } = useWorkspaceFolderStore.getState()
    const { spaces } = useAppStore.getState()
    const existing = spaces.find(s => records[s.id]?.folder === folder)
    if (existing) {
        enter(existing)
        return
    }
    createWorkspace(folderName(folder) || 'Untitled', folder)
}

/** Clones a repository into Kalynt's workspaces directory and opens it. */
export async function cloneIntoWorkspace(url: string, name: string): Promise<{ ok: boolean; error?: string }> {
    const api = window.electronAPI
    if (!api?.ipcRenderer) return { ok: false, error: 'Cloning needs the desktop app.' }
    try {
        const appPath = await api.getAppPath()
        const safeName = name.trim().replace(/[\\/:*?"<>|]/g, '-')
        const targetPath = `${appPath}/workspaces/${safeName}`
        const result = await api.ipcRenderer.invoke('git:clone', { url: url.trim(), targetPath })
        if (!result?.success) return { ok: false, error: result?.error || 'The clone did not finish.' }
        await api.fs?.setWorkspace?.(targetPath)
        createWorkspace(name, targetPath)
        return { ok: true }
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
}

export function relativeTime(timestamp: number): string {
    if (!timestamp) return 'Never opened'
    const diff = Date.now() - timestamp
    const minutes = Math.round(diff / 60000)
    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes} min ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours} h ago`
    const days = Math.round(hours / 24)
    if (days === 1) return 'Yesterday'
    if (days < 30) return `${days} days ago`
    return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

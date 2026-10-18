/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * File operations behind the explorer: ask for a name, validate it, call the
 * main process, and report the outcome.
 */
import { useNotificationStore } from '../../../stores/notificationStore'
import { confirmAction, promptText } from '../../ui'
import { baseName, dirName } from '../languages'

const notify = (message: string, type: 'success' | 'error' | 'info' = 'info') =>
    useNotificationStore.getState().addNotification(message, type)

export function validateName(name: string): string | null {
    if (!name.trim()) return 'Enter a name.'
    if (/[\\/:*?"<>|]/.test(name)) return 'Names can’t contain \\ / : * ? " < > or |.'
    if (name === '.' || name === '..' || name.includes('..')) return 'Names can’t contain "..".'
    if (name.length > 255) return 'That name is too long.'
    return null
}

const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}/${name}`

export async function createEntry(dir: string, kind: 'file' | 'folder'): Promise<string | null> {
    const name = await promptText({
        title: kind === 'file' ? 'New file' : 'New folder',
        label: 'Name',
        placeholder: kind === 'file' ? 'e.g. index.ts' : 'e.g. components',
        confirmLabel: 'Create',
        message: `In ${baseName(dir) || dir}`,
        validate: validateName,
        mono: true
    })
    if (!name) return null
    const path = join(dir, name)
    const api = window.electronAPI?.fs
    const result = kind === 'file' ? await api?.createFile(path) : await api?.createDir(path)
    if (!result?.success) {
        notify(`Couldn't create ${name}: ${result?.error || 'unknown error'}`, 'error')
        return null
    }
    return path
}

export async function renameEntry(path: string): Promise<{ from: string; to: string } | null> {
    const current = baseName(path)
    const name = await promptText({
        title: `Rename ${current}`,
        label: 'New name',
        initialValue: current,
        confirmLabel: 'Rename',
        validate: value => (value === current ? 'Choose a different name.' : validateName(value)),
        mono: true
    })
    if (!name) return null
    const to = join(dirName(path), name)
    const result = await window.electronAPI?.fs?.rename({ oldPath: path, newPath: to })
    if (!result?.success) {
        notify(`Couldn't rename ${current}: ${result?.error || 'unknown error'}`, 'error')
        return null
    }
    return { from: path, to }
}

export async function deleteEntry(path: string, isDirectory: boolean): Promise<boolean> {
    const name = baseName(path)
    const ok = await confirmAction({
        title: `Delete ${name}?`,
        message: isDirectory
            ? 'The folder and everything in it will be deleted from disk.'
            : 'The file will be deleted from disk.',
        confirmLabel: 'Delete',
        danger: true
    })
    if (!ok) return false
    const result = await window.electronAPI?.fs?.delete(path)
    if (!result?.success) {
        notify(`Couldn't delete ${name}: ${result?.error || 'unknown error'}`, 'error')
        return false
    }
    notify(`Deleted ${name}`)
    return true
}

export async function moveEntry(source: string, targetDir: string): Promise<{ from: string; to: string } | null> {
    const src = source.replace(/\\/g, '/')
    const dest = targetDir.replace(/\\/g, '/')
    const name = baseName(src)
    if (src === dest || dirName(src) === dest) return null
    if (dest.startsWith(src + '/')) {
        notify('A folder can’t be moved into itself.', 'error')
        return null
    }
    const ok = await confirmAction({
        title: `Move ${name}?`,
        message: `Move it into ${baseName(dest) || dest}.`,
        confirmLabel: 'Move'
    })
    if (!ok) return null
    const to = join(dest, name)
    const result = await window.electronAPI?.fs?.rename({ oldPath: source, newPath: to })
    if (!result?.success) {
        notify(`Couldn't move ${name}: ${result?.error || 'unknown error'}`, 'error')
        return null
    }
    return { from: source, to }
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * File operations behind the explorer: validate names & nested paths, call the
 * main process (both inline and modal workflows), copy/duplicate/move, and
 * report the outcome.
 */
import type { FileSystemItem } from '../../../vite-env'
import { useNotificationStore } from '../../../stores/notificationStore'
import { confirmAction, promptText } from '../../ui'
import { baseName, dirName } from '../languages'
import { isBinaryFile } from '../search/searchUtils'

const notify = (message: string, type: 'success' | 'error' | 'info' = 'info') =>
    useNotificationStore.getState().addNotification(message, type)

export function validateName(name: string): string | null {
    const trimmed = name.trim()
    if (!trimmed) return 'Enter a name.'
    if (/[\\/:*?"<>|]/.test(trimmed)) return 'Names can’t contain \\ / : * ? " < > or |.'
    if (trimmed === '.' || trimmed === '..' || trimmed.includes('..')) return 'Names can’t contain "..".'
    if (trimmed.length > 255) return 'That name is too long.'
    return null
}

/** Validates a single name or nested relative path such as `src/components/Button.tsx`. */
export function validateRelativePath(input: string): string | null {
    const normalized = input.trim().replace(/\\/g, '/')
    if (!normalized) return 'Enter a name.'
    if (normalized.startsWith('/') || normalized.endsWith('/')) return 'Path can’t start or end with /.'
    const segments = normalized.split('/')
    for (const seg of segments) {
        if (!seg) return 'Path can’t contain empty segments (//).'
        const err = validateName(seg)
        if (err) return err
    }
    return null
}

const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}/${name.replace(/\\/g, '/').replace(/^\/+/, '')}`

function bytesToBase64(bytes: Uint8Array): string {
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
}

async function pathExists(target: string): Promise<boolean> {
    const stat = await window.electronAPI?.fs?.stat?.(target)
    if (stat?.success) return true
    const exists = await window.electronAPI?.fileExists?.(target)
    return !!exists
}

async function uniqueCopyPath(destDir: string, originalName: string, isDirectory: boolean): Promise<string> {
    const candidate = join(destDir, originalName)
    if (!(await pathExists(candidate))) return candidate

    const dot = !isDirectory ? originalName.lastIndexOf('.') : -1
    const stem = dot > 0 ? originalName.slice(0, dot) : originalName
    const ext = dot > 0 ? originalName.slice(dot) : ''

    for (let i = 1; i <= 100; i++) {
        const suffix = i === 1 ? ' copy' : ` copy ${i}`
        const next = join(destDir, `${stem}${suffix}${ext}`)
        if (!(await pathExists(next))) return next
    }
    return join(destDir, `${stem}-${Date.now()}${ext}`)
}

/** Creates a file or folder directly (supporting nested paths like `src/a/b.ts`). */
export async function createEntryDirect(dir: string, rawName: string, kind: 'file' | 'folder'): Promise<string | null> {
    const err = validateRelativePath(rawName)
    if (err) {
        notify(err, 'error')
        return null
    }
    const clean = rawName.trim().replace(/\\/g, '/')
    const path = join(dir, clean)
    const api = window.electronAPI?.fs
    const result = kind === 'file' ? await api?.createFile(path) : await api?.createDir(path)
    if (!result?.success) {
        notify(`Couldn't create ${clean}: ${result?.error || 'unknown error'}`, 'error')
        return null
    }
    return path
}

/** Modal prompt variant kept for shortcuts like `Ctrl+N` from IDEWorkspace. */
export async function createEntry(dir: string, kind: 'file' | 'folder'): Promise<string | null> {
    const name = await promptText({
        title: kind === 'file' ? 'New file' : 'New folder',
        label: 'Name or path',
        placeholder: kind === 'file' ? 'e.g. index.ts or src/utils/format.ts' : 'e.g. components',
        confirmLabel: 'Create',
        message: `In ${baseName(dir) || dir}`,
        validate: validateRelativePath,
        mono: true
    })
    if (!name) return null
    return createEntryDirect(dir, name, kind)
}

/** Renames an entry directly without a modal prompt. */
export async function renameEntryDirect(path: string, rawName: string): Promise<{ from: string; to: string } | null> {
    const current = baseName(path)
    const name = rawName.trim()
    if (!name || name === current) return null
    const err = validateName(name)
    if (err) {
        notify(err, 'error')
        return null
    }
    const to = join(dirName(path), name)
    const result = await window.electronAPI?.fs?.rename({ oldPath: path, newPath: to })
    if (!result?.success) {
        notify(`Couldn't rename ${current}: ${result?.error || 'unknown error'}`, 'error')
        return null
    }
    return { from: path, to }
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
    return renameEntryDirect(path, name)
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

export async function moveEntryDirect(source: string, targetDir: string, confirm = false): Promise<{ from: string; to: string } | null> {
    const src = source.replace(/\\/g, '/')
    const dest = targetDir.replace(/\\/g, '/')
    const name = baseName(src)
    if (src === dest || dirName(src) === dest) return null
    if (dest.startsWith(src + '/')) {
        notify('A folder can’t be moved into itself.', 'error')
        return null
    }
    if (confirm) {
        const ok = await confirmAction({
            title: `Move ${name}?`,
            message: `Move it into ${baseName(dest) || dest}.`,
            confirmLabel: 'Move'
        })
        if (!ok) return null
    }
    const to = join(dest, name)
    const result = await window.electronAPI?.fs?.rename({ oldPath: source, newPath: to })
    if (!result?.success) {
        notify(`Couldn't move ${name}: ${result?.error || 'unknown error'}`, 'error')
        return null
    }
    return { from: source, to }
}

export async function moveEntry(source: string, targetDir: string): Promise<{ from: string; to: string } | null> {
    return moveEntryDirect(source, targetDir, true)
}

async function copyFileContent(src: string, dest: string): Promise<boolean> {
    const api = window.electronAPI?.fs
    if (isBinaryFile(baseName(src)) && typeof api?.readBinaryFile === 'function') {
        const bin = await api.readBinaryFile(src)
        if (!bin?.success || !bin.content) return false
        const bytes = bin.content instanceof Uint8Array ? bin.content : new Uint8Array(bin.content)
        const write = await api.writeFile({ path: dest, content: bytesToBase64(bytes), encoding: 'base64' })
        return !!write?.success
    }
    const res = await api?.readFile(src)
    if (!res?.success || typeof res.content !== 'string') return false
    const write = await api?.writeFile({ path: dest, content: res.content })
    return !!write?.success
}

async function copyDirectoryRecursive(src: string, dest: string): Promise<boolean> {
    const api = window.electronAPI?.fs
    const created = await api?.createDir(dest)
    if (!created?.success) return false
    const listing = await api?.readDir(src)
    if (!listing?.success || !Array.isArray(listing.items)) return true
    for (const entry of listing.items as FileSystemItem[]) {
        const childSrc = entry.path || join(src, entry.name)
        const childDest = join(dest, entry.name)
        if (entry.isDirectory) {
            if (!(await copyDirectoryRecursive(childSrc, childDest))) return false
        } else {
            if (!(await copyFileContent(childSrc, childDest))) return false
        }
    }
    return true
}

/** Copies a file or directory into `targetDir`, generating a unique copy name on collision. */
export async function copyEntry(source: string, targetDir: string, isDirectory: boolean): Promise<string | null> {
    const src = source.replace(/\\/g, '/')
    const destDir = targetDir.replace(/\\/g, '/')
    const name = baseName(src)
    if (isDirectory && (destDir === src || destDir.startsWith(src + '/'))) {
        notify('A folder can’t be copied into itself.', 'error')
        return null
    }
    const dest = await uniqueCopyPath(destDir, name, isDirectory)
    const ok = isDirectory ? await copyDirectoryRecursive(source, dest) : await copyFileContent(source, dest)
    if (!ok) {
        notify(`Couldn't copy ${name}.`, 'error')
        return null
    }
    return dest
}

export async function duplicateEntry(source: string, isDirectory: boolean): Promise<string | null> {
    return copyEntry(source, dirName(source), isDirectory)
}

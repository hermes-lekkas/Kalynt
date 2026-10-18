/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Open editor tabs: reading, editing, saving and closing files, plus the
 * window events other regions use to open files or propose edits.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OpenFile } from '../../../types/ide'
import { validatePath } from '../../../utils/path-validator'
import { logger } from '../../../utils/logger'
import { useNotificationStore } from '../../../stores/notificationStore'
import { useWorkspaceFolderStore } from '../../../stores/workspaceFolderStore'
import { chooseAction } from '../../ui'
import { baseName, languageFromFileName, samePath } from '../languages'
import { useFolderChanges } from './folderWatcher'

export interface RevealRequest {
    path: string
    line: number
    /** Changes on every request so the same line can be revealed twice. */
    nonce: number
}

interface Options {
    spaceId: string
    folder: string | null
    /** Called when an "open" request turns out to be a directory. */
    onRevealDirectory: (path: string) => void
    /** Releases the editor model for a closed file. */
    onDisposeModel: (path: string) => void
}

const api = () => window.electronAPI

export function useOpenFiles({ spaceId, folder, onRevealDirectory, onDisposeModel }: Options) {
    const [files, setFiles] = useState<OpenFile[]>([])
    const [activePath, setActivePath] = useState<string | null>(null)
    const [reveal, setReveal] = useState<RevealRequest | null>(null)
    const addNotification = useNotificationStore(s => s.addNotification)
    const setOpenFilesRecord = useWorkspaceFolderStore(s => s.setOpenFiles)

    // Latest state for async handlers and window events.
    const filesRef = useRef(files)
    filesRef.current = files
    const activeRef = useRef(activePath)
    activeRef.current = activePath

    const validate = useCallback((path: string): string | null => {
        const result = validatePath(path, folder)
        if (!result.valid) {
            addNotification(result.error || 'That path is outside this workspace.', 'error')
            logger.ide.warn('Path validation failed', { path, error: result.error })
            return null
        }
        return result.normalizedPath!
    }, [folder, addNotification])

    const openFile = useCallback(async (path: string, line?: number) => {
        const target = validate(path)
        if (!target) return
        if (line) setReveal({ path: target, line, nonce: Date.now() })

        if (filesRef.current.some(f => samePath(f.path, target))) {
            setActivePath(filesRef.current.find(f => samePath(f.path, target))!.path)
            return
        }

        const result = await api()?.fs?.readFile(target)
        if (!result?.success) {
            const dir = await api()?.fs?.readDir(target)
            if (dir?.success) {
                onRevealDirectory(target)
                return
            }
            addNotification(`Couldn't open ${baseName(target)}: ${result?.error || 'the file could not be read'}`, 'error')
            return
        }

        const name = baseName(target)
        setFiles(prev => prev.some(f => samePath(f.path, target))
            ? prev
            : [...prev, { path: target, name, content: result.content ?? '', language: languageFromFileName(name), isDirty: false }])
        setActivePath(target)
    }, [validate, onRevealDirectory, addNotification])

    const updateContent = useCallback((path: string, content: string) => {
        setFiles(prev => prev.map(f => (f.path === path && f.content !== content ? { ...f, content, isDirty: true } : f)))
    }, [])

    const writeFile = useCallback(async (file: OpenFile): Promise<boolean> => {
        const result = await api()?.fs?.writeFile({ path: file.path, content: file.content })
        if (!result?.success) {
            addNotification(`Couldn't save ${file.name}: ${result?.error || 'unknown error'}`, 'error')
            return false
        }
        setFiles(prev => prev.map(f => (f.path === file.path ? { ...f, isDirty: false } : f)))
        return true
    }, [addNotification])

    const forceClose = useCallback((path: string) => {
        const remaining = filesRef.current.filter(f => f.path !== path)
        setFiles(remaining)
        if (activeRef.current === path) {
            const index = filesRef.current.findIndex(f => f.path === path)
            const next = remaining[Math.min(index, remaining.length - 1)]
            setActivePath(next?.path ?? null)
        }
        onDisposeModel(path)
    }, [onDisposeModel])

    const saveFile = useCallback(async (path?: string | null): Promise<boolean> => {
        const target = path ?? activeRef.current
        const file = filesRef.current.find(f => f.path === target)
        if (!file) return false
        if (!validate(file.path)) return false

        const exists = await api()?.fileExists?.(file.path)
        if (exists === false && api()?.platform !== 'browser') {
            const choice = await chooseAction({
                title: `${file.name} was deleted`,
                message: 'The file no longer exists on disk. Save to create it again, or close the tab.',
                choices: [
                    { id: 'close', label: 'Close tab', variant: 'ghost' },
                    { id: 'save', label: 'Save again', variant: 'primary' }
                ]
            })
            if (choice === 'close') forceClose(file.path)
            if (choice !== 'save') return false
        }
        return writeFile(file)
    }, [validate, writeFile, forceClose])

    const saveAll = useCallback(async () => {
        for (const file of filesRef.current.filter(f => f.isDirty)) await writeFile(file)
    }, [writeFile])

    const closeFile = useCallback(async (path: string) => {
        const file = filesRef.current.find(f => f.path === path)
        if (!file) return
        if (file.isDirty) {
            const choice = await chooseAction({
                title: `Save changes to ${file.name}?`,
                message: 'Your changes will be lost if you close without saving.',
                choices: [
                    { id: 'discard', label: 'Don’t save', variant: 'ghost' },
                    { id: 'cancel', label: 'Cancel' },
                    { id: 'save', label: 'Save', variant: 'primary' }
                ]
            })
            if (choice === 'save') {
                if (!(await writeFile(file))) return
            } else if (choice !== 'discard') {
                return
            }
        }
        forceClose(path)
    }, [writeFile, forceClose])

    /** Closes every tab except `keep`; asks once when any of them has unsaved changes. */
    const closeMany = useCallback(async (keep?: string): Promise<boolean> => {
        const closing = filesRef.current.filter(f => f.path !== keep)
        const dirty = closing.filter(f => f.isDirty)
        if (dirty.length > 0) {
            const choice = await chooseAction({
                title: dirty.length === 1 ? `Save changes to ${dirty[0].name}?` : `Save changes to ${dirty.length} files?`,
                message: 'Unsaved changes will be lost if you close without saving.',
                choices: [
                    { id: 'discard', label: 'Don’t save', variant: 'ghost' },
                    { id: 'cancel', label: 'Cancel' },
                    { id: 'save', label: dirty.length === 1 ? 'Save' : 'Save all', variant: 'primary' }
                ]
            })
            if (choice === 'save') {
                for (const file of dirty) if (!(await writeFile(file))) return false
            } else if (choice !== 'discard') {
                return false
            }
        }
        closing.forEach(f => onDisposeModel(f.path))
        setFiles(prev => prev.filter(f => f.path === keep))
        setActivePath(keep ?? null)
        return true
    }, [writeFile, onDisposeModel])

    const renamePath = useCallback((oldPath: string, newPath: string) => {
        const oldNorm = oldPath.replace(/\\/g, '/')
        setFiles(prev => prev.map(f => {
            const p = f.path.replace(/\\/g, '/')
            if (p !== oldNorm && !p.startsWith(oldNorm + '/')) return f
            onDisposeModel(f.path)
            const path = newPath.replace(/\\/g, '/') + p.slice(oldNorm.length)
            const name = baseName(path)
            return { ...f, path, name, language: languageFromFileName(name) }
        }))
        setActivePath(prev => {
            if (!prev) return prev
            const p = prev.replace(/\\/g, '/')
            return p === oldNorm || p.startsWith(oldNorm + '/') ? newPath.replace(/\\/g, '/') + p.slice(oldNorm.length) : prev
        })
    }, [onDisposeModel])

    /** A file or folder vanished from disk: drop clean tabs, keep unsaved ones. */
    const handleDeleted = useCallback((deletedPath: string) => {
        const gone = deletedPath.replace(/\\/g, '/')
        const affected = filesRef.current.filter(f => {
            const p = f.path.replace(/\\/g, '/')
            return (p === gone || p.startsWith(gone + '/')) && !f.isDirty
        })
        affected.forEach(f => forceClose(f.path))
    }, [forceClose])

    // Files changed on disk by the agent, git or another tool: reload clean tabs so they never show stale text.
    useFolderChanges(folder, async change => {
        if (change.event !== 'change') return
        const file = filesRef.current.find(f => samePath(f.path, change.path))
        if (!file || file.isDirty) return
        const result = await api()?.fs?.readFile(file.path)
        if (!result?.success || result.content == null) return
        setFiles(prev => prev.map(f => (f.path === file.path && !f.isDirty && f.content !== result.content ? { ...f, content: result.content } : f)))
    })

    const cycle = useCallback((delta: 1 | -1) => {
        const list = filesRef.current
        if (list.length < 2) return
        const index = list.findIndex(f => f.path === activeRef.current)
        setActivePath(list[(index + delta + list.length) % list.length].path)
    }, [])

    // A new folder starts with no tabs; tabs from a previous session are restored.
    const restoredFor = useRef<string | null>(null)
    useEffect(() => {
        setFiles([])
        setActivePath(null)
        if (!folder) return
        const key = `${spaceId}:${folder}`
        if (restoredFor.current === key) return
        restoredFor.current = key
        const record = useWorkspaceFolderStore.getState().records[spaceId]
        if (!record || record.folder !== folder) return
        const toRestore = record.openFiles.slice(0, 20)
        ;(async () => {
            for (const path of toRestore) await openFile(path)
            if (record.activeFile) setActivePath(prev => (filesRef.current.some(f => f.path === record.activeFile) ? record.activeFile : prev))
        })()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [spaceId, folder])

    // Remember which tabs were open for next time.
    useEffect(() => {
        if (!folder || restoredFor.current !== `${spaceId}:${folder}`) return
        setOpenFilesRecord(spaceId, files.map(f => f.path), activePath)
    }, [spaceId, folder, files, activePath, setOpenFilesRecord])

    // Other regions (agent tools, scan results, mentions) open files and propose fixes through window events.
    useEffect(() => {
        const onOpen = (e: Event) => {
            const detail = (e as CustomEvent<{ path: string; line?: number }>).detail
            if (detail?.path) openFile(detail.path, detail.line)
        }
        const onApplyFix = (e: Event) => {
            const detail = (e as CustomEvent<{ path: string; content: string; line?: number }>).detail
            if (!detail?.path || detail.content == null) return
            const target = validate(detail.path)
            if (!target) return
            if (detail.line) setReveal({ path: target, line: detail.line, nonce: Date.now() })
            const name = baseName(target)
            setFiles(prev => prev.some(f => samePath(f.path, target))
                ? prev.map(f => (samePath(f.path, target) ? { ...f, content: detail.content, isDirty: true } : f))
                : [...prev, { path: target, name, content: detail.content, language: languageFromFileName(name), isDirty: true }])
            setActivePath(target)
            addNotification(`Fix applied to ${name}. Review it, then save.`, 'info')
        }
        window.addEventListener('kalynt-open-file', onOpen)
        window.addEventListener('kalynt-apply-fix', onApplyFix)
        return () => {
            window.removeEventListener('kalynt-open-file', onOpen)
            window.removeEventListener('kalynt-apply-fix', onApplyFix)
        }
    }, [openFile, validate, addNotification])

    const activeFile = files.find(f => f.path === activePath) ?? null

    return {
        files, activeFile, activePath, setActivePath, reveal, clearReveal: () => setReveal(null),
        openFile, updateContent, saveFile, saveAll, closeFile, closeMany, forceClose,
        renamePath, handleDeleted, cycle
    }
}

export type OpenFilesApi = ReturnType<typeof useOpenFiles>

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Open editor tabs: reading, editing, saving and closing files, plus the
 * window events other regions use to open files or propose edits.
 */
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'
import type { OpenFile } from '../../../types/ide'
import { validatePath } from '../../../utils/path-validator'
import { logger } from '../../../utils/logger'
import { useLayoutStore } from '../../../stores/layoutStore'
import { useNotificationStore } from '../../../stores/notificationStore'
import { useWorkspaceFolderStore } from '../../../stores/workspaceFolderStore'
import { chooseAction } from '../../ui'
import { baseName, languageFromFileName, samePath } from '../languages'
import { useFolderChanges } from './folderWatcher'
import { captureEditorState, readEditorState, flushEditorStates, onRecoveryError } from '../../../services/editorRecovery'

export interface RevealRequest {
    path: string
    line: number
    column?: number
    /** Changes on every request so the same line can be revealed twice. */
    nonce: number
}

interface Options {
    spaceId: string
    folder: string | null
    /** Whether the current user can save or mutate files (defaults to true). */
    canEdit?: boolean
    /** Called when an "open" request turns out to be a directory. */
    onRevealDirectory: (path: string) => void
    /** Releases the editor model for a closed file. */
    onDisposeModel: (path: string) => void
    /** Optional hook invoked before saving when Format on Save is enabled. */
    onFormatBeforeSave?: (path: string) => Promise<void> | void
    /** Optional callback notified after a file or directory is renamed. */
    onRenamedPath?: (oldPath: string, newPath: string) => void
}

interface SaveOptions {
    skipFormat?: boolean
    skipDeletedPrompt?: boolean
}

const MAX_CLOSED_STACK = 25
const AUTO_SAVE_DELAY_MS = 1000

const api = () => window.electronAPI
const editorText = (text: string) => text.replace(/^\uFEFF/, '')

export function useOpenFiles({
    spaceId,
    folder,
    canEdit = true,
    onRevealDirectory,
    onDisposeModel,
    onFormatBeforeSave,
    onRenamedPath
}: Options) {
    const [files, setFilesState] = useState<OpenFile[]>([])
    const [activePath, setActiveState] = useState<string | null>(null)
    const [restoring, setRestoring] = useState(true)
    const [reveal, setReveal] = useState<RevealRequest | null>(null)
    const addNotification = useNotificationStore(s => s.addNotification)
    const setOpenFilesRecord = useWorkspaceFolderStore(s => s.setOpenFiles)
    const autoSave = useLayoutStore(s => s.autoSave)

    // Latest state for async handlers and window events.
    const filesRef = useRef(files)
    filesRef.current = files
    const activeRef = useRef(activePath)
    activeRef.current = activePath
    const canEditRef = useRef(canEdit)
    canEditRef.current = canEdit
    const autoSaveRef = useRef(autoSave)
    autoSaveRef.current = autoSave
    const onDisposeModelRef = useRef(onDisposeModel)
    onDisposeModelRef.current = onDisposeModel
    const onFormatBeforeSaveRef = useRef(onFormatBeforeSave)
    onFormatBeforeSaveRef.current = onFormatBeforeSave
    const onRenamedPathRef = useRef(onRenamedPath)
    onRenamedPathRef.current = onRenamedPath

    const generation = useRef(0)
    const scope = useRef({ spaceId, folder })
    const ready = useRef(false)
    const saveQueues = useRef(new Map<string, Promise<boolean>>())
    const autoSaveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
    const closedStackRef = useRef<string[]>([])
    const mruRef = useRef<string[]>([])
    const mruSessionRef = useRef<{ order: string[]; index: number } | null>(null)

    const pushClosed = useCallback((path: string) => {
        const stack = closedStackRef.current.filter(p => !samePath(p, path))
        stack.push(path)
        if (stack.length > MAX_CLOSED_STACK) stack.splice(0, stack.length - MAX_CLOSED_STACK)
        closedStackRef.current = stack
    }, [])

    const promoteMru = useCallback((path: string | null) => {
        if (!path) return
        mruRef.current = [path, ...mruRef.current.filter(p => p !== path)]
    }, [])

    const clearAutoSaveTimer = useCallback((path: string) => {
        const timer = autoSaveTimers.current.get(path)
        if (timer !== undefined) {
            clearTimeout(timer)
            autoSaveTimers.current.delete(path)
        }
    }, [])

    const clearAllAutoSaveTimers = useCallback(() => {
        autoSaveTimers.current.forEach(timer => clearTimeout(timer))
        autoSaveTimers.current.clear()
    }, [])

    // Async saves/opens and multiple closes in one tick must see the latest
    // buffer state, even before React commits the next render.
    const setFiles = useCallback((update: SetStateAction<OpenFile[]>) => {
        const next = typeof update === 'function' ? update(filesRef.current) : update
        filesRef.current = next
        setFilesState(next)
    }, [])

    const setActivePathInternal = useCallback((update: SetStateAction<string | null>, recordMru = true) => {
        const next = typeof update === 'function' ? update(activeRef.current) : update
        activeRef.current = next
        setActiveState(next)
        if (recordMru) {
            mruSessionRef.current = null
            promoteMru(next)
        }
    }, [promoteMru])

    const setActivePath = useCallback((update: SetStateAction<string | null>) => {
        setActivePathInternal(update, true)
    }, [setActivePathInternal])

    const validate = useCallback((path: string, silent = false): string | null => {
        const result = validatePath(path, folder)
        if (!result.valid) {
            if (!silent) addNotification(result.error || 'That path is outside this workspace.', 'error')
            logger.ide.warn('Path validation failed', { path, error: result.error })
            return null
        }
        return result.normalizedPath!
    }, [folder, addNotification])

    const openFileInternal = useCallback(async (
        path: string,
        line?: number,
        column?: number,
        opts?: { silentMissing?: boolean }
    ) => {
        const openedIn = generation.current
        const target = validate(path, opts?.silentMissing)
        if (!target) return
        if (line) setReveal({ path: target, line, column, nonce: Date.now() })

        const existing = filesRef.current.find(f => samePath(f.path, target))
        if (existing) {
            setActivePath(existing.path)
            return
        }

        const result = await api()?.fs?.readFile(target)
        if (openedIn !== generation.current) return
        if (!result?.success) {
            if (opts?.silentMissing) return
            const dir = await api()?.fs?.readDir(target)
            if (openedIn !== generation.current) return
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
            : [...prev, { path: target, name, content: editorText(result.content ?? ''), diskContent: result.content ?? '', language: languageFromFileName(name), isDirty: false }])
        setActivePath(target)
    }, [validate, onRevealDirectory, addNotification, setFiles, setActivePath])

    const openFile = useCallback((path: string, line?: number, column?: number) => {
        return openFileInternal(path, line, column)
    }, [openFileInternal])

    const writeFile = useCallback((file: OpenFile): Promise<boolean> => {
        const savedIn = generation.current
        const queued = saveQueues.current.get(file.path) ?? Promise.resolve(true)
        const operation = queued.catch(() => false).then(async () => {
            if (savedIn !== generation.current) return false
            const latest = filesRef.current.find(f => f.path === file.path)
            let result = await api()?.fs?.writeFile({ path: file.path, content: file.content, expectedContent: latest?.diskContent })
            if (savedIn !== generation.current) return false
            if (result?.conflict) {
                const choice = await chooseAction({
                    title: `${file.name} changed on disk`,
                    message: 'Another tool changed this file. Overwrite the disk version with your editor text, or reload the disk version and discard your editor changes.',
                    choices: [{ id: 'cancel', label: 'Cancel' }, { id: 'reload', label: 'Reload from disk' }, { id: 'overwrite', label: 'Overwrite', variant: 'primary' }]
                })
                if (savedIn !== generation.current) return false
                if (choice === 'reload') {
                    const disk = await api()?.fs?.readFile(file.path)
                    if (disk?.success && savedIn === generation.current) {
                        setFiles(prev => prev.map(f => f.path === file.path
                            ? { ...f, content: editorText(disk.content), diskContent: disk.content, isDirty: false }
                            : f))
                    }
                    return false
                }
                if (choice !== 'overwrite') return false
                result = await api()?.fs?.writeFile({ path: file.path, content: file.content })
            }
            if (savedIn !== generation.current) return false
            if (!result?.success) {
                addNotification(`Couldn't save ${file.name}: ${result?.error || 'unknown error'}`, 'error')
                return false
            }
            if (savedIn === generation.current) {
                setFiles(prev => prev.map(f => f.path === file.path ? {
                    ...f, diskContent: (result.bom ? '\uFEFF' : '') + editorText(file.content), isDirty: f.content !== file.content
                } : f))
            }
            return true
        }).catch(error => {
            addNotification(`Couldn't save ${file.name}: ${error instanceof Error ? error.message : String(error)}`, 'error')
            return false
        })
        saveQueues.current.set(file.path, operation)
        void operation.finally(() => { if (saveQueues.current.get(file.path) === operation) saveQueues.current.delete(file.path) })
        return operation
    }, [addNotification, setFiles])

    const forceClose = useCallback((path: string) => {
        clearAutoSaveTimer(path)
        const index = filesRef.current.findIndex(f => f.path === path)
        if (index !== -1) pushClosed(path)
        const remaining = filesRef.current.filter(f => f.path !== path)
        mruRef.current = mruRef.current.filter(p => p !== path)
        mruSessionRef.current = null
        setFiles(remaining)
        if (activeRef.current === path) {
            const next = remaining[Math.min(index, remaining.length - 1)]
            setActivePath(next?.path ?? null)
        }
        onDisposeModelRef.current(path)
    }, [clearAutoSaveTimer, pushClosed, setFiles, setActivePath])

    const saveFile = useCallback(async (path?: string | null, opts?: SaveOptions): Promise<boolean> => {
        const savedIn = generation.current
        const target = path ?? activeRef.current
        let file = filesRef.current.find(f => f.path === target)
        if (!file) return false
        if (!canEditRef.current) {
            if (!opts?.skipDeletedPrompt) addNotification('Your role in this workspace is read-only.', 'warning')
            return false
        }
        if (!validate(file.path)) return false
        clearAutoSaveTimer(file.path)

        const exists = await api()?.fileExists?.(file.path)
        if (savedIn !== generation.current) return false
        if (exists === false && api()?.platform !== 'browser') {
            if (opts?.skipDeletedPrompt) return false
            const choice = await chooseAction({
                title: `${file.name} was deleted`,
                message: 'The file no longer exists on disk. Save to create it again, or close the tab.',
                choices: [
                    { id: 'close', label: 'Close tab', variant: 'ghost' },
                    { id: 'save', label: 'Save again', variant: 'primary' }
                ]
            })
            if (savedIn !== generation.current) return false
            if (choice === 'close') forceClose(file.path)
            if (choice !== 'save') return false
        }

        if (!opts?.skipFormat && useLayoutStore.getState().formatOnSave && onFormatBeforeSaveRef.current) {
            try {
                await onFormatBeforeSaveRef.current(file.path)
            } catch {
                // Formatting is best-effort; never block saving.
            }
            if (savedIn !== generation.current) return false
            file = filesRef.current.find(f => f.path === target)
            if (!file) return false
        }

        return writeFile(file)
    }, [validate, writeFile, forceClose, clearAutoSaveTimer, addNotification])

    const saveFileRef = useRef(saveFile)
    saveFileRef.current = saveFile

    const updateContent = useCallback((path: string, content: string) => {
        let becameDirty = false
        setFiles(prev => prev.map(f => {
            if (f.path !== path || f.content === content) return f
            const isDirty = f.diskContent === undefined || content !== editorText(f.diskContent)
            becameDirty = isDirty
            return { ...f, content, isDirty }
        }))
        if (becameDirty && autoSaveRef.current === 'afterDelay' && canEditRef.current) {
            clearAutoSaveTimer(path)
            const scheduledIn = generation.current
            autoSaveTimers.current.set(path, setTimeout(() => {
                autoSaveTimers.current.delete(path)
                if (scheduledIn !== generation.current || autoSaveRef.current !== 'afterDelay' || !canEditRef.current) return
                const latest = filesRef.current.find(f => f.path === path)
                if (latest && latest.isDirty && latest.diskContent !== undefined) {
                    void saveFileRef.current(path, { skipFormat: true, skipDeletedPrompt: true })
                }
            }, AUTO_SAVE_DELAY_MS))
        }
    }, [setFiles, clearAutoSaveTimer])

    const saveAll = useCallback(async () => {
        const savedIn = generation.current
        if (!canEditRef.current) {
            addNotification('Your role in this workspace is read-only.', 'warning')
            return
        }
        for (const file of filesRef.current.filter(f => f.isDirty)) {
            if (savedIn !== generation.current) return
            await saveFile(file.path)
        }
    }, [saveFile, addNotification])

    const closeFile = useCallback(async (path: string) => {
        const closedIn = generation.current
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
            if (closedIn !== generation.current) return
            if (choice === 'save') {
                if (!(await saveFile(file.path))) return
                if (closedIn !== generation.current) return
                if (filesRef.current.find(f => f.path === path)?.isDirty) return
            } else if (choice !== 'discard') {
                return
            }
        }
        forceClose(path)
    }, [saveFile, forceClose])

    /** Prompts once for any dirty files in `candidates`. Returns true if caller may proceed. */
    const promptAndSaveDirty = useCallback(async (candidates: OpenFile[]): Promise<boolean> => {
        const startedIn = generation.current
        const dirty = candidates.filter(f => f.isDirty)
        if (dirty.length === 0) return true
        const choice = await chooseAction({
            title: dirty.length === 1 ? `Save changes to ${dirty[0].name}?` : `Save changes to ${dirty.length} files?`,
            message: 'Unsaved changes will be lost if you continue without saving.',
            choices: [
                { id: 'discard', label: 'Don’t save', variant: 'ghost' },
                { id: 'cancel', label: 'Cancel' },
                { id: 'save', label: dirty.length === 1 ? 'Save' : 'Save all', variant: 'primary' }
            ]
        })
        if (startedIn !== generation.current) return false
        if (choice === 'save') {
            for (const file of dirty) {
                if (startedIn !== generation.current || !(await saveFile(file.path))) return false
            }
            if (startedIn !== generation.current) return false
            const dirtyPaths = new Set(dirty.map(d => d.path))
            if (filesRef.current.some(f => dirtyPaths.has(f.path) && f.isDirty)) return false
            return true
        }
        return choice === 'discard'
    }, [saveFile])

    /** Closes every tab except `keep`; asks once when any of them has unsaved changes. */
    const closeMany = useCallback(async (keep?: string): Promise<boolean> => {
        const closedIn = generation.current
        const closing = filesRef.current.filter(f => f.path !== keep)
        if (!(await promptAndSaveDirty(closing))) return false
        if (closedIn !== generation.current) return false
        const closedPaths = closing.map(f => f.path)
        closedPaths.forEach(p => {
            clearAutoSaveTimer(p)
            pushClosed(p)
        })
        const closedSet = new Set(closedPaths)
        mruRef.current = mruRef.current.filter(p => !closedSet.has(p))
        mruSessionRef.current = null
        setFiles(prev => prev.filter(f => f.path === keep))
        setActivePath(keep ?? null)
        closedPaths.forEach(p => onDisposeModelRef.current(p))
        return true
    }, [promptAndSaveDirty, clearAutoSaveTimer, pushClosed, setFiles, setActivePath])

    /** Closes all tabs strictly to the right of `path`. */
    const closeToRight = useCallback(async (path: string): Promise<boolean> => {
        const closedIn = generation.current
        const index = filesRef.current.findIndex(f => f.path === path)
        if (index === -1 || index >= filesRef.current.length - 1) return true
        const closing = filesRef.current.slice(index + 1)
        if (!(await promptAndSaveDirty(closing))) return false
        if (closedIn !== generation.current) return false
        const closedPaths = closing.map(f => f.path)
        const closedSet = new Set(closedPaths)
        closedPaths.forEach(p => {
            clearAutoSaveTimer(p)
            pushClosed(p)
        })
        mruRef.current = mruRef.current.filter(p => !closedSet.has(p))
        mruSessionRef.current = null
        setFiles(prev => prev.filter(f => !closedSet.has(f.path)))
        if (activeRef.current && closedSet.has(activeRef.current)) {
            setActivePath(path)
        }
        closedPaths.forEach(p => onDisposeModelRef.current(p))
        return true
    }, [promptAndSaveDirty, clearAutoSaveTimer, pushClosed, setFiles, setActivePath])

    /** Closes all clean (saved) tabs immediately. */
    const closeSaved = useCallback(() => {
        const closing = filesRef.current.filter(f => !f.isDirty)
        if (closing.length === 0) return
        const closedPaths = closing.map(f => f.path)
        const closedSet = new Set(closedPaths)
        closedPaths.forEach(p => {
            clearAutoSaveTimer(p)
            pushClosed(p)
        })
        const remaining = filesRef.current.filter(f => f.isDirty)
        mruRef.current = mruRef.current.filter(p => !closedSet.has(p))
        mruSessionRef.current = null
        setFiles(remaining)
        if (activeRef.current && closedSet.has(activeRef.current)) {
            setActivePath(remaining[0]?.path ?? null)
        }
        closedPaths.forEach(p => onDisposeModelRef.current(p))
    }, [clearAutoSaveTimer, pushClosed, setFiles, setActivePath])

    /** Prompts to save dirty files before switching folders (without closing tabs prematurely). */
    const confirmDirtyBeforeSwitch = useCallback(async (): Promise<boolean> => {
        return promptAndSaveDirty(filesRef.current)
    }, [promptAndSaveDirty])

    const reopenClosedTab = useCallback(async () => {
        while (closedStackRef.current.length > 0) {
            const path = closedStackRef.current.pop()!
            if (filesRef.current.some(f => samePath(f.path, path))) continue
            await openFile(path)
            return
        }
    }, [openFile])

    const reorderFiles = useCallback((fromIndex: number, toIndex: number) => {
        if (fromIndex === toIndex) return
        setFiles(prev => {
            if (fromIndex < 0 || toIndex < 0 || fromIndex >= prev.length || toIndex >= prev.length) return prev
            const next = [...prev]
            const [moved] = next.splice(fromIndex, 1)
            next.splice(toIndex, 0, moved)
            return next
        })
    }, [setFiles])

    const setFileLanguage = useCallback((path: string, language: string) => {
        setFiles(prev => prev.map(f => (f.path === path ? { ...f, language } : f)))
    }, [setFiles])

    const renamePath = useCallback((oldPath: string, newPath: string) => {
        const oldNorm = oldPath.replace(/\\/g, '/')
        const newNorm = newPath.replace(/\\/g, '/')
        const remap = (raw: string) => {
            const p = raw.replace(/\\/g, '/')
            return p === oldNorm || p.startsWith(oldNorm + '/') ? newNorm + p.slice(oldNorm.length) : raw
        }

        // Collect affected old paths first — never dispose Monaco models inside a React updater.
        const affectedOldPaths = filesRef.current
            .filter(f => {
                const p = f.path.replace(/\\/g, '/')
                return p === oldNorm || p.startsWith(oldNorm + '/')
            })
            .map(f => f.path)

        setFiles(prev => prev.map(f => {
            const nextPath = remap(f.path)
            if (nextPath === f.path) return f
            const name = baseName(nextPath)
            return { ...f, path: nextPath, name, language: languageFromFileName(name) }
        }))
        setActivePath(prev => (prev ? remap(prev) : prev))
        mruRef.current = mruRef.current.map(remap)
        closedStackRef.current = closedStackRef.current.map(remap)
        affectedOldPaths.forEach(p => {
            clearAutoSaveTimer(p)
            onDisposeModelRef.current(p)
        })
        onRenamedPathRef.current?.(oldPath, newPath)
    }, [setFiles, setActivePath, clearAutoSaveTimer])

    /** A file or folder vanished from disk: drop clean tabs, mark dirty ones deleted. */
    const handleDeleted = useCallback((deletedPath: string, notifyDirty = false) => {
        const gone = deletedPath.replace(/\\/g, '/')
        const matching = filesRef.current.filter(f => {
            const p = f.path.replace(/\\/g, '/')
            return p === gone || p.startsWith(gone + '/')
        })
        if (matching.length === 0) return

        const clean = matching.filter(f => !f.isDirty)
        const dirty = matching.filter(f => f.isDirty)
        clean.forEach(f => forceClose(f.path))

        if (dirty.length > 0) {
            const dirtySet = new Set(dirty.map(f => f.path))
            let newlyDeleted: OpenFile[] = []
            setFiles(prev => prev.map(f => {
                if (!dirtySet.has(f.path)) return f
                if (f.diskContent !== undefined) newlyDeleted.push(f)
                return { ...f, diskContent: undefined }
            }))
            if (notifyDirty && newlyDeleted.length > 0) {
                const label = newlyDeleted.length === 1
                    ? `${newlyDeleted[0].name} was deleted on disk`
                    : `${newlyDeleted.length} unsaved files were deleted on disk`
                addNotification(`${label}. Save to recreate or close the tab.`, 'warning')
            }
        }
    }, [forceClose, setFiles, addNotification])

    // Files changed or deleted on disk by the agent, git or another tool.
    useFolderChanges(folder, async change => {
        if (change.event === 'unlink' || change.event === 'unlinkDir') {
            handleDeleted(change.path, true)
            return
        }
        if (change.event !== 'change') return
        const file = filesRef.current.find(f => samePath(f.path, change.path))
        if (!file || file.isDirty) return
        const changedIn = generation.current
        const result = await api()?.fs?.readFile(file.path)
        if (!result?.success || result.content == null || changedIn !== generation.current) return
        setFiles(prev => prev.map(f => (f.path === file.path && !f.isDirty && f.content === file.content
            ? { ...f, content: editorText(result.content), diskContent: result.content }
            : f)))
    })

    // MRU Ctrl+Tab cycling: keep a stable snapshot while Ctrl/Meta is held, promote on keyup.
    useEffect(() => {
        const onKeyUp = (e: KeyboardEvent) => {
            if ((e.key === 'Control' || e.key === 'Meta') && mruSessionRef.current) {
                mruSessionRef.current = null
                promoteMru(activeRef.current)
            }
        }
        window.addEventListener('keyup', onKeyUp)
        return () => window.removeEventListener('keyup', onKeyUp)
    }, [promoteMru])

    const cycle = useCallback((delta: 1 | -1) => {
        const list = filesRef.current
        if (list.length < 2) return
        const openSet = new Set(list.map(f => f.path))
        let session = mruSessionRef.current
        if (!session) {
            const ordered = [
                ...mruRef.current.filter(p => openSet.has(p)),
                ...list.map(f => f.path).filter(p => !mruRef.current.includes(p))
            ]
            const currentIdx = Math.max(0, ordered.indexOf(activeRef.current ?? ''))
            session = { order: ordered, index: currentIdx }
            mruSessionRef.current = session
        }
        if (session.order.length < 2) return
        session.index = (session.index + delta + session.order.length) % session.order.length
        setActivePathInternal(session.order[session.index], false)
    }, [setActivePathInternal])

    const selectByIndex = useCallback((index: number) => {
        const list = filesRef.current
        if (list.length === 0) return
        const target = index === 8 ? list[list.length - 1] : list[index]
        if (target) setActivePath(target.path)
    }, [setActivePath])

    // Auto-Save on focus change: save previous active tab when switching tabs or losing window focus.
    const prevActiveRef = useRef<string | null>(null)
    useEffect(() => {
        const prev = prevActiveRef.current
        prevActiveRef.current = activePath
        if (autoSave !== 'onFocusChange' || !canEditRef.current) return
        if (prev && prev !== activePath) {
            const file = filesRef.current.find(f => f.path === prev)
            if (file && file.isDirty && file.diskContent !== undefined) {
                void saveFileRef.current(prev, { skipDeletedPrompt: true })
            }
        }
    }, [activePath, autoSave])

    useEffect(() => {
        if (autoSave !== 'onFocusChange') return
        const onBlur = () => {
            if (!canEditRef.current) return
            const current = filesRef.current.find(f => f.path === activeRef.current)
            if (current && current.isDirty && current.diskContent !== undefined) {
                void saveFileRef.current(current.path, { skipDeletedPrompt: true })
            }
        }
        window.addEventListener('blur', onBlur)
        return () => window.removeEventListener('blur', onBlur)
    }, [autoSave])

    // A new folder starts with no tabs; tabs from a previous session are restored.
    useEffect(() => {
        if (ready.current && scope.current.folder) {
            captureEditorState(scope.current.spaceId, scope.current.folder, filesRef.current, activeRef.current)
        }
        const prevOpenPaths = filesRef.current.map(f => f.path)
        clearAllAutoSaveTimers()
        const currentGeneration = ++generation.current
        scope.current = { spaceId, folder }
        ready.current = false
        closedStackRef.current = []
        mruRef.current = []
        mruSessionRef.current = null
        setRestoring(true)
        setFiles([])
        setActivePath(null)
        prevOpenPaths.forEach(p => onDisposeModelRef.current(p))

        if (!folder) { setRestoring(false); return }
        const record = useWorkspaceFolderStore.getState().records[spaceId]
        void (async () => {
            const recovered = await readEditorState(spaceId, folder)
            if (generation.current !== currentGeneration) return
            const paths = recovered?.paths ?? (record?.folder === folder ? record.openFiles : [])
            const drafts = new Map(recovered?.files.map(file => [file.path, file]) ?? [])
            for (const path of [...new Set([...paths, ...drafts.keys()])]) {
                if (generation.current !== currentGeneration) return
                const draft = drafts.get(path)
                if (draft && validate(path, true)) {
                    const disk = await api()?.fs?.readFile(path)
                    if (generation.current !== currentGeneration) return
                    const alreadySaved = disk?.success && editorText(disk.content) === draft.content
                    setFiles(prev => [...prev, { ...draft, isDirty: !alreadySaved, ...(alreadySaved ? { diskContent: disk.content } : {}) }])
                    setActivePath(path)
                } else {
                    await openFileInternal(path, undefined, undefined, { silentMissing: true })
                }
            }
            if (generation.current !== currentGeneration) return
            const active = recovered?.activePath ?? record?.activeFile
            if (active && filesRef.current.some(f => f.path === active)) setActivePath(active)
            ready.current = true
            setRestoring(false)
        })().catch(error => {
            if (generation.current !== currentGeneration) return
            addNotification(`Couldn't restore editor tabs: ${error instanceof Error ? error.message : String(error)}`, 'error')
            ready.current = true
            setRestoring(false)
        })
        return () => {
            clearAllAutoSaveTimers()
            if (ready.current) captureEditorState(spaceId, folder, filesRef.current, activeRef.current)
            const unmountPaths = filesRef.current.map(f => f.path)
            generation.current++
            unmountPaths.forEach(p => onDisposeModelRef.current(p))
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [spaceId, folder])

    // Remember which tabs were open for next time.
    useEffect(() => {
        if (!folder || restoring || !ready.current || scope.current.spaceId !== spaceId || scope.current.folder !== folder) return
        captureEditorState(spaceId, folder, files, activePath)
        setOpenFilesRecord(spaceId, files.map(f => f.path), activePath)
    }, [spaceId, folder, files, activePath, restoring, setOpenFilesRecord])

    useEffect(() => {
        const off = onRecoveryError(message => addNotification(`Unsaved editor recovery failed: ${message}`, 'error'))
        const syncCaptureAndFlush = () => {
            if (ready.current && scope.current.folder) {
                captureEditorState(scope.current.spaceId, scope.current.folder, filesRef.current, activeRef.current)
            }
            return flushEditorStates()
        }
        const onBeforeFlush = () => {
            syncCaptureAndFlush()
        }
        const onBeforeUnload = (event: BeforeUnloadEvent) => {
            const result = syncCaptureAndFlush()
            if (!result.success) {
                event.preventDefault()
                event.returnValue = ''
                addNotification(result.error ?? 'Save your files before closing.', 'error')
            }
        }
        window.addEventListener('kalynt-before-flush-editor', onBeforeFlush)
        window.addEventListener('beforeunload', onBeforeUnload)
        return () => {
            off()
            window.removeEventListener('kalynt-before-flush-editor', onBeforeFlush)
            window.removeEventListener('beforeunload', onBeforeUnload)
        }
    }, [addNotification])

    // Other regions (agent tools, scan results, mentions, command palette) communicate through window events.
    useEffect(() => {
        const onOpen = (e: Event) => {
            const detail = (e as CustomEvent<{ path: string; line?: number; column?: number }>).detail
            if (detail?.path) void openFile(detail.path, detail.line, detail.column)
        }
        const onApplyFix = (e: Event) => {
            const detail = (e as CustomEvent<{ path: string; content: string; line?: number }>).detail
            if (!detail?.path || detail.content == null) return
            if (!canEditRef.current) {
                addNotification('Your role in this workspace is read-only; fixes cannot be applied.', 'warning')
                return
            }
            const target = validate(detail.path)
            if (!target) return
            const appliedIn = generation.current
            const name = baseName(target)
            const existing = filesRef.current.find(f => samePath(f.path, target))
            if (existing) {
                if (detail.line) setReveal({ path: existing.path, line: detail.line, nonce: Date.now() })
                setFiles(prev => prev.map(f => (samePath(f.path, target) ? { ...f, content: detail.content, isDirty: true } : f)))
                setActivePath(existing.path)
                addNotification(`Fix applied to ${name}. Review it, then save.`, 'info')
                return
            }
            // Load diskContent first so compare-and-write conflict detection remains intact on save.
            void (async () => {
                const disk = await api()?.fs?.readFile(target)
                if (appliedIn !== generation.current) return
                const diskContent = disk?.success && typeof disk.content === 'string' ? disk.content : undefined
                if (detail.line) setReveal({ path: target, line: detail.line, nonce: Date.now() })
                setFiles(prev => prev.some(f => samePath(f.path, target))
                    ? prev.map(f => (samePath(f.path, target) ? { ...f, content: detail.content, isDirty: true } : f))
                    : [...prev, { path: target, name, content: detail.content, diskContent, language: languageFromFileName(name), isDirty: true }])
                setActivePath(target)
                addNotification(`Fix applied to ${name}. Review it, then save.`, 'info')
            })()
        }
        const onFileChanged = (e: Event) => {
            const detail = (e as CustomEvent<{ path?: string; content?: string; source?: string }>).detail
            if (!detail?.path) return
            const file = filesRef.current.find(f => samePath(f.path, detail.path))
            if (!file) return
            const changedIn = generation.current
            if (file.isDirty) {
                if (typeof detail.content === 'string' && editorText(detail.content) === file.content) {
                    setFiles(prev => prev.map(f => (f.path === file.path ? { ...f, diskContent: detail.content, isDirty: false } : f)))
                    return
                }
                const who = detail.source === 'agent' ? ' by the agent' : ''
                addNotification(`${file.name} changed on disk${who} while you have unsaved edits. Save or reload to resolve.`, 'warning')
                return
            }
            if (typeof detail.content === 'string') {
                const nextContent = detail.content
                setFiles(prev => prev.map(f => (f.path === file.path && !f.isDirty
                    ? { ...f, content: editorText(nextContent), diskContent: nextContent }
                    : f)))
                return
            }
            void api()?.fs?.readFile(file.path).then((result: { success?: boolean; content?: string } | undefined) => {
                if (!result?.success || result.content == null || changedIn !== generation.current) return
                const diskText = result.content
                setFiles(prev => prev.map(f => (f.path === file.path && !f.isDirty && f.content === file.content
                    ? { ...f, content: editorText(diskText), diskContent: diskText }
                    : f)))
            })
        }
        window.addEventListener('kalynt-open-file', onOpen)
        window.addEventListener('kalynt-apply-fix', onApplyFix)
        window.addEventListener('kalynt-file-changed', onFileChanged)
        return () => {
            window.removeEventListener('kalynt-open-file', onOpen)
            window.removeEventListener('kalynt-apply-fix', onApplyFix)
            window.removeEventListener('kalynt-file-changed', onFileChanged)
        }
    }, [openFile, validate, addNotification, setFiles, setActivePath])

    const activeFile = files.find(f => f.path === activePath) ?? null

    return {
        files, activeFile, activePath, setActivePath, reveal, clearReveal: () => setReveal(null),
        openFile, updateContent, saveFile, saveAll, closeFile, closeMany, closeToRight, closeSaved,
        confirmDirtyBeforeSwitch, forceClose, renamePath, handleDeleted, cycle,
        reopenClosedTab, selectByIndex, reorderFiles, setFileLanguage
    }
}

export type OpenFilesApi = ReturnType<typeof useOpenFiles>

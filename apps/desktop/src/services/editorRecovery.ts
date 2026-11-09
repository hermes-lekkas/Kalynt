/* SPDX-License-Identifier: AGPL-3.0-only */
import type { OpenFile } from '../types/ide'
export interface EditorRecoveryState {
    spaceId: string
    folder: string
    paths: string[]
    activePath: string | null
    files: OpenFile[]
}
const memory = new Map<string, EditorRecoveryState>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const keyFor = (spaceId: string, folder: string) => JSON.stringify([spaceId, folder])
const subscribers = new Set<(message: string) => void>()
export const onRecoveryError = (callback: (message: string) => void) => { subscribers.add(callback); return () => { subscribers.delete(callback) } }

export function captureEditorState(spaceId: string, folder: string, files: OpenFile[], activePath: string | null): EditorRecoveryState {
    const state = { spaceId, folder, paths: files.map(f => f.path), activePath, files: files.filter(f => f.isDirty).map(f => ({ ...f })) }
    const key = keyFor(spaceId, folder)
    memory.set(key, state)
    clearTimeout(timers.get(key))
    timers.set(key, setTimeout(() => {
        timers.delete(key)
        const api = window.electronAPI?.editorState
        if (!api) return
        void Promise.resolve().then(() => api.save(state)).then(result => {
            if (!result?.success) throw new Error(result?.error ?? 'Editor recovery could not be saved.')
        }).catch(error => subscribers.forEach(fn => fn(error instanceof Error ? error.message : String(error))))
    }, 250))
    return state
}

export async function readEditorState(spaceId: string, folder: string): Promise<EditorRecoveryState | null> {
    const key = keyFor(spaceId, folder)
    if (memory.has(key)) return memory.get(key)!
    const saved = await window.electronAPI?.editorState?.load(spaceId, folder)
    if (!saved || saved.spaceId !== spaceId || saved.folder !== folder || !Array.isArray(saved.paths) || !Array.isArray(saved.files)) return null
    return saved
}

/** Flush every workspace, including buffers belonging to a previous workspace. */
export function flushEditorStates(): { success: boolean; error?: string } {
    const api = window.electronAPI?.editorState
    if (!api) return { success: false, error: 'Editor recovery is unavailable. Save your files before closing.' }
    for (const state of memory.values()) {
        clearTimeout(timers.get(keyFor(state.spaceId, state.folder)))
        timers.delete(keyFor(state.spaceId, state.folder))
        try {
            const result = api.flush(state)
            if (!result?.success) return { success: false, error: result?.error ?? 'Editor recovery could not be saved.' }
        } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
    }
    return { success: true }
}

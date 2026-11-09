/* SPDX-License-Identifier: AGPL-3.0-only */
import type { IpcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { validatePath } from '../utils/pathValidator'
import type { OpenFile } from '../../src/types/ide'

export interface EditorState {
    spaceId: string
    folder: string
    paths: string[]
    activePath: string | null
    files: OpenFile[]
}
const MAX_BYTES = 64 * 1024 * 1024
function statePath(userData: string, spaceId: string, folder: string): string {
    if (typeof spaceId !== 'string' || !spaceId || spaceId.length > 200 || typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Invalid editor workspace')
    const key = createHash('sha256').update(JSON.stringify([spaceId, folder])).digest('hex')
    return path.join(userData, 'editor-state', `${key}.json`)
}
export function saveEditorState(userData: string, state: EditorState): { success: boolean; error?: string } {
    let temporary: string | undefined
    try {
        const destination = statePath(userData, state.spaceId, state.folder)
        if (!Array.isArray(state.files) || !Array.isArray(state.paths)) throw new Error('Invalid editor state')
        for (const file of state.files) {
            validatePath(state.folder, file.path)
            if (typeof file.content !== 'string' || typeof file.name !== 'string' || typeof file.language !== 'string' || file.isDirty !== true || (file.diskContent !== undefined && typeof file.diskContent !== 'string')) throw new Error('Invalid editor draft')
        }
        for (const file of state.paths) validatePath(state.folder, file)
        if (state.activePath !== null) validatePath(state.folder, state.activePath)
        const serialized = JSON.stringify(state)
        if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Unsaved editor recovery exceeds 64 MB. Save some files before closing.')
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        temporary = `${destination}.${randomUUID()}.tmp`
        fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
        fs.renameSync(temporary, destination)
        return { success: true }
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
        if (temporary) { try { fs.rmSync(temporary, { force: true }) } catch { /* retain the original save error */ } }
    }
}
export function loadEditorState(userData: string, spaceId: string, folder: string): EditorState | null {
    try {
        const file = statePath(userData, spaceId, folder)
        if (fs.statSync(file).size > MAX_BYTES) return null
        const state = JSON.parse(fs.readFileSync(file, 'utf8')) as EditorState
        if (state.spaceId !== spaceId || state.folder !== folder || !Array.isArray(state.files) || !Array.isArray(state.paths)) return null
        return state
    } catch { return null }
}
export function registerEditorStateHandlers(ipc: IpcMain, getUserData: () => string): void {
    ipc.handle('editor:load-state', (_, spaceId: string, folder: string) => loadEditorState(getUserData(), spaceId, folder))
    ipc.handle('editor:save-state', (_, state: EditorState) => saveEditorState(getUserData(), state))
    // Used only while closing/reloading: acknowledge durable recovery before
    // allowing Chromium to tear down the renderer and its pending promises.
    ipc.on('editor:flush-state', (event, state: EditorState) => { event.returnValue = saveEditorState(getUserData(), state) })
}

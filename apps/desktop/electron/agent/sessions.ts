/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent conversations on disk, one JSON file each under
 * <userData>/agent-sessions, plus an index for the conversation list.
 * Transcripts carry provider data (thinking blocks, encrypted reasoning) that
 * would not fit in localStorage.
 *
 *   agent:sessions-list    spaceId? -> SessionSummary[]
 *   agent:session-load     id -> session | null
 *   agent:session-save     session -> { ok }
 *   agent:session-delete   id -> { ok }
 */
import fs from 'node:fs'
import path from 'node:path'
import { app, type IpcMain } from 'electron'

export interface SessionSummary {
    id: string
    title: string
    spaceId?: string
    provider?: string
    model?: string
    updatedAt: number
    createdAt: number
}

const ID = /^[a-zA-Z0-9-]{8,64}$/
const dir = () => path.join(app.getPath('userData'), 'agent-sessions')
const indexPath = () => path.join(dir(), 'index.json')

function writeAtomic(file: string, data: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
}

function readIndex(): SessionSummary[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(indexPath(), 'utf8'))
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

function writeIndex(index: SessionSummary[]): void {
    writeAtomic(indexPath(), JSON.stringify(index))
}

export function registerAgentSessionHandlers(ipcMain: IpcMain): void {
    ipcMain.handle('agent:sessions-list', (_event, spaceId?: string) => {
        const index = readIndex().sort((a, b) => b.updatedAt - a.updatedAt)
        return spaceId ? index.filter(s => !s.spaceId || s.spaceId === spaceId) : index
    })

    ipcMain.handle('agent:session-load', (_event, id: string) => {
        if (!ID.test(String(id))) return null
        try {
            return JSON.parse(fs.readFileSync(path.join(dir(), `${id}.json`), 'utf8'))
        } catch {
            return null
        }
    })

    ipcMain.handle('agent:session-save', (_event, session: SessionSummary & Record<string, unknown>) => {
        if (!session || !ID.test(String(session.id))) return { ok: false, error: 'Invalid session id.' }
        try {
            writeAtomic(path.join(dir(), `${session.id}.json`), JSON.stringify(session))
            const summary: SessionSummary = {
                id: session.id,
                title: String(session.title ?? 'New conversation').slice(0, 200),
                spaceId: typeof session.spaceId === 'string' ? session.spaceId : undefined,
                provider: typeof session.provider === 'string' ? session.provider : undefined,
                model: typeof session.model === 'string' ? session.model : undefined,
                updatedAt: Number(session.updatedAt) || Date.now(),
                createdAt: Number(session.createdAt) || Date.now()
            }
            writeIndex([summary, ...readIndex().filter(s => s.id !== session.id)])
            return { ok: true }
        } catch (error) {
            console.error('[Agent] Saving a conversation failed:', error)
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    ipcMain.handle('agent:session-delete', (_event, id: string) => {
        if (!ID.test(String(id))) return { ok: false }
        try { fs.rmSync(path.join(dir(), `${id}.json`), { force: true }) } catch { /* already gone */ }
        writeIndex(readIndex().filter(s => s.id !== id))
        return { ok: true }
    })
}

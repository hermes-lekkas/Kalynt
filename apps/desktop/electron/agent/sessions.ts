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
import { randomUUID } from 'node:crypto'
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

let indexQueue: Promise<unknown> = Promise.resolve()

function serializeIndex<T>(fn: () => Promise<T>): Promise<T> {
    const next = indexQueue.then(fn, fn)
    indexQueue = next.catch(() => undefined)
    return next
}

async function writeAtomicAsync(file: string, data: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
        await fs.promises.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 })
        await fs.promises.rename(tmp, file)
    } catch (error) {
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
        throw error
    }
}

function writeAtomicSync(file: string, data: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
        fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 })
        fs.renameSync(tmp, file)
    } catch (error) {
        try { fs.rmSync(tmp, { force: true }) } catch { /* ignore cleanup failure */ }
        throw error
    }
}

async function readIndexAsync(): Promise<SessionSummary[]> {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(indexPath(), 'utf8'))
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

function readIndexSync(): SessionSummary[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(indexPath(), 'utf8'))
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

function toSummary(session: SessionSummary & Record<string, unknown>): SessionSummary {
    return {
        id: session.id,
        title: String(session.title ?? 'New conversation').slice(0, 200),
        spaceId: typeof session.spaceId === 'string' ? session.spaceId : undefined,
        provider: typeof session.provider === 'string' ? session.provider : undefined,
        model: typeof session.model === 'string' ? session.model : undefined,
        updatedAt: Number(session.updatedAt) || Date.now(),
        createdAt: Number(session.createdAt) || Date.now()
    }
}

export function registerAgentSessionHandlers(ipcMain: IpcMain): void {
    ipcMain.handle('agent:sessions-list', async (_event, spaceId?: string) => {
        const index = (await readIndexAsync()).sort((a, b) => b.updatedAt - a.updatedAt)
        return spaceId ? index.filter(s => !s.spaceId || s.spaceId === spaceId) : index
    })

    ipcMain.handle('agent:session-load', async (_event, id: string) => {
        if (!ID.test(String(id))) return null
        try {
            return JSON.parse(await fs.promises.readFile(path.join(dir(), `${id}.json`), 'utf8'))
        } catch {
            return null
        }
    })

    ipcMain.handle('agent:session-save', async (_event, session: SessionSummary & Record<string, unknown>) => {
        if (!session || !ID.test(String(session.id))) return { ok: false, error: 'Invalid session id.' }
        try {
            await writeAtomicAsync(path.join(dir(), `${session.id}.json`), JSON.stringify(session))
            const summary = toSummary(session)
            await serializeIndex(async () => {
                const current = await readIndexAsync()
                await writeAtomicAsync(indexPath(), JSON.stringify([summary, ...current.filter(s => s.id !== session.id)]))
            })
            return { ok: true }
        } catch (error) {
            console.error('[Agent] Saving a conversation failed:', error)
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    // Synchronous IPC used strictly on window beforeunload flush.
    ipcMain.on('agent:session-flush', (event, session: SessionSummary & Record<string, unknown>) => {
        if (!session || !ID.test(String(session.id))) {
            event.returnValue = { ok: false, error: 'Invalid session id.' }
            return
        }
        try {
            writeAtomicSync(path.join(dir(), `${session.id}.json`), JSON.stringify(session))
            const summary = toSummary(session)
            writeAtomicSync(indexPath(), JSON.stringify([summary, ...readIndexSync().filter(s => s.id !== session.id)]))
            event.returnValue = { ok: true }
        } catch (error) {
            console.error('[Agent] Flushing a conversation failed:', error)
            event.returnValue = { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    ipcMain.handle('agent:session-delete', async (_event, id: string) => {
        if (!ID.test(String(id))) return { ok: false }
        await fs.promises.rm(path.join(dir(), `${id}.json`), { force: true }).catch(() => undefined)
        await serializeIndex(async () => {
            const current = await readIndexAsync()
            await writeAtomicAsync(indexPath(), JSON.stringify(current.filter(s => s.id !== id)))
        })
        return { ok: true }
    })
}

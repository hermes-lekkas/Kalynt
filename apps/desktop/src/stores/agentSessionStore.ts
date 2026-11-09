/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent conversations: the list for the current workspace and the open one.
 * Conversations are saved as files by the main process (they include provider
 * data too large for localStorage). Older conversations from the previous
 * chat store are imported once.
 */
import { create } from 'zustand'
import type { ConversationItem, UserItem } from '../types/aiProtocol'
import { newSession, titleFrom, type AgentSession } from '../services/agent/session'
import { useNotificationStore } from './notificationStore'

export interface SessionSummary {
    id: string
    title: string
    spaceId?: string
    provider?: string
    model?: string
    updatedAt: number
    createdAt: number
}

interface AgentSessionState {
    summaries: SessionSummary[]
    current: AgentSession | null
    /** Bumped on every in-place change to `current`, so views re-render. */
    revision: number
    loadList: (spaceId: string) => Promise<void>
    open: (id: string) => Promise<void>
    create: (spaceId: string) => AgentSession
    /** Call after mutating `current` in place. Saves shortly after. */
    touch: () => void
    saveNow: () => Promise<void>
    flushNow: () => { ok: boolean; error?: string }
    rename: (id: string, title: string) => Promise<void>
    remove: (id: string) => Promise<void>
}

const MIGRATED_KEY = 'kalynt-agent-sessions-imported'
let saveTimer: ReturnType<typeof setTimeout> | null = null

const api = () => window.electronAPI?.agent
const pending = new Map<string, AgentSession>()
const writes = new Map<string, Promise<void>>()
const epochs = new Map<string, number>()

async function persist(session: AgentSession) {
    const snapshot = JSON.parse(JSON.stringify(session)) as AgentSession
    pending.set(session.id, snapshot)
    const epoch = epochs.get(session.id) ?? 0
    const operation = (writes.get(session.id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        if (epoch !== (epochs.get(session.id) ?? 0)) return
        const result = await api()?.saveSession(snapshot)
        if (!result?.ok) throw new Error(result?.error ?? 'Conversation storage is unavailable.')
        if (pending.get(session.id) === snapshot) pending.delete(session.id)
    })
    writes.set(session.id, operation)
    try { await operation }
    finally { if (writes.get(session.id) === operation) writes.delete(session.id) }
}

function reportError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[Agent] Conversation storage failed:', message)
    useNotificationStore.getState().addNotification(`Conversation could not be saved: ${message}`, 'error')
}

/** One-time import of conversations kept by the old chat store. */
async function importLegacy(): Promise<void> {
    try {
        if (localStorage.getItem(MIGRATED_KEY)) return
        const legacy = JSON.parse(localStorage.getItem('kalynt-chat-sessions') ?? 'null')?.state?.sessions as Array<{
            id: string; title: string; spaceId?: string; lastModified?: number; createdAt?: number
            messages: Array<{ role?: string; content: string; timestamp?: number; modelId?: string }>
        }> | undefined
        for (const old of legacy ?? []) {
            const items: ConversationItem[] = []
            for (const m of old.messages ?? []) {
                if (m.role === 'user') items.push({ role: 'user', content: m.content })
                else if (m.role === 'assistant' && m.content) items.push({ role: 'assistant', text: m.content, toolCalls: [], provider: 'local', model: m.modelId ?? 'earlier model' })
            }
            if (!items.length) continue
            const firstUser = items.find((i): i is UserItem => i.role === 'user')
            const session: AgentSession = {
                ...newSession(old.spaceId),
                id: /^[a-zA-Z0-9-]{8,64}$/.test(old.id) ? old.id : crypto.randomUUID(),
                title: old.title && old.title !== 'New Chat' ? old.title : titleFrom(firstUser?.content ?? ''),
                createdAt: old.createdAt ?? old.lastModified ?? Date.now(),
                updatedAt: old.lastModified ?? Date.now(),
                items
            }
            await persist(session)
        }
        localStorage.setItem(MIGRATED_KEY, '1')
    } catch (error) {
        console.error('[Agent] Importing earlier conversations failed', error)
    }
}

export const useAgentSessionStore = create<AgentSessionState>()((set, get) => ({
    summaries: [],
    current: null,
    revision: 0,

    loadList: async spaceId => {
        if (!api()) return
        await importLegacy()
        const summaries = await api()!.listSessions(spaceId)
        const combined = new Map((Array.isArray(summaries) ? summaries : []).map(summary => [summary.id, summary]))
        for (const session of pending.values()) combined.set(session.id, session)
        set({ summaries: [...combined.values()] })
    },

    open: async id => {
        await get().saveNow().catch(reportError)
        const loaded = pending.get(id) ?? await api()?.loadSession(id) as AgentSession | null
        if (!loaded || typeof loaded.id !== 'string' || !Array.isArray(loaded.items)) return
        // Older files may miss newer fields.
        set(state => ({ current: { ...newSession(loaded.spaceId), ...loaded }, revision: state.revision + 1 }))
    },

    create: spaceId => {
        void get().saveNow().catch(reportError)
        const session = newSession(spaceId)
        set(state => ({ current: session, revision: state.revision + 1 }))
        return session
    },

    touch: () => {
        set(state => ({ revision: state.revision + 1 }))
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => { void get().saveNow().catch(reportError) }, 800)
    },

    saveNow: async () => {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
        const session = get().current
        const candidates = new Map(pending)
        if (session?.items.length) candidates.set(session.id, session)
        await Promise.all([...candidates.values()].map(async candidate => {
            await persist(candidate)
            const summary: SessionSummary = {
                id: candidate.id, title: candidate.title, spaceId: candidate.spaceId, provider: candidate.provider,
                model: candidate.model, updatedAt: candidate.updatedAt, createdAt: candidate.createdAt
            }
            set(state => ({ summaries: [summary, ...state.summaries.filter(s => s.id !== candidate.id)] }))
        }))
    },

    flushNow: () => {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
        const candidates = new Map(pending)
        const current = get().current
        if (current?.items.length) candidates.set(current.id, current)
        try {
            for (const session of candidates.values()) {
                pending.set(session.id, session)
                epochs.set(session.id, (epochs.get(session.id) ?? 0) + 1)
                const result = api()?.flushSession(session)
                if (!result?.ok) return { ok: false, error: result?.error ?? 'Save your conversations before closing.' }
                pending.delete(session.id)
            }
            return { ok: true }
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    },

    rename: async (id, title) => {
        const current = get().current
        if (current?.id === id) {
            current.title = title
            get().touch()
            await get().saveNow()
            return
        }
        const loaded = await api()?.loadSession(id) as AgentSession | null
        if (!loaded) return
        await persist({ ...loaded, title })
        set(state => ({ summaries: state.summaries.map(s => s.id === id ? { ...s, title } : s) }))
    },

    remove: async id => {
        await writes.get(id)?.catch(() => undefined)
        const result = await api()?.deleteSession(id)
        if (!result?.ok) throw new Error(result?.error ?? 'The conversation could not be deleted.')
        pending.delete(id)
        set(state => ({
            summaries: state.summaries.filter(s => s.id !== id),
            ...(state.current?.id === id ? { current: null } : {})
        }))
    }
}))

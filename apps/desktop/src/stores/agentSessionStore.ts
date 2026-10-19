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
    rename: (id: string, title: string) => Promise<void>
    remove: (id: string) => Promise<void>
}

const MIGRATED_KEY = 'kalynt-agent-sessions-imported'
let saveTimer: ReturnType<typeof setTimeout> | null = null

const api = () => window.electronAPI?.agent

async function persist(session: AgentSession) {
    await api()?.saveSession(session)
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
        set({ summaries })
    },

    open: async id => {
        await get().saveNow()
        const loaded = await api()?.loadSession(id) as AgentSession | null
        if (!loaded) return
        // Older files may miss newer fields.
        set(state => ({ current: { ...newSession(loaded.spaceId), ...loaded }, revision: state.revision + 1 }))
    },

    create: spaceId => {
        void get().saveNow()
        const session = newSession(spaceId)
        set(state => ({ current: session, revision: state.revision + 1 }))
        return session
    },

    touch: () => {
        set(state => ({ revision: state.revision + 1 }))
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => { void get().saveNow() }, 800)
    },

    saveNow: async () => {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
        const session = get().current
        if (!session || session.items.length === 0) return
        await persist(session)
        const summary: SessionSummary = {
            id: session.id, title: session.title, spaceId: session.spaceId, provider: session.provider,
            model: session.model, updatedAt: session.updatedAt, createdAt: session.createdAt
        }
        set(state => ({ summaries: [summary, ...state.summaries.filter(s => s.id !== session.id)] }))
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
        await api()?.deleteSession(id)
        set(state => ({
            summaries: state.summaries.filter(s => s.id !== id),
            ...(state.current?.id === id ? { current: null } : {})
        }))
    }
}))

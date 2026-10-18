/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ChatMessage } from '../types/chat'

export interface ChatSession {
    id: string
    title: string
    lastModified: number
    messages: ChatMessage[]
    mode: 'agent' | 'collaboration'
    /** Workspace the conversation belongs to. Older sessions have none and show everywhere. */
    spaceId?: string
}

interface ChatStore {
    sessions: ChatSession[]
    currentSessionId: string | null
    
    // Actions
    createSession: (title?: string, spaceId?: string) => string
    updateSession: (id: string, updates: Partial<ChatSession>) => void
    deleteSession: (id: string) => void
    setCurrentSession: (id: string | null) => void
    addMessageToSession: (sessionId: string, message: ChatMessage) => void
    renameSession: (id: string, newTitle: string) => void
}

export const useChatStore = create<ChatStore>()(
    persist(
        (set) => ({
            sessions: [],
            currentSessionId: null,

            createSession: (title = 'New Chat', spaceId) => {
                const id = crypto.randomUUID()
                const newSession: ChatSession = {
                    id,
                    title,
                    lastModified: Date.now(),
                    messages: [],
                    mode: 'agent',
                    spaceId
                }
                set((state) => ({ 
                    sessions: [newSession, ...state.sessions],
                    currentSessionId: id
                }))
                return id
            },

            updateSession: (id, updates) => {
                set((state) => ({
                    sessions: state.sessions.map((s) => 
                        s.id === id ? { ...s, ...updates, lastModified: Date.now() } : s
                    )
                }))
            },

            deleteSession: (id) => {
                set((state) => ({
                    sessions: state.sessions.filter((s) => s.id !== id),
                    currentSessionId: state.currentSessionId === id ? null : state.currentSessionId
                }))
            },

            setCurrentSession: (id) => set({ currentSessionId: id }),

            addMessageToSession: (sessionId, message) => {
                set((state) => ({
                    sessions: state.sessions.map((s) => {
                        if (s.id === sessionId) {
                            const newMessages = [...s.messages, message]
                            // Auto-rename from first message if title is default
                            let newTitle = s.title
                            if (s.title === 'New Chat' && message.role === 'user') {
                                newTitle = message.content.slice(0, 30).trim() + (message.content.length > 30 ? '...' : '')
                            }
                            return { 
                                ...s, 
                                messages: newMessages, 
                                title: newTitle,
                                lastModified: Date.now() 
                            }
                        }
                        return s
                    })
                }))
            },

            renameSession: (id, newTitle) => {
                set((state) => ({
                    sessions: state.sessions.map((s) => 
                        s.id === id ? { ...s, title: newTitle, lastModified: Date.now() } : s
                    )
                }))
            }
        }),
        {
            name: 'kalynt-chat-sessions',
            storage: createJSONStorage(() => localStorage)
        }
    )
)

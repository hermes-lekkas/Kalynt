/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Cloud AI requests and the agent's main-process tools.
 */
import { ipcRenderer } from 'electron'
import { subscribe } from './subscribe'

export const agentApi = {
    ai: {
        chat: (requestId: string, request: unknown) => ipcRenderer.invoke('ai:chat', { requestId, request }),
        cancel: (requestId: string) => ipcRenderer.invoke('ai:cancel', requestId),
        models: (provider: string, refresh?: boolean) => ipcRenderer.invoke('ai:models', provider, refresh),
        verify: (provider: string, key: string) => ipcRenderer.invoke('ai:verify', { provider, key }),
        keyStatus: () => ipcRenderer.invoke('ai:key-status'),
        onEvent: (callback: (data: { requestId: string; event: unknown }) => void) => subscribe('ai:event', callback)
    },
    agent: {
        exec: (options: { id: string; command: string; cwd?: string; timeoutMs?: number; background?: boolean }) => ipcRenderer.invoke('agent:exec', options),
        execRead: (id: string) => ipcRenderer.invoke('agent:exec-read', id),
        execKill: (id: string) => ipcRenderer.invoke('agent:exec-kill', id),
        onExecOutput: (callback: (data: { id: string; data: string }) => void) => subscribe('agent:exec-output', callback),
        glob: (options: { pattern: string; path?: string; limit?: number }) => ipcRenderer.invoke('agent:glob', options),
        grep: (options: { pattern: string; path?: string; glob?: string; caseSensitive?: boolean; context?: number; maxResults?: number; filesOnly?: boolean }) => ipcRenderer.invoke('agent:grep', options),
        webSearch: (options: { query: string; count?: number }) => ipcRenderer.invoke('agent:web-search', options),
        webFetch: (options: { url: string; maxChars?: number; allowPrivate?: boolean }) => ipcRenderer.invoke('agent:web-fetch', options),
        listSessions: (spaceId?: string) => ipcRenderer.invoke('agent:sessions-list', spaceId),
        loadSession: (id: string) => ipcRenderer.invoke('agent:session-load', id),
        saveSession: (session: unknown) => ipcRenderer.invoke('agent:session-save', session),
        deleteSession: (id: string) => ipcRenderer.invoke('agent:session-delete', id)
    }
}

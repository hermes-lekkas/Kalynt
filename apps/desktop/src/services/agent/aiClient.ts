/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Renderer side of the AI gateway. Requests run in the main process (which
 * holds the API keys); this client streams their events back and supports
 * cancelling.
 */
import type { ChatRequest, ChatResult, ModelInfo, ProviderId, StreamEvent } from '../../types/aiProtocol'

export class AiRequestError extends Error {
    constructor(message: string, readonly status?: number, readonly aborted = false) {
        super(message)
        this.name = 'AiRequestError'
    }
}

const listeners = new Map<string, (event: StreamEvent) => void>()
let subscribed = false

function ensureSubscribed() {
    if (subscribed) return
    const api = window.electronAPI?.ai
    if (!api) throw new AiRequestError('Cloud models need the desktop app.')
    api.onEvent(({ requestId, event }) => listeners.get(requestId)?.(event))
    subscribed = true
}

/** Streams one model turn. Throws AiRequestError (aborted=true when cancelled). */
export async function chat(request: ChatRequest, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<ChatResult> {
    ensureSubscribed()
    const api = window.electronAPI.ai
    const requestId = crypto.randomUUID()
    listeners.set(requestId, onEvent)
    const cancel = () => { void api.cancel(requestId) }
    if (signal?.aborted) throw new AiRequestError('Stopped.', undefined, true)
    signal?.addEventListener('abort', cancel, { once: true })
    try {
        const response = await api.chat(requestId, request)
        if (response.ok) return response.result
        throw new AiRequestError(response.error, response.status, !!response.aborted || !!signal?.aborted)
    } finally {
        signal?.removeEventListener('abort', cancel)
        listeners.delete(requestId)
    }
}

/** One-shot text completion without tools, for features other than the agent. */
export async function complete(options: {
    provider: ProviderId
    model: string
    system: string
    prompt: string
    maxTokens?: number
    effort?: ChatRequest['effort']
    signal?: AbortSignal
}): Promise<string> {
    const result = await chat({
        provider: options.provider,
        model: options.model,
        system: options.system,
        items: [{ role: 'user', content: options.prompt }],
        maxTokens: options.maxTokens,
        effort: options.effort ?? 'low'
    }, () => {}, options.signal)
    if (result.stopReason === 'refusal') throw new AiRequestError('The model declined this request.')
    return result.assistant.text.trim()
}

export async function listModels(provider: ProviderId, refresh = false): Promise<{ models: ModelInfo[]; live: boolean; error?: string }> {
    const api = window.electronAPI?.ai
    if (!api) return { models: [], live: false, error: 'Cloud models need the desktop app.' }
    return api.models(provider, refresh)
}

export async function verifyKey(provider: ProviderId, key: string): Promise<{ ok: boolean; error?: string }> {
    const api = window.electronAPI?.ai
    if (!api) return { ok: false, error: 'Cloud models need the desktop app.' }
    return api.verify(provider, key)
}

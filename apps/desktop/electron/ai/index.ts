/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The AI gateway: every request to a cloud model goes through the main process.
 * API keys are read from secure storage here and never cross into the renderer
 * for requests, and providers without browser (CORS) support work the same as
 * the rest.
 *
 * IPC:
 *   ai:chat      { requestId, request } -> { ok, result } | { ok: false, error }
 *                streams `ai:event` { requestId, event } to the caller meanwhile
 *   ai:cancel    requestId
 *   ai:models    provider -> { models, live, error? }
 *   ai:verify    { provider, key } -> { ok, error? }
 */
import { app, type IpcMain } from 'electron'
import type { ChatRequest, ChatResult, ModelInfo, ProviderId, StreamEvent } from '../../src/types/aiProtocol'
import { PROVIDER_IDS, isProviderId, providerInfo } from '../../src/types/aiProviders'
import { readSecret } from '../handlers/safeStorage'
import { streamAnthropic } from './anthropic'
import { streamOpenAIResponses } from './openaiResponses'
import { streamChatCompletions } from './openaiChat'
import { streamGemini } from './gemini'
import { fetchModelIds, mergeModels } from './models'
import { ProviderError } from './http'

const active = new Map<string, AbortController>()
const modelCache = new Map<string, { at: number; models: ModelInfo[]; live: boolean }>()
const MODEL_CACHE_MS = 10 * 60 * 1000

/**
 * Tests point every provider at a local mock server (`<url>/<provider>`).
 * Development builds only: a packaged app always talks to the real providers.
 */
const testBaseUrl = () => (app.isPackaged ? undefined : process.env.KALYNT_AI_TEST_BASE_URL)

function baseUrl(provider: ProviderId): string {
    const override = testBaseUrl()
    if (override) return `${override.replace(/\/$/, '')}/${provider}`
    return providerInfo(provider).baseUrl
}

function apiKey(provider: ProviderId): string {
    const key = readSecret(app.getPath('userData'), `apiKey_${provider}`)
    if (!key) throw new ProviderError(`Add a ${providerInfo(provider).label} API key in Settings → Models and keys.`, 401)
    return key
}

async function dispatch(request: ChatRequest, signal: AbortSignal, emit: (event: StreamEvent) => void): Promise<ChatResult> {
    const key = apiKey(request.provider)
    const url = baseUrl(request.provider)
    switch (providerInfo(request.provider).protocol) {
        case 'anthropic':
            return streamAnthropic(request, { apiKey: key, baseURL: testBaseUrl() ? url : undefined, signal, emit })
        case 'openai-responses':
            return streamOpenAIResponses(request, { apiKey: key, baseUrl: url, signal, emit })
        case 'gemini':
            return streamGemini(request, { apiKey: key, baseUrl: url, signal, emit })
        default:
            return streamChatCompletions(request, { apiKey: key, baseUrl: url, signal, emit })
    }
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Aborted')) }, { once: true })
})

/** Retries rate limits and server errors, but only before anything was streamed. */
async function chatWithRetry(request: ChatRequest, signal: AbortSignal, emit: (event: StreamEvent) => void): Promise<ChatResult> {
    let streamed = false
    const tracked = (event: StreamEvent) => { streamed = true; emit(event) }
    for (let attempt = 0; ; attempt++) {
        try {
            return await dispatch(request, signal, tracked)
        } catch (error) {
            const retryable = error instanceof ProviderError && error.retryable
            if (signal.aborted || !retryable || streamed || attempt >= 2) throw error
            emit({ type: 'notice', message: `${providerInfo(request.provider).label} is busy; retrying…` })
            await sleep(1500 * 2 ** attempt, signal)
        }
    }
}

function describeError(error: unknown): { error: string; status?: number } {
    if (error instanceof ProviderError) {
        const hint = error.status === 401 || error.status === 403 ? ' Check the API key in Settings → Models and keys.'
            : error.status === 404 ? ' The model may have been retired; pick another one.'
                : error.status === 429 ? ' You have hit the provider\'s rate limit; wait a moment.' : ''
        return { error: error.message + (hint && !error.message.includes('Settings') ? hint : ''), status: error.status }
    }
    return { error: error instanceof Error ? error.message : String(error) }
}

export async function listModels(provider: ProviderId, refresh = false): Promise<{ models: ModelInfo[]; live: boolean; error?: string }> {
    const cached = modelCache.get(provider)
    if (!refresh && cached && Date.now() - cached.at < MODEL_CACHE_MS) return { models: cached.models, live: cached.live }
    const key = readSecret(app.getPath('userData'), `apiKey_${provider}`)
    if (!key) return { models: mergeModels(provider, null), live: false }
    try {
        const ids = await fetchModelIds(provider, key, baseUrl(provider))
        const models = mergeModels(provider, ids)
        modelCache.set(provider, { at: Date.now(), models, live: true })
        return { models, live: true }
    } catch (error) {
        // Not every provider lists models; fall back to the curated list.
        return { models: mergeModels(provider, null), live: false, error: describeError(error).error }
    }
}

export function registerAiHandlers(ipcMain: IpcMain): void {
    ipcMain.handle('ai:chat', async (event, payload: { requestId: string; request: ChatRequest }) => {
        const { requestId, request } = payload ?? {}
        if (!requestId || !request || !isProviderId(request.provider) || typeof request.model !== 'string') {
            return { ok: false, error: 'Invalid AI request.' }
        }
        const controller = new AbortController()
        active.set(requestId, controller)
        const emit = (e: StreamEvent) => {
            if (!event.sender.isDestroyed()) event.sender.send('ai:event', { requestId, event: e })
        }
        try {
            const result = await chatWithRetry(request, controller.signal, emit)
            return { ok: true, result }
        } catch (error) {
            if (controller.signal.aborted) return { ok: false, aborted: true, error: 'Stopped.' }
            console.error(`[AI] ${request.provider}/${request.model} failed:`, error instanceof Error ? error.message : error)
            return { ok: false, ...describeError(error) }
        } finally {
            active.delete(requestId)
        }
    })

    ipcMain.handle('ai:cancel', (_event, requestId: string) => {
        active.get(requestId)?.abort()
        return { ok: true }
    })

    // Which providers have a key. The keys themselves never leave the main process.
    ipcMain.handle('ai:key-status', () => Object.fromEntries(PROVIDER_IDS.map(id => [id, !!readSecret(app.getPath('userData'), `apiKey_${id}`)])))

    ipcMain.handle('ai:models', async (_event, provider: string, refresh?: boolean) => {
        if (!isProviderId(provider)) return { models: [], live: false, error: 'Unknown provider.' }
        return listModels(provider, !!refresh)
    })

    ipcMain.handle('ai:verify', async (_event, payload: { provider: string; key: string }) => {
        const { provider, key } = payload ?? {}
        if (!isProviderId(provider) || typeof key !== 'string' || !key.trim()) return { ok: false, error: 'Enter a key.' }
        try {
            await fetchModelIds(provider, key.trim(), baseUrl(provider))
            modelCache.delete(provider)
            return { ok: true }
        } catch (error) {
            // A provider without a model list can't confirm the key, but didn't reject it either.
            if (error instanceof ProviderError && error.status === 404) return { ok: true }
            return { ok: false, ...describeError(error) }
        }
    })
}

/** Stops every in-flight model request (used by "Stop all" and on quit). */
export function cancelAllAiRequests(): number {
    const count = active.size
    for (const controller of active.values()) controller.abort()
    active.clear()
    return count
}

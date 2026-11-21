/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Live model lists. Each provider is asked which models the user's key can
 * call; curated models it no longer lists (retired) are hidden, and other
 * current chat models it offers are added after the curated ones.
 */
import type { ModelInfo, ProviderId } from '../../src/types/aiProtocol'
import { providerInfo, tidyModelId } from '../../src/types/aiProviders'
import { listAnthropicModels } from './anthropic'
import { getJson, ProviderError } from './http'

export type ModelCatalogSource = 'live' | 'fallback' | 'error'

export interface ModelCatalogResult {
    models: ModelInfo[]
    live: boolean
    source: ModelCatalogSource
    fallback?: boolean
    error?: string
    status?: number
    /** Number of raw model IDs returned by the live endpoint before eligibility filtering. */
    rawCount?: number
}

/** Model families that are retired, scheduled for shutdown or not chat models. */
const EXCLUDE: Partial<Record<ProviderId, RegExp>> = {
    // Only GPT-6 and later: earlier GPT and o-series models all have announced shutdowns.
    openai: /^(?!gpt-(?:[6-9]|\d{2,}))|audio|realtime|tts|transcri|image|search|embedding|moderation|cyber|chat-latest|-\d{4}-\d{2}-\d{2}$/,
    google: /^(?!gemini-)|tts|image|live|embedding|transcribe|robotics|omni|banana|preview|-exp|gemini-[12]\./,
    anthropic: /^(?!claude-)|claude-(?:3|2|instant)|claude-[a-z]+-4|-\d{8}$/,
    deepseek: /^deepseek-(?:chat|reasoner)$/,
    moonshot: /^moonshot-v1|kimi-k2\.5/,
    zai: /embedding|^glm-4/
}

export function describeProviderError(error: unknown): { error: string; status?: number } {
    if (error instanceof ProviderError) {
        const hint = error.status === 401 || error.status === 403 ? ' Check the API key in Settings → Models and keys.'
            : error.status === 404 ? ' The model may have been retired; pick another one.'
                : error.status === 429 ? ' You have hit the provider\'s rate limit; wait a moment.' : ''
        return { error: error.message + (hint && !error.message.includes('Settings') ? hint : ''), status: error.status }
    }
    return { error: error instanceof Error ? error.message : String(error) }
}

export async function fetchModelIds(provider: ProviderId, apiKey: string, baseUrl: string): Promise<string[]> {
    const info = providerInfo(provider)
    switch (info.protocol) {
        case 'anthropic':
            return listAnthropicModels(apiKey, baseUrl)
        case 'gemini': {
            const ids: string[] = []
            let pageToken = ''
            for (let page = 0; page < 5; page++) {
                const data = await getJson(`${baseUrl}/models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`, { 'x-goog-api-key': apiKey })
                if (!data || typeof data !== 'object' || (data.models !== undefined && !Array.isArray(data.models))) {
                    throw new ProviderError('The provider did not return a valid Gemini model list.')
                }
                for (const m of data.models ?? []) {
                    if ((m.supportedGenerationMethods ?? []).includes('generateContent')) ids.push(String(m.name).replace(/^models\//, ''))
                }
                pageToken = data.nextPageToken ?? ''
                if (!pageToken) break
            }
            return ids
        }
        default: {
            const data = await getJson(`${baseUrl}/models`, { Authorization: `Bearer ${apiKey}` })
            if (!Array.isArray(data?.data)) {
                throw new ProviderError('The provider did not return an OpenAI-compatible model list.')
            }
            const now = Date.now() / 1000
            return data.data
                .filter((m: { id?: unknown; shutdown_date?: number | string | null }) => {
                    if (typeof m?.id !== 'string' || !m.id.trim()) return false
                    const at = typeof m.shutdown_date === 'string' ? Date.parse(m.shutdown_date) / 1000 : m.shutdown_date
                    return !at || at > now
                })
                .map((m: { id: string }) => m.id)
        }
    }
}

/**
 * Curated models first (minus any the provider no longer lists), then other current ones.
 * When `liveIds` is `null` (offline/fallback), returns the curated fallback list.
 * When `liveIds` is an array from a successful live response, never substitutes absent curated models.
 */
export function mergeModels(provider: ProviderId, liveIds: string[] | null): ModelInfo[] {
    const curated = providerInfo(provider).models
    if (liveIds === null) return curated
    const uniqueLiveIds = Array.from(new Set(liveIds))
    const live = new Set(uniqueLiveIds)
    const exclude = EXCLUDE[provider]
    const kept = curated.filter(m => live.has(m.id))
    const extra = uniqueLiveIds
        .filter(id => !curated.some(m => m.id === id) && !(exclude?.test(id)))
        .sort()
        .map((id): ModelInfo => ({ id, label: tidyModelId(id), tools: true }))
    const merged: ModelInfo[] = [...kept, ...extra]
    // A key that lists none of the curated models still gets a sensible default.
    if (merged.length && !merged.some(m => m.recommended)) merged[0] = { ...merged[0], recommended: true }
    return merged
}

/**
 * Queries a cloud provider's live model catalog and distinguishes:
 * - Successful live catalog (non-empty or empty/filtered, never substituting absent curated models)
 * - Authorization failures (401/403, returns empty list with actionable key error)
 * - Rate-limited, unsupported (404), or temporarily unavailable endpoints (returns explicit offline fallback)
 */
export async function fetchModelCatalog(provider: ProviderId, apiKey: string, baseUrl: string): Promise<ModelCatalogResult> {
    const label = providerInfo(provider).label
    try {
        const ids = await fetchModelIds(provider, apiKey, baseUrl)
        const models = mergeModels(provider, ids)
        if (models.length === 0) {
            const error = ids.length === 0
                ? `${label} returned no available models for this key. Check account model access and click Refresh models.`
                : `${label} returned ${ids.length} model${ids.length === 1 ? '' : 's'}, but none are eligible chat models supported by Kalynt. Check account model access and click Refresh models.`
            return { models: [], live: true, source: 'live', fallback: false, rawCount: ids.length, error }
        }
        return { models, live: true, source: 'live', fallback: false, rawCount: ids.length }
    } catch (error) {
        const described = describeProviderError(error)
        if (described.status === 401 || described.status === 403) {
            return {
                models: [],
                live: false,
                source: 'error',
                fallback: false,
                status: described.status,
                error: described.error
            }
        }
        const fallbackNote = described.status === 404
            ? `${label} does not expose a live model list at this endpoint. Showing offline fallback models.`
            : `${described.error} Showing offline fallback models.`
        return {
            models: mergeModels(provider, null),
            live: false,
            source: 'fallback',
            fallback: true,
            status: described.status,
            error: fallbackNote
        }
    }
}

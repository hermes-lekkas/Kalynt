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
import { getJson } from './http'

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
                for (const m of data?.models ?? []) {
                    if ((m.supportedGenerationMethods ?? []).includes('generateContent')) ids.push(String(m.name).replace(/^models\//, ''))
                }
                pageToken = data?.nextPageToken ?? ''
                if (!pageToken) break
            }
            return ids
        }
        default: {
            const data = await getJson(`${baseUrl}/models`, { Authorization: `Bearer ${apiKey}` })
            const now = Date.now() / 1000
            return (data?.data ?? [])
                .filter((m: { shutdown_date?: number | string | null }) => {
                    const at = typeof m.shutdown_date === 'string' ? Date.parse(m.shutdown_date) / 1000 : m.shutdown_date
                    return !at || at > now
                })
                .map((m: { id: string }) => m.id)
        }
    }
}

/** Curated models first (minus any the provider no longer lists), then other current ones. */
export function mergeModels(provider: ProviderId, liveIds: string[] | null): ModelInfo[] {
    const curated = providerInfo(provider).models
    if (!liveIds) return curated
    const live = new Set(liveIds)
    const exclude = EXCLUDE[provider]
    const kept = curated.filter(m => live.has(m.id))
    const extra = liveIds
        .filter(id => !curated.some(m => m.id === id) && !(exclude?.test(id)))
        .sort()
        .map((id): ModelInfo => ({ id, label: tidyModelId(id), tools: true }))
    const merged: ModelInfo[] = [...kept, ...extra]
    // A key that lists none of the curated models still gets a sensible default.
    if (merged.length && !merged.some(m => m.recommended)) merged[0] = { ...merged[0], recommended: true }
    return merged.length ? merged : curated
}

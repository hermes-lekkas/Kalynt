/* SPDX-License-Identifier: AGPL-3.0-only */
import type { LocalServerInput, ModelInfo } from '../../src/types/aiProtocol'
import { getJson, ProviderError } from './http'

/** An explicit loopback connection, never an arbitrary server or redirect. */
export function normalizeLocalServerUrl(value: string): string {
    let url: URL
    try { url = new URL(value.trim()) } catch { throw new ProviderError('Enter a full local server URL, for example http://127.0.0.1:11434/v1.') }
    const local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname)
    if (!local || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new ProviderError('Use an HTTP or HTTPS loopback address (localhost, 127.0.0.1, or [::1]) without credentials, query parameters, or a fragment.')
    }
    if (url.pathname === '/') url.pathname = '/v1'
    return url.href.replace(/\/+$/, '')
}

export function localServerInput(input: LocalServerInput, previous?: LocalServerInput): Required<LocalServerInput> {
    if (!input || typeof input.baseUrl !== 'string' || (input.apiKey !== undefined && typeof input.apiKey !== 'string')) throw new ProviderError('Enter a local server URL.')
    const baseUrl = normalizeLocalServerUrl(input.baseUrl)
    // A saved token is reused only for exactly the same endpoint.
    const apiKey = input.apiKey?.trim() ?? (previous?.baseUrl === baseUrl ? previous.apiKey ?? '' : '')
    if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new ProviderError('The server token is not valid.')
    const contextWindow = input.contextWindow ?? previous?.contextWindow ?? 8192
    if (!Number.isInteger(contextWindow) || contextWindow < 4096 || contextWindow > 262144) throw new ProviderError('Choose a context window between 4,096 and 262,144 tokens to match your server.')
    return { baseUrl, apiKey, contextWindow }
}

export async function discoverLocalModels(input: LocalServerInput): Promise<ModelInfo[]> {
    const config = localServerInput(input)
    const data = await getJson(`${config.baseUrl}/models`, config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}, undefined, 'error')
    if (!data || !Array.isArray(data.data)) throw new ProviderError('The server did not return an OpenAI-compatible model list. Check the URL includes /v1.')
    const ids = [...new Set<string>(data.data.map((m: { id?: unknown }) => m?.id).filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0 && id.length < 512 && !/embed|rerank|\btts\b|whisper/i.test(id)))]
    if (!ids.length) throw new ProviderError('The server is reachable but has no models. Download a model in Ollama, or load one in LM Studio, then try again.')
    return ids.sort().map((id, index) => ({ id, label: id, recommended: index === 0, contextWindow: config.contextWindow }))
}

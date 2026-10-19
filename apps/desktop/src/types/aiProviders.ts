/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The cloud providers Kalynt supports and their current models. Shared by the
 * renderer (labels, pickers, settings) and the main process (endpoints).
 *
 * Model IDs come from each provider's documentation as of October 2026. The
 * app also asks each provider for its live model list (see electron/ai/models.ts),
 * so a retired ID here is hidden as soon as the provider stops listing it.
 * Check these lists against the providers' deprecation pages before a release.
 */
import type { Effort, ModelInfo, ProviderId } from './aiProtocol'

/** Which wire protocol a provider speaks. */
export type ProviderProtocol = 'anthropic' | 'openai-responses' | 'openai-chat' | 'gemini'

export interface ProviderInfo {
    id: ProviderId
    label: string
    /** Company or product name shown under the label. */
    vendor: string
    protocol: ProviderProtocol
    baseUrl: string
    keyPlaceholder: string
    consoleUrl: string
    /** Curated models, best first. The first `recommended` one is the default. */
    models: ModelInfo[]
}

export const PROVIDERS: ProviderInfo[] = [
    {
        id: 'anthropic',
        label: 'Claude',
        vendor: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        keyPlaceholder: 'sk-ant-…',
        consoleUrl: 'https://console.anthropic.com/settings/keys',
        models: [
            { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', recommended: true, tools: true, contextWindow: 1_000_000 },
            { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', tools: true, contextWindow: 1_000_000 },
            { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tools: true, contextWindow: 1_000_000 },
            { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', tools: true, contextWindow: 1_000_000 }
        ]
    },
    {
        id: 'openai',
        label: 'OpenAI',
        vendor: 'OpenAI',
        protocol: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        keyPlaceholder: 'sk-…',
        consoleUrl: 'https://platform.openai.com/api-keys',
        models: [
            { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', recommended: true, tools: true, contextWindow: 1_050_000 },
            { id: 'gpt-6-astra', label: 'GPT-6 Astra', tools: true, contextWindow: 1_050_000 },
            { id: 'gpt-6-luna', label: 'GPT-6 Luna', tools: true, contextWindow: 1_050_000 }
        ]
    },
    {
        id: 'google',
        label: 'Gemini',
        vendor: 'Google',
        protocol: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        keyPlaceholder: 'AIza…',
        consoleUrl: 'https://aistudio.google.com/app/apikey',
        models: [
            { id: 'gemini-4-argon', label: 'Gemini 4 Argon', recommended: true, tools: true, contextWindow: 1_000_000 },
            { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', tools: true, contextWindow: 1_000_000 },
            { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', tools: true, contextWindow: 1_000_000 }
        ]
    },
    {
        id: 'deepseek',
        label: 'DeepSeek',
        vendor: 'DeepSeek',
        protocol: 'openai-chat',
        baseUrl: 'https://api.deepseek.com',
        keyPlaceholder: 'sk-…',
        consoleUrl: 'https://platform.deepseek.com/api_keys',
        models: [
            { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', recommended: true, tools: true },
            { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', tools: true }
        ]
    },
    {
        id: 'moonshot',
        label: 'Kimi',
        vendor: 'Moonshot AI',
        protocol: 'openai-chat',
        baseUrl: 'https://api.moonshot.ai/v1',
        keyPlaceholder: 'sk-…',
        consoleUrl: 'https://platform.moonshot.ai/console/api-keys',
        models: [
            { id: 'kimi-k3', label: 'Kimi K3', recommended: true, tools: true, contextWindow: 1_000_000 }
        ]
    },
    {
        id: 'zai',
        label: 'GLM',
        vendor: 'Z.ai',
        protocol: 'openai-chat',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        keyPlaceholder: 'Your Z.ai API key',
        consoleUrl: 'https://z.ai/manage-apikey/apikey-list',
        models: [
            { id: 'glm-5.3', label: 'GLM-5.3', recommended: true, tools: true, contextWindow: 1_000_000 }
        ]
    }
]

export const PROVIDER_IDS = PROVIDERS.map(p => p.id)

export function providerInfo(id: ProviderId): ProviderInfo {
    const info = PROVIDERS.find(p => p.id === id)
    if (!info) throw new Error(`Unknown provider: ${id}`)
    return info
}

export const isProviderId = (value: unknown): value is ProviderId =>
    typeof value === 'string' && PROVIDERS.some(p => p.id === value)

/** The provider's default model. */
export function defaultModel(id: ProviderId): string {
    const { models } = providerInfo(id)
    return (models.find(m => m.recommended) ?? models[0]).id
}

const BRANDS: Record<string, string> = { claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', deepseek: 'DeepSeek', kimi: 'Kimi', glm: 'GLM', moonshot: 'Moonshot' }

/** "kimi-k2.7-code" -> "Kimi K2.7 Code", "claude-opus-5-5" -> "Claude Opus 5.5", "glm-5.3-flash" -> "GLM-5.3 Flash". */
export function tidyModelId(modelId: string): string {
    const words: string[] = []
    for (const part of modelId.split('-').filter(Boolean)) {
        const last = words[words.length - 1]
        if (/^\d+$/.test(part) && last && /(^|[^a-z])\d+$/i.test(last) && !last.includes('.')) words[words.length - 1] = `${last}.${part}`
        else if (/^\d/.test(part) && (last === 'GPT' || last === 'GLM')) words[words.length - 1] = `${last}-${part}`
        else words.push(BRANDS[part.toLowerCase()] ?? part.charAt(0).toUpperCase() + part.slice(1))
    }
    return words.join(' ')
}

/** Friendly name for a model ID, falling back to a tidied ID. */
export function modelLabel(modelId: string): string {
    for (const provider of PROVIDERS) {
        const known = provider.models.find(m => m.id === modelId)
        if (known) return known.label
    }
    return tidyModelId(modelId)
}

/** A quick, inexpensive model for small jobs such as inline completions. */
export function fastModel(id: ProviderId): string {
    const { models } = providerInfo(id)
    return (models.find(m => /haiku|luna|lite|flash/.test(m.id)) ?? models.find(m => m.recommended) ?? models[0]).id
}

/**
 * Effort the agent uses when the user hasn't picked one. Coding agents gain a
 * lot from deeper reasoning; small and fast models are run lighter.
 */
export function defaultEffort(provider: ProviderId, model: string): Effort {
    if (/haiku|luna|lite|flash/.test(model)) return 'medium'
    if (provider === 'anthropic' && /sonnet/.test(model)) return 'medium'
    return 'high'
}

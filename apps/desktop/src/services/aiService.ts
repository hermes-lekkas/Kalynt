/**
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Simple text requests to cloud models, for features other than the agent
 * (inline completions, task breakdown, code review, fixes). Requests go
 * through the main-process AI gateway (services/agent/aiClient), which holds
 * the API keys and speaks each provider's protocol.
 */
import type { Effort, ProviderId } from '../types/aiProtocol'
import { PROVIDER_IDS, defaultModel, isProviderId, providerInfo } from '../types/aiProviders'
import { chat as gatewayChat, verifyKey as gatewayVerify, AiRequestError } from './agent/aiClient'

export type AIProvider = ProviderId

export interface AIMessage {
    role: 'user' | 'assistant' | 'system'
    content: string
}

export type AIErrorType = 'network' | 'timeout' | 'auth' | 'rate_limit' | 'api' | 'unknown'

export interface AIResponse {
    content: string
    provider: AIProvider
    model: string
    error?: string
    errorType?: AIErrorType
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

export interface StreamCallbacks {
    onToken: (token: string) => void
    onComplete: (content: string) => void
    onError: (error: string) => void
}

export interface ChatOptions {
    model?: string
    maxTokens?: number
    temperature?: number
    /** Ask for deeper reasoning. */
    thinking?: boolean
}

/**
 * The provider for background features (task steps, completions): the one the
 * agent uses when it has a key, otherwise the first provider with a key.
 */
export function pickProvider(apiKeys: Partial<Record<ProviderId, boolean>>): AIProvider | null {
    try {
        const saved = JSON.parse(localStorage.getItem('kalynt-agent-model') || 'null')
        const provider: unknown = saved?.mode === 'cloud' ? saved.provider : null
        if (isProviderId(provider) && apiKeys[provider]) return provider
    } catch { /* fall through */ }
    return PROVIDER_IDS.find(p => !!apiKeys[p]) ?? null
}

/** Current models think before answering; small output limits would leave no room for the answer. */
const MIN_OUTPUT_TOKENS = 8000

function toRequest(messages: AIMessage[], provider: AIProvider, options?: ChatOptions) {
    const model = options?.model || defaultModel(provider)
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n') || 'You are a helpful assistant.'
    const items = messages.filter(m => m.role !== 'system').map(m => m.role === 'user'
        ? { role: 'user' as const, content: m.content }
        : { role: 'assistant' as const, text: m.content, toolCalls: [], provider, model })
    const effort: Effort = options?.thinking ? 'high' : 'low'
    return {
        model,
        request: { provider, model, system, items, effort, maxTokens: Math.max(options?.maxTokens ?? 0, MIN_OUTPUT_TOKENS), temperature: options?.temperature }
    }
}

function errorType(error: unknown): AIErrorType {
    if (!(error instanceof AiRequestError)) return 'unknown'
    const status = error.status
    if (status === 401 || status === 403) return 'auth'
    if (status === 429) return 'rate_limit'
    if (status === 408 || /timed? ?out/i.test(error.message)) return 'timeout'
    if (status && status >= 400) return 'api'
    return /reach|network|fetch/i.test(error.message) ? 'network' : 'unknown'
}

class AIService {
    private readonly controllers = new Set<AbortController>()

    getContextWindow(provider: AIProvider): number {
        const info = providerInfo(provider)
        return (info.models.find(m => m.recommended) ?? info.models[0])?.contextWindow ?? 128_000
    }

    async verifyKey(provider: AIProvider, key: string): Promise<boolean> {
        return (await gatewayVerify(provider, key)).ok
    }

    async chat(messages: AIMessage[], provider: AIProvider = 'anthropic', options?: ChatOptions): Promise<AIResponse> {
        const { model, request } = toRequest(messages, provider, options)
        const controller = new AbortController()
        this.controllers.add(controller)
        try {
            const result = await gatewayChat(request, () => {}, controller.signal)
            if (result.stopReason === 'refusal') return { content: '', provider, model, error: 'The model declined this request.', errorType: 'api' }
            return {
                content: result.assistant.text.trim(),
                provider,
                model: result.assistant.model,
                usage: result.usage ? {
                    promptTokens: result.usage.inputTokens,
                    completionTokens: result.usage.outputTokens,
                    totalTokens: result.usage.inputTokens + result.usage.outputTokens
                } : undefined
            }
        } catch (error) {
            return { content: '', provider, model, error: error instanceof Error ? error.message : String(error), errorType: errorType(error) }
        } finally {
            this.controllers.delete(controller)
        }
    }

    async chatStream(messages: AIMessage[], callbacks: StreamCallbacks, provider: AIProvider = 'anthropic', options?: ChatOptions): Promise<string> {
        const { request } = toRequest(messages, provider, options)
        const controller = new AbortController()
        this.controllers.add(controller)
        try {
            const result = await gatewayChat(request, event => { if (event.type === 'text') callbacks.onToken(event.delta) }, controller.signal)
            const text = result.assistant.text
            callbacks.onComplete(text)
            return text
        } catch (error) {
            if (!(error instanceof AiRequestError && error.aborted)) callbacks.onError(error instanceof Error ? error.message : String(error))
            return ''
        } finally {
            this.controllers.delete(controller)
        }
    }

    cancelStream() {
        for (const controller of this.controllers) controller.abort()
        this.controllers.clear()
    }
}

export const aiService = new AIService()

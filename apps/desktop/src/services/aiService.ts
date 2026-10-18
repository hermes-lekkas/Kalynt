/**
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { logger } from '../utils/logger'

export type AIProvider = 'openai' | 'anthropic' | 'google'

export interface AIMessage {
    role: 'user' | 'assistant' | 'system'
    content: string
}

// FIX BUG-010: Error types for better error handling and retry logic
export type AIErrorType = 'network' | 'timeout' | 'auth' | 'rate_limit' | 'api' | 'unknown'

export interface AIResponse {
    content: string
    provider: AIProvider
    model: string
    error?: string
    // FIX BUG-010: Add error type for distinguishing retriable vs permanent errors
    errorType?: AIErrorType
    usage?: {
        promptTokens: number
        completionTokens: number
        totalTokens: number
    }
}

export interface ImageGenerationResponse {
    url?: string
    base64?: string
    error?: string
}

export interface ChatOptions {
    model?: string
    maxTokens?: number
    temperature?: number
    thinking?: boolean
}

export interface StreamCallbacks {
    onToken: (token: string) => void
    onComplete: (content: string) => void
    onError: (error: string) => void
}

const PROVIDER_CONFIG = {
    openai: {
        baseUrl: 'https://api.openai.com/v1',
        contextWindow: 128000,
        models: {
            chat: 'gpt-4o-mini',
            chatPro: 'gpt-4o',
            image: 'dall-e-3'
        }
    },
    anthropic: {
        baseUrl: 'https://api.anthropic.com/v1',
        contextWindow: 200000,
        models: {
            chat: 'claude-haiku-5-5',
            chatPro: 'claude-sonnet-5-5',
            chatUltra: 'claude-opus-5-5'
        }
    },
    google: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        contextWindow: 1000000,
        models: {
            chat: 'gemini-2.5-flash',
            chatPro: 'gemini-2.5-pro',
            chatUltra: 'gemini-3.8-flash'
        }
    }
}

/**
 * Exported model lists per provider for UI dropdowns.
 * Single source of truth — do NOT duplicate these elsewhere.
 * Providers retire model IDs on a schedule (OpenAI, Anthropic and Google each
 * publish a deprecations page); check them before each release.
 */
export const PROVIDER_MODELS: Record<AIProvider, string[]> = {
    openai: ['gpt-4o', 'gpt-4o-mini'],
    anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    google: ['gemini-2.5-pro', 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-3.5-flash-lite']
}

/** Anthropic models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const ANTHROPIC_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5'])

/**
 * Current Claude and Gemini models think before answering, and those tokens
 * count against the output limit, so a small limit can leave no room for the
 * answer itself.
 */
const MIN_OUTPUT_TOKENS_WITH_THINKING = 16000

/** GPT-4-era chat models take `temperature`; reasoning models reject it. */
const openAIAcceptsTemperature = (model: string) => /^gpt-(4|3\.5)/.test(model)

/**
 * Reads a server-sent-events body line by line. Network chunks can end in the
 * middle of a line, so the unfinished tail is kept for the next chunk.
 */
async function readSSE(reader: ReadableStreamDefaultReader<Uint8Array>, onData: (data: string) => void): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
        const { done, value } = await reader.read()
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = done ? '' : lines.pop() ?? ''
        for (const line of lines) {
            if (line.startsWith('data: ')) onData(line.slice(6).trim())
        }
        if (done) return
    }
}

class AIService {
    private apiKeys: Record<string, string> = {}
    private readonly abortControllers: Map<string, AbortController> = new Map()

    getContextWindow(provider: AIProvider): number {
        // Return default context window for the provider
        // Ideally we map this by model, but provider-level default is a good start
        // as most modern models within a provider share similar large context windows
        switch (provider) {
            case 'openai': return PROVIDER_CONFIG.openai.contextWindow
            case 'anthropic': return PROVIDER_CONFIG.anthropic.contextWindow
            case 'google': return PROVIDER_CONFIG.google.contextWindow
            default: return 8192 // Safe fallback
        }
    }

    setAPIKey(provider: AIProvider, key: string) {
        this.apiKeys[provider] = key
    }

    removeAPIKey(provider: AIProvider) {
        delete this.apiKeys[provider]
    }

    hasKey(provider: AIProvider): boolean {
        return !!this.apiKeys[provider]
    }

    getAvailableProviders(): AIProvider[] {
        return Object.keys(this.apiKeys).filter(k => this.apiKeys[k]) as AIProvider[]
    }

    /**
     * Checks a key against the provider's model list: free, and independent of
     * which model IDs are still being served.
     */
    async verifyKey(provider: AIProvider, key: string): Promise<boolean> {
        try {
            let response: Response
            if (provider === 'openai') {
                response = await fetch(`${PROVIDER_CONFIG.openai.baseUrl}/models`, {
                    headers: { 'Authorization': `Bearer ${key}` }
                })
            } else if (provider === 'anthropic') {
                response = await fetch(`${PROVIDER_CONFIG.anthropic.baseUrl}/models?limit=1`, {
                    headers: {
                        'x-api-key': key,
                        'anthropic-version': '2023-06-01',
                        'anthropic-dangerous-direct-browser-access': 'true'
                    }
                })
            } else {
                response = await fetch(`${PROVIDER_CONFIG.google.baseUrl}/models?pageSize=1&key=${encodeURIComponent(key)}`)
            }
            if (!response.ok) throw new Error(`${provider} rejected the key: ${response.status}`)
            return true
        } catch (error) {
            logger.ai.warn(`API Key verification failed for ${provider}`, error)
            return false
        }
    }

    async chat(
        messages: AIMessage[],
        provider: AIProvider = 'openai',
        options?: ChatOptions
    ): Promise<AIResponse> {
        const key = this.apiKeys[provider]
        if (!key) {
            return { content: '', provider, model: '', error: `No API key for ${provider}` }
        }

        try {
            if (provider === 'openai') return await this.chatOpenAI(messages, key, options)
            if (provider === 'anthropic') return await this.chatAnthropic(messages, key, options)
            if (provider === 'google') return await this.chatGoogle(messages, key, options)
            return { content: '', provider, model: '', error: 'Unknown provider' }
        } catch (error) {
            // FIX BUG-010: Classify error type for better error handling
            const errorMessage = error instanceof Error ? error.message : 'Unknown error'
            let errorType: AIErrorType = 'unknown'

            // Classify based on error message patterns
            if (error instanceof TypeError || errorMessage.includes('fetch') || errorMessage.includes('network') || errorMessage.includes('Failed to fetch')) {
                errorType = 'network'
            } else if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
                errorType = 'timeout'
            } else if (errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('Unauthorized') || errorMessage.includes('Invalid API key')) {
                errorType = 'auth'
            } else if (errorMessage.includes('429') || errorMessage.includes('rate limit') || errorMessage.includes('Too Many Requests')) {
                errorType = 'rate_limit'
            } else if (errorMessage.includes('400') || errorMessage.includes('500') || errorMessage.includes('502') || errorMessage.includes('503')) {
                errorType = 'api'
            }

            return {
                content: '',
                provider,
                model: '',
                error: errorMessage,
                errorType
            }
        }
    }

    async chatStream(
        messages: AIMessage[],
        callbacks: StreamCallbacks,
        provider: AIProvider = 'openai',
        options?: ChatOptions
    ): Promise<string> {
        const key = this.apiKeys[provider]
        if (!key) {
            callbacks.onError(`No API key for ${provider}`)
            return ''
        }

        const requestId = crypto.randomUUID()
        const abortController = new AbortController()
        this.abortControllers.set(requestId, abortController)

        try {
            let fullContent = ''

            if (provider === 'openai') {
                fullContent = await this.streamOpenAI(messages, key, callbacks, abortController.signal, options)
            } else if (provider === 'anthropic') {
                fullContent = await this.streamAnthropic(messages, key, callbacks, abortController.signal, options)
            } else if (provider === 'google') {
                fullContent = await this.streamGoogle(messages, key, callbacks, abortController.signal, options)
            } else {
                callbacks.onError('Unknown provider')
            }

            callbacks.onComplete(fullContent)
            return fullContent
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                return ''
            }
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            callbacks.onError(errorMsg)
            return ''
        } finally {
            this.abortControllers.delete(requestId)
        }
    }

    cancelStream(requestId?: string) {
        if (requestId) {
            this.abortControllers.get(requestId)?.abort()
        } else {

            this.abortControllers.forEach(controller => controller.abort())
            this.abortControllers.clear()
        }
    }

    // ---- OpenAI ------------------------------------------------------------

    private openAIBody(messages: AIMessage[], options: ChatOptions | undefined, stream: boolean) {
        const model = options?.model || PROVIDER_CONFIG.openai.models.chat
        // max_completion_tokens works on every chat model; reasoning models reject max_tokens.
        const body: Record<string, unknown> = {
            model,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            max_completion_tokens: options?.maxTokens || 2048
        }
        if (openAIAcceptsTemperature(model)) body.temperature = options?.temperature ?? 0.7
        else if (options?.thinking) body.reasoning_effort = 'high'
        if (stream) body.stream = true
        return { model, body }
    }

    private async streamOpenAI(
        messages: AIMessage[],
        apiKey: string,
        callbacks: StreamCallbacks,
        signal: AbortSignal,
        options?: ChatOptions
    ): Promise<string> {
        const { body } = this.openAIBody(messages, options, true)

        // Give up if the server sends nothing for 60 seconds.
        const timeoutController = new AbortController()
        const timeoutId = setTimeout(() => timeoutController.abort(), 60000)
        const handleAbort = () => timeoutController.abort()
        signal.addEventListener('abort', handleAbort)

        try {
            const response = await fetch(`${PROVIDER_CONFIG.openai.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(body),
                signal: timeoutController.signal
            })

            if (!response.ok) {
                const error = await response.json().catch(() => ({}))
                throw new Error(error.error?.message || `OpenAI API error: ${response.status}`)
            }

            const reader = response.body?.getReader()
            if (!reader) throw new Error('No response body')

            let fullContent = ''
            await readSSE(reader, data => {
                if (data === '[DONE]') return
                try {
                    const token = JSON.parse(data).choices?.[0]?.delta?.content || ''
                    if (token) {
                        fullContent += token
                        callbacks.onToken(token)
                    }
                } catch (error) {
                    logger.ai.debug('Failed to parse OpenAI stream chunk', { data, error })
                }
            })
            return fullContent
        } finally {
            clearTimeout(timeoutId)
            signal.removeEventListener('abort', handleAbort)
        }
    }

    private async chatOpenAI(messages: AIMessage[], apiKey: string, options?: ChatOptions): Promise<AIResponse> {
        const { model, body } = this.openAIBody(messages, options, false)

        const response = await fetch(`${PROVIDER_CONFIG.openai.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body)
        })

        if (!response.ok) {
            const error = await response.json().catch(() => ({}))
            throw new Error(error.error?.message || `OpenAI API error: ${response.status}`)
        }

        const data = await response.json()
        return {
            content: data.choices?.[0]?.message?.content || '',
            provider: 'openai',
            model,
            usage: data.usage ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens
            } : undefined
        }
    }

    // ---- Anthropic ---------------------------------------------------------

    /**
     * Current Claude models always think (adaptively), so the response can
     * start with thinking blocks and `max_tokens` must leave room for them.
     * Small requested limits mean "a short, quick answer", so effort drops to low.
     */
    private anthropicRequest(messages: AIMessage[], apiKey: string, options: ChatOptions | undefined, stream: boolean) {
        const model = options?.model || PROVIDER_CONFIG.anthropic.models.chat
        const systemMsg = messages.find(m => m.role === 'system')
        const requested = options?.maxTokens || 2048

        const body: Record<string, unknown> = {
            model,
            max_tokens: Math.max(requested, MIN_OUTPUT_TOKENS_WITH_THINKING),
            system: systemMsg?.content || 'You are a helpful AI assistant.',
            messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }))
        }
        if (options?.thinking) body.thinking = { type: 'adaptive' }
        else if (requested < 4096) body.output_config = { effort: 'low' }
        if (stream) body.stream = true

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        }
        // If a safety classifier declines the request, Anthropic re-runs it on
        // the model it recommends for that case instead of returning a refusal.
        if (ANTHROPIC_FALLBACK_MODELS.has(model)) {
            body.fallbacks = 'default'
            headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'
        }
        return { model, body, headers }
    }

    private async streamAnthropic(
        messages: AIMessage[],
        apiKey: string,
        callbacks: StreamCallbacks,
        signal: AbortSignal,
        options?: ChatOptions
    ): Promise<string> {
        const { body, headers } = this.anthropicRequest(messages, apiKey, options, true)

        const response = await fetch(`${PROVIDER_CONFIG.anthropic.baseUrl}/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal
        })

        if (!response.ok) {
            const error = await response.json().catch(() => ({}))
            throw new Error(error.error?.message || `Anthropic API error: ${response.status}`)
        }

        const reader = response.body?.getReader()
        if (!reader) throw new Error('No response body')

        let fullContent = ''
        let refused = false
        await readSSE(reader, data => {
            try {
                const json = JSON.parse(data)
                if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
                    const token = json.delta.text || ''
                    if (token) {
                        fullContent += token
                        callbacks.onToken(token)
                    }
                } else if (json.type === 'message_delta' && json.delta?.stop_reason === 'refusal') {
                    refused = true
                } else if (json.type === 'error') {
                    throw new Error(json.error?.message || 'Anthropic stream error')
                }
            } catch (error) {
                if (error instanceof SyntaxError) logger.ai.debug('Failed to parse Anthropic stream chunk', { data, error })
                else throw error
            }
        })
        if (refused) throw new Error('Claude declined this request. Rephrase it or choose another model.')
        return fullContent
    }

    private async chatAnthropic(messages: AIMessage[], apiKey: string, options?: ChatOptions): Promise<AIResponse> {
        const { model, body, headers } = this.anthropicRequest(messages, apiKey, options, false)

        const response = await fetch(`${PROVIDER_CONFIG.anthropic.baseUrl}/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        })

        if (!response.ok) {
            const error = await response.json().catch(() => ({}))
            throw new Error(error.error?.message || `Anthropic API error: ${response.status}`)
        }

        const data = await response.json()
        if (data.stop_reason === 'refusal') throw new Error('Claude declined this request. Rephrase it or choose another model.')
        // Read text blocks by type: thinking (and fallback marker) blocks can come first.
        const blocks: Array<{ type: string; text?: string }> = Array.isArray(data.content) ? data.content : []
        return {
            content: blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join(''),
            provider: 'anthropic',
            model: data.model || model,
            usage: data.usage ? {
                promptTokens: data.usage.input_tokens,
                completionTokens: data.usage.output_tokens,
                totalTokens: data.usage.input_tokens + data.usage.output_tokens
            } : undefined
        }
    }

    // ---- Google ------------------------------------------------------------

    private googleBody(messages: AIMessage[], options: ChatOptions | undefined) {
        const systemInstruction = messages.find(m => m.role === 'system')
        return {
            contents: messages
                .filter(m => m.role !== 'system')
                .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
            systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction.content }] } : undefined,
            generationConfig: {
                // Gemini 2.5 and later think too, within the same output limit.
                maxOutputTokens: Math.max(options?.maxTokens || 2048, MIN_OUTPUT_TOKENS_WITH_THINKING),
                temperature: options?.temperature ?? 0.7
            }
        }
    }

    /** Answer text of a Gemini candidate, skipping thought-summary parts. */
    private static googleText(json: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }): string {
        return (json.candidates?.[0]?.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join('')
    }

    private async streamGoogle(
        messages: AIMessage[],
        apiKey: string,
        callbacks: StreamCallbacks,
        signal: AbortSignal,
        options?: ChatOptions
    ): Promise<string> {
        const model = options?.model || PROVIDER_CONFIG.google.models.chat

        const response = await fetch(
            `${PROVIDER_CONFIG.google.baseUrl}/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.googleBody(messages, options)),
                signal
            }
        )

        if (!response.ok) {
            const error = await response.json().catch(() => ({}))
            throw new Error(error.error?.message || `Google AI error: ${response.status}`)
        }

        const reader = response.body?.getReader()
        if (!reader) throw new Error('No response body')

        let fullContent = ''
        await readSSE(reader, data => {
            try {
                const token = AIService.googleText(JSON.parse(data))
                if (token) {
                    fullContent += token
                    callbacks.onToken(token)
                }
            } catch (error) {
                logger.ai.debug('Failed to parse Google stream chunk', { data, error })
            }
        })
        return fullContent
    }

    private async chatGoogle(messages: AIMessage[], apiKey: string, options?: ChatOptions): Promise<AIResponse> {
        const model = options?.model || PROVIDER_CONFIG.google.models.chat

        const response = await fetch(
            `${PROVIDER_CONFIG.google.baseUrl}/models/${model}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.googleBody(messages, options))
            }
        )

        if (!response.ok) {
            const error = await response.json().catch(() => ({}))
            throw new Error(error.error?.message || `Google AI error: ${response.status}`)
        }

        const data = await response.json()
        return {
            content: AIService.googleText(data),
            provider: 'google',
            model,
            usage: data.usageMetadata ? {
                promptTokens: data.usageMetadata.promptTokenCount || 0,
                completionTokens: data.usageMetadata.candidatesTokenCount || 0,
                totalTokens: data.usageMetadata.totalTokenCount || 0
            } : undefined
        }
    }

    async generateImage(
        prompt: string,
        options?: { size?: string; quality?: string }
    ): Promise<ImageGenerationResponse> {
        const key = this.apiKeys.openai
        if (!key) {
            return { error: 'OpenAI API key required for image generation' }
        }

        try {
            const response = await fetch(`${PROVIDER_CONFIG.openai.baseUrl}/images/generations`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                body: JSON.stringify({
                    model: 'dall-e-3',
                    prompt,
                    n: 1,
                    size: options?.size || '1024x1024',
                    quality: options?.quality || 'standard',
                    response_format: 'url'
                })
            })

            if (!response.ok) {
                const error = await response.json().catch(() => ({}))
                throw new Error(error.error?.message || `DALL-E error: ${response.status}`)
            }

            const data = await response.json()
            return { url: data.data[0]?.url }
        } catch (error) {
            return { error: error instanceof Error ? error.message : 'Image generation failed' }
        }
    }

    async summarize(text: string, provider: AIProvider = 'openai'): Promise<string> {
        const response = await this.chat([
            { role: 'system', content: 'Summarize the following text concisely.' },
            { role: 'user', content: text }
        ], provider)
        return response.content || response.error || ''
    }

    async fixGrammar(text: string, provider: AIProvider = 'openai'): Promise<string> {
        const response = await this.chat([
            { role: 'system', content: 'Fix any grammar and spelling errors in this text. Return only the corrected text.' },
            { role: 'user', content: text }
        ], provider)
        return response.content || response.error || ''
    }

    async generateCode(prompt: string, language: string, provider: AIProvider = 'openai'): Promise<string> {
        const response = await this.chat([
            { role: 'system', content: `You are a helpful coding assistant. Generate ${language} code based on the user's request. Return only code, no explanations.` },
            { role: 'user', content: prompt }
        ], provider)
        return response.content || response.error || ''
    }

    async expandText(text: string, provider: AIProvider = 'openai'): Promise<string> {
        const response = await this.chat([
            { role: 'system', content: 'Expand and elaborate on the following text while maintaining its tone and style.' },
            { role: 'user', content: text }
        ], provider)
        return response.content || response.error || ''
    }
}

export const aiService = new AIService()

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * OpenAI-compatible Chat Completions, as spoken by DeepSeek, Kimi (Moonshot)
 * and GLM (Z.ai). All three are reasoning models that return their thinking
 * as `reasoning_content`; in tool-calling conversations that field must be
 * sent back on every earlier assistant turn (DeepSeek rejects the request
 * otherwise, Kimi asks for the complete assistant message).
 */
import type { AssistantItem, ChatRequest, ChatResult, ConversationItem, Effort, ProviderId, StreamEvent } from '../../src/types/aiProtocol'
import { providerInfo } from '../../src/types/aiProviders'
import { parseArguments, postJson, ProviderError, readSse, TruncatedStreamError } from './http'

/** Reasoning effort mapping for OpenAI-compatible reasoning providers. */
const EFFORT: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', max: 'max' }

/** Per-provider request fields. Sampling parameters are left out: all three ignore or reject them while thinking. */
function providerParams(provider: ProviderId, request: ChatRequest): Record<string, unknown> {
    const maxTokens = request.maxTokens ?? (provider === 'local-server' ? 4096 : 32000)
    const effort = request.effort ? { reasoning_effort: EFFORT[request.effort] } : {}
    switch (provider) {
        case 'moonshot':
            return { max_completion_tokens: maxTokens, ...effort }
        case 'zai':
            return { max_tokens: maxTokens, thinking: { type: 'enabled' }, ...effort }
        case 'deepseek':
            return { max_tokens: maxTokens, ...effort }
        default:
            return { max_tokens: maxTokens }
    }
}

interface RawTurn {
    reasoning_content?: string
}

function toMessages(system: string, items: ConversationItem[], provider: ProviderId): unknown[] {
    const messages: unknown[] = [{ role: 'system', content: system }]
    for (const item of items) {
        if (item.role === 'user') messages.push({ role: 'user', content: item.content })
        else if (item.role === 'assistant') {
            const sameProvider = item.provider === provider
            const rawReasoning = sameProvider ? (item.raw as RawTurn | undefined)?.reasoning_content ?? item.reasoning : undefined
            const includeReasoning = provider !== 'local-server' && sameProvider && typeof rawReasoning === 'string' && rawReasoning.length > 0
            messages.push({
                role: 'assistant',
                content: item.text,
                ...(includeReasoning ? { reasoning_content: rawReasoning } : {}),
                ...(item.toolCalls.length ? {
                    tool_calls: item.toolCalls.map(call => ({
                        id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) }
                    }))
                } : {})
            })
        } else {
            messages.push({ role: 'tool', tool_call_id: item.callId, content: item.content || '(no output)' })
        }
    }
    return messages
}

export interface ChatCompletionsOptions {
    apiKey: string
    baseUrl: string
    signal: AbortSignal
    emit: (event: StreamEvent) => void
}

interface PartialCall {
    id: string
    name: string
    args: string
}

export async function streamChatCompletions(request: ChatRequest, options: ChatCompletionsOptions): Promise<ChatResult> {
    const body = {
        model: request.model,
        messages: toMessages(request.system, request.items, request.provider),
        stream: true,
        ...(request.provider === 'local-server' ? {} : { stream_options: { include_usage: true } }),
        ...providerParams(request.provider, request),
        ...(request.tools?.length ? {
            tools: request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
        } : {})
    }

    if (request.provider === 'local-server') {
        // Reserve space for tool schemas and output as well as the transcript.
        // This is a conservative estimate; the inference server is authoritative.
        const inputEstimate = Math.ceil(JSON.stringify({ messages: body.messages, tools: request.tools ?? [] }).length / 3) + 256
        const available = (request.contextWindow ?? 8192) - inputEstimate
        if (available < 256) throw new ProviderError('This request is too large for the local server context. Start a shorter conversation, attach fewer files, or increase the context in both your server and Kalynt settings.')
        Object.assign(body, { max_tokens: Math.min(request.maxTokens ?? 2048, available, 4096) })
    }

    const response = await postJson(`${options.baseUrl}/chat/completions`, body, options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}, options.signal, request.provider === 'local-server' ? 'error' : 'follow')
    let text = ''
    let reasoning = ''
    let sawReasoning = false
    let emittedAny = false
    let sawDone = false
    let finish = null as string | null
    let usage = null as { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; cached_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null
    let model = request.model
    const calls = new Map<number, PartialCall>()
    const providerLabel = providerInfo(request.provider).label

    const emit = (event: StreamEvent) => {
        emittedAny = true
        options.emit(event)
    }

    const buildResult = (stopReason: ChatResult['stopReason']): ChatResult => {
        const toolCalls: AssistantItem['toolCalls'] = [...calls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, call]) => {
                const { args, error } = parseArguments(call.args)
                return { id: call.id, name: call.name, arguments: args, ...(error ? { argumentsError: error } : {}) }
            })

        const u = usage
        return {
            assistant: {
                role: 'assistant', text, toolCalls,
                reasoning: reasoning.trim() || undefined,
                provider: request.provider, model,
                ...(sawReasoning ? { raw: { reasoning_content: reasoning } satisfies RawTurn } : {})
            },
            stopReason,
            usage: u ? {
                inputTokens: u.prompt_tokens ?? 0,
                outputTokens: u.completion_tokens ?? 0,
                cacheReadTokens: u.prompt_cache_hit_tokens ?? u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens
            } : undefined
        }
    }

    const resolveCallIndex = (part: { index?: unknown; id?: unknown; function?: { name?: unknown } }): number => {
        if (typeof part.index === 'number') return part.index
        if (typeof part.id === 'string' && part.id) {
            for (const [idx, existing] of calls.entries()) {
                if (existing.id === part.id) return idx
            }
            return calls.size
        }
        if (calls.size === 0) return 0
        const lastIndex = calls.size - 1
        const lastCall = calls.get(lastIndex)
        if (typeof part.function?.name === 'string' && part.function.name && lastCall?.name) {
            return calls.size
        }
        return lastIndex
    }

    try {
        await readSse(response, ({ data }) => {
            if (data.trim() === '[DONE]') {
                sawDone = true
                return
            }
            let chunk: any
            try { chunk = JSON.parse(data) } catch { return }
            if (chunk.error) throw new ProviderError(chunk.error.message ?? 'The provider reported an error.')
            if (chunk.model) model = chunk.model
            if (chunk.usage) usage = chunk.usage
            const choice = chunk.choices?.[0]
            if (!choice) return
            const delta = choice.delta ?? {}
            const thought = delta.reasoning_content ?? delta.reasoning
            if (typeof thought === 'string' && thought) {
                sawReasoning = true
                reasoning += thought
                emit({ type: 'reasoning', delta: thought })
            }
            if (typeof delta.content === 'string' && delta.content) {
                text += delta.content
                emit({ type: 'text', delta: delta.content })
            }
            for (const part of delta.tool_calls ?? []) {
                const index = resolveCallIndex(part)
                let call = calls.get(index)
                if (!call) {
                    call = { id: part.id || `call_${index}_${Date.now().toString(36)}`, name: part.function?.name ?? '', args: '' }
                    calls.set(index, call)
                    if (call.name) emit({ type: 'tool-call-start', id: call.id, name: call.name })
                } else if (part.function?.name && !call.name) {
                    call.name = part.function.name
                    emit({ type: 'tool-call-start', id: call.id, name: call.name })
                }
                const args = part.function?.arguments
                if (typeof args === 'string' && args) {
                    call.args += args
                    emit({ type: 'tool-call-delta', id: call.id, delta: args })
                } else if (args && typeof args === 'object') {
                    // Some providers send arguments as an object instead of a string.
                    call.args = JSON.stringify(args)
                }
            }
            if (typeof choice.finish_reason === 'string' && choice.finish_reason) finish = choice.finish_reason
        })
    } catch (error) {
        if (options.signal.aborted || error instanceof ProviderError) throw error
        if (!emittedAny) {
            throw new ProviderError(`${providerLabel} connection was interrupted before any output arrived. Try again.`, undefined, true)
        }
        const partial = buildResult('end')
        throw new TruncatedStreamError(
            `${providerLabel} stream was interrupted before finishing. Partial output was preserved — try again or ask to continue.`,
            partial,
            false
        )
    }

    const preliminary = buildResult('end')
    const hasMalformedToolArgs = preliminary.assistant.toolCalls.some(c => Boolean(c.argumentsError))
    const sawTerminal = Boolean(finish) || (sawDone && !hasMalformedToolArgs)

    if (!sawTerminal) {
        if (!emittedAny) {
            throw new TruncatedStreamError(
                `${providerLabel} ended the stream before sending any output. Try again.`,
                preliminary,
                true
            )
        }
        throw new TruncatedStreamError(
            `${providerLabel} ended the response early before finishing. Partial output was preserved — try again or ask to continue.`,
            preliminary,
            false
        )
    }

    const stopReason: ChatResult['stopReason'] = finish === 'length' ? 'max_tokens'
        : finish === 'content_filter' || finish === 'sensitive' ? 'refusal'
            : preliminary.assistant.toolCalls.length ? 'tool_use' : 'end'

    return {
        ...preliminary,
        stopReason
    }
}

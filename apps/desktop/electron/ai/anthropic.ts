/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Claude through the official Anthropic SDK: streaming Messages API with
 * client tools, adaptive thinking and server-side refusal fallbacks.
 *
 * Conversations are append-only. Earlier assistant turns are sent back exactly
 * as Claude returned them (thinking blocks included), and the system prompt and
 * tool list stay fixed for a conversation, so thinking blocks stay valid
 * ("preserved thinking"). As a safety net, a block that no longer matches its
 * conversation is dropped instead of failing the request.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { AssistantItem, ChatRequest, ChatResult, ConversationItem, StopReason, StreamEvent } from '../../src/types/aiProtocol'
import { ProviderError } from './http'

type Block = Anthropic.Beta.BetaContentBlock
type MessageParam = Anthropic.Beta.BetaMessageParam

/** Opus, Sonnet and Fable support server-side fallbacks; Haiku has none. */
const FALLBACK_MODELS = /^claude-(opus|sonnet|fable)-/
const BETAS = {
    fallback: 'server-side-fallback-2026-07-01',
    binding: 'thinking-binding-controls-2026-08-01'
} as const

/**
 * After a mid-output fallback, thinking and unfinished tool calls from before
 * the last fallback marker must not be echoed back; text before it may be.
 */
function sanitizeForReplay(blocks: Block[]): Block[] {
    const lastFallback = blocks.map(b => b.type).lastIndexOf('fallback' as Block['type'])
    if (lastFallback < 0) return blocks
    return blocks.filter((b, i) => i > lastFallback || b.type === 'text')
}

function toMessages(items: ConversationItem[]): MessageParam[] {
    const messages: MessageParam[] = []
    for (const item of items) {
        if (item.role === 'user') {
            messages.push({ role: 'user', content: item.content })
        } else if (item.role === 'assistant') {
            if (item.provider === 'anthropic' && Array.isArray(item.raw) && item.raw.length > 0) {
                messages.push({ role: 'assistant', content: item.raw as MessageParam['content'] })
                continue
            }
            const content: Anthropic.Beta.BetaContentBlockParam[] = []
            if (item.text.trim()) content.push({ type: 'text', text: item.text })
            for (const call of item.toolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })
            messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no reply)' }] })
        } else {
            const block: Anthropic.Beta.BetaToolResultBlockParam = {
                type: 'tool_result',
                tool_use_id: item.callId,
                content: item.content || '(no output)',
                ...(item.isError ? { is_error: true } : {})
            }
            // All results for one assistant turn go back in a single user message.
            const last = messages[messages.length - 1]
            if (last?.role === 'user' && Array.isArray(last.content) && last.content.every(b => b.type === 'tool_result')) {
                (last.content as Anthropic.Beta.BetaToolResultBlockParam[]).push(block)
            } else {
                messages.push({ role: 'user', content: [block] })
            }
        }
    }
    return messages
}

const STOP: Record<string, StopReason> = {
    end_turn: 'end', stop_sequence: 'end', tool_use: 'tool_use', max_tokens: 'max_tokens',
    refusal: 'refusal', model_context_window_exceeded: 'max_tokens'
}

export interface AnthropicOptions {
    apiKey: string
    baseURL?: string
    signal: AbortSignal
    emit: (event: StreamEvent) => void
}

export async function streamAnthropic(request: ChatRequest, options: AnthropicOptions): Promise<ChatResult> {
    const client = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL, maxRetries: 2 })
    const fallback = FALLBACK_MODELS.test(request.model)
    const betas = [BETAS.binding, ...(fallback ? [BETAS.fallback] : [])]

    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
        model: request.model,
        max_tokens: request.maxTokens ?? 64000,
        system: request.system,
        messages: toMessages(request.items),
        // Caches the conversation prefix; agent loops resend it on every step.
        cache_control: { type: 'ephemeral' },
        thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        betas,
        stream: true,
        ...(request.effort ? { output_config: { effort: request.effort } } : {}),
        ...(fallback ? { fallbacks: 'default' } : {}),
        ...(request.tools?.length ? {
            tools: request.tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters as Anthropic.Beta.BetaTool['input_schema'],
                eager_input_streaming: true
            }))
        } : {})
    } as Anthropic.Beta.MessageCreateParamsStreaming

    // A tool input that can't be parsed at all rejects finalMessage(); re-issue
    // the turn (at most twice). API errors are never retried here.
    for (let attempt = 0; ; attempt++) {
        const toolIds = new Map<number, string>()
        const stream = client.beta.messages.stream(params, { signal: options.signal })
        try {
            for await (const event of stream) {
                if (event.type === 'content_block_start') {
                    const block = event.content_block
                    if (block.type === 'tool_use') {
                        toolIds.set(event.index, block.id)
                        options.emit({ type: 'tool-call-start', id: block.id, name: block.name })
                    } else if ((block.type as string) === 'fallback') {
                        const to = (block as unknown as { to?: { model?: string } }).to?.model
                        options.emit({ type: 'notice', message: to ? `Continued on ${to} after a safety check.` : 'Continued on another model after a safety check.' })
                    }
                } else if (event.type === 'content_block_delta') {
                    const delta = event.delta
                    if (delta.type === 'text_delta') options.emit({ type: 'text', delta: delta.text })
                    else if (delta.type === 'thinking_delta') options.emit({ type: 'reasoning', delta: delta.thinking })
                    else if (delta.type === 'input_json_delta') {
                        const id = toolIds.get(event.index)
                        if (id) options.emit({ type: 'tool-call-delta', id, delta: delta.partial_json })
                    }
                }
            }
            const message = await stream.finalMessage()
            return toResult(message, request)
        } catch (error) {
            if (options.signal.aborted) throw error
            if (error instanceof Anthropic.APIError) {
                const status = typeof error.status === 'number' ? error.status : undefined
                const retryable = error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError || error instanceof Anthropic.APIConnectionError
                throw new ProviderError(cleanApiMessage(error), status, retryable)
            }
            if (attempt >= 2) throw error
            console.warn('[AI] Claude sent tool input that was not valid JSON; re-issuing the turn')
        }
    }
}

function toResult(message: Anthropic.Beta.BetaMessage, request: ChatRequest): ChatResult {
    const blocks = sanitizeForReplay(message.content)
    let text = ''
    let reasoning = ''
    const toolCalls: AssistantItem['toolCalls'] = []
    for (const block of blocks) {
        if (block.type === 'text') text += block.text
        else if (block.type === 'thinking') reasoning += (reasoning ? '\n\n' : '') + block.thinking
        else if (block.type === 'tool_use') {
            const input = block.input
            const valid = input !== null && typeof input === 'object' && !Array.isArray(input)
            toolCalls.push({
                id: block.id,
                name: block.name,
                arguments: valid ? input as Record<string, unknown> : {},
                ...(valid ? {} : { argumentsError: 'Tool input was not a JSON object.' })
            })
        }
    }
    const stopReason = STOP[message.stop_reason ?? ''] ?? (toolCalls.length ? 'tool_use' : 'end')
    return {
        assistant: {
            role: 'assistant',
            text,
            toolCalls,
            reasoning: reasoning.trim() || undefined,
            provider: 'anthropic',
            model: message.model || request.model,
            raw: blocks
        },
        stopReason,
        usage: {
            inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0),
            outputTokens: message.usage.output_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens ?? undefined
        }
    }
}

/** The SDK prefixes messages with the status and raw JSON; keep the human part. */
function cleanApiMessage(error: InstanceType<typeof Anthropic.APIError>): string {
    const body = (error as { error?: { error?: { message?: string } } }).error
    return body?.error?.message ?? error.message
}

export async function listAnthropicModels(apiKey: string, baseURL?: string): Promise<string[]> {
    const client = new Anthropic({ apiKey, baseURL, maxRetries: 1 })
    const ids: string[] = []
    for await (const model of client.models.list({ limit: 100 })) ids.push(model.id)
    return ids
}

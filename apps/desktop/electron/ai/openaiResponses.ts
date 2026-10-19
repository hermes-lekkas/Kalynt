/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * OpenAI through the Responses API, which current GPT models need for tool
 * calling. Requests are stateless (`store: false`): nothing is kept on
 * OpenAI's side, so each turn's output items, including encrypted reasoning,
 * are sent back with the next request.
 */
import type { AssistantItem, ChatRequest, ChatResult, ConversationItem, StreamEvent } from '../../src/types/aiProtocol'
import { parseArguments, postJson, ProviderError, readSse } from './http'

interface ResponseItem {
    type: string
    id?: string
    role?: string
    call_id?: string
    name?: string
    arguments?: string
    content?: Array<{ type: string; text?: string; refusal?: string }>
    summary?: Array<{ type: string; text: string }>
    encrypted_content?: string
}

/** Reasoning models take `reasoning`; GPT-4-era models take `temperature`. */
const isReasoningModel = (model: string) => /^(gpt-([5-9]|\d{2})|o\d)/.test(model)

/**
 * Output items go back as input. With `store: false` the server has no copy,
 * so ids are dropped (except on reasoning items, which carry their encrypted
 * content) to avoid "item not found" errors.
 */
function replayItems(raw: ResponseItem[]): unknown[] {
    const out: unknown[] = []
    for (const item of raw) {
        if (item.type === 'reasoning') {
            if (item.encrypted_content) out.push({ type: 'reasoning', id: item.id, summary: item.summary ?? [], encrypted_content: item.encrypted_content })
        } else if (item.type === 'function_call') {
            out.push({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments ?? '{}' })
        } else if (item.type === 'message') {
            const text = (item.content ?? []).map(c => c.text ?? '').join('')
            if (text) out.push({ role: 'assistant', content: text })
        }
    }
    return out
}

function toInput(items: ConversationItem[]): unknown[] {
    const input: unknown[] = []
    for (const item of items) {
        if (item.role === 'user') input.push({ role: 'user', content: item.content })
        else if (item.role === 'assistant') {
            if (item.provider === 'openai' && Array.isArray(item.raw)) {
                input.push(...replayItems(item.raw as ResponseItem[]))
                continue
            }
            if (item.text.trim()) input.push({ role: 'assistant', content: item.text })
            for (const call of item.toolCalls) {
                input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })
            }
        } else {
            input.push({ type: 'function_call_output', call_id: item.callId, output: item.content || '(no output)' })
        }
    }
    return input
}

const EFFORT = { low: 'low', medium: 'medium', high: 'high', max: 'max' } as const

export interface OpenAIOptions {
    apiKey: string
    baseUrl: string
    signal: AbortSignal
    emit: (event: StreamEvent) => void
}

export async function streamOpenAIResponses(request: ChatRequest, options: OpenAIOptions): Promise<ChatResult> {
    const reasoning = isReasoningModel(request.model)
    const body: Record<string, unknown> = {
        model: request.model,
        instructions: request.system,
        input: toInput(request.items),
        stream: true,
        store: false,
        max_output_tokens: request.maxTokens ?? 64000,
        ...(reasoning
            ? { include: ['reasoning.encrypted_content'], reasoning: { effort: EFFORT[request.effort ?? 'medium'], summary: 'auto' } }
            : { temperature: request.temperature ?? 0.3 }),
        ...(request.tools?.length ? {
            tools: request.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
            parallel_tool_calls: true
        } : {})
    }

    const response = await postJson(`${options.baseUrl}/responses`, body, { Authorization: `Bearer ${options.apiKey}` }, options.signal)
    const callIds = new Map<string, string>()
    let final = null as { output?: ResponseItem[]; usage?: any; status?: string; incomplete_details?: { reason?: string } } | null
    let failure = null as string | null

    await readSse(response, ({ data }) => {
        if (data === '[DONE]') return
        let event: any
        try { event = JSON.parse(data) } catch { return }
        switch (event.type) {
            case 'response.output_text.delta':
                options.emit({ type: 'text', delta: event.delta ?? '' })
                break
            case 'response.reasoning_summary_text.delta':
                options.emit({ type: 'reasoning', delta: event.delta ?? '' })
                break
            case 'response.reasoning_summary_part.added':
                if (event.summary_index > 0) options.emit({ type: 'reasoning', delta: '\n\n' })
                break
            case 'response.output_item.added':
                if (event.item?.type === 'function_call') {
                    callIds.set(event.item.id, event.item.call_id)
                    options.emit({ type: 'tool-call-start', id: event.item.call_id, name: event.item.name })
                }
                break
            case 'response.function_call_arguments.delta': {
                const id = callIds.get(event.item_id)
                if (id) options.emit({ type: 'tool-call-delta', id, delta: event.delta ?? '' })
                break
            }
            case 'response.completed':
            case 'response.incomplete':
                final = event.response
                break
            case 'response.failed':
                failure = event.response?.error?.message ?? 'OpenAI could not complete the response.'
                break
            case 'error':
                failure = event.message ?? event.error?.message ?? 'OpenAI reported an error.'
                break
        }
    })

    if (failure) throw new ProviderError(failure)
    if (!final) throw new ProviderError('OpenAI ended the response early. Try again.', undefined, true)
    return toResult(final, request)
}

function toResult(response: { output?: ResponseItem[]; usage?: any; status?: string; incomplete_details?: { reason?: string } }, request: ChatRequest): ChatResult {
    const output = response.output ?? []
    let text = ''
    let refused = false
    const summaries: string[] = []
    const toolCalls: AssistantItem['toolCalls'] = []
    for (const item of output) {
        if (item.type === 'message') {
            for (const part of item.content ?? []) {
                if (part.type === 'output_text') text += part.text ?? ''
                else if (part.type === 'refusal') { refused = true; text += part.refusal ?? '' }
            }
        } else if (item.type === 'reasoning') {
            for (const s of item.summary ?? []) if (s.text) summaries.push(s.text)
        } else if (item.type === 'function_call') {
            const { args, error } = parseArguments(item.arguments)
            toolCalls.push({ id: item.call_id ?? item.id ?? '', name: item.name ?? '', arguments: args, ...(error ? { argumentsError: error } : {}) })
        }
    }
    const incomplete = response.status === 'incomplete' ? response.incomplete_details?.reason : undefined
    return {
        assistant: {
            role: 'assistant', text, toolCalls,
            reasoning: summaries.join('\n\n') || undefined,
            provider: 'openai', model: request.model, raw: output
        },
        stopReason: refused || incomplete === 'content_filter' ? 'refusal'
            : incomplete === 'max_output_tokens' ? 'max_tokens'
                : toolCalls.length ? 'tool_use' : 'end',
        usage: response.usage ? {
            inputTokens: response.usage.input_tokens ?? 0,
            outputTokens: response.usage.output_tokens ?? 0,
            cacheReadTokens: response.usage.input_tokens_details?.cached_tokens
        } : undefined
    }
}

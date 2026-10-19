/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Gemini through the generateContent streaming API with function calling.
 * The model's parts are sent back exactly as received, so thought signatures
 * (attached to function-call and text parts) stay with their turn.
 */
import type { AssistantItem, ChatRequest, ChatResult, ConversationItem, Effort, StreamEvent } from '../../src/types/aiProtocol'
import { postJson, ProviderError, readSse } from './http'

interface Part {
    text?: string
    thought?: boolean
    thoughtSignature?: string
    functionCall?: { id?: string; name: string; args?: Record<string, unknown> }
    functionResponse?: { id?: string; name: string; response: Record<string, unknown> }
}

interface Content {
    role: 'user' | 'model'
    parts: Part[]
}

/** Gemini's schema dialect is a subset of JSON Schema; drop what it rejects. */
function toGeminiSchema(schema: unknown): unknown {
    if (Array.isArray(schema)) return schema.map(toGeminiSchema)
    if (!schema || typeof schema !== 'object') return schema
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
        if (key === 'additionalProperties' || key === '$schema' || key === 'default' || key === 'examples') continue
        out[key] = key === 'properties' && value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]))
            : toGeminiSchema(value)
    }
    return out
}

function toContents(items: ConversationItem[]): Content[] {
    const contents: Content[] = []
    const callIds = new Map<string, boolean>()
    for (const item of items) {
        if (item.role === 'user') contents.push({ role: 'user', parts: [{ text: item.content }] })
        else if (item.role === 'assistant') {
            if (item.provider === 'google' && Array.isArray(item.raw) && item.raw.length) {
                for (const part of item.raw as Part[]) if (part.functionCall?.id) callIds.set(part.functionCall.id, true)
                contents.push({ role: 'model', parts: item.raw as Part[] })
                continue
            }
            const parts: Part[] = []
            if (item.text.trim()) parts.push({ text: item.text })
            for (const call of item.toolCalls) parts.push({ functionCall: { name: call.name, args: call.arguments } })
            contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '(no reply)' }] })
        } else {
            const response = item.isError ? { error: item.content } : { result: item.content }
            const part: Part = { functionResponse: { name: item.name, response, ...(callIds.has(item.callId) ? { id: item.callId } : {}) } }
            // All responses to one model turn travel together.
            const last = contents[contents.length - 1]
            if (last?.role === 'user' && last.parts.every(p => p.functionResponse)) last.parts.push(part)
            else contents.push({ role: 'user', parts: [part] })
        }
    }
    return contents
}

/** Thinking levels exist on Gemini 3.x; other models think dynamically. */
function thinkingConfig(model: string, effort?: Effort): Record<string, unknown> {
    const config: Record<string, unknown> = { includeThoughts: true }
    if (effort && /^gemini-3\./.test(model)) config.thinkingLevel = effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high'
    return config
}

const REFUSALS = new Set(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY'])

export interface GeminiOptions {
    apiKey: string
    baseUrl: string
    signal: AbortSignal
    emit: (event: StreamEvent) => void
}

export async function streamGemini(request: ChatRequest, options: GeminiOptions): Promise<ChatResult> {
    const body = {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: toContents(request.items),
        generationConfig: {
            maxOutputTokens: request.maxTokens ?? 64000,
            thinkingConfig: thinkingConfig(request.model, request.effort)
        },
        ...(request.tools?.length ? {
            tools: [{ functionDeclarations: request.tools.map(t => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }]
        } : {})
    }

    const url = `${options.baseUrl}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`
    const response = await postJson(url, body, { 'x-goog-api-key': options.apiKey }, options.signal)

    const parts: Part[] = []
    let finish = null as string | null
    let blocked = null as string | null
    let usage = null as { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number } | null
    let model = request.model

    await readSse(response, ({ data }) => {
        let chunk: any
        try { chunk = JSON.parse(data) } catch { return }
        if (chunk.error) throw new ProviderError(chunk.error.message ?? 'Gemini reported an error.', chunk.error.code)
        if (chunk.modelVersion) model = chunk.modelVersion
        if (chunk.usageMetadata) usage = chunk.usageMetadata
        if (chunk.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReason
        const candidate = chunk.candidates?.[0]
        if (!candidate) return
        for (const part of (candidate.content?.parts ?? []) as Part[]) {
            if (part.functionCall) {
                const id = part.functionCall.id || `gemini-call-${parts.filter(p => p.functionCall).length + 1}`
                options.emit({ type: 'tool-call-start', id, name: part.functionCall.name })
                options.emit({ type: 'tool-call-delta', id, delta: JSON.stringify(part.functionCall.args ?? {}) })
            } else if (typeof part.text === 'string' && part.text) {
                options.emit({ type: part.thought ? 'reasoning' : 'text', delta: part.text })
            }
            // Keep empty parts that carry a signature; drop truly empty ones.
            if (part.functionCall || part.text || part.thoughtSignature) parts.push(part)
        }
        if (candidate.finishReason) finish = candidate.finishReason
    })

    if (blocked) throw new ProviderError(`Gemini blocked this request (${String(blocked).toLowerCase().replace(/_/g, ' ')}).`)

    let text = ''
    let reasoning = ''
    const toolCalls: AssistantItem['toolCalls'] = []
    let callIndex = 0
    for (const part of parts) {
        if (part.functionCall) {
            callIndex++
            toolCalls.push({ id: part.functionCall.id || `gemini-call-${callIndex}`, name: part.functionCall.name, arguments: part.functionCall.args ?? {} })
        } else if (part.text) {
            if (part.thought) reasoning += part.text
            else text += part.text
        }
    }

    const u = usage
    return {
        assistant: {
            role: 'assistant', text, toolCalls,
            reasoning: reasoning.trim() || undefined,
            provider: 'google', model, raw: parts
        },
        stopReason: finish && REFUSALS.has(finish) ? 'refusal'
            : finish === 'MAX_TOKENS' ? 'max_tokens'
                : toolCalls.length ? 'tool_use' : 'end',
        usage: u ? {
            inputTokens: u.promptTokenCount ?? 0,
            outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
            cacheReadTokens: u.cachedContentTokenCount
        } : undefined
    }
}

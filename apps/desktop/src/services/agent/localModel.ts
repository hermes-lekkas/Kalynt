/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Local models (node-llama-cpp) as an agent backend. They don't have reliable
 * native function calling, so tools are described in the prompt and the
 * model replies with ```tool JSON blocks, parsed here into the same tool-call
 * structure cloud providers return. The agent loop doesn't know the difference.
 */
import type { AssistantItem, ChatRequest, ChatResult, ConversationItem, StreamEvent, ToolSpec } from '../../types/aiProtocol'
import { offlineLLMService, type ChatMessage } from '../offlineLLMService'
import { useModelStore } from '../../stores/modelStore'
import { AiRequestError } from './aiClient'

function toolGuide(tools: ToolSpec[]): string {
    const lines = tools.map(tool => {
        const props = tool.parameters.properties as Record<string, { type?: string; description?: string }>
        const required = new Set(tool.parameters.required ?? [])
        const params = Object.entries(props).map(([name, p]) => `${name}${required.has(name) ? '' : '?'}: ${p.type ?? 'any'}`).join(', ')
        return `- ${tool.name}(${params}): ${tool.description.split('. ')[0]}.`
    })
    return `

# Tools
To use a tool, reply with one or more blocks in exactly this format, then stop and wait for the results:

\`\`\`tool
{"name": "read_file", "arguments": {"path": "src/main.py"}}
\`\`\`

Available tools:
${lines.join('\n')}

When you have the final answer, reply normally without a tool block.`
}

function toMessages(request: ChatRequest): ChatMessage[] {
    const system = request.system + (request.tools?.length ? toolGuide(request.tools) : '')
    const messages: ChatMessage[] = [{ role: 'system', content: system }]
    const push = (role: 'user' | 'assistant', content: string) => {
        const last = messages[messages.length - 1]
        if (last.role === role && role === 'user') last.content += `\n\n${content}`
        else messages.push({ role, content })
    }
    for (const item of request.items as ConversationItem[]) {
        if (item.role === 'user') push('user', item.content)
        else if (item.role === 'assistant') {
            const blocks = item.toolCalls.map(c => '```tool\n' + JSON.stringify({ name: c.name, arguments: c.arguments }) + '\n```')
            push('assistant', [item.text.trim(), ...blocks].filter(Boolean).join('\n\n') || '(no reply)')
        } else push('user', `Result of ${item.name}${item.isError ? ' (error)' : ''}:\n${item.content}`)
    }
    return messages
}

/** Keeps the system prompt and as many recent messages as fit the model's context. */
function fitContext(messages: ChatMessage[], contextTokens: number, reserve: number): ChatMessage[] {
    const budget = Math.max(1024, contextTokens - reserve) * 3.5
    const [system, ...rest] = messages
    let used = system.content.length
    const kept: ChatMessage[] = []
    for (let i = rest.length - 1; i >= 0; i--) {
        const size = rest[i].content.length
        if (used + size > budget && kept.length > 0) break
        kept.unshift(size > budget - used ? { ...rest[i], content: '…' + rest[i].content.slice(-(budget - used)) } : rest[i])
        used += size
    }
    while (kept.length && kept[0].role !== 'user') kept.shift()
    return [system, ...kept]
}

/**
 * ```tool fences (what the prompt asks for), plus the formats local models
 * use by habit: <tool_call> tags (Qwen, Hermes) and ```json fences holding a
 * call. A tag left open at the end of the reply still counts.
 */
const TOOL_BLOCK = /```tool(?:_call)?[ \t]*\n?([\s\S]*?)```|<tool_call>([\s\S]*?)(?:<\/tool_call>|$)|```json[ \t]*\n([\s\S]*?)```/g

type ParsedCall = { name?: unknown; arguments?: unknown; parameters?: unknown; params?: unknown }

function callArguments(call: ParsedCall): Record<string, unknown> | null {
    let args = call.arguments ?? call.parameters ?? call.params ?? {}
    if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { return null }
    }
    return typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : null
}

export function parseToolBlocks(text: string): { text: string; calls: AssistantItem['toolCalls'] } {
    const calls: AssistantItem['toolCalls'] = []
    const nextId = () => `local-${Date.now().toString(36)}-${calls.length}`
    const invalid = (message: string) => { calls.push({ id: nextId(), name: 'invalid', arguments: {}, argumentsError: message }) }
    const rest = text.replace(TOOL_BLOCK, (block: string, fenced?: string, tagged?: string, json?: string) => {
        // A ```json fence is only a call when it looks like one; otherwise it's part of the answer.
        const optional = json !== undefined
        const body = (fenced ?? tagged ?? json ?? '').trim()
        let parsed: ParsedCall
        try { parsed = JSON.parse(body) } catch {
            if (optional) return block
            invalid(`The tool block was not valid JSON: ${body.slice(0, 200)}`)
            return ''
        }
        const isObject = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        if (optional && !(isObject && typeof parsed.name === 'string' && ('arguments' in parsed || 'parameters' in parsed))) return block
        const args = isObject ? callArguments(parsed) : null
        if (!isObject || typeof parsed.name !== 'string' || !args) {
            invalid('A tool block needs {"name": "<tool>", "arguments": {...}}.')
            return ''
        }
        calls.push({ id: nextId(), name: parsed.name, arguments: args })
        return ''
    })
    return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), calls }
}

export async function localChat(request: ChatRequest, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<ChatResult> {
    if (!useModelStore.getState().loadedModelId) {
        throw new AiRequestError('Load a local model first (Settings → Models and keys).')
    }
    const contextTokens = offlineLLMService.getContextWindow()
    const maxTokens = Math.min(request.maxTokens ?? 2048, Math.max(512, Math.floor(contextTokens / 3)))
    const messages = fitContext(toMessages(request), contextTokens, maxTokens + 256)

    // Stream visible text, but hold back tool blocks and <think> sections.
    let raw = ''
    let shown = 0
    const visible = () => {
        let display = raw.replace(/<think>[\s\S]*?<\/think>/g, '')
        const openThink = display.indexOf('<think>')
        if (openThink >= 0) display = display.slice(0, openThink)
        const toolStart = display.search(/```tool|<tool_call>/)
        // Hold back the last few characters: they may be the start of a tool block.
        display = toolStart >= 0 ? display.slice(0, toolStart) : display.slice(0, Math.max(0, display.length - 11))
        if (display.length > shown) { onEvent({ type: 'text', delta: display.slice(shown) }); shown = display.length }
    }
    const abort = () => { void offlineLLMService.cancelGeneration() }
    signal?.addEventListener('abort', abort, { once: true })
    let full: string
    try {
        full = await offlineLLMService.generateStream(messages, token => { raw += token; visible() }, { maxTokens, temperature: 0.2 })
    } catch (error) {
        if (signal?.aborted) throw new AiRequestError('Stopped.', undefined, true)
        throw new AiRequestError(error instanceof Error ? error.message : String(error))
    } finally {
        signal?.removeEventListener('abort', abort)
    }
    if (signal?.aborted) throw new AiRequestError('Stopped.', undefined, true)

    const thinking = [...full.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/g)].map(m => m[1].trim()).join('\n\n')
    const withoutThinking = full.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '')
    const { text, calls } = parseToolBlocks(withoutThinking)
    if (text.length > shown) onEvent({ type: 'text', delta: text.slice(shown) })
    return {
        assistant: { role: 'assistant', text, toolCalls: calls, reasoning: thinking || undefined, provider: 'local', model: request.model },
        stopReason: calls.length ? 'tool_use' : 'end'
    }
}

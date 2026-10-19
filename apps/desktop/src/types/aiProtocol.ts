/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The provider-neutral conversation format shared by the renderer (agent loop,
 * chat UI) and the main process (provider adapters). Pure types: imported by
 * both sides.
 */

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'moonshot' | 'zai'

/** How hard the model should think. Each adapter maps it to the provider's own scale. */
export type Effort = 'low' | 'medium' | 'high' | 'max'

/** A JSON Schema object describing a tool's input. */
export interface JsonSchema {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
}

export interface ToolSpec {
    name: string
    description: string
    parameters: JsonSchema
}

export interface ToolCall {
    /** Provider-issued id that the matching tool result must echo. */
    id: string
    name: string
    arguments: Record<string, unknown>
    /** Set when the model's arguments weren't valid JSON. */
    argumentsError?: string
}

export interface UserItem {
    role: 'user'
    /** Sent to the model (may include attached file contents and editor context). */
    content: string
    /** What the user typed, shown in the chat. Defaults to `content`. */
    display?: string
}

export interface AssistantItem {
    role: 'assistant'
    text: string
    toolCalls: ToolCall[]
    /** Readable reasoning or reasoning summary, when the provider returns one. */
    reasoning?: string
    /** 'local' for models running on this machine. */
    provider: ProviderId | 'local'
    model: string
    /**
     * The provider's own representation of this turn (Anthropic content blocks,
     * OpenAI Responses output items, Gemini parts, reasoning_content). Sent back
     * unchanged to the same provider so thinking and signatures stay valid.
     */
    raw?: unknown
}

export interface ToolResultItem {
    role: 'tool'
    callId: string
    name: string
    content: string
    isError?: boolean
}

export type ConversationItem = UserItem | AssistantItem | ToolResultItem

export interface ChatRequest {
    provider: ProviderId
    model: string
    system: string
    items: ConversationItem[]
    tools?: ToolSpec[]
    /** Output cap including reasoning. Adapters pick a generous default. */
    maxTokens?: number
    effort?: Effort
    /** Ignored by reasoning models that don't accept sampling parameters. */
    temperature?: number
}

export type StreamEvent =
    | { type: 'text'; delta: string }
    | { type: 'reasoning'; delta: string }
    | { type: 'tool-call-start'; id: string; name: string }
    | { type: 'tool-call-delta'; id: string; delta: string }
    | { type: 'notice'; message: string }

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal'

export interface Usage {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
}

export interface ChatResult {
    assistant: AssistantItem
    stopReason: StopReason
    usage?: Usage
}

export interface ModelInfo {
    id: string
    label: string
    /** Shown first and selected by default for new conversations. */
    recommended?: boolean
    /** Accepts tools; models that can't are kept out of the agent's picker. */
    tools?: boolean
    contextWindow?: number
}

/** Payload of the `ai:event` channel. */
export interface AiEventEnvelope {
    requestId: string
    event: StreamEvent
}

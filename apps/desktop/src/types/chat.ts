/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** A message in an agent conversation or the team chat. */
export interface ChatMessage {
    id: string
    role?: 'user' | 'assistant' | 'system' | 'tool'
    content: string
    sender?: string
    senderId?: string
    timestamp: number
    channelId?: string
    encrypted?: boolean
    /** Tool name for `role: 'tool'` messages. */
    name?: string
    /** Raw tool output for `role: 'tool'` messages. */
    data?: string
    isError?: boolean
    modelId?: string
    isLoading?: boolean
    issueType?: string
    /** The model's chain-of-thought, when it exposes one. */
    thinking?: string
    replyToId?: string
    replyToContent?: string
    replyToSender?: string
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Keeps long conversations within the model's context window. When the
 * transcript grows past the budget, the model writes a summary of the work
 * so far and the conversation continues from that summary alone ("simple
 * compaction"). Earlier turns stay visible in the chat but are no longer sent.
 */
import type { ChatRequest, ChatResult, StreamEvent } from '../../types/aiProtocol'
import { estimateTokens, type AgentSession } from './session'
import type { RunTarget } from './runner'

/** Even with 1M-token models, very long contexts are slow and costly. */
const MAX_BUDGET = 400_000
const DEFAULT_WINDOW = 128_000

const PROMPT = `Summarize this conversation so that you can continue the work with only your summary. Include:
- the user's goals, requirements and preferences;
- what has been done: files created or changed (with paths) and how, commands run and their results;
- the current state, including any errors still open;
- decisions made and why;
- what remains to be done, in order.
Be specific (paths, function names, exact error messages). Don't use tools.`

type ChatFn = (request: ChatRequest, onEvent: (event: StreamEvent) => void, signal?: AbortSignal) => Promise<ChatResult>

export function compactionBudget(target: RunTarget): number {
    return Math.floor(Math.min(target.contextWindow ?? DEFAULT_WINDOW, MAX_BUDGET) * 0.75)
}

export async function compactIfNeeded(session: AgentSession, target: RunTarget, chat: ChatFn, signal: AbortSignal): Promise<boolean> {
    if (estimateTokens(session) < compactionBudget(target)) return false
    const last = session.items[session.items.length - 1]
    // Never in the middle of a tool round.
    if (!last || last.role === 'assistant') return false

    const result = await chat({
        provider: target.provider === 'local' ? 'anthropic' : target.provider,
        model: target.model,
        system: session.system ?? '',
        items: [...session.items, { role: 'user', content: PROMPT }],
        effort: 'low',
        maxTokens: 12000
    }, () => {}, signal)
    const summary = result.assistant.text.trim()
    if (!summary) return false

    session.archive = [...(session.archive ?? []), ...session.items]
    session.items = [{
        role: 'user',
        content: `This conversation was summarized to save space. Summary of the work so far:\n\n${summary}\n\nContinue from here.`,
        display: 'Earlier messages were summarized to save space.'
    }]
    session.notes = [...(session.notes ?? []), { at: 0, text: 'Earlier messages were summarized to stay within the model\'s context window.' }]
    return true
}

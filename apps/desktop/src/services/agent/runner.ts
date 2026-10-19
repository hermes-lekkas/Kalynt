/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The agent loop. Each step streams one model turn, appends it to the
 * transcript, runs the tools it asked for (approval and checkpoints included)
 * and feeds the results back, until the model answers without tools.
 *
 * Invariants the providers rely on:
 * - The transcript is append-only and the system prompt never changes.
 * - Every tool call gets exactly one result, in order, before the next model
 *   turn, including when the user declines or stops.
 */
import type { ChatRequest, ChatResult, Effort, ProviderId, StreamEvent, ToolCall } from '../../types/aiProtocol'
import { chat as cloudChat, AiRequestError } from './aiClient'
import { localChat } from './localModel'
import { AGENT_TOOLS, getTool, runTool, toolSpecs, type AgentTool, type ToolDisplay, type ToolOutcome } from './tools'
import { isDangerousCommand, needsApproval, type AgentMode, type ApprovalDecision, type ApprovalMemory } from './approvals'
import { snapshot } from './checkpoints'
import { compactIfNeeded } from './compaction'
import type { AgentSession, RunCheckpoint, ToolRecord } from './session'

/** Local models get a smaller tool set they can use reliably. */
const LOCAL_TOOL_NAMES = new Set(['read_file', 'list_directory', 'find_files', 'search_code', 'edit_file', 'write_file', 'run_command', 'update_plan'])
const MAX_RESULT_CHARS = 60_000

export interface RunTarget {
    provider: ProviderId | 'local'
    model: string
    effort?: Effort
    contextWindow?: number
}

export interface LiveTurn {
    text: string
    reasoning: string
    calls: Array<{ id: string; name: string; input: string }>
    notice?: string
}

export interface ApprovalRequest {
    callId: string
    tool: AgentTool
    args: Record<string, unknown>
    title: string
    preview: ToolDisplay | null
    dangerous: boolean
}

export interface RunHooks {
    /** The session changed (transcript, tool records, plan); re-render and save. */
    onChange(): void
    /** The model turn in progress, or null between turns. */
    onLive(turn: LiveTurn | null): void
    onOutput(callId: string, chunk: string): void
    requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>
}

export interface RunOptions {
    workspace: string | null
    mode: AgentMode
    memory: ApprovalMemory
    signal: AbortSignal
    hooks: RunHooks
    knownFiles: Set<string>
    maxSteps?: number
}

export type RunOutcome = 'done' | 'stopped' | 'paused' | 'declined' | 'refused' | 'error'

type ChatFn = (request: ChatRequest, onEvent: (event: StreamEvent) => void, signal?: AbortSignal) => Promise<ChatResult>

const note = (session: AgentSession, text: string, tone: 'info' | 'error' = 'info') => {
    session.notes = [...(session.notes ?? []), { at: session.items.length, text, tone }]
}

const clipResult = (text: string) => text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n(Output truncated at ${MAX_RESULT_CHARS} characters.)`
    : text

export async function runAgent(session: AgentSession, target: RunTarget, options: RunOptions): Promise<RunOutcome> {
    const { hooks, signal } = options
    const chatFn: ChatFn = target.provider === 'local' ? localChat : cloudChat
    const tools = target.provider === 'local' ? AGENT_TOOLS.filter(t => LOCAL_TOOL_NAMES.has(t.name)) : AGENT_TOOLS
    const specs = toolSpecs(tools)
    const checkpoint: RunCheckpoint = { runId: crypto.randomUUID(), startedAt: Date.now(), files: {} }
    session.checkpoints.push(checkpoint)
    session.paused = false
    const maxSteps = options.maxSteps ?? 60

    try {
        for (let step = 0; step < maxSteps; step++) {
            if (signal.aborted) return 'stopped'
            if (target.provider !== 'local' && await compactIfNeeded(session, target, chatFn, signal)) hooks.onChange()

            const live: LiveTurn = { text: '', reasoning: '', calls: [] }
            hooks.onLive({ ...live })
            let result: ChatResult
            try {
                result = await chatFn({
                    provider: target.provider === 'local' ? 'anthropic' : target.provider,
                    model: target.model,
                    system: session.system ?? '',
                    items: session.items,
                    tools: specs,
                    effort: target.effort
                }, event => applyEvent(live, event, hooks), signal)
            } catch (error) {
                hooks.onLive(null)
                if (signal.aborted || (error instanceof AiRequestError && error.aborted)) {
                    // Keep what was written before the stop; it's still a valid turn.
                    if (live.text.trim()) session.items.push({ role: 'assistant', text: live.text, toolCalls: [], provider: target.provider, model: target.model })
                    return 'stopped'
                }
                note(session, error instanceof Error ? error.message : String(error), 'error')
                return 'error'
            } finally {
                hooks.onLive(null)
            }

            if (result.usage) {
                session.usage.input += result.usage.inputTokens
                session.usage.output += result.usage.outputTokens
            }
            session.items.push(result.assistant)
            session.updatedAt = Date.now()
            hooks.onChange()

            if (result.stopReason === 'refusal') {
                note(session, 'The model declined to continue this request. Rephrase it, or try another model.', 'error')
                return 'refused'
            }
            const calls = result.assistant.toolCalls
            if (!calls.length) {
                if (result.stopReason === 'max_tokens') note(session, 'The reply reached the output limit and may be cut off. Ask the agent to continue.')
                return 'done'
            }
            if (result.stopReason === 'max_tokens') {
                // A tool input cut off mid-stream can still parse; don't run it.
                for (const call of calls) {
                    recordTool(session, call, { status: 'error', display: { type: 'text', text: 'Not run: the reply hit the output limit.' } })
                    session.items.push({ role: 'tool', callId: call.id, name: call.name, content: 'Not run: your reply reached the output length limit before this call was complete. Do the work in smaller steps (for example several smaller edits).', isError: true })
                }
                hooks.onChange()
                continue
            }

            const outcome = await executeCalls(session, calls, checkpoint, tools, options)
            hooks.onChange()
            if (outcome !== 'ok') return outcome
        }
        session.paused = true
        note(session, `Paused after ${maxSteps} steps. Continue if you want the agent to keep going.`)
        return 'paused'
    } finally {
        if (Object.keys(checkpoint.files).length === 0) session.checkpoints = session.checkpoints.filter(c => c !== checkpoint)
        session.updatedAt = Date.now()
        hooks.onChange()
    }
}

function applyEvent(live: LiveTurn, event: StreamEvent, hooks: RunHooks) {
    switch (event.type) {
        case 'text': live.text += event.delta; break
        case 'reasoning': live.reasoning += event.delta; break
        case 'tool-call-start': live.calls.push({ id: event.id, name: event.name, input: '' }); break
        case 'tool-call-delta': {
            const call = live.calls.find(c => c.id === event.id)
            if (call) call.input += event.delta
            break
        }
        case 'notice': live.notice = event.message; break
    }
    hooks.onLive({ ...live, calls: live.calls.map(c => ({ ...c })) })
}

function recordTool(session: AgentSession, call: ToolCall, patch: Partial<ToolRecord>, tool?: AgentTool, workspace?: string | null) {
    const existing = session.tools[call.id]
    let title = existing?.title
    if (!title) {
        try { title = tool ? tool.title(call.arguments, workspace ?? null) : call.name } catch { title = call.name }
    }
    const base: ToolRecord = existing ?? { name: call.name, kind: tool?.kind ?? 'read', status: 'running', title }
    session.tools[call.id] = { ...base, title, ...patch }
}

/** Read-only calls that never need approval can run side by side. */
const isParallelSafe = (tool: AgentTool | undefined, call: ToolCall, options: RunOptions) =>
    !!tool && !call.argumentsError && ['read', 'search', 'web'].includes(tool.kind) && tool.name !== 'command_output'
    && !needsApproval(tool, call.arguments, options.mode, options.memory)

async function executeCalls(session: AgentSession, calls: ToolCall[], checkpoint: RunCheckpoint, tools: AgentTool[], options: RunOptions): Promise<'ok' | 'stopped' | 'declined'> {
    const { hooks, signal } = options
    const results = new Map<string, ToolOutcome>()
    let stopReason: 'stopped' | 'declined' | null = null

    const contextFor = (call: ToolCall) => ({
        workspace: options.workspace,
        signal,
        callId: call.id,
        knownFiles: options.knownFiles,
        checkpoint: (path: string) => snapshot(checkpoint, path),
        onOutput: (chunk: string) => hooks.onOutput(call.id, chunk),
        plan: {
            get: () => session.plan,
            set: (items: typeof session.plan) => { session.plan = items; hooks.onChange() }
        }
    })

    const run = async (call: ToolCall, tool: AgentTool) => {
        const started = Date.now()
        recordTool(session, call, { status: 'running', preview: undefined }, tool, options.workspace)
        hooks.onChange()
        const outcome = await runTool(call.name, call.arguments, contextFor(call))
        results.set(call.id, outcome)
        recordTool(session, call, { status: outcome.isError ? 'error' : 'done', display: outcome.display, durationMs: Date.now() - started }, tool)
        hooks.onChange()
    }

    for (let i = 0; i < calls.length; i++) {
        const call = calls[i]
        const tool = getTool(call.name)
        if (stopReason || signal.aborted) {
            stopReason ??= 'stopped'
            const text = stopReason === 'declined' ? 'Not run because the user declined an earlier action.' : 'Not run: stopped by the user.'
            results.set(call.id, { content: text, isError: true })
            recordTool(session, call, { status: 'skipped' }, tool, options.workspace)
            continue
        }
        if (!tool || call.argumentsError) {
            const text = call.argumentsError ? `${call.argumentsError} Send the arguments as a JSON object.`
                : `Unknown tool "${call.name}". Available tools: ${tools.map(t => t.name).join(', ')}.`
            results.set(call.id, { content: text, isError: true })
            recordTool(session, call, { status: 'error', display: { type: 'text', text } }, tool, options.workspace)
            continue
        }

        // Batch consecutive read-only calls.
        if (isParallelSafe(tool, call, options)) {
            const batch: Array<[ToolCall, AgentTool]> = [[call, tool]]
            while (i + 1 < calls.length) {
                const next = calls[i + 1]
                const nextTool = getTool(next.name)
                if (!isParallelSafe(nextTool, next, options)) break
                batch.push([next, nextTool!])
                i++
            }
            await Promise.all(batch.map(([c, t]) => run(c, t)))
            continue
        }

        if (needsApproval(tool, call.arguments, options.mode, options.memory)) {
            const ctx = contextFor(call)
            const preview = await tool.preview?.(call.arguments, ctx).catch(() => null) ?? null
            // An edit that can't apply (text not found, file missing) changes nothing:
            // let it fail straight back to the model instead of asking first.
            if (tool.preview && !preview) {
                await run(call, tool)
                continue
            }
            recordTool(session, call, { status: 'awaiting-approval', preview: preview ?? undefined }, tool, options.workspace)
            hooks.onChange()
            const decision = await waitForApproval(hooks, {
                callId: call.id, tool, args: call.arguments,
                title: session.tools[call.id].title, preview,
                dangerous: tool.kind === 'execute' && isDangerousCommand(String(call.arguments.command ?? ''))
            }, signal)
            if (signal.aborted) { stopReason = 'stopped'; i--; continue }
            if (!decision.allow) {
                const text = decision.feedback?.trim()
                    ? `The user declined this action and said: ${decision.feedback.trim()}`
                    : 'The user declined this action.'
                results.set(call.id, { content: text, isError: true })
                recordTool(session, call, { status: 'denied', preview: undefined }, tool)
                stopReason = 'declined'
                continue
            }
            if (decision.remember) options.memory.remember(tool, call.arguments)
        }
        await run(call, tool)
        if (signal.aborted) stopReason = 'stopped'
        markBackgroundFinished(session, call, results.get(call.id))
    }

    for (const call of calls) {
        const result = results.get(call.id) ?? { content: 'Not run: stopped by the user.', isError: true }
        session.items.push({ role: 'tool', callId: call.id, name: call.name, content: clipResult(result.content), ...(result.isError ? { isError: true } : {}) })
    }
    session.updatedAt = Date.now()
    return stopReason ?? 'ok'
}

/** When a background command is stopped or found finished, its original card stops saying "running". */
function markBackgroundFinished(session: AgentSession, call: ToolCall, outcome?: ToolOutcome) {
    if (call.name !== 'stop_command' && call.name !== 'command_output') return
    if (call.name === 'command_output' && !/Exited with code/.test(outcome?.content ?? '')) return
    const original = session.tools[String(call.arguments.process_id ?? '').replace(/^agent-/, '')]
    if (original?.display?.type === 'command' && original.display.running) {
        original.display = { ...original.display, running: false }
    }
}

/** Resolves with a denial if the run is stopped while waiting. */
function waitForApproval(hooks: RunHooks, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise(resolve => {
        const onAbort = () => resolve({ allow: false })
        signal.addEventListener('abort', onAbort, { once: true })
        hooks.requestApproval(request).then(decision => {
            signal.removeEventListener('abort', onAbort)
            resolve(decision)
        }, () => resolve({ allow: false }))
    })
}

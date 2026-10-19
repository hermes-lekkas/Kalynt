/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The agent chat's state: conversations, runs, the turn being streamed, live
 * command output, approvals, stop / continue / undo.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAgentSessionStore } from '../../../stores/agentSessionStore'
import { useAgentStatusStore } from '../../../stores/agentStatusStore'
import { useNotificationStore } from '../../../stores/notificationStore'
import { runAgent, type ApprovalRequest, type LiveTurn, type RunOutcome } from '../../../services/agent/runner'
import { ApprovalMemory, type AgentMode, type ApprovalDecision } from '../../../services/agent/approvals'
import { buildSystemPrompt } from '../../../services/agent/systemPrompt'
import { composeMessage, promptEnvironment } from '../../../services/agent/messageContext'
import { restore } from '../../../services/agent/checkpoints'
import { titleFrom, type AgentSession } from '../../../services/agent/session'
import type { ModelChoiceApi } from './useModelChoice'

const MODE_KEY = 'kalynt-agent-mode'

export const sessionLabel = (title: string) => !title || title === 'New Chat' ? 'New conversation' : title

function loadMode(): AgentMode {
    try {
        const saved = localStorage.getItem(MODE_KEY)
        if (saved === 'ask' || saved === 'auto-edit' || saved === 'full-auto') return saved
    } catch { /* storage unavailable */ }
    return 'ask'
}

/** Batches rapid updates (streamed tokens, command output) into one render per frame. */
function useFrameState<T>(initial: T): [T, (update: (prev: T) => T) => void, (value: T) => void] {
    const [state, setState] = useState(initial)
    const pending = useRef<Array<(prev: T) => T>>([])
    const frame = useRef<number | null>(null)
    const schedule = useCallback((update: (prev: T) => T) => {
        pending.current.push(update)
        if (frame.current !== null) return
        frame.current = requestAnimationFrame(() => {
            frame.current = null
            const updates = pending.current
            pending.current = []
            setState(prev => updates.reduce((acc, fn) => fn(acc), prev))
        })
    }, [])
    const reset = useCallback((value: T) => {
        pending.current = []
        if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
        setState(value)
    }, [])
    return [state, schedule, reset]
}

export function useAgentChat(spaceId: string, folder: string | null, model: ModelChoiceApi) {
    const store = useAgentSessionStore()
    const addNotification = useNotificationStore(s => s.addNotification)
    const [running, setRunning] = useState(false)
    const [live, scheduleLive, resetLive] = useFrameState<LiveTurn | null>(null)
    const [outputs, scheduleOutput, resetOutputs] = useFrameState<Record<string, string>>({})
    const [approval, setApproval] = useState<{ request: ApprovalRequest; decide: (d: ApprovalDecision) => void } | null>(null)
    const [mode, setModeState] = useState<AgentMode>(loadMode)
    const abortRef = useRef<AbortController | null>(null)
    const memories = useRef(new Map<string, ApprovalMemory>())
    const knownFiles = useRef(new Map<string, Set<string>>())
    const modelRef = useRef(model)
    modelRef.current = model
    const modeRef = useRef(mode)
    modeRef.current = mode

    const session = store.current && (!store.current.spaceId || store.current.spaceId === spaceId) ? store.current : null
    const sessions = useMemo(() => store.summaries.filter(s => !s.spaceId || s.spaceId === spaceId), [store.summaries, spaceId])

    // Each workspace opens on its most recent conversation.
    useEffect(() => {
        let cancelled = false
        void useAgentSessionStore.getState().loadList(spaceId).then(() => {
            if (cancelled) return
            const state = useAgentSessionStore.getState()
            if (state.current && state.current.spaceId === spaceId) return
            const latest = state.summaries.find(s => s.spaceId === spaceId)
            if (latest) void state.open(latest.id)
            else state.create(spaceId)
        })
        return () => { cancelled = true }
    }, [spaceId])

    useEffect(() => {
        useAgentStatusStore.getState().setModel(model.ready ? model.label : null)
    }, [model.ready, model.label])

    // Save before the window closes.
    useEffect(() => {
        const flush = () => { void useAgentSessionStore.getState().saveNow() }
        window.addEventListener('beforeunload', flush)
        return () => window.removeEventListener('beforeunload', flush)
    }, [])

    const memoryFor = (id: string) => {
        let memory = memories.current.get(id)
        if (!memory) { memory = new ApprovalMemory(); memories.current.set(id, memory) }
        return memory
    }
    const knownFor = (id: string) => {
        let set = knownFiles.current.get(id)
        if (!set) { set = new Set(); knownFiles.current.set(id, set) }
        return set
    }

    const run = useCallback(async (target: AgentSession): Promise<RunOutcome> => {
        const m = modelRef.current
        const controller = new AbortController()
        abortRef.current = controller
        setRunning(true)
        resetOutputs({})
        const status = useAgentStatusStore.getState()
        status.setActivity('thinking')
        try {
            return await runAgent(target, {
                provider: m.choice.mode === 'offline' ? 'local' : m.choice.provider,
                model: m.modelId ?? '',
                effort: m.choice.mode === 'cloud' ? m.effort : undefined,
                contextWindow: m.contextWindow
            }, {
                workspace: folder,
                mode: modeRef.current,
                memory: memoryFor(target.id),
                signal: controller.signal,
                knownFiles: knownFor(target.id),
                hooks: {
                    onChange: () => useAgentSessionStore.getState().touch(),
                    onLive: turn => {
                        scheduleLive(() => turn)
                        status.setActivity(turn ? (turn.calls.length ? 'working' : 'thinking') : 'working')
                    },
                    onOutput: (callId, chunk) => scheduleOutput(prev => ({ ...prev, [callId]: ((prev[callId] ?? '') + chunk).slice(-40_000) })),
                    requestApproval: request => new Promise(resolve => {
                        status.setActivity('waiting-approval')
                        setApproval({
                            request,
                            decide: decision => {
                                setApproval(null)
                                status.setActivity('working')
                                resolve(decision)
                            }
                        })
                    })
                }
            })
        } catch (error) {
            addNotification(`The agent stopped: ${error instanceof Error ? error.message : String(error)}`, 'error')
            return 'error'
        } finally {
            abortRef.current = null
            setApproval(null)
            setRunning(false)
            resetLive(null)
            status.setActivity('idle')
            status.setStep(null)
            void useAgentSessionStore.getState().saveNow()
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [folder, addNotification])

    const send = useCallback(async (text: string) => {
        const m = modelRef.current
        if (!text.trim() || running || !m.ready) return
        const state = useAgentSessionStore.getState()
        let target = state.current && state.current.spaceId === spaceId ? state.current : state.create(spaceId)
        if (!target.system) target.system = buildSystemPrompt(await promptEnvironment(folder))
        const message = await composeMessage(text.trim(), folder, spaceId)
        message.attached.forEach(path => knownFor(target.id).add(path))
        target.items.push({ role: 'user', content: message.content, display: message.display })
        if (target.title === 'New conversation') target.title = titleFrom(message.display)
        target.provider = m.choice.mode === 'offline' ? 'local' : m.choice.provider
        target.model = m.modelId
        target.updatedAt = Date.now()
        useAgentSessionStore.getState().touch()
        target = useAgentSessionStore.getState().current ?? target
        await run(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [running, spaceId, folder, run])

    const stop = useCallback(() => {
        approval?.decide({ allow: false })
        abortRef.current?.abort()
    }, [approval])

    const undoRun = useCallback(async (runId: string) => {
        const current = useAgentSessionStore.getState().current
        const checkpoint = current?.checkpoints.find(c => c.runId === runId)
        if (!current || !checkpoint || checkpoint.undone) return
        const failed = await restore(checkpoint)
        // Files were reverted, so their content in the conversation is stale.
        knownFor(current.id).clear()
        current.notes = [...(current.notes ?? []), {
            at: current.items.length,
            text: failed.length ? `Undid the changes, except ${failed.length} file${failed.length === 1 ? '' : 's'} that couldn't be restored.` : 'Undid the changes from this run.',
            tone: failed.length ? 'error' : 'info'
        }]
        current.items.push({ role: 'user', content: 'I undid all the file changes from your last run; those files are back to how they were before it.', display: 'Undid the changes from the last run.' })
        useAgentSessionStore.getState().touch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const setMode = useCallback((next: AgentMode) => {
        setModeState(next)
        try { localStorage.setItem(MODE_KEY, next) } catch { /* storage unavailable */ }
    }, [])

    return {
        sessions, session, revision: store.revision,
        messages: session?.items ?? [],
        running, live, outputs, approval, mode,
        send,
        stop,
        continueRun: () => send('Continue.'),
        undoRun,
        setMode,
        newChat: () => { if (!running) useAgentSessionStore.getState().create(spaceId) },
        selectSession: (id: string) => { if (!running) void useAgentSessionStore.getState().open(id) },
        deleteSession: (id: string) => {
            void useAgentSessionStore.getState().remove(id).then(() => {
                const state = useAgentSessionStore.getState()
                if (!state.current) state.create(spaceId)
            })
        },
        renameSession: (id: string, title: string) => void useAgentSessionStore.getState().rename(id, title)
    }
}

export type AgentChatApi = ReturnType<typeof useAgentChat>

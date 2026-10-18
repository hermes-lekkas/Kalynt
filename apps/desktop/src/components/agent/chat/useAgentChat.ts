/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Conversation state for the coding agent: sessions, the multi-step agent
 * loop, live progress, and tool approvals.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../../../stores/chatStore'
import { useAgentStatusStore } from '../../../stores/agentStatusStore'
import { agentLoopService } from '../../../services/agentLoopService'
import { aiService } from '../../../services/aiService'
import { offlineLLMService } from '../../../services/offlineLLMService'
import { toolPermissionManager, stopActiveTool, type ToolCallRequest } from '../../../services/ideAgentTools'
import type { AgentLoopEvent, AgentStep } from '../../../types/agentTypes'
import type { ChatMessage } from '../../../types/chat'
import { cleanModelOutput } from './modelOutput'
import type { ModelChoiceApi } from './useModelChoice'

type Approval = { request: ToolCallRequest; resolve: (r: { approved: boolean; alwaysAllow: boolean }) => void }

const newId = () => crypto.randomUUID()

/** The store keeps 'New Chat' as its untitled marker; show it in sentence case. */
export const sessionLabel = (title: string) => !title || title === 'New Chat' ? 'New conversation' : title

export function useAgentChat(spaceId: string, folder: string | null, model: ModelChoiceApi) {
    const { sessions, currentSessionId, createSession, deleteSession, setCurrentSession, addMessageToSession, renameSession } = useChatStore()
    const [steps, setSteps] = useState<AgentStep[]>([])
    const [streaming, setStreaming] = useState('')
    const [thinking, setThinking] = useState('')
    const [running, setRunning] = useState(false)
    const [iteration, setIteration] = useState<{ current: number; max: number } | null>(null)
    const [approval, setApproval] = useState<Approval | null>(null)
    const runActive = useRef(false)

    const spaceSessions = useMemo(
        () => sessions.filter(s => !s.spaceId || s.spaceId === spaceId).sort((a, b) => b.lastModified - a.lastModified),
        [sessions, spaceId]
    )
    const session = spaceSessions.find(s => s.id === currentSessionId) ?? null
    const sessionRef = useRef<string | null>(session?.id ?? null)
    sessionRef.current = session?.id ?? null
    const modelRef = useRef(model)
    modelRef.current = model

    // Each workspace opens on its most recent conversation, or a fresh one.
    useEffect(() => {
        if (session) return
        if (spaceSessions.length > 0) setCurrentSession(spaceSessions[0].id)
        else createSession('New Chat', spaceId)
    }, [session, spaceSessions, spaceId, setCurrentSession, createSession])

    const append = useCallback((message: ChatMessage, sessionId = sessionRef.current) => {
        if (sessionId) addMessageToSession(sessionId, message)
    }, [addMessageToSession])

    const resetRun = useCallback(() => {
        runActive.current = false
        setRunning(false)
        setStreaming('')
        setThinking('')
        setIteration(null)
        setSteps([])
        useAgentStatusStore.getState().setActivity('idle')
        useAgentStatusStore.getState().setStep(null)
    }, [])

    // Agent loop events drive the live progress view.
    useEffect(() => {
        return agentLoopService.on((event: AgentLoopEvent) => {
            const set = useAgentStatusStore.getState()
            switch (event.type) {
                case 'started': setSteps([]); setRunning(true); set.setActivity('thinking'); break
                case 'step-added': setSteps(prev => [...prev, event.step]); if (event.step.type === 'tool-call') set.setActivity('working'); break
                case 'step-updated': setSteps(prev => prev.map(s => (s.id === event.stepId ? { ...s, ...event.updates } : s))); break
                case 'streaming': setStreaming(cleanModelOutput(event.text)); break
                case 'thinking': setThinking(event.content); set.setActivity('thinking'); break
                case 'iteration': setIteration({ current: event.iteration, max: event.maxIterations }); set.setStep({ current: event.iteration, max: event.maxIterations }); break
                case 'tool-result':
                    append({
                        id: newId(), role: 'tool', name: event.toolName, timestamp: Date.now(), content: `Ran ${event.toolName}`,
                        data: typeof event.result === 'string' ? event.result : JSON.stringify(event.result), isError: !event.success
                    })
                    break
                case 'completed':
                    if (event.finalMessage) {
                        append({ id: newId(), role: 'assistant', content: event.finalMessage, timestamp: Date.now(), modelId: modelRef.current.modelId })
                    }
                    resetRun()
                    break
                case 'error':
                    append({ id: newId(), role: 'assistant', content: event.error, timestamp: Date.now(), isError: true })
                    resetRun()
                    break
                case 'aborted': resetRun(); break
            }
        })
    }, [append, resetRun])

    // Tool approvals come through this handler while the panel is mounted.
    useEffect(() => {
        toolPermissionManager.setConfirmationHandler(request => new Promise(resolve => {
            useAgentStatusStore.getState().setActivity('waiting-approval')
            setApproval({
                request,
                resolve: result => {
                    setApproval(null)
                    useAgentStatusStore.getState().setActivity('working')
                    resolve(result)
                }
            })
        }))
        toolPermissionManager.setTrustedMode(false)
        toolPermissionManager.setReadOnlyAutoAllow(true)
        return () => {
            toolPermissionManager.setConfirmationHandler(null as unknown as Parameters<typeof toolPermissionManager.setConfirmationHandler>[0])
            toolPermissionManager.clearSession()
        }
    }, [])

    // Deny anything still waiting if the panel goes away, so the loop can finish.
    const approvalRef = useRef(approval)
    approvalRef.current = approval
    useEffect(() => () => approvalRef.current?.resolve({ approved: false, alwaysAllow: false }), [])

    useEffect(() => {
        agentLoopService.setWorkspacePath(folder || '')
    }, [folder])

    useEffect(() => {
        useAgentStatusStore.getState().setModel(model.ready ? model.label : null)
    }, [model.ready, model.label])

    const send = useCallback(async (text: string) => {
        const content = text.trim()
        const m = modelRef.current
        if (!content || running || !m.ready) return
        let sessionId = sessionRef.current
        if (!sessionId) sessionId = createSession('New Chat', spaceId)
        const history = (useChatStore.getState().sessions.find(s => s.id === sessionId)?.messages ?? []).map(msg => ({
            role: msg.role === 'tool' ? 'assistant' : (msg.role || 'user'),
            content: msg.role === 'tool' ? `Tool ${msg.name} result: ${msg.data?.slice(0, 500) || msg.content}` : msg.content
        }))
        append({ id: newId(), role: 'user', content, timestamp: Date.now() }, sessionId)
        history.push({ role: 'user', content })

        runActive.current = true
        setRunning(true)
        setSteps([])
        useAgentStatusStore.getState().setActivity('thinking')
        agentLoopService.setUseOfflineAI(m.choice.mode === 'offline')
        agentLoopService.setCloudProvider(m.choice.provider)
        agentLoopService.setWorkspacePath(folder || '')
        try {
            await agentLoopService.run(content, history, {
                trustedMode: toolPermissionManager.isTrustedMode(),
                autoApproveReadOnly: true,
                model: m.modelId
            })
        } catch (e) {
            // The loop usually reports its own errors; only add one if it didn't.
            if (runActive.current) {
                append({ id: newId(), role: 'assistant', content: e instanceof Error ? e.message : 'The agent stopped unexpectedly.', timestamp: Date.now(), isError: true }, sessionId)
            }
            resetRun()
        } finally {
            if (runActive.current) resetRun()
        }
    }, [running, createSession, spaceId, append, folder, resetRun])

    const stop = useCallback(async () => {
        approvalRef.current?.resolve({ approved: false, alwaysAllow: false })
        try {
            if (agentLoopService.isRunning()) await agentLoopService.abort()
            if (modelRef.current.choice.mode === 'offline') await offlineLLMService.cancelGeneration()
            else aiService.cancelStream()
            await stopActiveTool()
        } catch (e) {
            console.error('Stopping the agent failed', e)
        }
        resetRun()
    }, [resetRun])

    const newChat = useCallback(() => {
        if (running) return
        if (session && session.messages.length === 0) return
        createSession('New Chat', spaceId)
        setSteps([])
    }, [running, session, createSession, spaceId])

    return {
        sessions: spaceSessions, session, messages: session?.messages ?? [],
        steps, streaming, thinking, running, iteration, approval,
        send, stop, newChat,
        selectSession: (id: string) => { if (!running) setCurrentSession(id) },
        deleteSession, renameSession
    }
}

export type AgentChatApi = ReturnType<typeof useAgentChat>

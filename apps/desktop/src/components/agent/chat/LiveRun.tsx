/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * What the agent is doing during a run: its steps, its reasoning, the
 * answer as it streams, and any tool waiting for approval.
 */
import { useState } from 'react'
import { AlertCircle, Brain, Check, ChevronRight, ListChecks, Loader2, Wrench } from 'lucide-react'
import type { AgentStep } from '../../../types/agentTypes'
import { Markdown } from './Markdown'
import { ToolApproval } from './ToolApproval'
import { describeTool, toolTarget } from './toolText'
import type { AgentChatApi } from './useAgentChat'

function StepLine({ step }: { step: AgentStep }) {
    const [open, setOpen] = useState(false)
    const icon = step.type === 'tool-call' ? <Wrench size={12} />
        : step.type === 'tool-result' ? <Check size={12} />
            : step.type === 'thinking' ? <Brain size={12} />
                : step.type === 'plan' ? <ListChecks size={12} />
                    : step.type === 'error' ? <AlertCircle size={12} />
                        : <ChevronRight size={12} />

    const title = step.type === 'tool-call' ? describeTool(step.name ?? 'tool')
        : step.type === 'tool-result' ? `${describeTool(step.name ?? 'tool')} finished`
            : step.type === 'plan' ? 'Plan'
                : step.type === 'error' ? 'Problem'
                    : step.type === 'thinking' ? 'Thinking' : 'Answer'

    const target = step.type === 'tool-call' ? toolTarget(step.params) : null
    const detail = step.type === 'tool-result'
        ? (typeof step.data === 'string' ? step.data : JSON.stringify(step.data ?? '', null, 2))
        : step.type === 'tool-call' ? JSON.stringify(step.params ?? {}, null, 2) : step.content

    return (
        <li className={`run-step run-step--${step.type}`}>
            <button type="button" className="run-step__head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
                <span className="run-step__icon" aria-hidden>{icon}</span>
                <span className="run-step__title">{title}</span>
                {target && <span className="run-step__target mono truncate">{target}</span>}
                {step.duration !== undefined && <span className="run-step__time">{step.duration < 1000 ? `${step.duration} ms` : `${(step.duration / 1000).toFixed(1)} s`}</span>}
            </button>
            {open && detail && <pre className="run-step__detail selectable">{detail.slice(0, 4000)}</pre>}
        </li>
    )
}

export function LiveRun({ chat }: { chat: AgentChatApi }) {
    const [showThinking, setShowThinking] = useState(false)
    if (!chat.running && !chat.approval) return null

    return (
        <div className="live-run" aria-live="polite">
            <div className="live-run__head">
                <Loader2 size={13} className="spin" aria-hidden />
                <span>{chat.approval ? 'Waiting for your approval' : chat.streaming ? 'Writing the answer' : 'Working'}</span>
                {chat.iteration && <span className="live-run__iter">Step {chat.iteration.current} of {chat.iteration.max}</span>}
            </div>

            {chat.steps.length > 0 && (
                <ol className="run-steps">
                    {chat.steps.map(step => <StepLine key={step.id} step={step} />)}
                </ol>
            )}

            {chat.thinking && (
                <div className="chat-thinking">
                    <button type="button" className="chat-thinking__head" onClick={() => setShowThinking(v => !v)} aria-expanded={showThinking}>
                        <ChevronRight size={12} className={showThinking ? 'is-open' : ''} aria-hidden />
                        Reasoning
                    </button>
                    {showThinking && <p className="chat-thinking__body selectable">{chat.thinking}</p>}
                </div>
            )}

            {chat.approval && <ToolApproval request={chat.approval.request} onDecide={chat.approval.resolve} />}

            {chat.streaming && (
                <div className="chat-msg chat-msg--agent is-streaming selectable">
                    <Markdown text={chat.streaming} />
                </div>
            )}
        </div>
    )
}

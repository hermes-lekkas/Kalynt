/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { memo, useState } from 'react'
import { AlertCircle, ChevronRight, Wrench } from 'lucide-react'
import type { ChatMessage } from '../../../types/chat'
import { Markdown } from './Markdown'
import { splitThinking } from './modelOutput'
import { cloudModelName, localModelName } from './modelNames'
import { describeTool } from './toolText'

function modelLabel(modelId?: string): string {
    if (!modelId) return 'Agent'
    return /^(gpt|o\d|claude|gemini)/.test(modelId) ? cloudModelName(modelId) : localModelName(modelId)
}

function ToolResult({ message }: { message: ChatMessage }) {
    const [open, setOpen] = useState(false)
    let output = message.data ?? ''
    let exit: number | undefined
    try {
        const parsed = JSON.parse(output)
        if (parsed && typeof parsed === 'object' && ('stdout' in parsed || 'stderr' in parsed)) {
            output = [parsed.stdout, parsed.stderr, parsed.error].filter(Boolean).join('\n')
            exit = parsed.exitCode
        }
    } catch { /* plain text */ }

    return (
        <div className={`chat-tool ${message.isError ? 'is-error' : ''}`}>
            <button type="button" className="chat-tool__head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
                <ChevronRight size={12} className={open ? 'is-open' : ''} aria-hidden />
                {message.isError ? <AlertCircle size={12} aria-hidden /> : <Wrench size={12} aria-hidden />}
                <span>{describeTool(message.name ?? 'tool')}</span>
                {exit !== undefined && <span className="chat-tool__exit">exit {exit}</span>}
            </button>
            {open && <pre className="chat-tool__output selectable">{output.slice(0, 6000) || 'No output.'}</pre>}
        </div>
    )
}

interface MessageItemProps {
    message: ChatMessage
}

export const MessageItem = memo(function MessageItem({ message }: MessageItemProps) {
    const [showThinking, setShowThinking] = useState(false)

    if (message.role === 'tool') return <ToolResult message={message} />

    if (message.role === 'user') {
        return (
            <div className="chat-msg chat-msg--user selectable">
                <Markdown text={message.content} />
            </div>
        )
    }

    const { thinking, answer } = splitThinking(message.content)
    return (
        <div className={`chat-msg chat-msg--agent ${message.isError ? 'is-error' : ''}`}>
            <div className="chat-msg__meta">
                {message.isError ? <><AlertCircle size={12} aria-hidden /> The agent stopped</> : modelLabel(message.modelId)}
            </div>
            {thinking && (
                <div className="chat-thinking">
                    <button type="button" className="chat-thinking__head" onClick={() => setShowThinking(v => !v)} aria-expanded={showThinking}>
                        <ChevronRight size={12} className={showThinking ? 'is-open' : ''} aria-hidden />
                        Reasoning
                    </button>
                    {showThinking && <p className="chat-thinking__body selectable">{thinking}</p>}
                </div>
            )}
            <div className="selectable">
                <Markdown text={answer || message.content} />
            </div>
        </div>
    )
})

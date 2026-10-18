/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Cpu, KeyRound, Lock } from 'lucide-react'
import type { FileItem } from '../../../types/ide'
import { useAppStore } from '../../../stores/appStore'
import { fileTransferService } from '../../../services/fileTransferService'
import { Button, EmptyState } from '../../ui'
import { Composer, type ComposerHandle, type MentionOption } from '../Composer'
import { AGENT_EVENTS } from '../../ide/hooks/useIdeCommands'
import { AGENT_MENTION_EVENT } from '../../ide/explorer/FileExplorer'
import { relativePath } from '../../ide/languages'
import { MessageItem } from './MessageItem'
import { LiveRun } from './LiveRun'
import { ModelPicker } from './ModelPicker'
import type { AgentChatApi } from './useAgentChat'
import type { ModelChoiceApi } from './useModelChoice'

const EXAMPLES = [
    'Explain how this project is structured',
    'Find likely bugs in the files I changed today',
    'Write tests for the open file'
]

interface AgentChatProps {
    chat: AgentChatApi
    model: ModelChoiceApi
    files: FileItem[]
    folder: string | null
    canUseAgent: boolean
}

export function AgentChat({ chat, model, files, folder, canUseAgent }: AgentChatProps) {
    const [draft, setDraft] = useState('')
    const composerRef = useRef<ComposerHandle>(null)
    const threadRef = useRef<HTMLDivElement>(null)
    const stickToBottom = useRef(true)
    const setShowSettings = useAppStore(s => s.setShowSettings)
    const setSettingsTab = useAppStore(s => s.setSettingsTab)
    const chatRef = useRef(chat)
    chatRef.current = chat
    const folderRef = useRef(folder)
    folderRef.current = folder

    useEffect(() => {
        const focus = () => composerRef.current?.focus()
        const newChat = () => { chatRef.current.newChat(); requestAnimationFrame(focus) }
        const mention = (e: Event) => {
            const { path, name } = (e as CustomEvent<{ path: string; name: string }>).detail
            composerRef.current?.mention({ kind: 'file', label: name, detail: relativePath(path, folderRef.current), insert: `@[${name}](local://${path})` })
        }
        window.addEventListener(AGENT_EVENTS.focus, focus)
        window.addEventListener(AGENT_EVENTS.newChat, newChat)
        window.addEventListener(AGENT_MENTION_EVENT, mention)
        return () => {
            window.removeEventListener(AGENT_EVENTS.focus, focus)
            window.removeEventListener(AGENT_EVENTS.newChat, newChat)
            window.removeEventListener(AGENT_MENTION_EVENT, mention)
        }
    }, [])

    // Follow new output unless the reader scrolled up.
    useLayoutEffect(() => {
        const el = threadRef.current
        if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
    }, [chat.messages.length, chat.steps.length, chat.streaming, chat.approval])

    const mentionOptions = useCallback((query: string): MentionOption[] => {
        const q = query.toLowerCase()
        const local = files
            .filter(f => f.type === 'file' && (!q || f.name.toLowerCase().includes(q) || relativePath(f.path, folder).toLowerCase().includes(q)))
            .slice(0, 8)
            .map(f => ({ kind: 'file' as const, label: f.name, detail: relativePath(f.path, folder), insert: `@[${f.name}](local://${f.path})` }))
        const shared = fileTransferService.getFiles()
            .filter(f => !q || f.name.toLowerCase().includes(q))
            .slice(0, 4)
            .map(f => ({ kind: 'file' as const, label: f.name, detail: 'Shared file', insert: `@[${f.name}](p2p://${f.id})` }))
        return [...local, ...shared]
    }, [files, folder])

    const openModels = () => { setSettingsTab('models'); setShowSettings(true) }

    if (!canUseAgent) {
        return <EmptyState icon={<Lock size={26} />} title="The agent is off for your role" description="Ask a workspace owner or admin to allow the agent for you." />
    }

    const submit = (text: string) => {
        if (!text.trim()) return
        chat.send(text)
        setDraft('')
        stickToBottom.current = true
    }

    const empty = chat.messages.length === 0 && !chat.running

    return (
        <div className="agent-chat">
            <div
                ref={threadRef}
                className="agent-chat__thread"
                onScroll={e => {
                    const el = e.currentTarget
                    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
                }}
            >
                {empty ? (
                    model.ready ? (
                        <div className="agent-chat__intro">
                            <p className="agent-chat__intro-title">What should we work on?</p>
                            <p className="agent-chat__intro-text">
                                The agent can read and search {folder ? 'this folder' : 'your files'}, edit files and run commands.
                                It asks before changing anything. Type @ to point it at a file.
                            </p>
                            <div className="agent-chat__examples">
                                {EXAMPLES.map(example => (
                                    <button key={example} type="button" className="agent-chat__example" onClick={() => { setDraft(example); composerRef.current?.focus() }}>
                                        {example}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <EmptyState
                            title="Connect a model to start"
                            description="Use a cloud model with your own API key, or download one that runs entirely on this machine."
                            actions={<>
                                <Button size="sm" icon={<KeyRound size={14} />} onClick={openModels}>Add an API key</Button>
                                <Button size="sm" icon={<Cpu size={14} />} onClick={openModels}>Get a local model</Button>
                            </>}
                        />
                    )
                ) : (
                    <div className="agent-chat__messages">
                        {chat.messages.map(message => <MessageItem key={message.id} message={message} />)}
                        <LiveRun chat={chat} />
                    </div>
                )}
            </div>

            {model.blockedReason && !empty && <p className="agent-chat__blocked">{model.blockedReason}</p>}

            <Composer
                ref={composerRef}
                value={draft}
                onChange={setDraft}
                onSubmit={submit}
                onStop={chat.stop}
                busy={chat.running}
                disabled={!model.ready && !chat.running}
                placeholder={model.ready ? 'Ask the agent to explain, change or run something' : 'Connect a model to ask the agent'}
                mentionOptions={mentionOptions}
                footer={<ModelPicker model={model} />}
                sendLabel="Send to agent"
            />
        </div>
    )
}

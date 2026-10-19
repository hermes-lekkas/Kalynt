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
import { Transcript } from './Transcript'
import { LiveTurnView } from './LiveTurnView'
import { PlanPanel, RunFooter } from './RunExtras'
import { ModeMenu, ModelPicker } from './ModelPicker'
import type { AgentChatApi } from './useAgentChat'
import type { ModelChoiceApi } from './useModelChoice'

const EXAMPLES = [
    'Explain how this project is structured',
    'Run the tests and fix what fails',
    'Find likely bugs in the files I changed today'
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
    }, [chat.revision, chat.live, chat.outputs, chat.approval])

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
        void chat.send(text)
        setDraft('')
        stickToBottom.current = true
    }

    const session = chat.session
    const empty = !session || (session.items.length === 0 && !(session.archive?.length) && !chat.running)

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
                                The agent can read and search {folder ? 'this project' : 'your files'}, edit code, run commands and tests, and look things up on the web.
                                {chat.mode === 'full-auto' ? ' It works without asking, except for risky commands.' : ' It asks before changing files or running commands.'} Type @ to point it at a file.
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
                            description="Use a cloud model with your own API key (Claude, OpenAI, Gemini, DeepSeek, Kimi or GLM), or download one that runs entirely on this machine."
                            actions={<>
                                <Button size="sm" icon={<KeyRound size={14} />} onClick={openModels}>Add an API key</Button>
                                <Button size="sm" icon={<Cpu size={14} />} onClick={openModels}>Get a local model</Button>
                            </>}
                        />
                    )
                ) : session && (
                    <div className="agent-chat__messages">
                        <Transcript session={session} workspace={folder} revision={chat.revision} outputs={chat.outputs} approval={chat.approval} />
                        {chat.running && <LiveTurnView turn={chat.live} working={!chat.approval} />}
                        <RunFooter session={session} folder={folder} running={chat.running} onUndo={chat.undoRun} onContinue={chat.continueRun} />
                    </div>
                )}
            </div>

            {model.blockedReason && !empty && <p className="agent-chat__blocked">{model.blockedReason}</p>}
            {session && <PlanPanel session={session} running={chat.running} />}

            <Composer
                ref={composerRef}
                value={draft}
                onChange={setDraft}
                onSubmit={submit}
                onStop={chat.stop}
                busy={chat.running}
                disabled={!model.ready && !chat.running}
                placeholder={model.ready ? 'Ask the agent to build, fix, explain or run something' : 'Connect a model to ask the agent'}
                mentionOptions={mentionOptions}
                footer={<div className="agent-chat__controls"><ModelPicker model={model} /><ModeMenu mode={chat.mode} onChange={chat.setMode} /></div>}
                sendLabel="Send to agent"
            />
        </div>
    )
}

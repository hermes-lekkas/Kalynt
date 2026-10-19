/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { CornerUpLeft, Loader2, Lock, MessagesSquare, ShieldOff, UserPlus } from 'lucide-react'
import type { FileItem } from '../../../types/ide'
import { useUiStore } from '../../../stores/uiStore'
import { Avatar, Button, EmptyState, IconButton } from '../../ui'
import { Composer, type MentionOption } from '../Composer'
import { Markdown } from '../chat/Markdown'
import { relativePath } from '../../ide/languages'
import type { TeamChatApi, TeamMessage } from './useTeamChat'

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

interface TeamChatProps {
    team: TeamChatApi
    files: FileItem[]
    folder: string | null
}

export function TeamChat({ team, files, folder }: TeamChatProps) {
    const [draft, setDraft] = useState('')
    const [replyTo, setReplyTo] = useState<TeamMessage | null>(null)
    const threadRef = useRef<HTMLDivElement>(null)
    const openCollaboration = useUiStore(s => s.openCollaboration)

    useLayoutEffect(() => {
        const el = threadRef.current
        if (el) el.scrollTop = el.scrollHeight
    }, [team.messages.length])

    const mentionOptions = useCallback((query: string): MentionOption[] => {
        const q = query.toLowerCase()
        const people = team.people
            .filter(p => !q || p.name.toLowerCase().includes(q))
            .map(p => ({ kind: 'person' as const, label: p.name, insert: `@${p.name.replace(/\s+/g, '')}` }))
        const fileOptions = files
            .filter(f => f.type === 'file' && q.length > 0 && f.name.toLowerCase().includes(q))
            .slice(0, 6)
            .map(f => ({ kind: 'file' as const, label: f.name, detail: relativePath(f.path, folder), insert: `@[${f.name}](local://${f.path})` }))
        return [...people, ...fileOptions]
    }, [team.people, files, folder])

    const submit = (text: string) => {
        team.send(text, replyTo)
        setDraft('')
        setReplyTo(null)
    }

    return (
        <div className="team-chat">
            <div className="team-chat__status">
                {team.encrypted
                    ? <span className="team-chat__lock"><Lock size={12} aria-hidden /> End-to-end encrypted</span>
                    : <span className="team-chat__lock is-off"><ShieldOff size={12} aria-hidden /> Not encrypted. Set a room password in Settings.</span>}
                <span>{team.peerCount > 0 ? `${team.peerCount} connected` : 'Only you'}</span>
            </div>

            <div ref={threadRef} className="team-chat__thread">
                {team.messages.length === 0 ? (
                    <EmptyState
                        icon={<MessagesSquare size={26} />}
                        title="No messages yet"
                        description="Messages go straight to the people in this workspace and stay in its history."
                        actions={team.peerCount === 0 ? <Button size="sm" icon={<UserPlus size={14} />} onClick={() => openCollaboration('invite')}>Invite people</Button> : undefined}
                    />
                ) : team.messages.map((m, i) => {
                    const prev = team.messages[i - 1]
                    const grouped = prev && prev.senderId === m.senderId && m.timestamp - prev.timestamp < 5 * 60_000 && !m.replyToId
                    return (
                        <article key={m.id} id={`team-${m.id}`} className={`team-msg ${m.own ? 'is-own' : ''} ${grouped ? 'is-grouped' : ''}`}>
                            {!grouped && (
                                <header className="team-msg__head">
                                    <Avatar name={m.sender || 'Someone'} size={20} />
                                    <span className="team-msg__name">{m.own ? 'You' : m.sender || 'Someone'}</span>
                                    <time className="team-msg__time">{time(m.timestamp)}</time>
                                    {m.encrypted && <Lock size={10} className="team-msg__lock" aria-label="Encrypted" />}
                                </header>
                            )}
                            {m.replyToId && (
                                <button type="button" className="team-msg__quote" onClick={() => document.getElementById(`team-${m.replyToId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}>
                                    <span>{m.replyToSender}</span> {m.replyToContent}
                                </button>
                            )}
                            <div className="team-msg__body selectable">
                                {m.decryptFailed ? <span className="team-msg__muted">Couldn’t decrypt this message. Check the room password.</span>
                                    : m.text === null ? <span className="team-msg__muted"><Loader2 size={11} className="spin" aria-hidden /> Decrypting</span>
                                        : <Markdown text={m.text} />}
                            </div>
                            <IconButton size="sm" className="team-msg__reply" label="Reply" icon={<CornerUpLeft size={13} />} onClick={() => setReplyTo(m)} />
                        </article>
                    )
                })}
            </div>

            {team.typingPeople.length > 0 && (
                <p className="team-chat__typing" aria-live="polite">
                    {team.typingPeople.length > 2 ? 'Several people are typing' : `${team.typingPeople.join(' and ')} ${team.typingPeople.length === 1 ? 'is' : 'are'} typing`}
                </p>
            )}

            <Composer
                value={draft}
                onChange={setDraft}
                onSubmit={submit}
                disabled={!team.canChat}
                placeholder={team.canChat ? 'Message the team' : 'Your role can’t send messages here'}
                mentionOptions={mentionOptions}
                onTyping={team.typing}
                banner={replyTo ? <><span className="composer__banner-label">Replying to {replyTo.own ? 'yourself' : replyTo.sender}</span> {replyTo.text?.slice(0, 120)}</> : undefined}
                onDismissBanner={() => setReplyTo(null)}
                sendLabel="Send message"
            />
        </div>
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, CornerUpLeft, KeyRound, Loader2, Lock, MessagesSquare, ShieldOff, UserPlus } from 'lucide-react'
import type { FileItem } from '../../../types/ide'
import { useUiStore } from '../../../stores/uiStore'
import { Avatar, Button, EmptyState, IconButton, TextInput } from '../../ui'
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
    const [retryInput, setRetryInput] = useState('')
    const [retrying, setRetrying] = useState(false)
    const [retryError, setRetryError] = useState<string | null>(null)
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

    const submitRetryPassword = async () => {
        if (!retryInput.trim() || retrying) return
        setRetrying(true)
        setRetryError(null)
        const result = await team.retryPassword(retryInput)
        setRetrying(false)
        if (result.ok) {
            setRetryInput('')
        } else {
            setRetryInput('')
            setRetryError(result.error || 'Incorrect room password. Check the password and try again.')
        }
    }

    const hasIncompatibleMessage = team.messages.some(m => m.decryptFailureReason === 'incompatible-version')
    const hasWrongPasswordMessage = team.messages.some(m => m.decryptFailureReason === 'wrong-password')
    const showProtocolBanner = team.authInfo.status === 'protocol-mismatch' || hasIncompatibleMessage
    const showPasswordRetry =
        team.authInfo.status === 'auth-failed' ||
        team.authInfo.status === 'password-required' ||
        hasWrongPasswordMessage

    const renderStatusLabel = () => {
        switch (team.authInfo.status) {
            case 'authenticated':
                return <span className="team-chat__lock"><Lock size={12} aria-hidden /> End-to-end encrypted</span>
            case 'key-configured':
                return <span className="team-chat__lock is-off"><KeyRound size={12} aria-hidden /> Room key set · Waiting for peers</span>
            case 'auth-failed':
                return <span className="team-chat__lock" style={{ color: 'var(--danger)' }}><AlertTriangle size={12} aria-hidden /> Incorrect room password</span>
            case 'password-required':
                return <span className="team-chat__lock" style={{ color: 'var(--warning)' }}><Lock size={12} aria-hidden /> Room password required</span>
            case 'protocol-mismatch':
                return <span className="team-chat__lock" style={{ color: 'var(--warning)' }}><AlertTriangle size={12} aria-hidden /> Incompatible Kalynt version</span>
            case 'unencrypted':
            default:
                return team.encrypted
                    ? <span className="team-chat__lock is-off"><KeyRound size={12} aria-hidden /> Room key set · Waiting for peers</span>
                    : <span className="team-chat__lock is-off"><ShieldOff size={12} aria-hidden /> Not encrypted. Set a room password in Settings.</span>
        }
    }

    return (
        <div className="team-chat">
            <div className="team-chat__status">
                {renderStatusLabel()}
                <span>{team.peerCount > 0 ? `${team.peerCount} connected` : 'Only you'}</span>
            </div>

            {showProtocolBanner && (
                <div
                    role="alert"
                    style={{
                        padding: '10px 14px',
                        borderBottom: '1px solid var(--line)',
                        background: 'color-mix(in srgb, var(--warning) 10%, transparent)',
                        color: 'var(--text)',
                        fontSize: 'var(--fs-xs)',
                        lineHeight: 1.45,
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '8px'
                    }}
                >
                    <AlertTriangle size={14} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '1px' }} aria-hidden />
                    <span>
                        {team.authInfo.reason || 'A peer in this workspace is using an older Kalynt 2.0 encryption protocol. All room members must upgrade to Kalynt 2.1 to exchange encrypted messages.'}
                    </span>
                </div>
            )}

            {showPasswordRetry && (
                <div
                    role="alert"
                    style={{
                        padding: '10px 14px',
                        borderBottom: '1px solid var(--line)',
                        background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
                        color: 'var(--text)',
                        fontSize: 'var(--fs-xs)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px'
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--danger)' }}>
                        <AlertTriangle size={13} aria-hidden />
                        <span>
                            {retryError || team.authInfo.reason || (team.authInfo.status === 'password-required'
                                ? 'This workspace requires a room password to decrypt messages and connect to peers.'
                                : 'Your room password did not match online peers. Re-enter the room password to retry.')}
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <TextInput
                            type="password"
                            value={retryInput}
                            autoComplete="off"
                            placeholder="Enter room password"
                            aria-label="Room password"
                            onChange={e => { setRetryInput(e.target.value); setRetryError(null) }}
                            onKeyDown={e => { if (e.key === 'Enter') void submitRetryPassword() }}
                        />
                        <Button
                            size="sm"
                            variant="primary"
                            loading={retrying}
                            disabled={!retryInput.trim()}
                            onClick={() => void submitRetryPassword()}
                        >
                            Retry password
                        </Button>
                    </div>
                </div>
            )}

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
                            {m.replyToId && (m.replyToSender || m.replyToContent) && (
                                <button type="button" className="team-msg__quote" onClick={() => document.getElementById(`team-${m.replyToId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}>
                                    <span>{m.replyToSender}</span> {m.replyToContent}
                                </button>
                            )}
                            <div className="team-msg__body selectable">
                                {m.decryptFailed ? (
                                    <span className="team-msg__muted">
                                        {m.decryptFailureReason === 'incompatible-version'
                                            ? 'Encrypted with an incompatible Kalynt 2.0 protocol. All room members must upgrade to Kalynt 2.1.'
                                            : 'Couldn’t decrypt this message. Re-enter the room password above.'}
                                    </span>
                                ) : m.text === null ? (
                                    <span className="team-msg__muted"><Loader2 size={11} className="spin" aria-hidden /> Decrypting</span>
                                ) : (
                                    <Markdown text={m.text} />
                                )}
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

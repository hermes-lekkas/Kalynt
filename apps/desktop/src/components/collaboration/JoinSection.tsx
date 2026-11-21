/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { p2pService, normalizeRoomId } from '../../services/p2pService'
import { useUiStore } from '../../stores/uiStore'
import { Button, Field, TextInput } from '../ui'

interface JoinSectionProps {
    onJoin: (input: string, password?: string) => Promise<void>
    isJoining: boolean
    error: string | null
    onJoined: () => void
}

interface Parsed {
    roomId: string
    spaceName?: string
    password?: string
    passwordProtected?: boolean
}

function parse(input: string): Parsed | string {
    const value = input.trim()
    if (!value) return 'Paste an invite link or type a room code.'
    if (value.includes('://') && !value.startsWith('kalynt://') && !value.startsWith('collabforge://')) {
        return 'Only kalynt:// invite links work here.'
    }
    const link = p2pService.parseRoomLink(value)
    if (link) {
        return {
            roomId: normalizeRoomId(link.roomId),
            spaceName: link.spaceName,
            password: link.password,
            passwordProtected: link.passwordProtected
        }
    }
    if (value.length <= 50 && !/\s/.test(value) && !value.includes('://')) {
        return { roomId: normalizeRoomId(value) }
    }
    return 'That doesn’t look like an invite link or room code.'
}

export default function JoinSection({ onJoin, isJoining, error, onJoined }: JoinSectionProps) {
    const pendingJoinInvite = useUiStore(s => s.pendingJoinInvite)
    const clearPendingJoinInvite = useUiStore(s => s.clearPendingJoinInvite)

    const [input, setInput] = useState(() => pendingJoinInvite?.url ?? '')
    const [password, setPassword] = useState(() => pendingJoinInvite?.password ?? '')
    const [parsed, setParsed] = useState<Parsed | null>(() =>
        pendingJoinInvite
            ? {
                roomId: normalizeRoomId(pendingJoinInvite.roomId),
                spaceName: pendingJoinInvite.spaceName,
                password: pendingJoinInvite.password,
                passwordProtected: pendingJoinInvite.passwordProtected
            }
            : null
    )
    const [localError, setLocalError] = useState<string | null>(null)
    const passwordInputRef = useRef<HTMLInputElement | null>(null)

    // Consume cold/warm deep links targeting password-protected rooms and land directly on the password prompt.
    useEffect(() => {
        if (!pendingJoinInvite) return
        setInput(pendingJoinInvite.url)
        setParsed({
            roomId: normalizeRoomId(pendingJoinInvite.roomId),
            spaceName: pendingJoinInvite.spaceName,
            password: pendingJoinInvite.password,
            passwordProtected: pendingJoinInvite.passwordProtected
        })
        setPassword(pendingJoinInvite.password ?? '')
        setLocalError(null)
    }, [pendingJoinInvite])

    const next = () => {
        const result = parse(input)
        if (typeof result === 'string') { setLocalError(result); return }
        setLocalError(null)
        setParsed(result)
        if (result.password) setPassword(result.password)
    }

    const join = async () => {
        if (!parsed) return
        setLocalError(null)
        if (parsed.passwordProtected && !password.trim()) {
            setLocalError('This workspace requires a room password.')
            passwordInputRef.current?.focus()
            return
        }
        try {
            await onJoin(input.trim() || parsed.roomId, password || undefined)
            clearPendingJoinInvite()
            onJoined()
        } catch (err) {
            // Stay on the password step, clear the failed password, and allow immediate retry.
            setPassword('')
            setLocalError(err instanceof Error ? err.message : 'Failed to join workspace.')
            passwordInputRef.current?.focus()
        }
    }

    if (parsed) {
        const displayError = localError || error
        return (
            <div className="collab-pane">
                <button
                    type="button"
                    className="collab-back"
                    onClick={() => {
                        setParsed(null)
                        setPassword('')
                        setLocalError(null)
                        clearPendingJoinInvite()
                    }}
                >
                    <ArrowLeft size={14} aria-hidden /> Back
                </button>
                <header className="collab-pane__head">
                    <h3>Join {parsed.spaceName ? `“${parsed.spaceName}”` : 'this workspace'}</h3>
                    <p>Room <span className="mono">{parsed.roomId.slice(0, 18)}{parsed.roomId.length > 18 ? '…' : ''}</span>. You’ll connect directly to the people already in it.</p>
                </header>
                <Field
                    label="Room password"
                    hint={
                        parsed.passwordProtected
                            ? 'This workspace is password-protected. Enter the room password from the person who invited you.'
                            : 'Only if the workspace has one. Ask the person who invited you.'
                    }
                >
                    {id => (
                        <TextInput
                            ref={passwordInputRef}
                            id={id}
                            type="password"
                            autoFocus
                            value={password}
                            invalid={!!displayError}
                            autoComplete="off"
                            onChange={e => { setPassword(e.target.value); setLocalError(null) }}
                            onKeyDown={e => { if (e.key === 'Enter') void join() }}
                        />
                    )}
                </Field>
                {displayError && <p className="collab-error" role="alert">{displayError}</p>}
                <div><Button variant="primary" loading={isJoining} onClick={() => void join()}>Join workspace</Button></div>
            </div>
        )
    }

    return (
        <div className="collab-pane">
            <header className="collab-pane__head">
                <h3>Join a session</h3>
                <p>Paste the invite link someone sent you, or type their room code.</p>
            </header>
            <Field label="Invite link or room code" error={localError}>
                {id => (
                    <TextInput
                        id={id}
                        mono
                        autoFocus
                        value={input}
                        invalid={!!localError}
                        placeholder="kalynt://join/… or a room code"
                        onChange={e => { setInput(e.target.value); setLocalError(null) }}
                        onKeyDown={e => { if (e.key === 'Enter') next() }}
                    />
                )}
            </Field>
            <div><Button variant="primary" onClick={next} disabled={!input.trim()}>Continue</Button></div>
        </div>
    )
}

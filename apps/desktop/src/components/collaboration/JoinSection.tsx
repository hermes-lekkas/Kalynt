/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { p2pService } from '../../services/p2pService'
import { encryptionService } from '../../services/encryptionService'
import { setRoomPassword } from '../../services/roomPasswordStore'
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
}

function parse(input: string): Parsed | string {
    const value = input.trim()
    if (!value) return 'Paste an invite link or type a room code.'
    if (value.includes('://') && !value.startsWith('kalynt://')) return 'Only kalynt:// invite links work here.'
    const link = p2pService.parseRoomLink(value)
    if (link) return { roomId: link.roomId, spaceName: link.spaceName, password: link.password }
    if (value.length <= 50 && !/\s/.test(value)) return { roomId: value.toLowerCase() }
    return 'That doesn’t look like an invite link or room code.'
}

export default function JoinSection({ onJoin, isJoining, error, onJoined }: JoinSectionProps) {
    const [input, setInput] = useState('')
    const [password, setPassword] = useState('')
    const [parsed, setParsed] = useState<Parsed | null>(null)
    const [localError, setLocalError] = useState<string | null>(null)

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
        // Store the password before joining so the connection uses it from the start,
        // the same way Settings › Security stores it.
        if (password) {
            try {
                await setRoomPassword(parsed.roomId, password)
            } catch (e) {
                setLocalError(e instanceof Error ? e.message : String(e))
                return
            }
            await encryptionService.setRoomKey(parsed.roomId, password).catch(() => undefined)
        }
        try {
            await onJoin(input.trim())
            onJoined()
        } catch {
            // The hook reports the error.
        }
    }

    if (parsed) {
        return (
            <div className="collab-pane">
                <button type="button" className="collab-back" onClick={() => { setParsed(null); setPassword(''); setLocalError(null) }}>
                    <ArrowLeft size={14} aria-hidden /> Back
                </button>
                <header className="collab-pane__head">
                    <h3>Join {parsed.spaceName ? `“${parsed.spaceName}”` : 'this workspace'}</h3>
                    <p>Room <span className="mono">{parsed.roomId.slice(0, 18)}{parsed.roomId.length > 18 ? '…' : ''}</span>. You’ll connect directly to the people already in it.</p>
                </header>
                <Field label="Room password" hint="Only if the workspace has one. Ask the person who invited you.">
                    {id => (
                        <TextInput id={id} type="password" value={password} autoComplete="off" onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') join() }} />
                    )}
                </Field>
                {(localError || error) && <p className="collab-error" role="alert">{localError || error}</p>}
                <div><Button variant="primary" loading={isJoining} onClick={join}>Join workspace</Button></div>
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

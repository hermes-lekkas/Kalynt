/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { Badge, Button, Field, TextInput } from '../ui'

interface InviteSectionProps {
    spaceId: string
    onGenerateLink: () => { url: string; code: string } | null
    onOpenSecurity: () => void
}

function hasPassword(spaceId: string): boolean {
    try {
        const s = JSON.parse(localStorage.getItem(`space-settings-${spaceId}`) || '{}')
        return !!(s.encryptionEnabled && s.roomPassword)
    } catch {
        return false
    }
}

export default function InviteSection({ spaceId, onGenerateLink, onOpenSecurity }: InviteSectionProps) {
    const spaceName = useAppStore(s => s.currentSpace?.name)
    const [invite] = useState(onGenerateLink)
    const [copied, setCopied] = useState<'link' | 'code' | null>(null)
    const protectedRoom = hasPassword(spaceId)

    const copy = async (text: string, which: 'link' | 'code') => {
        await navigator.clipboard.writeText(text)
        setCopied(which)
        setTimeout(() => setCopied(null), 1800)
    }

    if (!invite) {
        return <p className="collab-note">Open a workspace to invite people to it.</p>
    }

    return (
        <div className="collab-pane">
            <header className="collab-pane__head">
                <h3>Invite people to {spaceName}</h3>
                <p>Anyone with the link joins as a member and connects to you directly. Nothing passes through a Kalynt server.</p>
            </header>

            <Field label="Invite link" hint="Opens Kalynt and joins this workspace.">
                {id => (
                    <div className="collab-copy">
                        <TextInput id={id} mono readOnly value={invite.url} onFocus={e => e.currentTarget.select()} />
                        <Button variant="primary" icon={copied === 'link' ? <Check size={14} /> : <Copy size={14} />} onClick={() => copy(invite.url, 'link')}>
                            {copied === 'link' ? 'Copied' : 'Copy link'}
                        </Button>
                    </div>
                )}
            </Field>

            <Field label="Room code" hint="For people who prefer to type it in “Join a session”.">
                {id => (
                    <div className="collab-copy">
                        <TextInput id={id} mono readOnly value={invite.code} onFocus={e => e.currentTarget.select()} />
                        <Button icon={copied === 'code' ? <Check size={14} /> : <Copy size={14} />} onClick={() => copy(invite.code, 'code')}>
                            {copied === 'code' ? 'Copied' : 'Copy code'}
                        </Button>
                    </div>
                )}
            </Field>

            <div className="collab-callout">
                {protectedRoom ? (
                    <>
                        <Badge tone="success">Password protected</Badge>
                        <p>Share the room password separately, for example by phone. It is not part of the link.</p>
                    </>
                ) : (
                    <>
                        <Badge tone="warning">No room password</Badge>
                        <p>Anyone with the link or code can join and read the shared document. Set a password to encrypt everything end to end.</p>
                        <Button size="sm" onClick={onOpenSecurity}>Set a password</Button>
                    </>
                )}
            </div>

        </div>
    )
}

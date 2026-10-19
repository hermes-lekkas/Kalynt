/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { encryptionService } from '../../services/encryptionService'
import { clearRoomPassword, getRoomPassword, setRoomPassword } from '../../services/roomPasswordStore'
import { Badge, Button, Field, IconButton, TextInput, confirmAction } from '../ui'
import { SavedNote, SettingsPage, SettingsSection } from './parts'

function WorkspaceEncryption({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
    // The saved password: undefined while loading from secure storage, null when there is none.
    const [stored, setStored] = useState<string | null | undefined>(undefined)
    const [password, setPassword] = useState('')
    const [visible, setVisible] = useState(false)
    const [saved, setSaved] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const active = !!stored

    useEffect(() => {
        let live = true
        getRoomPassword(spaceId).then(value => {
            if (!live) return
            setStored(value)
            if (value) setPassword(current => current || value)
        })
        return () => { live = false }
    }, [spaceId])

    const save = async () => {
        if (!password.trim()) return
        setError(null)
        try {
            await setRoomPassword(spaceId, password)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
            return
        }
        await encryptionService.setRoomKey(spaceId, password)
        setStored(password)
        setSaved(true)
        setTimeout(() => setSaved(false), 1800)
    }

    const turnOff = async () => {
        const ok = await confirmAction({
            title: 'Turn off the room password?',
            message: 'New team messages will be sent without end-to-end encryption, and people can join with the room code alone.',
            confirmLabel: 'Turn off',
            danger: true
        })
        if (!ok) return
        await clearRoomPassword(spaceId)
        setStored(null)
        setPassword('')
    }

    return (
        <SettingsSection
            title={`Room password for ${spaceName}`}
            description="Everyone in the workspace uses the same password. It encrypts team chat and the shared document with AES-256-GCM, and people need it to join. Share it outside Kalynt."
            actions={stored === undefined ? undefined : active ? <Badge tone="success">Encrypted</Badge> : <Badge>Not encrypted</Badge>}
        >
            <Field label="Password" error={error} hint={password && password.length < 12 ? 'Longer is stronger. Twelve or more characters is a good minimum.' : 'Changes apply after peers reconnect.'}>
                {id => (
                    <div className="set-inline">
                        <TextInput
                            id={id}
                            type={visible ? 'text' : 'password'}
                            value={password}
                            autoComplete="new-password"
                            placeholder="Choose a password to share with collaborators"
                            onChange={e => setPassword(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') save() }}
                            trailing={<IconButton size="sm" label={visible ? 'Hide password' : 'Show password'} icon={visible ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => setVisible(v => !v)} />}
                        />
                        <Button variant="primary" onClick={save} disabled={!password.trim() || password === stored}>Save password</Button>
                        <SavedNote show={saved} />
                    </div>
                )}
            </Field>
            {active && <Button variant="ghost" size="sm" onClick={turnOff}>Turn off the room password</Button>}
        </SettingsSection>
    )
}

function GithubToken() {
    const [token, setToken] = useState('')
    const [stored, setStored] = useState(false)
    const [visible, setVisible] = useState(false)
    const [busy, setBusy] = useState(false)
    const [saved, setSaved] = useState(false)

    useEffect(() => {
        window.electronAPI?.safeStorage?.get('github-update-token')
            .then((r: { success?: boolean; value?: string }) => { if (r?.success && r.value) { setToken(r.value); setStored(true) } })
            .catch(() => undefined)
    }, [])

    const save = async () => {
        if (!token.trim()) return
        setBusy(true)
        try {
            const r = await window.electronAPI?.safeStorage?.set({ key: 'github-update-token', value: token.trim() })
            if (r?.success) {
                await window.electronAPI?.update?.configureToken(token.trim())
                setStored(true)
                setSaved(true)
                setTimeout(() => setSaved(false), 1800)
            }
        } finally {
            setBusy(false)
        }
    }

    const remove = async () => {
        setBusy(true)
        try {
            await window.electronAPI?.safeStorage?.delete('github-update-token')
            await window.electronAPI?.update?.configureToken('')
            setToken('')
            setStored(false)
        } finally {
            setBusy(false)
        }
    }

    return (
        <SettingsSection
            title="GitHub access token"
            description="Optional. Used to clone, pull and push private repositories over HTTPS, and to download updates from private release feeds. Stored in your system keychain."
            actions={stored ? <Badge tone="success">Saved</Badge> : undefined}
        >
            <div className="set-inline">
                <TextInput
                    mono
                    type={visible ? 'text' : 'password'}
                    value={token}
                    aria-label="GitHub personal access token"
                    placeholder="ghp_…"
                    onChange={e => setToken(e.target.value)}
                    trailing={<IconButton size="sm" label={visible ? 'Hide token' : 'Show token'} icon={visible ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => setVisible(v => !v)} />}
                />
                <Button variant="primary" loading={busy} onClick={save} disabled={!token.trim()}>Save token</Button>
                {stored && <Button variant="ghost" onClick={remove} disabled={busy}>Remove</Button>}
                <SavedNote show={saved} />
            </div>
        </SettingsSection>
    )
}

export function SecuritySettings() {
    const currentSpace = useAppStore(s => s.currentSpace)
    return (
        <SettingsPage title="Security" description="API keys and tokens live in your operating system's keychain, not in plain files.">
            {currentSpace
                ? <WorkspaceEncryption key={currentSpace.id} spaceId={currentSpace.id} spaceName={currentSpace.name} />
                : <p className="set-note">Open a workspace to set its room password.</p>}
            <GithubToken />
        </SettingsPage>
    )
}

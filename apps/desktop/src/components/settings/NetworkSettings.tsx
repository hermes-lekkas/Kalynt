/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { p2pService } from '../../services/p2pService'
import { Badge, Button, Field, TextInput } from '../ui'
import { SavedNote, SettingsPage, SettingsSection } from './parts'

const TURN_KEY = 'kalynt-turn-settings'

interface TestResult {
    stun: boolean
    turn: boolean
    candidates?: { type: string; protocol: string }[]
    error?: string
}

function ResultLine({ ok, label }: { ok: boolean; label: string }) {
    return (
        <span className={`net-result__line ${ok ? 'is-ok' : 'is-bad'}`}>
            {ok ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden />}
            {label}
        </span>
    )
}

export function NetworkSettings() {
    const [turn, setTurn] = useState(() => {
        const s = p2pService.getTurnSettings()
        return { url: s.url, username: s.username, credential: s.credential }
    })
    const [saved, setSaved] = useState(false)
    const [testing, setTesting] = useState(false)
    const [result, setResult] = useState<TestResult | null>(null)

    const complete = !!(turn.url && turn.username && turn.credential)
    const partial = !complete && !!(turn.url || turn.username || turn.credential)

    const save = () => {
        localStorage.setItem(TURN_KEY, JSON.stringify(turn))
        p2pService.refreshTurnSettings()
        setSaved(true)
        setTimeout(() => setSaved(false), 1800)
    }

    // Tests the values in the form without keeping them unless they were saved.
    const test = async () => {
        setTesting(true)
        setResult(null)
        const previous = localStorage.getItem(TURN_KEY)
        try {
            if (complete) localStorage.setItem(TURN_KEY, JSON.stringify(turn))
            setResult(await p2pService.testConnectivity())
        } catch (e) {
            setResult({ stun: false, turn: false, error: e instanceof Error ? e.message : String(e) })
        } finally {
            if (previous === null) localStorage.removeItem(TURN_KEY)
            else localStorage.setItem(TURN_KEY, previous)
            setTesting(false)
        }
    }

    return (
        <SettingsPage
            title="Network"
            description="Kalynt connects collaborators directly, peer to peer. A public STUN server helps peers find each other; a TURN relay is only needed when both sides are behind strict firewalls."
        >
            <SettingsSection
                title="TURN relay"
                description="Optional. Use your own relay credentials, for example from a free metered.ca account. They stay on this machine."
                actions={complete ? <Badge tone="success">Configured</Badge> : partial ? <Badge tone="warning">Incomplete</Badge> : <Badge>Not set</Badge>}
            >
                <Field label="Relay URL">
                    {id => <TextInput id={id} mono value={turn.url} placeholder="turn:relay.example.com:80" onChange={e => setTurn({ ...turn, url: e.target.value })} />}
                </Field>
                <div className="set-grid-2">
                    <Field label="Username">
                        {id => <TextInput id={id} value={turn.username} autoComplete="off" onChange={e => setTurn({ ...turn, username: e.target.value })} />}
                    </Field>
                    <Field label="Credential">
                        {id => <TextInput id={id} type="password" value={turn.credential} autoComplete="new-password" onChange={e => setTurn({ ...turn, credential: e.target.value })} />}
                    </Field>
                </div>
                <div className="set-inline">
                    <Button variant="primary" onClick={save} disabled={partial}>Save and reconnect</Button>
                    <SavedNote show={saved} />
                </div>
            </SettingsSection>

            <SettingsSection
                title="Connection test"
                description="Checks whether this machine can reach the STUN server, and the relay if one is set."
                actions={<Button loading={testing} onClick={test}>{testing ? 'Testing' : 'Run test'}</Button>}
            >
                {result ? (
                    <div className="net-result" role="status">
                        <ResultLine ok={result.stun} label={result.stun ? 'Peers can find this machine (STUN)' : 'STUN server unreachable'} />
                        {complete && <ResultLine ok={result.turn} label={result.turn ? 'Relay reachable (TURN)' : 'Relay unreachable. Check the URL and credentials.'} />}
                        {result.candidates && result.candidates.length > 0 && (
                            <p className="net-result__note">{result.candidates.length} network route{result.candidates.length === 1 ? '' : 's'} found.</p>
                        )}
                        {result.error && <p className="net-result__note is-error">{result.error}</p>}
                    </div>
                ) : (
                    <p className="set-note">No test run yet.</p>
                )}
            </SettingsSection>
        </SettingsPage>
    )
}

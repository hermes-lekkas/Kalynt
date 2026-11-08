/* SPDX-License-Identifier: AGPL-3.0-only */
import { useEffect, useState } from 'react'
import { Check, Plug } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import type { LocalServerStatus } from '../../types/aiProtocol'
import { Badge, Button, Field, Select, TextInput, confirmAction } from '../ui'

export function LocalServerSettings() {
    const [status, setStatus] = useState<LocalServerStatus | null>(null)
    const [url, setUrl] = useState('http://127.0.0.1:11434/v1')
    const [token, setToken] = useState('')
    const [context, setContext] = useState(8192)
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState('')
    const [error, setError] = useState('')

    useEffect(() => {
        let active = true
        const api = window.electronAPI?.ai
        if (!api) { setError('Connecting a local server needs the desktop app.'); return }
        api.localServerStatus().then(value => {
            if (!active) return
            setStatus(value)
            setContext(value.contextWindow)
            if (value.baseUrl) setUrl(value.baseUrl)
        }).catch(() => { if (active) setError('Could not read the saved connection. Reopen settings and try again.') })
        return () => { active = false }
    }, [])

    const connect = async () => {
        const api = window.electronAPI?.ai
        if (!api || busy) return
        setBusy(true); setError(''); setMessage('')
        try {
            const result = await api.connectLocalServer({ baseUrl: url, apiKey: token || undefined, contextWindow: context })
            if (!result.ok) { setError(result.error || 'Could not connect. Check that the server is running.'); return }
            setToken('')
            const saved = await api.localServerStatus()
            setStatus(saved); setUrl(saved.baseUrl)
            await useAppStore.getState().loadAPIKeys()
            setMessage(`Connection saved. ${result.models?.length ?? 0} models found. Choose one in the agent's model menu.`)
        } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the connection.') }
        finally { setBusy(false) }
    }

    const disconnect = async () => {
        if (!await confirmAction({ title: 'Remove this local server?', message: 'The endpoint and its saved token will be removed from Kalynt. Your server and models are kept.', confirmLabel: 'Remove connection' })) return
        setBusy(true); setError(''); setMessage('')
        try {
            const result = await window.electronAPI.ai.disconnectLocalServer()
            if (!result.ok) { setError(result.error || 'Could not remove the connection.'); return }
            setStatus({ configured: false, baseUrl: '', hasToken: false, contextWindow: 8192 }); setToken('')
            await useAppStore.getState().loadAPIKeys()
        } catch { setError('Could not remove the saved connection. Try again.') }
        finally { setBusy(false) }
    }

    return (
        <div className="server-setup">
            {status?.configured && <Badge tone="success" icon={<Check size={11} />}>Connection saved</Badge>}
            <p className="set-section__desc">Keep the models you already use. Start Ollama, or load a model and enable the local server in LM Studio. Agent tasks need a model that supports tools.</p>
            <div className="set-inline">
                <Button size="sm" disabled={busy} onClick={() => { setUrl('http://127.0.0.1:11434/v1'); setError(''); setMessage('') }}>Ollama preset</Button>
                <Button size="sm" disabled={busy} onClick={() => { setUrl('http://127.0.0.1:1234/v1'); setError(''); setMessage('') }}>LM Studio preset</Button>
            </div>
            <Field label="Server URL" hint="Use a loopback address on this computer. Requests go directly from Kalynt to this endpoint; redirects and remote hosts are not allowed.">
                {id => <TextInput id={id} value={url} mono disabled={busy} onChange={e => { setUrl(e.target.value); setError(''); setMessage('') }} placeholder="http://127.0.0.1:11434/v1" />}
            </Field>
            <Field label="Server token (optional)" hint={status?.hasToken && status.baseUrl === url ? 'Leave blank to keep the saved token. Remove the connection to clear it.' : 'Usually unnecessary for Ollama. If your server requires authentication, its token is kept in your system keychain.'}>
                {id => <TextInput id={id} type="password" autoComplete="off" value={token} disabled={busy} onChange={e => setToken(e.target.value)} placeholder="Only if your server requires one" />}
            </Field>
            <Field label="Server context window" hint="Match the context configured in your server. Larger windows need more memory. Kalynt does not change your server's configuration.">
                {id => <Select id={id} value={context} disabled={busy} onChange={e => setContext(Number(e.target.value))}>{[4096, 8192, 16384, 32768, 65536, 131072, 262144].map(n => <option key={n} value={n}>{n.toLocaleString()} tokens</option>)}</Select>}
            </Field>
            <div className="set-inline">
                <Button variant="primary" icon={<Plug size={14} />} loading={busy} disabled={!url.trim()} onClick={connect}>Test and connect</Button>
                {status?.configured && <Button variant="ghost" disabled={busy} onClick={disconnect}>Remove connection</Button>}
            </div>
            {error && <p className="key-row__error" role="alert">{error}</p>}
            {message && <p className="server-setup__success" role="status">{message}</p>}
            <p className="set-section__desc">Some Ollama models use remote inference even through a local endpoint. Check the model's configuration if your code must stay offline.</p>
        </div>
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState } from 'react'
import { Check } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { aiService, type AIProvider } from '../../services/aiService'
import { Badge, Button, TextInput, confirmAction } from '../ui'

interface ApiKeyRowProps {
    provider: AIProvider
    name: string
    models: string
    placeholder: string
    consoleUrl: string
}

/** Add, replace or remove one provider's API key. Keys are checked before saving. */
export function ApiKeyRow({ provider, name, models, placeholder, consoleUrl }: ApiKeyRowProps) {
    const { apiKeys, setAPIKey, removeAPIKey } = useAppStore()
    const hasKey = !!apiKeys[provider]
    const [editing, setEditing] = useState(false)
    const [value, setValue] = useState('')
    const [checking, setChecking] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const save = async () => {
        const key = value.trim()
        if (!key) return
        setChecking(true)
        setError(null)
        try {
            const valid = await aiService.verifyKey(provider, key)
            if (!valid) {
                setError(`${name} didn't accept this key. Check that it was copied in full and is active.`)
                return
            }
            await setAPIKey(provider, key)
            setEditing(false)
            setValue('')
        } catch {
            setError(`Couldn't reach ${name} to check the key. Check your connection and try again.`)
        } finally {
            setChecking(false)
        }
    }

    const remove = async () => {
        const ok = await confirmAction({
            title: `Remove your ${name} key?`,
            message: `The agent won't be able to use ${name} models until you add a key again.`,
            confirmLabel: 'Remove key',
            danger: true
        })
        if (ok) await removeAPIKey(provider)
    }

    return (
        <div className="key-row">
            <div className="key-row__info">
                <div className="key-row__name">
                    {name}
                    {hasKey && <Badge tone="success" icon={<Check size={11} />}>Connected</Badge>}
                </div>
                <p className="key-row__models">{models}</p>
            </div>
            {editing ? (
                <div className="key-row__edit">
                    <TextInput
                        type="password"
                        mono
                        autoFocus
                        value={value}
                        placeholder={placeholder}
                        aria-label={`${name} API key`}
                        invalid={!!error}
                        disabled={checking}
                        onChange={e => { setValue(e.target.value); setError(null) }}
                        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) } }}
                    />
                    <div className="key-row__buttons">
                        <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setValue(''); setError(null) }} disabled={checking}>Cancel</Button>
                        <Button size="sm" variant="primary" loading={checking} disabled={!value.trim()} onClick={save}>
                            {checking ? 'Checking' : 'Save key'}
                        </Button>
                    </div>
                    {error ? <p className="key-row__error" role="alert">{error}</p> : (
                        <p className="key-row__hint">
                            Create a key in your <a href={consoleUrl} onClick={e => { e.preventDefault(); window.electronAPI?.shell?.openExternal?.(consoleUrl) }}>{name} console</a>.
                            It is stored in your system keychain.
                        </p>
                    )}
                </div>
            ) : (
                <div className="key-row__buttons">
                    {hasKey && <Button size="sm" variant="ghost" onClick={remove}>Remove</Button>}
                    <Button size="sm" onClick={() => setEditing(true)}>{hasKey ? 'Replace key' : 'Add key'}</Button>
                </div>
            )}
        </div>
    )
}

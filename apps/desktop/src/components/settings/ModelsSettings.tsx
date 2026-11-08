/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState } from 'react'
import { useModelStore } from '../../stores/modelStore'
import { useAppStore } from '../../stores/appStore'
import { formatBytes } from '../../types/offlineModels'
import { CLOUD_PROVIDERS } from '../../types/aiProviders'
import { ApiKeyRow } from './ApiKeyRow'
import { LocalModels } from './LocalModels'
import { LocalServerSettings } from './LocalServerSettings'
import { SettingsPage, SettingsSection } from './parts'

export function ModelsSettings() {
    const totalSize = useModelStore(s => s.getTotalDownloadedSize())
    const requested = useAppStore(s => s.settingsTab)
    const [route, setRoute] = useState<'local' | 'server' | 'cloud'>(() => requested === 'models-server' ? 'server' : requested === 'models-cloud' ? 'cloud' : 'local')

    return (
        <SettingsPage
            title="Models and keys"
            description="Choose how to connect AI. Download a model, reuse your local server, or bring your own cloud API key. You can change this later."
        >
            <div className="model-setup-tabs" role="tablist" aria-label="AI setup options">
                {([['local', 'Download a local model'], ['server', 'Ollama / LM Studio'], ['cloud', 'Cloud API key']] as const).map(([id, label]) => (
                    <button key={id} id={`model-setup-${id}`} type="button" role="tab" aria-selected={route === id} aria-controls="model-setup-panel" tabIndex={route === id ? 0 : -1} onClick={() => setRoute(id)} onKeyDown={e => {
                        const ids = ['local', 'server', 'cloud'] as const
                        const index = ids.indexOf(id)
                        const target = e.key === 'ArrowRight' ? ids[(index + 1) % 3] : e.key === 'ArrowLeft' ? ids[(index + 2) % 3] : e.key === 'Home' ? 'local' : e.key === 'End' ? 'cloud' : null
                        if (target) { e.preventDefault(); setRoute(target); document.getElementById(`model-setup-${target}`)?.focus() }
                    }}>{label}</button>
                ))}
            </div>
            <div id="model-setup-panel" role="tabpanel" aria-labelledby={`model-setup-${route}`}>
            {route === 'cloud' && (
            <SettingsSection title="Cloud providers" description="Bring your own key. Requests go directly from this machine to the provider, and the key stays in your system keychain.">
                <div className="key-list">
                    {CLOUD_PROVIDERS.map(p => (
                        <ApiKeyRow
                            key={p.id}
                            provider={p.id}
                            name={p.label === p.vendor ? p.label : `${p.label} (${p.vendor})`}
                            models={p.models.map(m => m.label).join(', ')}
                            placeholder={p.keyPlaceholder}
                            consoleUrl={p.consoleUrl}
                        />
                    ))}
                </div>
            </SettingsSection>
            )}
            {route === 'server' && <SettingsSection title="Connect your local server" description="Use an OpenAI-compatible server running on this computer."><LocalServerSettings /></SettingsSection>}
            {route === 'local' && (
            <SettingsSection
                title="Models on this machine"
                description={totalSize > 0 ? `${formatBytes(totalSize)} of models downloaded. One model can be loaded at a time.` : 'Download a model to work offline. Smaller models answer faster; larger ones handle harder tasks.'}
            >
                <LocalModels />
            </SettingsSection>
            )}
            </div>
        </SettingsPage>
    )
}

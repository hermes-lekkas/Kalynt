/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useState } from 'react'
import { useModelStore } from '../../stores/modelStore'
import { useAppStore } from '../../stores/appStore'
import { formatBytes } from '../../types/offlineModels'
import { CLOUD_PROVIDERS } from '../../types/aiProviders'
import { Tabs, type TabItem } from '../ui'
import { ApiKeyRow } from './ApiKeyRow'
import { LocalModels } from './LocalModels'
import { LocalServerSettings } from './LocalServerSettings'
import { SettingsPage, SettingsSection } from './parts'

type ModelRoute = 'local' | 'server' | 'cloud'

const MODEL_TABS: TabItem<ModelRoute>[] = [
    { id: 'local', label: 'Download a local model' },
    { id: 'server', label: 'Ollama / LM Studio' },
    { id: 'cloud', label: 'Cloud API key' }
]

function routeForTab(requested: string | null): ModelRoute | null {
    if (requested === 'models-server') return 'server'
    if (requested === 'models-cloud') return 'cloud'
    if (requested === 'models-local' || requested === 'models') return 'local'
    return null
}

export function ModelsSettings() {
    const totalSize = useModelStore(s => s.getTotalDownloadedSize())
    const requested = useAppStore(s => s.settingsTab)
    const [route, setRoute] = useState<ModelRoute>(() => routeForTab(requested) ?? 'local')

    useEffect(() => {
        const next = routeForTab(requested)
        if (next) setRoute(next)
    }, [requested])

    return (
        <SettingsPage
            title="Models and keys"
            description="Choose how to connect AI. Download a model, reuse your local server, or bring your own cloud API key. You can change this later."
        >
            <div className="models-tabs">
                <Tabs
                    variant="segmented"
                    ariaLabel="AI setup options"
                    idPrefix="model-setup"
                    items={MODEL_TABS}
                    value={route}
                    onChange={setRoute}
                />
            </div>

            <div id={`model-setup-panel-${route}`} role="tabpanel" aria-labelledby={`model-setup-tab-${route}`}>
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
                {route === 'server' && (
                    <SettingsSection title="Connect your local server" description="Use an OpenAI-compatible server running on this computer.">
                        <LocalServerSettings />
                    </SettingsSection>
                )}
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

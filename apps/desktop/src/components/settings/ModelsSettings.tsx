/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useModelStore } from '../../stores/modelStore'
import { formatBytes } from '../../types/offlineModels'
import { PROVIDERS } from '../../types/aiProviders'
import { ApiKeyRow } from './ApiKeyRow'
import { LocalModels } from './LocalModels'
import { SettingsPage, SettingsSection } from './parts'

export function ModelsSettings() {
    const totalSize = useModelStore(s => s.getTotalDownloadedSize())

    return (
        <SettingsPage
            title="Models and keys"
            description="The agent can use a cloud model with your own API key, or a model that runs entirely on this machine. Local models keep your code on your computer."
        >
            <SettingsSection title="Cloud providers" description="Bring your own key. Requests go directly from this machine to the provider, and the key stays in your system keychain.">
                <div className="key-list">
                    {PROVIDERS.map(p => (
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

            <SettingsSection
                title="Models on this machine"
                description={totalSize > 0 ? `${formatBytes(totalSize)} of models downloaded. One model can be loaded at a time.` : 'Download a model to work offline. Smaller models answer faster; larger ones handle harder tasks.'}
            >
                <LocalModels />
            </SettingsSection>
        </SettingsPage>
    )
}

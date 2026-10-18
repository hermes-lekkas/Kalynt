/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useModelStore } from '../../stores/modelStore'
import { formatBytes } from '../../types/offlineModels'
import { PROVIDER_MODELS, type AIProvider } from '../../services/aiService'
import { cloudModelName } from '../agent/chat/modelNames'
import { ApiKeyRow } from './ApiKeyRow'
import { LocalModels } from './LocalModels'
import { SettingsPage, SettingsSection } from './parts'

const modelList = (provider: AIProvider) => PROVIDER_MODELS[provider].map(cloudModelName).join(', ')

export function ModelsSettings() {
    const totalSize = useModelStore(s => s.getTotalDownloadedSize())

    return (
        <SettingsPage
            title="Models and keys"
            description="The agent can use a cloud model with your own API key, or a model that runs entirely on this machine. Local models keep your code on your computer."
        >
            <SettingsSection title="Cloud providers" description="Bring your own key. Requests go directly from this machine to the provider.">
                <div className="key-list">
                    <ApiKeyRow provider="anthropic" name="Anthropic" models={modelList('anthropic')} placeholder="sk-ant-…" consoleUrl="https://console.anthropic.com/settings/keys" />
                    <ApiKeyRow provider="openai" name="OpenAI" models={modelList('openai')} placeholder="sk-…" consoleUrl="https://platform.openai.com/api-keys" />
                    <ApiKeyRow provider="google" name="Google" models={modelList('google')} placeholder="AIza…" consoleUrl="https://aistudio.google.com/app/apikey" />
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

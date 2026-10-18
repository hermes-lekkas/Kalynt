/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Which model the agent uses: a cloud provider and model, or a local model.
 * Remembered between sessions and corrected when a key or model disappears.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { useModelStore } from '../../../stores/modelStore'
import { PROVIDER_MODELS, type AIProvider } from '../../../services/aiService'
import { offlineLLMService } from '../../../services/offlineLLMService'
import { useNotificationStore } from '../../../stores/notificationStore'
import { cloudModelName, localModelName, PROVIDER_LABEL } from './modelNames'

export type AIMode = 'cloud' | 'offline'

export interface ModelChoice {
    mode: AIMode
    provider: AIProvider
    cloudModel: string
}

const STORAGE_KEY = 'kalynt-agent-model'
const PROVIDERS: AIProvider[] = ['anthropic', 'openai', 'google']

function defaultModelFor(provider: AIProvider): string {
    const models = PROVIDER_MODELS[provider] ?? []
    return models.find(m => /sonnet|pro|gpt-4o$/.test(m)) ?? models[0] ?? ''
}

function load(): ModelChoice {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
        if (saved && (saved.mode === 'cloud' || saved.mode === 'offline')) {
            // A model the provider has since retired is replaced by the current default.
            const known = PROVIDER_MODELS[saved.provider as AIProvider]
            if (!known) return { ...saved, provider: 'anthropic', cloudModel: defaultModelFor('anthropic') }
            if (!known.includes(saved.cloudModel)) return { ...saved, cloudModel: defaultModelFor(saved.provider) }
            return saved
        }
    } catch { /* fall through */ }
    return { mode: 'cloud', provider: 'anthropic', cloudModel: defaultModelFor('anthropic') }
}

export function useModelChoice() {
    const apiKeys = useAppStore(s => s.apiKeys)
    const { loadedModelId, downloadedModels, isLoading, loadError } = useModelStore()
    const addNotification = useNotificationStore(s => s.addNotification)
    const [choice, setChoice] = useState<ModelChoice>(load)

    const providers = useMemo(() => PROVIDERS.filter(p => !!apiKeys[p]), [apiKeys])
    const downloaded = useMemo(() => Object.keys(downloadedModels), [downloadedModels])

    useEffect(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(choice)) } catch { /* storage unavailable */ }
    }, [choice])

    // Fall back to something usable when the chosen provider loses its key.
    useEffect(() => {
        if (choice.mode !== 'cloud' || providers.includes(choice.provider)) return
        if (providers.length > 0) setChoice(c => ({ ...c, provider: providers[0], cloudModel: defaultModelFor(providers[0]) }))
        else if (loadedModelId) setChoice(c => ({ ...c, mode: 'offline' }))
    }, [choice.mode, choice.provider, providers, loadedModelId])

    const chooseCloud = useCallback((provider: AIProvider, cloudModel: string) => {
        setChoice({ mode: 'cloud', provider, cloudModel })
    }, [])

    const chooseLocal = useCallback(async (modelId: string) => {
        setChoice(c => ({ ...c, mode: 'offline' }))
        if (loadedModelId === modelId) return
        try {
            await offlineLLMService.loadModel(modelId)
        } catch (e) {
            addNotification(`Couldn't load ${localModelName(modelId)}: ${e instanceof Error ? e.message : String(e)}`, 'error')
        }
    }, [loadedModelId, addNotification])

    const ready = choice.mode === 'cloud' ? providers.includes(choice.provider) : !!loadedModelId
    const label = choice.mode === 'cloud'
        ? (providers.includes(choice.provider) ? cloudModelName(choice.cloudModel) : 'No model')
        : (loadedModelId ? `${localModelName(loadedModelId)} (local)` : isLoading ? 'Loading local model…' : 'No local model loaded')

    const blockedReason = ready ? null
        : choice.mode === 'cloud'
            ? (providers.length === 0 ? 'Add an API key or load a local model to use the agent.' : `Add a ${PROVIDER_LABEL[choice.provider]} key or pick another model.`)
            : (isLoading ? 'The local model is still loading.' : loadError ? `The local model failed to load: ${loadError}` : 'Load a local model or switch to a cloud model.')

    return {
        choice, providers, downloaded, loadedModelId, isLoading, ready, label, blockedReason,
        chooseCloud, chooseLocal,
        /** Model id passed to the agent loop. */
        modelId: choice.mode === 'cloud' ? choice.cloudModel : loadedModelId ?? undefined
    }
}

export type ModelChoiceApi = ReturnType<typeof useModelChoice>

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Which model the agent uses: a cloud provider and model (from the provider's
 * live model list), or a local model. Remembered between sessions and
 * corrected when a key disappears or a model is retired.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { useModelStore } from '../../../stores/modelStore'
import { offlineLLMService } from '../../../services/offlineLLMService'
import { useNotificationStore } from '../../../stores/notificationStore'
import { listModels } from '../../../services/agent/aiClient'
import type { Effort, ModelInfo, ProviderId } from '../../../types/aiProtocol'
import { PROVIDER_IDS, defaultEffort, defaultModel, isProviderId, modelLabel, providerInfo } from '../../../types/aiProviders'
import { localModelName } from './modelNames'

export type AIMode = 'cloud' | 'offline'

export interface ModelChoice {
    mode: AIMode
    provider: ProviderId
    cloudModel: string
    /** Unset: the model's default for agent work. */
    effort?: Effort
}

const STORAGE_KEY = 'kalynt-agent-model'

function load(): ModelChoice {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
        if (saved && (saved.mode === 'cloud' || saved.mode === 'offline') && isProviderId(saved.provider)) {
            return { mode: saved.mode, provider: saved.provider, cloudModel: String(saved.cloudModel || defaultModel(saved.provider)), effort: saved.effort }
        }
    } catch { /* fall through */ }
    return { mode: 'cloud', provider: 'anthropic', cloudModel: defaultModel('anthropic') }
}

export function useModelChoice() {
    const apiKeys = useAppStore(s => s.apiKeys)
    const { loadedModelId, downloadedModels, isLoading, loadError } = useModelStore()
    const addNotification = useNotificationStore(s => s.addNotification)
    const [choice, setChoice] = useState<ModelChoice>(load)
    const [models, setModels] = useState<Partial<Record<ProviderId, ModelInfo[]>>>({})

    const providers = useMemo(() => PROVIDER_IDS.filter(p => !!apiKeys[p]), [apiKeys])
    const downloaded = useMemo(() => Object.keys(downloadedModels), [downloadedModels])
    const providerKey = providers.join(',')

    // Ask each configured provider which models the key can use.
    useEffect(() => {
        let cancelled = false
        for (const provider of providers) {
            listModels(provider).then(result => {
                if (!cancelled && result.models.length) setModels(m => ({ ...m, [provider]: result.models.filter(x => x.tools !== false) }))
            }).catch(() => undefined)
        }
        return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [providerKey])

    const modelsFor = useCallback((provider: ProviderId): ModelInfo[] => models[provider] ?? providerInfo(provider).models, [models])

    useEffect(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(choice)) } catch { /* storage unavailable */ }
    }, [choice])

    // Fall back to something usable when the chosen provider loses its key or the model is retired.
    useEffect(() => {
        if (choice.mode !== 'cloud') return
        if (!providers.includes(choice.provider)) {
            if (providers.length > 0) setChoice(c => ({ ...c, provider: providers[0], cloudModel: defaultModel(providers[0]), effort: undefined }))
            else if (loadedModelId) setChoice(c => ({ ...c, mode: 'offline' }))
            return
        }
        const list = models[choice.provider]
        if (list && list.length && !list.some(m => m.id === choice.cloudModel)) {
            const fallback = list.find(m => m.recommended) ?? list[0]
            setChoice(c => ({ ...c, cloudModel: fallback.id, effort: undefined }))
        }
    }, [choice.mode, choice.provider, choice.cloudModel, providers, models, loadedModelId])

    const chooseCloud = useCallback((provider: ProviderId, cloudModel: string) => {
        setChoice(c => ({ mode: 'cloud', provider, cloudModel, effort: c.provider === provider && c.cloudModel === cloudModel ? c.effort : undefined }))
    }, [])

    const setEffort = useCallback((effort: Effort) => setChoice(c => ({ ...c, effort })), [])

    const chooseLocal = useCallback(async (modelId: string) => {
        setChoice(c => ({ ...c, mode: 'offline' }))
        if (loadedModelId === modelId) return
        try {
            await offlineLLMService.loadModel(modelId)
        } catch (e) {
            addNotification(`Couldn't load ${localModelName(modelId)}: ${e instanceof Error ? e.message : String(e)}`, 'error')
        }
    }, [loadedModelId, addNotification])

    const cloudReady = providers.includes(choice.provider)
    const ready = choice.mode === 'cloud' ? cloudReady : !!loadedModelId
    const info = modelsFor(choice.provider).find(m => m.id === choice.cloudModel)
    const effort = choice.effort ?? defaultEffort(choice.provider, choice.cloudModel)
    const label = choice.mode === 'cloud'
        ? (cloudReady ? info?.label ?? modelLabel(choice.cloudModel) : 'No model')
        : (loadedModelId ? `${localModelName(loadedModelId)} (local)` : isLoading ? 'Loading local model…' : 'No local model loaded')

    const blockedReason = ready ? null
        : choice.mode === 'cloud'
            ? (providers.length === 0 ? 'Add an API key or load a local model to use the agent.' : `Add a ${providerInfo(choice.provider).label} key or pick another model.`)
            : (isLoading ? 'The local model is still loading.' : loadError ? `The local model failed to load: ${loadError}` : 'Load a local model or switch to a cloud model.')

    return {
        choice, providers, downloaded, loadedModelId, isLoading, ready, label, blockedReason, effort,
        modelsFor, chooseCloud, chooseLocal, setEffort,
        contextWindow: choice.mode === 'cloud' ? info?.contextWindow : offlineLLMService.getContextWindow(),
        /** Model id passed to the agent loop. */
        modelId: choice.mode === 'cloud' ? choice.cloudModel : loadedModelId ?? undefined
    }
}

export type ModelChoiceApi = ReturnType<typeof useModelChoice>

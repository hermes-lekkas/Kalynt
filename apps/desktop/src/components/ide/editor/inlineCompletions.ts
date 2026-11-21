/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Optional AI inline completions ("ghost text"). Off by default because it
 * sends the code above the cursor to a cloud provider while you type.
 */
import { useEffect } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { registerGhostTextProvider } from '../../../hooks/useGhostText'
import { pickProvider, type AIProvider } from '../../../services/aiService'
import { monaco } from './monacoSetup'
import { isCancellationError } from './monacoReliability'
import { INLINE_COMPLETIONS_EVENT, inlineCompletionsEnabled } from './inlineCompletionsPref'

// Shared singleton registration so split editors never register duplicate global providers.
let consumers = 0
let activeDisposable: { dispose: () => void } | null = null
let activeProvider: AIProvider | null = null
let registrationSeq = 0

async function syncRegistration(provider: AIProvider | null) {
    const seq = ++registrationSeq
    const enabled = consumers > 0 && !!provider && inlineCompletionsEnabled()
    if (!enabled) {
        activeDisposable?.dispose()
        activeDisposable = null
        activeProvider = null
        return
    }
    if (activeDisposable && activeProvider === provider) return
    activeDisposable?.dispose()
    activeDisposable = null
    activeProvider = null
    try {
        const registered = await registerGhostTextProvider(monaco, true, provider)
        if (seq !== registrationSeq || consumers === 0 || !inlineCompletionsEnabled()) {
            registered?.dispose()
            return
        }
        activeDisposable = registered
        activeProvider = provider
    } catch (error) {
        if (!isCancellationError(error)) {
            console.warn('[InlineCompletions] Failed to register provider:', error)
        }
    }
}

/** Registers the completion provider while the setting is on and a cloud key exists. */
export function useInlineCompletions() {
    const apiKeys = useAppStore(s => s.apiKeys)
    useAppStore(s => s.modelChoiceRevision)
    const provider = pickProvider(apiKeys)

    useEffect(() => {
        consumers++
        const onToggle = () => { void syncRegistration(provider) }
        void syncRegistration(provider)
        window.addEventListener(INLINE_COMPLETIONS_EVENT, onToggle)
        return () => {
            consumers = Math.max(0, consumers - 1)
            window.removeEventListener(INLINE_COMPLETIONS_EVENT, onToggle)
            if (consumers === 0) void syncRegistration(null)
        }
    }, [provider])
}

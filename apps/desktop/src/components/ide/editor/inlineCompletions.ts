/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Optional AI inline completions ("ghost text"). Off by default because it
 * sends the code above the cursor to a cloud provider while you type.
 */
import { useEffect } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { registerGhostTextProvider } from '../../../hooks/useGhostText'
import type { AIProvider } from '../../../services/aiService'
import { monaco } from './monacoSetup'
import { INLINE_COMPLETIONS_EVENT, inlineCompletionsEnabled } from './inlineCompletionsPref'

/** Registers the completion provider while the setting is on and a cloud key exists. */
export function useInlineCompletions() {
    const apiKeys = useAppStore(s => s.apiKeys)
    const provider = (['openai', 'anthropic', 'google'] as AIProvider[]).find(p => !!apiKeys[p]) ?? null

    useEffect(() => {
        let disposable: { dispose: () => void } | null = null
        let cancelled = false

        const apply = async () => {
            disposable?.dispose()
            disposable = null
            if (!provider || !inlineCompletionsEnabled()) return
            const registered = await registerGhostTextProvider(monaco, true, provider)
            if (cancelled) registered?.dispose()
            else disposable = registered
        }

        apply()
        window.addEventListener(INLINE_COMPLETIONS_EVENT, apply)
        return () => {
            cancelled = true
            window.removeEventListener(INLINE_COMPLETIONS_EVENT, apply)
            disposable?.dispose()
        }
    }, [provider])
}

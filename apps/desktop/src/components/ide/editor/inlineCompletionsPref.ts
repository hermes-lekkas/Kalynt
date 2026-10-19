/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The inline-completion preference, kept free of Monaco imports so Settings
 * can read and change it without loading the editor.
 */
export const INLINE_COMPLETIONS_KEY = 'kalynt-ai-ghost-text'
export const INLINE_COMPLETIONS_EVENT = 'kalynt-ai-settings-changed'

export function inlineCompletionsEnabled(): boolean {
    try {
        return localStorage.getItem(INLINE_COMPLETIONS_KEY) === 'true'
    } catch {
        return false
    }
}

export function setInlineCompletionsEnabled(enabled: boolean) {
    try { localStorage.setItem(INLINE_COMPLETIONS_KEY, String(enabled)) } catch { /* storage unavailable */ }
    window.dispatchEvent(new CustomEvent(INLINE_COMPLETIONS_EVENT, { detail: { enabled } }))
}

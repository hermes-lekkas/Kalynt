/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { AIProvider } from '../../../services/aiService'
import { getModelById } from '../../../types/offlineModels'

export const PROVIDER_LABEL: Record<AIProvider, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google'
}

const KNOWN: Record<string, string> = {
    'gpt-4o': 'GPT-4o',
    'gpt-4o-mini': 'GPT-4o mini',
    'claude-opus-5-5': 'Claude Opus 5.5',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5',
    'claude-haiku-5-5': 'Claude Haiku 5.5',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-3.8-flash': 'Gemini 3.8 Flash',
    'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite'
}

/** Friendly name for a cloud model id, e.g. "claude-sonnet-5-5" → "Claude Sonnet 5.5". */
export function cloudModelName(id: string): string {
    if (KNOWN[id]) return KNOWN[id]
    return id
        .replace(/-latest$/, '')
        .split('-')
        .map(part => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
        .join(' ')
        .replace(/(\d) (\d)/g, '$1.$2')
}

export function localModelName(id: string | null | undefined): string {
    if (!id) return 'Local model'
    return getModelById(id)?.name ?? id
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { ProviderId } from '../../../types/aiProtocol'
import { PROVIDERS, modelLabel } from '../../../types/aiProviders'
import { getModelById } from '../../../types/offlineModels'

export const PROVIDER_LABEL = Object.fromEntries(PROVIDERS.map(p => [p.id, p.label])) as Record<ProviderId, string>

/** Friendly name for a cloud model id, e.g. "claude-opus-5-5" -> "Claude Opus 5.5". */
export function cloudModelName(id: string): string {
    return modelLabel(id)
}

export function localModelName(id: string | null | undefined): string {
    if (!id) return 'Local model'
    return getModelById(id)?.name ?? id
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Transient, app-wide interface state: which global dialogs are open.
 * Settings visibility stays in appStore because other modules already use it.
 */
import { create } from 'zustand'
import type { CollaborationTab } from '../components/collaboration/types'

export type ExtensionsTab = 'runtimes' | 'extensions'
export type PaletteMode = 'commands' | 'files' | 'workspaces'

interface UiState {
    collaborationOpen: boolean
    collaborationTab: CollaborationTab
    extensionsOpen: boolean
    extensionsTab: ExtensionsTab
    paletteOpen: boolean
    paletteMode: PaletteMode

    openCollaboration: (tab?: CollaborationTab) => void
    closeCollaboration: () => void
    openExtensions: (tab?: ExtensionsTab) => void
    closeExtensions: () => void
    openPalette: (mode?: PaletteMode) => void
    closePalette: () => void
}

export const useUiStore = create<UiState>(set => ({
    collaborationOpen: false,
    collaborationTab: 'members',
    extensionsOpen: false,
    extensionsTab: 'runtimes',
    paletteOpen: false,
    paletteMode: 'commands',

    openCollaboration: (tab = 'members') => set({ collaborationOpen: true, collaborationTab: tab }),
    closeCollaboration: () => set({ collaborationOpen: false }),
    openExtensions: (tab = 'runtimes') => set({ extensionsOpen: true, extensionsTab: tab }),
    closeExtensions: () => set({ extensionsOpen: false }),
    openPalette: (mode = 'commands') => set({ paletteOpen: true, paletteMode: mode }),
    closePalette: () => set({ paletteOpen: false })
}))

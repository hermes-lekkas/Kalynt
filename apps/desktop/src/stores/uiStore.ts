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

export interface PendingJoinInvite {
    url: string
    roomId: string
    spaceName?: string
    password?: string
    passwordProtected?: boolean
}

interface UiState {
    collaborationOpen: boolean
    collaborationTab: CollaborationTab
    pendingJoinInvite: PendingJoinInvite | null
    extensionsOpen: boolean
    extensionsTab: ExtensionsTab
    paletteOpen: boolean
    paletteMode: PaletteMode
    agentDraft: string | null
    setAgentDraft: (draft: string | null) => void

    openCollaboration: (tab?: CollaborationTab) => void
    openJoinInvite: (invite: PendingJoinInvite) => void
    clearPendingJoinInvite: () => void
    closeCollaboration: () => void
    openExtensions: (tab?: ExtensionsTab) => void
    closeExtensions: () => void
    openPalette: (mode?: PaletteMode) => void
    closePalette: () => void
}

export const useUiStore = create<UiState>(set => ({
    collaborationOpen: false,
    collaborationTab: 'members',
    pendingJoinInvite: null,
    extensionsOpen: false,
    extensionsTab: 'runtimes',
    paletteOpen: false,
    paletteMode: 'commands',
    agentDraft: null,
    setAgentDraft: agentDraft => set({ agentDraft }),

    openCollaboration: (tab = 'members') => set({ collaborationOpen: true, collaborationTab: tab }),
    openJoinInvite: (invite) => set({ collaborationOpen: true, collaborationTab: 'join', pendingJoinInvite: invite }),
    clearPendingJoinInvite: () => set({ pendingJoinInvite: null }),
    closeCollaboration: () => set({ collaborationOpen: false, pendingJoinInvite: null }),
    openExtensions: (tab = 'runtimes') => set({ extensionsOpen: true, extensionsTab: tab }),
    closeExtensions: () => set({ extensionsOpen: false }),
    openPalette: (mode = 'commands') => set({ paletteOpen: true, paletteMode: mode }),
    closePalette: () => set({ paletteOpen: false })
}))

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { WorkspaceCategoryId } from '../types/workspaceCategories'
import { logger } from '../utils/logger'
import type { ProviderId } from '../types/aiProtocol'

// Free beta configuration - no limits
export const BETA_CONFIG = {
    maxWorkspaces: Infinity,
    maxCollaborators: 100,
    offlineModelsAllowed: Infinity
}

// Tier types for model gating (legacy - all models now free in beta)
// All models are available to all users in this open-source project
export type TierType = 'starter' | 'pro' | 'enterprise' | 'beta'

export interface Space {
    id: string
    name: string
    createdAt: number
    category: WorkspaceCategoryId
}

/** Which providers have a key in secure storage. The keys stay in the main process. */
export type APIKeys = Partial<Record<ProviderId, boolean>>

export interface Peer {
    id: string
    name: string
    status: 'online' | 'away' | 'offline'
}

interface AppState {
    isInitialized: boolean
    version: string
    spaces: Space[]
    currentSpace: Space | null
    apiKeys: APIKeys
    userName: string
    connectedPeers: Peer[]
    sidebarCollapsed: boolean
    _hasHydrated: boolean
    startupStatus: string // [NEW] Real-time status for splash screen
    showSettings: boolean // [NEW] Global settings toggle
    settingsTab: string | null // [NEW] Current active settings tab
    theme: 'light' | 'dark' // [NEW]

    // Actions
    initialize: () => Promise<void>
    setCurrentSpace: (space: Space | null) => void
    createSpace: (name: string, spaceId?: string, category?: WorkspaceCategoryId) => Space
    deleteSpace: (id: string) => void
    renameSpace: (id: string, name: string) => void
    setConnectedPeers: (peers: Peer[]) => void
    toggleSidebarCollapsed: () => void
    setStartupStatus: (status: string) => void // [NEW]
    setShowSettings: (show: boolean) => void // [NEW]
    setSettingsTab: (tab: string | null) => void // [NEW]
    setTheme: (theme: 'light' | 'dark') => void // [NEW]
    reorderSpaces: (fromIndex: number, toIndex: number) => void // [NEW]

    // API Key actions (now async for safeStorage)
    setAPIKey: (provider: string, key: string) => Promise<void>
    removeAPIKey: (provider: string) => Promise<void>
    loadAPIKeys: () => Promise<void>
    hasRequiredKeys: () => boolean
    setUserName: (name: string) => void

    // Provider access check (always returns true in beta)
    canUseProvider: (provider: string) => boolean

    // Subscription status (free beta - always active)
    getSubscriptionStatus: () => { isActive: boolean; tier: string }
}

export const useAppStore = create<AppState>()(
    persist(
        (set, get) => ({
            isInitialized: false,
            version: 'v1.0 beta',
            spaces: [],
            currentSpace: null,
            apiKeys: {},
            userName: 'Local User',
            connectedPeers: [],
            sidebarCollapsed: false,
            _hasHydrated: false,
            startupStatus: 'Starting Kalynt',
            showSettings: false,
            settingsTab: null,
            theme: 'dark',

            setStartupStatus: (status) => set({ startupStatus: status }),
            setShowSettings: (show) => set({ showSettings: show }),
            setSettingsTab: (tab) => set({ settingsTab: tab }),
            setTheme: (theme) => set({ theme }),

            reorderSpaces: (fromIndex, toIndex) => {
                const { spaces } = get()
                const newSpaces = [...spaces]
                const [moved] = newSpaces.splice(fromIndex, 1)
                newSpaces.splice(toIndex, 0, moved)
                set({ spaces: newSpaces })
            },

            initialize: async () => {
                set({ startupStatus: 'Starting Kalynt' })

                // Get version from Electron if available
                if (globalThis.electronAPI) {
                    try {
                        set({ startupStatus: 'Reading app version' })
                        const version = await globalThis.electronAPI.getVersion()
                        set({ version })
                    } catch (error) {
                        logger.general.warn('Failed to get app version from Electron', error)
                    }

                    // Load API keys from secure storage
                    set({ startupStatus: 'Unlocking saved API keys' })
                    await get().loadAPIKeys()
                }

                set({ isInitialized: true, startupStatus: 'Ready' })
            },

            setCurrentSpace: (space) => set({ currentSpace: space }),

            createSpace: (name, spaceId) => {
                const { spaces, connectedPeers } = get()

                // Free beta - check collaborator limit only
                if (connectedPeers.length >= BETA_CONFIG.maxCollaborators) {
                    throw new Error(`Maximum ${BETA_CONFIG.maxCollaborators} collaborators per workspace.`)
                }

                // Check if space with this ID already exists (for joining)
                const existing = spaces.find(s => s.id === spaceId)
                if (existing) {
                    return existing
                }

                const newSpace: Space = {
                    id: spaceId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2)),
                    name,
                    createdAt: Date.now(),
                    category: 'programming'
                }

                set({ spaces: [...spaces, newSpace] })
                return newSpace
            },

            deleteSpace: (id) => {
                const { spaces, currentSpace } = get()
                set({
                    spaces: spaces.filter(s => s.id !== id),
                    currentSpace: currentSpace?.id === id ? null : currentSpace
                })
            },

            renameSpace: (id, name) => {
                const { spaces, currentSpace } = get()
                set({
                    spaces: spaces.map(s => s.id === id ? { ...s, name } : s),
                    currentSpace: currentSpace?.id === id ? { ...currentSpace, name } : currentSpace
                })
            },

            setConnectedPeers: (peers) => set({ connectedPeers: peers }),

            toggleSidebarCollapsed: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

            // API Key management - now uses secure storage
            setAPIKey: async (provider, key) => {
                const result = await globalThis.electronAPI?.safeStorage?.set({ key: `apiKey_${provider}`, value: key })
                if (!result?.success) throw new Error(result?.error || 'The key could not be saved to secure storage.')
                set({ apiKeys: { ...get().apiKeys, [provider]: true } })
            },

            removeAPIKey: async (provider) => {
                // Remove from secure storage
                if (globalThis.electronAPI?.safeStorage) {
                    await globalThis.electronAPI.safeStorage.delete(`apiKey_${provider}`)
                }
                // Update in-memory state
                const { apiKeys } = get()
                const newKeys = { ...apiKeys }
                delete newKeys[provider as keyof APIKeys]
                set({ apiKeys: newKeys })
            },

            loadAPIKeys: async () => {
                try {
                    const status = await globalThis.electronAPI?.ai?.keyStatus()
                    if (status) set({ apiKeys: status })
                } catch (error) {
                    logger.general.warn('Failed to read which API keys are stored', error)
                }
            },

            hasRequiredKeys: () => {
                const { apiKeys } = get()
                // Check if at least one provider has a key
                return Object.keys(apiKeys).some(k => apiKeys[k as keyof APIKeys])
            },

            setUserName: (name) => {
                set({ userName: name })
                // Sync to memberStore for P2P display name
                import('../stores/memberStore').then(({ useMemberStore }) => {
                    useMemberStore.getState().setDisplayName(name)
                })
            },

            // Provider access check - always returns true in beta
            canUseProvider: (_provider: string) => true,

            // Free beta - always active with unlimited access
            getSubscriptionStatus: () => ({
                isActive: true,
                tier: 'beta'
            })
        }),
        {
            name: 'kalynt-app',
            storage: createJSONStorage(() => localStorage),
            partialize: (state) => ({
                spaces: state.spaces,
                currentSpace: state.currentSpace,
                // Note: apiKeys are now stored in safeStorage, not localStorage
                userName: state.userName,
                sidebarCollapsed: state.sidebarCollapsed,
                theme: state.theme
            }),
            onRehydrateStorage: () => {
                console.log('[AppStore] Starting hydration...')
                return (state, error) => {
                    if (error) {
                        console.error('[AppStore] Hydration error:', error)
                    } else {
                        console.log('[AppStore] Hydration completed successfully')
                        console.log('[AppStore] Loaded spaces:', state?.spaces?.length || 0)
                        console.log('[AppStore] Current space:', state?.currentSpace?.name || 'None')
                        console.log('[AppStore] Username:', state?.userName || 'Not set')

                        // Sync userName to memberStore for P2P display name
                        if (state?.userName && state.userName !== 'Local User') {
                            import('../stores/memberStore').then(({ useMemberStore }) => {
                                useMemberStore.getState().setDisplayName(state.userName)
                            })
                        }
                    }
                    if (state) {
                        state._hasHydrated = true
                    }
                }
            }
        }
    )
)

// Log immediately after store creation to verify
console.log('[AppStore] Store created, initial hydration state:', useAppStore.getState()._hasHydrated)

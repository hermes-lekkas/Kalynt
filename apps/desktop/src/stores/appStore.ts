/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { WorkspaceCategoryId } from '../types/workspaceCategories'
import { logger } from '../utils/logger'
import type { ProviderId } from '../types/aiProtocol'
import { PROVIDER_IDS } from '../types/aiProviders'

// Free beta configuration - no limits
export const BETA_CONFIG = {
    maxWorkspaces: Infinity,
    maxCollaborators: 100,
    offlineModelsAllowed: Infinity
}

// Tier types for model gating (legacy - all models now free in beta)
// All models are available to all users in this open-source project
export type TierType = 'starter' | 'pro' | 'enterprise' | 'beta'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export interface ExtensionThemeSelection {
    id: string
    extensionId: string
    label: string
    uiTheme: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'
}

export function resolveTheme(theme: ThemePreference): ResolvedTheme {
    if (theme === 'light') return 'light'
    if (theme === 'dark') return 'dark'
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    }
    return 'dark'
}

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
    connectionRevision: number
    modelChoiceRevision: number
    userName: string
    connectedPeers: Peer[]
    sidebarCollapsed: boolean
    _hasHydrated: boolean
    startupStatus: string
    showSettings: boolean
    settingsTab: string | null
    theme: ThemePreference
    resolvedTheme: ResolvedTheme
    extensionTheme: ExtensionThemeSelection | null

    // Actions
    initialize: () => Promise<void>
    setCurrentSpace: (space: Space | null) => void
    createSpace: (name: string, spaceId?: string, category?: WorkspaceCategoryId) => Space
    deleteSpace: (id: string) => void
    renameSpace: (id: string, name: string) => void
    setConnectedPeers: (peers: Peer[]) => void
    toggleSidebarCollapsed: () => void
    setStartupStatus: (status: string) => void
    setShowSettings: (show: boolean) => void
    setSettingsTab: (tab: string | null) => void
    setTheme: (theme: ThemePreference) => void
    setResolvedTheme: (resolvedTheme: ResolvedTheme) => void
    setExtensionTheme: (extensionTheme: ExtensionThemeSelection | null) => void
    reorderSpaces: (fromIndex: number, toIndex: number) => void

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
            version: '2.1.0',
            spaces: [],
            currentSpace: null,
            apiKeys: {},
            connectionRevision: 0,
            modelChoiceRevision: 0,
            userName: 'Local User',
            connectedPeers: [],
            sidebarCollapsed: false,
            _hasHydrated: false,
            startupStatus: 'Starting Kalynt',
            showSettings: false,
            settingsTab: null,
            theme: 'dark',
            resolvedTheme: 'dark',
            extensionTheme: null,

            setStartupStatus: (status) => set({ startupStatus: status }),
            setShowSettings: (show) => set({ showSettings: show }),
            setSettingsTab: (tab) => set({ settingsTab: tab }),
            setTheme: (theme) => {
                const resolved = resolveTheme(theme)
                set({ theme, resolvedTheme: resolved, extensionTheme: null })
                void import('../services/extensions/themeService').then(({ restoreBuiltinTheme }) => restoreBuiltinTheme(resolved)).catch(() => undefined)
            },
            setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
            setExtensionTheme: (extensionTheme) => {
                if (!extensionTheme) {
                    const resolved = resolveTheme(get().theme)
                    set({ extensionTheme: null, resolvedTheme: resolved })
                    void import('../services/extensions/themeService').then(({ restoreBuiltinTheme }) => restoreBuiltinTheme(resolved)).catch(() => undefined)
                    return
                }
                const base: ResolvedTheme = extensionTheme.uiTheme === 'vs' || extensionTheme.uiTheme === 'hc-light' ? 'light' : 'dark'
                set({ extensionTheme, theme: base, resolvedTheme: base })
            },

            reorderSpaces: (fromIndex, toIndex) => {
                const { spaces } = get()
                if (
                    !Number.isInteger(fromIndex) ||
                    !Number.isInteger(toIndex) ||
                    fromIndex < 0 ||
                    toIndex < 0 ||
                    fromIndex >= spaces.length ||
                    toIndex >= spaces.length ||
                    fromIndex === toIndex
                ) {
                    return
                }
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
                        if (version) set({ version })
                    } catch (error) {
                        logger.general.warn('Failed to get app version from Electron', error)
                    }

                    // Load API keys from secure storage
                    set({ startupStatus: 'Unlocking saved API keys' })
                    await get().loadAPIKeys()

                    // Initialize extension IPC listeners (show-message, contributions) & restore any active extension theme
                    void import('../services/extensions/themeService')
                        .then(({ ensureExtensionThemeWatchers, syncActiveExtensionTheme }) => {
                            ensureExtensionThemeWatchers()
                            return syncActiveExtensionTheme()
                        })
                        .catch(error => logger.general.warn('Failed to synchronize extension theme', error))
                }

                set({ isInitialized: true, startupStatus: 'Ready' })
            },

            setCurrentSpace: (space) => set({ currentSpace: space }),

            createSpace: (name, spaceId, category = 'programming') => {
                const { spaces } = get()

                // Check if space with this ID already exists (for joining)
                if (spaceId) {
                    const existing = spaces.find(s => s.id === spaceId)
                    if (existing) return existing
                }

                const newSpace: Space = {
                    id: spaceId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2)),
                    name,
                    createdAt: Date.now(),
                    category
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
                set({ apiKeys: { ...get().apiKeys, [provider]: true }, connectionRevision: get().connectionRevision + 1 })
            },

            removeAPIKey: async (provider) => {
                const result = await globalThis.electronAPI?.safeStorage?.delete(`apiKey_${provider}`)
                if (!result?.success) throw new Error(result?.error || 'The key could not be removed from secure storage.')
                const { apiKeys } = get()
                const newKeys = { ...apiKeys }
                delete newKeys[provider as keyof APIKeys]
                set({ apiKeys: newKeys, connectionRevision: get().connectionRevision + 1 })
            },

            loadAPIKeys: async () => {
                try {
                    const status = await globalThis.electronAPI?.ai?.keyStatus()
                    if (status) set({ apiKeys: Object.fromEntries(PROVIDER_IDS.map(id => [id, status[id] === true])), connectionRevision: get().connectionRevision + 1 })
                } catch (error) {
                    logger.general.warn('Failed to read which API keys are stored', error)
                }
            },

            hasRequiredKeys: () => {
                const { apiKeys } = get()
                return Object.keys(apiKeys).some(k => apiKeys[k as keyof APIKeys])
            },

            setUserName: (name) => {
                set({ userName: name })
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
                // Note: apiKeys are stored in safeStorage, not localStorage
                userName: state.userName,
                sidebarCollapsed: state.sidebarCollapsed,
                theme: state.theme,
                extensionTheme: state.extensionTheme
            }),
            onRehydrateStorage: () => {
                return (state, error) => {
                    if (error) {
                        logger.general.error('AppStore hydration error', error)
                    } else if (state) {
                        state.resolvedTheme = resolveTheme(state.theme ?? 'dark')
                        if (state.userName && state.userName !== 'Local User') {
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

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Persisted interface layout: which regions are open, their sizes, and editor
 * display preferences. Pure UI state — nothing here reaches the main process.
 */
import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'

export type MainView = 'code' | 'tasks' | 'history' | 'files'
export type SidePanel = 'files' | 'search' | 'git'
export type BottomTab = 'terminal' | 'output' | 'build' | 'debug'
export type RightTab = 'agent' | 'team'
export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange'
export type LineNumbersMode = 'on' | 'off' | 'relative'
export type RenderWhitespaceMode = 'none' | 'selection' | 'boundary' | 'all'

export const LAYOUT_LIMITS = {
    sidebar: { min: 180, max: 520, default: 264 },
    right: { min: 280, max: 720, default: 400 },
    bottom: { min: 120, max: 640, default: 240 }
} as const

export const EDITOR_PREF_DEFAULTS = {
    wordWrap: true,
    minimap: false,
    stickyScroll: true,
    editorFontSize: 13,
    tabSize: 2,
    insertSpaces: true,
    autoSave: 'off' as AutoSaveMode,
    formatOnSave: false,
    lineNumbers: 'on' as LineNumbersMode,
    renderWhitespace: 'selection' as RenderWhitespaceMode,
    fontFamily: ''
} as const

export interface EditorPrefs {
    wordWrap: boolean
    minimap: boolean
    stickyScroll: boolean
    editorFontSize: number
    splitEditor: boolean
    splitRatio: number
    tabSize: number
    insertSpaces: boolean
    autoSave: AutoSaveMode
    formatOnSave: boolean
    lineNumbers: LineNumbersMode
    renderWhitespace: RenderWhitespaceMode
    fontFamily: string
}

interface LayoutState extends EditorPrefs {
    mainView: MainView

    sidebarOpen: boolean
    sidebarWidth: number
    sidePanel: SidePanel

    bottomOpen: boolean
    bottomHeight: number
    bottomTab: BottomTab

    rightOpen: boolean
    rightWidth: number
    rightTab: RightTab

    setMainView: (view: MainView) => void
    setSidebarOpen: (open: boolean) => void
    setSidebarWidth: (width: number) => void
    /** Opens the side bar on a panel, or closes it when that panel is already showing. */
    toggleSidePanel: (panel: SidePanel) => void
    showSidePanel: (panel: SidePanel) => void
    setBottomOpen: (open: boolean) => void
    setBottomHeight: (height: number) => void
    showBottomTab: (tab: BottomTab) => void
    setBottomTab: (tab: BottomTab) => void
    setRightOpen: (open: boolean) => void
    setRightWidth: (width: number) => void
    showRightTab: (tab: RightTab) => void
    setRightTab: (tab: RightTab) => void
    setEditorPref: (pref: Partial<EditorPrefs>) => void
}

function createDebouncedStorage(delayMs = 200): StateStorage {
    const pending = new Map<string, string>()
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
        if (timer !== null) {
            clearTimeout(timer)
            timer = null
        }
        if (pending.size === 0) return
        try {
            pending.forEach((value, key) => {
                localStorage.setItem(key, value)
            })
        } catch {
            // Storage may be unavailable or full; fail silently for UI layout state.
        }
        pending.clear()
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', flush)
        window.addEventListener('beforeunload', flush)
    }

    return {
        getItem: (name) => {
            if (pending.has(name)) return pending.get(name)!
            try {
                return localStorage.getItem(name)
            } catch {
                return null
            }
        },
        setItem: (name, value) => {
            pending.set(name, value)
            if (timer !== null) clearTimeout(timer)
            timer = setTimeout(flush, delayMs)
        },
        removeItem: (name) => {
            pending.delete(name)
            try {
                localStorage.removeItem(name)
            } catch {
                // Ignore storage errors.
            }
        }
    }
}

const debouncedStorage = createDebouncedStorage(200)

export const useLayoutStore = create<LayoutState>()(
    persist(
        (set, get) => ({
            mainView: 'code',

            sidebarOpen: true,
            sidebarWidth: LAYOUT_LIMITS.sidebar.default,
            sidePanel: 'files',

            bottomOpen: true,
            bottomHeight: LAYOUT_LIMITS.bottom.default,
            bottomTab: 'terminal',

            rightOpen: true,
            rightWidth: LAYOUT_LIMITS.right.default,
            rightTab: 'agent',

            ...EDITOR_PREF_DEFAULTS,
            splitEditor: false,
            splitRatio: 0.5,

            setMainView: mainView => set({ mainView }),
            setSidebarOpen: sidebarOpen => set({ sidebarOpen }),
            setSidebarWidth: sidebarWidth => set({ sidebarWidth }),
            toggleSidePanel: panel => {
                const { sidebarOpen, sidePanel } = get()
                if (sidebarOpen && sidePanel === panel) set({ sidebarOpen: false })
                else set({ sidebarOpen: true, sidePanel: panel })
            },
            showSidePanel: panel => set({ sidebarOpen: true, sidePanel: panel }),
            setBottomOpen: bottomOpen => set({ bottomOpen }),
            setBottomHeight: bottomHeight => set({ bottomHeight }),
            showBottomTab: bottomTab => set({ bottomOpen: true, bottomTab }),
            setBottomTab: bottomTab => set({ bottomTab }),
            setRightOpen: rightOpen => set({ rightOpen }),
            setRightWidth: rightWidth => set({ rightWidth }),
            showRightTab: rightTab => set({ rightOpen: true, rightTab }),
            setRightTab: rightTab => set({ rightTab }),
            setEditorPref: pref => set(pref)
        }),
        {
            name: 'kalynt-layout',
            version: 2,
            storage: createJSONStorage(() => debouncedStorage),
            migrate: (persisted) => {
                const state = (persisted && typeof persisted === 'object' ? persisted : {}) as Partial<LayoutState>
                return {
                    ...EDITOR_PREF_DEFAULTS,
                    ...state
                }
            }
        }
    )
)

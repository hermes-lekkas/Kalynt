/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Persisted interface layout: which regions are open, their sizes, and editor
 * display preferences. Pure UI state — nothing here reaches the main process.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type MainView = 'code' | 'tasks' | 'history' | 'files'
export type SidePanel = 'files' | 'search' | 'git'
export type BottomTab = 'terminal' | 'output' | 'build' | 'debug'
export type RightTab = 'agent' | 'team'

export const LAYOUT_LIMITS = {
    sidebar: { min: 200, max: 520, default: 264 },
    right: { min: 320, max: 720, default: 400 },
    bottom: { min: 120, max: 640, default: 240 }
} as const

interface LayoutState {
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

    wordWrap: boolean
    minimap: boolean
    stickyScroll: boolean
    editorFontSize: number
    splitEditor: boolean
    splitRatio: number

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
    setEditorPref: (pref: Partial<Pick<LayoutState, 'wordWrap' | 'minimap' | 'stickyScroll' | 'editorFontSize' | 'splitEditor' | 'splitRatio'>>) => void
}

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

            wordWrap: true,
            minimap: false,
            stickyScroll: true,
            editorFontSize: 13,
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
            version: 1,
            storage: createJSONStorage(() => localStorage)
        }
    )
)

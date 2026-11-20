/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect } from 'react'
import { Bug, Files, GitBranch, ListTree, PanelBottom, PanelRight, Search } from 'lucide-react'
import { create } from 'zustand'
import { useLayoutStore, type SidePanel } from '../../stores/layoutStore'
import { formatShortcut } from '../../stores/commandStore'
import { IconButton } from '../ui'
import { useActiveRunnerStore } from './hooks/useRunner'

export type ExtraSidePanel = 'outline' | 'debug'

interface ExtraSidePanelState {
    extraPanel: ExtraSidePanel | null
    setExtraPanel: (panel: ExtraSidePanel | null) => void
    toggleExtraPanel: (panel: ExtraSidePanel) => void
    showExtraPanel: (panel: ExtraSidePanel) => void
}

let syncingExtraLayout = false

export const useExtraSidePanelStore = create<ExtraSidePanelState>((set, get) => ({
    extraPanel: null,
    setExtraPanel: extraPanel => set({ extraPanel }),
    toggleExtraPanel: panel => {
        const layout = useLayoutStore.getState()
        const current = get().extraPanel
        if (layout.sidebarOpen && current === panel) {
            syncingExtraLayout = true
            try {
                layout.setSidebarOpen(false)
            } finally {
                syncingExtraLayout = false
            }
        } else {
            set({ extraPanel: panel })
            syncingExtraLayout = true
            try {
                layout.setSidebarOpen(true)
            } finally {
                syncingExtraLayout = false
            }
        }
    },
    showExtraPanel: panel => {
        set({ extraPanel: panel })
        syncingExtraLayout = true
        try {
            useLayoutStore.getState().setSidebarOpen(true)
        } finally {
            syncingExtraLayout = false
        }
    }
}))

// Keep extra side panels in sync whenever external shortcuts or stores invoke showSidePanel('files'|'search'|'git').
useLayoutStore.subscribe((state, prev) => {
    if (syncingExtraLayout) return
    if (useExtraSidePanelStore.getState().extraPanel === null) return

    if (state.sidePanel !== prev.sidePanel) {
        useExtraSidePanelStore.getState().setExtraPanel(null)
        return
    }

    // Detect showSidePanel(samePanel) called while an extra panel is showing.
    const nonSideChanged =
        state.mainView !== prev.mainView ||
        state.sidebarWidth !== prev.sidebarWidth ||
        state.bottomOpen !== prev.bottomOpen ||
        state.bottomHeight !== prev.bottomHeight ||
        state.bottomTab !== prev.bottomTab ||
        state.rightOpen !== prev.rightOpen ||
        state.rightWidth !== prev.rightWidth ||
        state.rightTab !== prev.rightTab ||
        state.wordWrap !== prev.wordWrap ||
        state.minimap !== prev.minimap ||
        state.stickyScroll !== prev.stickyScroll ||
        state.editorFontSize !== prev.editorFontSize ||
        state.splitEditor !== prev.splitEditor ||
        state.splitRatio !== prev.splitRatio

    if (!nonSideChanged && state.sidebarOpen && prev.sidebarOpen) {
        useExtraSidePanelStore.getState().setExtraPanel(null)
    }
})

const CORE_PANELS: Array<{ id: SidePanel; label: string; shortcut: string; Icon: typeof Files }> = [
    { id: 'files', label: 'Explorer', shortcut: 'Ctrl+Shift+E', Icon: Files },
    { id: 'search', label: 'Search', shortcut: 'Ctrl+Shift+F', Icon: Search },
    { id: 'git', label: 'Source control', shortcut: 'Ctrl+Shift+G', Icon: GitBranch }
]

const EXTRA_PANELS: Array<{ id: ExtraSidePanel; label: string; shortcut: string; Icon: typeof Files }> = [
    { id: 'debug', label: 'Run & Debug', shortcut: 'Ctrl+Shift+D', Icon: Bug },
    { id: 'outline', label: 'Outline', shortcut: 'Ctrl+Shift+O', Icon: ListTree }
]

export interface ActivityBarProps {
    gitChanges: number
    debugActive?: boolean
}

export function ActivityBar({ gitChanges, debugActive }: ActivityBarProps) {
    const { sidebarOpen, sidePanel, toggleSidePanel, showSidePanel, bottomOpen, setBottomOpen, rightOpen, setRightOpen } = useLayoutStore()
    const { extraPanel, setExtraPanel, toggleExtraPanel, showExtraPanel } = useExtraSidePanelStore()
    const runner = useActiveRunnerStore(s => s.runner)

    const isDebugging = debugActive ?? runner?.isDebugging ?? false
    let breakpointCount = 0
    if (runner) {
        runner.breakpoints.forEach(lines => { breakpointCount += lines.length })
    }

    useEffect(() => {
        const onOpenOutline = () => showExtraPanel('outline')
        const onOpenDebug = () => showExtraPanel('debug')
        window.addEventListener('kalynt-open-outline', onOpenOutline)
        window.addEventListener('kalynt-open-debug', onOpenDebug)
        return () => {
            window.removeEventListener('kalynt-open-outline', onOpenOutline)
            window.removeEventListener('kalynt-open-debug', onOpenDebug)
        }
    }, [showExtraPanel])

    const handleCoreClick = (id: SidePanel) => {
        if (extraPanel !== null) {
            setExtraPanel(null)
            showSidePanel(id)
        } else {
            toggleSidePanel(id)
        }
    }

    return (
        <nav className="activity-bar" aria-label="Side bar views">
            <div className="activity-bar__group">
                {CORE_PANELS.map(({ id, label, shortcut, Icon }) => (
                    <IconButton
                        key={id}
                        className="activity-bar__btn"
                        label={label}
                        shortcut={formatShortcut(shortcut)}
                        icon={<Icon size={18} strokeWidth={1.6} />}
                        active={sidebarOpen && extraPanel === null && sidePanel === id}
                        badge={id === 'git' ? gitChanges : undefined}
                        onClick={() => handleCoreClick(id)}
                    />
                ))}
                {EXTRA_PANELS.map(({ id, label, shortcut, Icon }) => (
                    <IconButton
                        key={id}
                        className="activity-bar__btn"
                        label={label}
                        shortcut={formatShortcut(shortcut)}
                        icon={<Icon size={18} strokeWidth={1.6} />}
                        active={sidebarOpen && extraPanel === id}
                        tone={id === 'debug' && isDebugging ? 'danger' : 'default'}
                        badge={id === 'debug' && breakpointCount > 0 ? breakpointCount : undefined}
                        onClick={() => toggleExtraPanel(id)}
                    />
                ))}
            </div>
            <div className="activity-bar__group">
                <IconButton
                    className="activity-bar__btn"
                    label={bottomOpen ? 'Hide terminal panel' : 'Show terminal panel'}
                    shortcut={formatShortcut('Ctrl+`')}
                    icon={<PanelBottom size={18} strokeWidth={1.6} />}
                    active={bottomOpen}
                    onClick={() => setBottomOpen(!bottomOpen)}
                />
                <IconButton
                    className="activity-bar__btn"
                    label={rightOpen ? 'Hide agent panel' : 'Show agent panel'}
                    shortcut={formatShortcut('Ctrl+Shift+A')}
                    icon={<PanelRight size={18} strokeWidth={1.6} />}
                    active={rightOpen}
                    onClick={() => setRightOpen(!rightOpen)}
                />
            </div>
        </nav>
    )
}

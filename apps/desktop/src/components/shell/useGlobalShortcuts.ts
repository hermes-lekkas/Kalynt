/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Shortcuts that work everywhere in the app. Code-view shortcuts live in the
 * IDE. Ctrl+K is deliberately left free for Monaco's chord commands.
 */
import { useEffect } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useUiStore } from '../../stores/uiStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { hasOpenLayer } from '../ui'

// Plain Ctrl+P is "previous command" in a shell, so the terminal keeps it.
const inTerminal = (e: KeyboardEvent) => e.target instanceof Element && !!e.target.closest('.xterm')

export function useGlobalShortcuts() {
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented) return

            const mod = e.ctrlKey || e.metaKey
            const key = e.key.toLowerCase()
            const ui = useUiStore.getState()
            const inWorkspace = useAppStore.getState().currentSpace !== null
            const layerOpen = hasOpenLayer()

            // Allow switching Command Palette modes while the palette itself is open,
            // but never open global modals on top of active dialogs/confirmations.
            if ((mod && e.shiftKey && !e.altKey && key === 'p') || (!mod && !e.altKey && e.key === 'F1')) {
                if (layerOpen && !ui.paletteOpen) return
                e.preventDefault()
                ui.openPalette('commands')
            } else if (mod && !e.shiftKey && !e.altKey && key === 'p' && !inTerminal(e)) {
                if (layerOpen && !ui.paletteOpen) return
                e.preventDefault()
                ui.openPalette(inWorkspace ? 'files' : 'workspaces')
            } else if (layerOpen) {
                return
            } else if (mod && !e.shiftKey && !e.altKey && key === ',') {
                e.preventDefault()
                useAppStore.getState().setShowSettings(true)
            } else if (mod && e.shiftKey && !e.altKey && key === 'x') {
                e.preventDefault()
                ui.openExtensions()
            } else if (mod && e.altKey && !e.shiftKey && inWorkspace && ['1', '2', '3', '4'].includes(key)) {
                e.preventDefault()
                const views = ['code', 'tasks', 'history', 'files'] as const
                useLayoutStore.getState().setMainView(views[Number(key) - 1])
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [])
}

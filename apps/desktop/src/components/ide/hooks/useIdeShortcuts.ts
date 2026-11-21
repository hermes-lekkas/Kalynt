/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Keyboard shortcuts for the code view. Only active while the code view is
 * visible and no dialog or menu is open. Ctrl+K stays free for Monaco chords,
 * and terminal shortcuts are handled inside the terminal itself.
 */
import { useEffect, useRef } from 'react'
import { useLayoutStore } from '../../../stores/layoutStore'
import { hasOpenLayer } from '../../ui'
import { AGENT_EVENTS, focusWorkspaceReplace, focusWorkspaceSearch, openProblemsPanel, type IdeActions } from './useIdeCommands'

export function useIdeShortcuts(enabled: boolean, actions: IdeActions) {
    const ref = useRef(actions)
    ref.current = actions

    useEffect(() => {
        if (!enabled) return
        const onKeyDown = (e: KeyboardEvent) => {
            if (hasOpenLayer() || e.defaultPrevented) return
            const { files, runner, folder, canEdit } = ref.current
            const layout = useLayoutStore.getState()
            const mod = e.ctrlKey || e.metaKey
            const key = e.key.toLowerCase()
            const run = (fn: () => void) => { e.preventDefault(); fn() }

            // The shell owns keys like Ctrl+W and Ctrl+B while the terminal has focus.
            const inTerminal = e.target instanceof Element && !!e.target.closest('.xterm')
            if (inTerminal && !(mod && !e.altKey && (key === '`' || e.code === 'Backquote')) && !/^F\d+$/.test(e.key)) return

            // Explicit Alt+Mod shortcut (must come before !e.altKey guards).
            if (mod && e.altKey && !e.shiftKey && key === 's') {
                return run(() => { if (canEdit) void files.saveAll() })
            }
            if (e.altKey && !mod && !e.shiftKey && key === 'z') {
                return run(() => layout.setEditorPref({ wordWrap: !layout.wordWrap }))
            }

            // Guard !e.altKey on all mod shortcuts so European AltGr (Ctrl+Alt) characters work.
            if (mod && !e.altKey) {
                if (!e.shiftKey && key === 's') return run(() => { if (canEdit) ref.current.saveFocusedFile() })
                if (!e.shiftKey && key === 'n' && folder && canEdit) return run(ref.current.newFile)
                if (!e.shiftKey && key === 'w') return run(ref.current.closeFocusedTab)
                if (e.shiftKey && key === 'w') return run(() => { void files.closeMany() })
                if (e.shiftKey && key === 't') return run(() => { void files.reopenClosedTab() })
                if (!e.shiftKey && key === 'o') return run(ref.current.openFolder)
                if (!e.shiftKey && key === 'b') return run(() => layout.setSidebarOpen(!layout.sidebarOpen))
                if (e.shiftKey && key === 'e') return run(() => layout.showSidePanel('files'))
                if (e.shiftKey && key === 'f') return run(focusWorkspaceSearch)
                if (e.shiftKey && key === 'h') return run(focusWorkspaceReplace)
                if (e.shiftKey && key === 'g') return run(() => layout.showSidePanel('git'))
                if (e.shiftKey && key === 'd') return run(() => layout.showSidePanel('debug'))
                if (e.shiftKey && key === 'o') return run(() => layout.showSidePanel('outline'))
                if (e.shiftKey && key === 'm') return run(openProblemsPanel)
                if (e.shiftKey && key === 'a') return run(() => layout.setRightOpen(!layout.rightOpen))
                if (key === '`' || e.code === 'Backquote') return run(() => layout.setBottomOpen(!layout.bottomOpen))
                if (!e.shiftKey && (key === '\\' || e.code === 'Backslash')) {
                    if (layout.splitEditor || files.files.length > 0) {
                        return run(() => layout.setEditorPref({ splitEditor: !layout.splitEditor }))
                    }
                    return
                }
                if (!e.shiftKey && key === 'l') return run(() => {
                    layout.showRightTab('agent')
                    window.dispatchEvent(new Event(AGENT_EVENTS.focus))
                })
                if (key === 'tab') return run(() => files.cycle(e.shiftKey ? -1 : 1))
                if (e.shiftKey && key === 'b') return run(() => { if (runner.isBuilding) void runner.stopBuild(); else void runner.build() })
                if (!e.shiftKey && e.key === 'F5') {
                    return run(() => {
                        if (runner.isRunning) runner.stopRun()
                        else void runner.run()
                    })
                }
                if (!e.shiftKey && /^[1-9]$/.test(e.key)) {
                    return run(() => files.selectByIndex(Number(e.key) - 1))
                }
            }

            // Function-key run / debug / breakpoint shortcuts (VS Code standard).
            if (!mod && !e.altKey) {
                if (e.key === 'F5' && !e.shiftKey) {
                    return run(() => {
                        if (runner.isDebugging) void runner.debugStep('continue')
                        else void runner.startDebug()
                    })
                }
                if (e.key === 'F5' && e.shiftKey) return run(() => { void runner.stopDebug() })
                if (e.key === 'F9' && !e.shiftKey) return run(ref.current.toggleCurrentBreakpoint)
                if (runner.isDebugging) {
                    if (e.key === 'F10' && !e.shiftKey) return run(() => { void runner.debugStep('stepOver') })
                    if (e.key === 'F11' && !e.shiftKey) return run(() => { void runner.debugStep('stepInto') })
                    if (e.key === 'F11' && e.shiftKey) return run(() => { void runner.debugStep('stepOut') })
                    if (e.key === 'F6' && !e.shiftKey) return run(() => { void runner.debugStep('pause') })
                }
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [enabled])
}

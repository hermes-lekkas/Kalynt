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
import { AGENT_EVENTS, focusWorkspaceSearch, type IdeActions } from './useIdeCommands'

export function useIdeShortcuts(enabled: boolean, actions: IdeActions) {
    const ref = useRef(actions)
    ref.current = actions

    useEffect(() => {
        if (!enabled) return
        const onKeyDown = (e: KeyboardEvent) => {
            if (hasOpenLayer() || e.defaultPrevented) return
            const { files, runner, folder } = ref.current
            const layout = useLayoutStore.getState()
            const mod = e.ctrlKey || e.metaKey
            const key = e.key.toLowerCase()
            const run = (fn: () => void) => { e.preventDefault(); fn() }

            // The shell owns keys like Ctrl+W and Ctrl+B while the terminal has focus.
            const inTerminal = e.target instanceof Element && !!e.target.closest('.xterm')
            if (inTerminal && !(mod && (key === '`' || e.code === 'Backquote')) && !/^F\d+$/.test(e.key)) return

            if (mod && e.altKey && key === 's') return run(() => { files.saveAll() })
            if (mod && !e.shiftKey && key === 's') return run(() => { files.saveFile() })
            if (mod && !e.shiftKey && key === 'n' && folder) return run(ref.current.newFile)
            if (mod && !e.shiftKey && key === 'w') return run(() => { if (files.activePath) files.closeFile(files.activePath) })
            if (mod && e.shiftKey && key === 'w') return run(() => { files.closeMany() })
            if (mod && !e.shiftKey && key === 'o') return run(ref.current.openFolder)
            if (mod && !e.shiftKey && key === 'b') return run(() => layout.setSidebarOpen(!layout.sidebarOpen))
            if (mod && e.shiftKey && key === 'e') return run(() => layout.showSidePanel('files'))
            if (mod && e.shiftKey && key === 'f') return run(focusWorkspaceSearch)
            if (mod && e.shiftKey && key === 'g') return run(() => layout.showSidePanel('git'))
            if (mod && e.shiftKey && key === 'a') return run(() => layout.setRightOpen(!layout.rightOpen))
            if (mod && (key === '`' || e.code === 'Backquote')) return run(() => layout.setBottomOpen(!layout.bottomOpen))
            if (mod && key === '\\') return run(() => layout.setEditorPref({ splitEditor: !layout.splitEditor }))
            if (mod && !e.shiftKey && key === 'l') return run(() => {
                layout.showRightTab('agent')
                window.dispatchEvent(new Event(AGENT_EVENTS.focus))
            })
            if (e.altKey && !mod && key === 'z') return run(() => layout.setEditorPref({ wordWrap: !layout.wordWrap }))
            if (mod && key === 'tab') return run(() => files.cycle(e.shiftKey ? -1 : 1))

            if (e.key === 'F5' && !e.shiftKey && !mod) {
                return run(() => {
                    if (runner.isDebugging) runner.debugStep('continue')
                    else if (runner.isRunning) runner.stopRun()
                    else runner.run()
                })
            }
            if (e.key === 'F5' && e.shiftKey) return run(() => { runner.stopDebug() })
            if (e.key === 'F9' && !mod) return run(() => { if (runner.isDebugging) runner.stopDebug(); else runner.startDebug() })
            if (mod && e.shiftKey && key === 'b') return run(() => { if (runner.isBuilding) runner.stopBuild(); else runner.build() })
            if (runner.isDebugging) {
                if (e.key === 'F10') return run(() => runner.debugStep('stepOver'))
                if (e.key === 'F11' && !e.shiftKey) return run(() => runner.debugStep('stepInto'))
                if (e.key === 'F11' && e.shiftKey) return run(() => runner.debugStep('stepOut'))
                if (e.key === 'F6') return run(() => runner.debugStep('pause'))
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [enabled])
}

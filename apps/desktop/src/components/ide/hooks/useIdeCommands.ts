/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Code-view commands, registered with the command palette while the IDE is
 * mounted. Shortcuts shown here are handled by useIdeShortcuts.
 */
import { useEffect, useMemo } from 'react'
import type { IDECommand } from '../../../types/ide'
import { useCommandStore } from '../../../stores/commandStore'
import { useLayoutStore } from '../../../stores/layoutStore'
import type { OpenFilesApi } from './useOpenFiles'
import type { RunnerApi } from './useRunner'

export interface IdeActions {
    files: OpenFilesApi
    runner: RunnerApi
    folder: string | null
    openFolder: () => void
    closeFolder: () => void
    newFile: () => void
    runEditorAction: (actionId: string) => void
    gitPush: () => void
    gitPull: () => void
}

export const AGENT_EVENTS = {
    focus: 'kalynt-agent-focus',
    newChat: 'kalynt-agent-new-chat'
} as const

export const FOCUS_SEARCH_EVENT = 'kalynt-focus-search'

/** Shows the search view and puts the cursor in its query box. */
export function focusWorkspaceSearch() {
    useLayoutStore.getState().showSidePanel('search')
    window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT))
}

export function useIdeCommands(actions: IdeActions) {
    const register = useCommandStore(s => s.register)
    const unregister = useCommandStore(s => s.unregister)
    const { files, runner, folder } = actions
    const hasFile = !!files.activeFile

    const commands = useMemo<IDECommand[]>(() => {
        const layout = useLayoutStore.getState
        const list: (IDECommand | false)[] = [
            !!folder && { id: 'file.new', title: 'New file', shortcut: 'Ctrl+N', category: 'file', icon: 'FilePlus', action: actions.newFile },
            hasFile && { id: 'file.save', title: 'Save', shortcut: 'Ctrl+S', category: 'file', icon: 'Save', action: () => { files.saveFile() } },
            files.files.some(f => f.isDirty) && { id: 'file.saveAll', title: 'Save all', shortcut: 'Ctrl+Alt+S', category: 'file', icon: 'Save', action: () => { files.saveAll() } },
            hasFile && { id: 'file.close', title: 'Close editor', shortcut: 'Ctrl+W', category: 'file', icon: 'X', action: () => { if (files.activePath) files.closeFile(files.activePath) } },
            files.files.length > 0 && { id: 'file.closeAll', title: 'Close all editors', shortcut: 'Ctrl+Shift+W', category: 'file', icon: 'X', action: () => { files.closeMany() } },
            { id: 'file.openFolder', title: folder ? 'Change folder…' : 'Open folder…', shortcut: 'Ctrl+O', category: 'file', icon: 'FolderOpen', action: actions.openFolder },
            !!folder && { id: 'file.closeFolder', title: 'Close folder', category: 'file', icon: 'FolderX', action: actions.closeFolder },

            { id: 'view.sidebar', title: 'Toggle side bar', shortcut: 'Ctrl+B', category: 'view', icon: 'PanelLeft', action: () => layout().setSidebarOpen(!layout().sidebarOpen) },
            { id: 'view.explorer', title: 'Show explorer', shortcut: 'Ctrl+Shift+E', category: 'view', icon: 'Files', action: () => layout().showSidePanel('files') },
            { id: 'view.search', title: 'Search in files', shortcut: 'Ctrl+Shift+F', category: 'view', icon: 'Search', action: focusWorkspaceSearch },
            { id: 'view.git', title: 'Show source control', shortcut: 'Ctrl+Shift+G', category: 'view', icon: 'GitBranch', action: () => layout().showSidePanel('git') },
            { id: 'view.terminal', title: 'Toggle terminal', shortcut: 'Ctrl+`', category: 'view', icon: 'TerminalSquare', action: () => layout().setBottomOpen(!layout().bottomOpen) },
            { id: 'view.agent', title: 'Toggle agent panel', shortcut: 'Ctrl+Shift+A', category: 'view', icon: 'PanelRight', action: () => layout().setRightOpen(!layout().rightOpen) },
            { id: 'view.team', title: 'Show team chat', category: 'view', icon: 'MessagesSquare', action: () => layout().showRightTab('team') },
            files.files.length > 1 && { id: 'view.split', title: layout().splitEditor ? 'Close split editor' : 'Split editor', shortcut: 'Ctrl+\\', category: 'view', icon: 'Columns2', action: () => layout().setEditorPref({ splitEditor: !layout().splitEditor }) },

            hasFile && { id: 'edit.format', title: 'Format document', shortcut: 'Shift+Alt+F', category: 'edit', icon: 'AlignLeft', action: () => actions.runEditorAction('editor.action.formatDocument') },
            hasFile && { id: 'edit.goToLine', title: 'Go to line…', shortcut: 'Ctrl+G', category: 'edit', icon: 'Hash', action: () => actions.runEditorAction('editor.action.gotoLine') },
            hasFile && { id: 'edit.find', title: 'Find in file', shortcut: 'Ctrl+F', category: 'edit', icon: 'Search', action: () => actions.runEditorAction('actions.find') },
            { id: 'edit.wordWrap', title: 'Toggle word wrap', shortcut: 'Alt+Z', category: 'edit', icon: 'WrapText', action: () => layout().setEditorPref({ wordWrap: !layout().wordWrap }) },
            { id: 'edit.minimap', title: 'Toggle minimap', category: 'edit', icon: 'Map', action: () => layout().setEditorPref({ minimap: !layout().minimap }) },
            { id: 'edit.stickyScroll', title: 'Toggle sticky scroll', category: 'edit', icon: 'Pin', action: () => layout().setEditorPref({ stickyScroll: !layout().stickyScroll }) },

            runner.canRun && !runner.isRunning && { id: 'run.file', title: 'Run current file', shortcut: 'F5', category: 'terminal', icon: 'Play', action: () => { runner.run() } },
            runner.isRunning && { id: 'run.stop', title: 'Stop running', shortcut: 'F5', category: 'terminal', icon: 'Square', action: runner.stopRun },
            hasFile && !runner.isDebugging && { id: 'debug.start', title: 'Debug current file', shortcut: 'F9', category: 'terminal', icon: 'Bug', action: () => { runner.startDebug() } },
            runner.isDebugging && { id: 'debug.stop', title: 'Stop debugging', shortcut: 'Shift+F5', category: 'terminal', icon: 'Square', action: () => { runner.stopDebug() } },
            !!folder && !runner.isBuilding && { id: 'build.run', title: 'Build project', shortcut: 'Ctrl+Shift+B', category: 'terminal', icon: 'Hammer', action: () => { runner.build() } },
            runner.isBuilding && { id: 'build.stop', title: 'Stop build', shortcut: 'Ctrl+Shift+B', category: 'terminal', icon: 'Square', action: () => { runner.stopBuild() } },

            !!folder && { id: 'git.commit', title: 'Git: Commit…', category: 'git', icon: 'GitCommit', action: () => layout().showSidePanel('git') },
            !!folder && { id: 'git.push', title: 'Git: Push', category: 'git', icon: 'ArrowUp', action: actions.gitPush },
            !!folder && { id: 'git.pull', title: 'Git: Pull', category: 'git', icon: 'ArrowDown', action: actions.gitPull },

            { id: 'ai.chat', title: 'Ask the agent', shortcut: 'Ctrl+L', category: 'ai', icon: 'Sparkles', action: () => { layout().showRightTab('agent'); window.dispatchEvent(new Event(AGENT_EVENTS.focus)) } },
            { id: 'ai.newChat', title: 'New agent conversation', category: 'ai', icon: 'MessageSquarePlus', action: () => { layout().showRightTab('agent'); window.dispatchEvent(new Event(AGENT_EVENTS.newChat)) } }
        ]
        return list.filter((c): c is IDECommand => !!c)
    }, [actions, files, runner, folder, hasFile])

    useEffect(() => {
        register('ide', commands)
    }, [commands, register])

    useEffect(() => () => unregister('ide'), [unregister])
}

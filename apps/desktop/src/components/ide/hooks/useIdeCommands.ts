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
    canEdit: boolean
    openFolder: () => void
    closeFolder: () => void
    newFile: () => void
    saveFocusedFile: () => void
    closeFocusedTab: () => void
    toggleCurrentBreakpoint: () => void
    runEditorAction: (actionId: string) => void
    gitPush: () => void
    gitPull: () => void
}

export const AGENT_EVENTS = {
    focus: 'kalynt-agent-focus',
    newChat: 'kalynt-agent-new-chat'
} as const

export const FOCUS_SEARCH_EVENT = 'kalynt-focus-search'
export const FOCUS_REPLACE_EVENT = 'kalynt-focus-replace'
export const OPEN_PROBLEMS_EVENT = 'kalynt-open-problems'

/** Shows the search view and puts the cursor in its query box. */
export function focusWorkspaceSearch() {
    useLayoutStore.getState().showSidePanel('search')
    window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT))
}

/** Shows the search view with Replace expanded. */
export function focusWorkspaceReplace() {
    useLayoutStore.getState().showSidePanel('search')
    window.dispatchEvent(new Event(FOCUS_REPLACE_EVENT))
}

/** Opens the Problems panel via custom event (handled by BottomPanel). */
export function openProblemsPanel() {
    window.dispatchEvent(new Event(OPEN_PROBLEMS_EVENT))
}

export function useIdeCommands(actions: IdeActions) {
    const register = useCommandStore(s => s.register)
    const unregister = useCommandStore(s => s.unregister)
    const splitEditor = useLayoutStore(s => s.splitEditor)
    const { files, runner, folder, canEdit } = actions
    const hasFile = !!files.activeFile

    const commands = useMemo<IDECommand[]>(() => {
        const layout = useLayoutStore.getState
        const list: (IDECommand | false)[] = [
            !!folder && canEdit && { id: 'file.new', title: 'New file', shortcut: 'Ctrl+N', category: 'file', icon: 'FilePlus', action: actions.newFile },
            hasFile && canEdit && { id: 'file.save', title: 'Save', shortcut: 'Ctrl+S', category: 'file', icon: 'Save', action: actions.saveFocusedFile },
            canEdit && files.files.some(f => f.isDirty) && { id: 'file.saveAll', title: 'Save all', shortcut: 'Ctrl+Alt+S', category: 'file', icon: 'Save', action: () => { void files.saveAll() } },
            hasFile && { id: 'file.close', title: 'Close editor', shortcut: 'Ctrl+W', category: 'file', icon: 'X', action: actions.closeFocusedTab },
            files.files.length > 0 && { id: 'file.closeAll', title: 'Close all editors', shortcut: 'Ctrl+Shift+W', category: 'file', icon: 'X', action: () => { void files.closeMany() } },
            { id: 'file.reopenClosed', title: 'Reopen closed editor', shortcut: 'Ctrl+Shift+T', category: 'file', icon: 'RotateCcw', action: () => { void files.reopenClosedTab() } },
            { id: 'file.openFolder', title: folder ? 'Change folder…' : 'Open folder…', shortcut: 'Ctrl+O', category: 'file', icon: 'FolderOpen', action: actions.openFolder },
            !!folder && { id: 'file.closeFolder', title: 'Close folder', category: 'file', icon: 'FolderX', action: actions.closeFolder },

            { id: 'view.sidebar', title: 'Toggle side bar', shortcut: 'Ctrl+B', category: 'view', icon: 'PanelLeft', action: () => layout().setSidebarOpen(!layout().sidebarOpen) },
            { id: 'view.explorer', title: 'Show explorer', shortcut: 'Ctrl+Shift+E', category: 'view', icon: 'Files', action: () => layout().showSidePanel('files') },
            { id: 'view.search', title: 'Search in files', shortcut: 'Ctrl+Shift+F', category: 'view', icon: 'Search', action: focusWorkspaceSearch },
            { id: 'view.replace', title: 'Replace in files', shortcut: 'Ctrl+Shift+H', category: 'view', icon: 'Replace', action: focusWorkspaceReplace },
            { id: 'view.git', title: 'Show source control', shortcut: 'Ctrl+Shift+G', category: 'view', icon: 'GitBranch', action: () => layout().showSidePanel('git') },
            { id: 'view.debug', title: 'Show run & debug', shortcut: 'Ctrl+Shift+D', category: 'view', icon: 'Bug', action: () => layout().showSidePanel('debug') },
            { id: 'view.outline', title: 'Show outline', shortcut: 'Ctrl+Shift+O', category: 'view', icon: 'ListTree', action: () => layout().showSidePanel('outline') },
            { id: 'view.problems', title: 'Show problems', shortcut: 'Ctrl+Shift+M', category: 'view', icon: 'AlertTriangle', action: openProblemsPanel },
            { id: 'view.terminal', title: 'Toggle terminal', shortcut: 'Ctrl+`', category: 'view', icon: 'TerminalSquare', action: () => layout().setBottomOpen(!layout().bottomOpen) },
            { id: 'view.agent', title: 'Toggle agent panel', shortcut: 'Ctrl+Shift+A', category: 'view', icon: 'PanelRight', action: () => layout().setRightOpen(!layout().rightOpen) },
            { id: 'view.team', title: 'Show team chat', category: 'view', icon: 'MessagesSquare', action: () => layout().showRightTab('team') },
            (files.files.length > 0 || splitEditor) && {
                id: 'view.split',
                title: splitEditor ? 'Close split editor' : 'Split editor',
                shortcut: 'Ctrl+\\',
                category: 'view',
                icon: 'Columns2',
                action: () => layout().setEditorPref({ splitEditor: !layout().splitEditor })
            },

            hasFile && { id: 'edit.format', title: 'Format document', shortcut: 'Shift+Alt+F', category: 'edit', icon: 'AlignLeft', action: () => actions.runEditorAction('editor.action.formatDocument') },
            hasFile && { id: 'edit.goToLine', title: 'Go to line…', shortcut: 'Ctrl+G', category: 'edit', icon: 'Hash', action: () => actions.runEditorAction('editor.action.gotoLine') },
            hasFile && { id: 'edit.find', title: 'Find in file', shortcut: 'Ctrl+F', category: 'edit', icon: 'Search', action: () => actions.runEditorAction('actions.find') },
            { id: 'edit.wordWrap', title: 'Toggle word wrap', shortcut: 'Alt+Z', category: 'edit', icon: 'WrapText', action: () => layout().setEditorPref({ wordWrap: !layout().wordWrap }) },
            { id: 'edit.minimap', title: 'Toggle minimap', category: 'edit', icon: 'Map', action: () => layout().setEditorPref({ minimap: !layout().minimap }) },
            { id: 'edit.stickyScroll', title: 'Toggle sticky scroll', category: 'edit', icon: 'Pin', action: () => layout().setEditorPref({ stickyScroll: !layout().stickyScroll }) },
            { id: 'edit.formatOnSave', title: 'Toggle format on save', category: 'edit', icon: 'AlignLeft', action: () => layout().setEditorPref({ formatOnSave: !layout().formatOnSave }) },

            runner.canRun && !runner.isRunning && { id: 'run.file', title: 'Run current file', shortcut: 'Ctrl+F5', category: 'terminal', icon: 'Play', action: () => { void runner.run() } },
            runner.isRunning && { id: 'run.stop', title: 'Stop running', shortcut: 'Ctrl+F5', category: 'terminal', icon: 'Square', action: runner.stopRun },
            hasFile && !runner.isDebugging && { id: 'debug.start', title: 'Debug current file', shortcut: 'F5', category: 'terminal', icon: 'Bug', action: () => { void runner.startDebug() } },
            runner.isDebugging && { id: 'debug.stop', title: 'Stop debugging', shortcut: 'Shift+F5', category: 'terminal', icon: 'Square', action: () => { void runner.stopDebug() } },
            hasFile && { id: 'debug.toggleBreakpoint', title: 'Toggle breakpoint', shortcut: 'F9', category: 'terminal', icon: 'CircleDot', action: actions.toggleCurrentBreakpoint },
            !!folder && !runner.isBuilding && { id: 'build.run', title: 'Build project', shortcut: 'Ctrl+Shift+B', category: 'terminal', icon: 'Hammer', action: () => { void runner.build() } },
            runner.isBuilding && { id: 'build.stop', title: 'Stop build', shortcut: 'Ctrl+Shift+B', category: 'terminal', icon: 'Square', action: () => { void runner.stopBuild() } },

            !!folder && { id: 'git.commit', title: 'Git: Commit…', category: 'git', icon: 'GitCommit', action: () => layout().showSidePanel('git') },
            !!folder && { id: 'git.push', title: 'Git: Push', category: 'git', icon: 'ArrowUp', action: actions.gitPush },
            !!folder && { id: 'git.pull', title: 'Git: Pull', category: 'git', icon: 'ArrowDown', action: actions.gitPull },

            { id: 'ai.chat', title: 'Ask the agent', shortcut: 'Ctrl+L', category: 'ai', icon: 'Sparkles', action: () => { layout().showRightTab('agent'); window.dispatchEvent(new Event(AGENT_EVENTS.focus)) } },
            { id: 'ai.newChat', title: 'New agent conversation', category: 'ai', icon: 'MessageSquarePlus', action: () => { layout().showRightTab('agent'); window.dispatchEvent(new Event(AGENT_EVENTS.newChat)) } }
        ]
        return list.filter((c): c is IDECommand => !!c)
    }, [actions, files, runner, folder, hasFile, canEdit, splitEditor])

    useEffect(() => {
        register('ide', commands)
    }, [commands, register])

    useEffect(() => () => unregister('ide'), [unregister])
}

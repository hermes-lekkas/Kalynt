/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Commands available everywhere, whether or not a workspace is open.
 */
import type { IDECommand } from '../../types/ide'
import { useAppStore } from '../../stores/appStore'
import { useUiStore } from '../../stores/uiStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useUpdateStore } from '../../stores/updateStore'
import { openFolderAsWorkspace } from '../home/workspaceActions'
import { promptText } from '../ui'

export function globalCommands(): IDECommand[] {
    const app = useAppStore.getState()
    const ui = useUiStore.getState()
    const inWorkspace = !!app.currentSpace
    const list: (IDECommand | false)[] = [
        { id: 'workspace.home', title: 'Show all workspaces', category: 'workspace', icon: 'LayoutGrid', action: () => app.setCurrentSpace(null) },
        {
            id: 'workspace.new', title: 'New workspace…', category: 'workspace', icon: 'Plus', action: async () => {
                const name = await promptText({ title: 'New workspace', label: 'Workspace name', confirmLabel: 'Create workspace' })
                if (name) app.setCurrentSpace(app.createSpace(name))
            }
        },
        { id: 'workspace.openFolder', title: 'Open folder as workspace…', category: 'workspace', icon: 'FolderOpen', action: () => { openFolderAsWorkspace() } },
        { id: 'workspace.join', title: 'Join a session…', category: 'workspace', icon: 'LogIn', action: () => ui.openCollaboration('join') },
        inWorkspace && { id: 'workspace.invite', title: 'Invite people to this workspace', category: 'workspace', icon: 'UserPlus', action: () => ui.openCollaboration('invite') },
        inWorkspace && { id: 'workspace.members', title: 'Manage members', category: 'workspace', icon: 'Users', action: () => ui.openCollaboration('members') },
        inWorkspace && { id: 'view.code', title: 'Go to code', shortcut: 'Ctrl+Alt+1', category: 'view', icon: 'Code2', action: () => useLayoutStore.getState().setMainView('code') },
        inWorkspace && { id: 'view.tasks', title: 'Go to tasks', shortcut: 'Ctrl+Alt+2', category: 'view', icon: 'ListTodo', action: () => useLayoutStore.getState().setMainView('tasks') },
        inWorkspace && { id: 'view.history', title: 'Go to history', shortcut: 'Ctrl+Alt+3', category: 'view', icon: 'History', action: () => useLayoutStore.getState().setMainView('history') },
        inWorkspace && { id: 'view.files', title: 'Go to shared files', shortcut: 'Ctrl+Alt+4', category: 'view', icon: 'Share2', action: () => useLayoutStore.getState().setMainView('files') },
        { id: 'app.settings', title: 'Open settings', shortcut: 'Ctrl+,', category: 'view', icon: 'Settings', action: () => app.setShowSettings(true) },
        {
            id: 'app.models', title: 'Manage models and API keys', category: 'ai', icon: 'Cpu', action: () => {
                app.setSettingsTab('models')
                app.setShowSettings(true)
            }
        },
        { id: 'app.extensions', title: 'Extensions and runtimes', shortcut: 'Ctrl+Shift+X', category: 'view', icon: 'Puzzle', action: () => ui.openExtensions() },
        {
            id: 'app.theme', title: app.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme', category: 'view', icon: 'SunMoon',
            action: () => app.setTheme(app.theme === 'light' ? 'dark' : 'light')
        },
        { id: 'app.updates', title: 'Check for updates', category: 'view', icon: 'RefreshCw', action: () => { useUpdateStore.getState().checkForUpdates() } },
        { id: 'app.reload', title: 'Reload window', category: 'view', icon: 'RotateCw', action: () => window.location.reload() }
    ]
    return list.filter((c): c is IDECommand => !!c)
}

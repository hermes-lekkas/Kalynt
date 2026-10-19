/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Puzzle, Search, Settings } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useLayoutStore, type MainView } from '../../stores/layoutStore'
import { useUiStore } from '../../stores/uiStore'
import { formatShortcut } from '../../stores/commandStore'
import { IconButton, Kbd } from '../ui'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { PeersIndicator } from './PeersIndicator'
import { UpdateIndicator } from './UpdateIndicator'
import { WindowControls } from './WindowControls'
import { LOGO_URL } from './brand'

const VIEWS: { id: MainView; label: string; shortcut: string }[] = [
    { id: 'code', label: 'Code', shortcut: 'Ctrl+Alt+1' },
    { id: 'tasks', label: 'Tasks', shortcut: 'Ctrl+Alt+2' },
    { id: 'history', label: 'History', shortcut: 'Ctrl+Alt+3' },
    { id: 'files', label: 'Shared files', shortcut: 'Ctrl+Alt+4' }
]

export function getPlatform(): string {
    return window.electronAPI?.platform ?? 'browser'
}

export function Titlebar() {
    const currentSpace = useAppStore(s => s.currentSpace)
    const searchLabel = currentSpace ? 'Go to file or run a command' : 'Find a workspace or command'
    const setCurrentSpace = useAppStore(s => s.setCurrentSpace)
    const setShowSettings = useAppStore(s => s.setShowSettings)
    const mainView = useLayoutStore(s => s.mainView)
    const setMainView = useLayoutStore(s => s.setMainView)
    const openPalette = useUiStore(s => s.openPalette)
    const openExtensions = useUiStore(s => s.openExtensions)
    const platform = getPlatform()

    return (
        <header className={`titlebar drag-region titlebar--${platform}`}>
            <div className="titlebar__start">
                <button
                    type="button"
                    className="titlebar__brand no-drag"
                    onClick={() => setCurrentSpace(null)}
                    title="All workspaces"
                    aria-label="Kalynt, show all workspaces"
                >
                    <img src={LOGO_URL} alt="" width={20} height={20} />
                </button>

                {currentSpace && (
                    <>
                        <WorkspaceSwitcher />
                        <nav className="titlebar__views no-drag" aria-label="Workspace views">
                            {VIEWS.map(view => (
                                <button
                                    key={view.id}
                                    type="button"
                                    className={`titlebar__view ${mainView === view.id ? 'is-active' : ''}`}
                                    aria-current={mainView === view.id ? 'page' : undefined}
                                    title={`${view.label} (${formatShortcut(view.shortcut)})`}
                                    onClick={() => setMainView(view.id)}
                                >
                                    {view.label}
                                </button>
                            ))}
                        </nav>
                    </>
                )}
            </div>

            <div className="titlebar__center">
                <button
                    type="button"
                    className="titlebar__search no-drag"
                    onClick={() => openPalette(currentSpace ? 'files' : 'workspaces')}
                    aria-label={searchLabel}
                    title={`${searchLabel} (${formatShortcut('Ctrl+P')})`}
                >
                    <Search size={14} aria-hidden />
                    <span className="titlebar__search-label" aria-hidden>{searchLabel}</span>
                    <Kbd>{formatShortcut('Ctrl+P')}</Kbd>
                </button>
            </div>

            <div className="titlebar__end no-drag">
                {currentSpace && <PeersIndicator spaceId={currentSpace.id} />}
                <UpdateIndicator />
                <IconButton
                    label="Extensions and runtimes"
                    shortcut={formatShortcut('Ctrl+Shift+X')}
                    icon={<Puzzle size={16} />}
                    onClick={() => openExtensions()}
                />
                <IconButton
                    label="Settings"
                    shortcut={formatShortcut('Ctrl+,')}
                    icon={<Settings size={16} />}
                    onClick={() => setShowSettings(true)}
                />
                {platform === 'win32' && <WindowControls />}
            </div>
        </header>
    )
}

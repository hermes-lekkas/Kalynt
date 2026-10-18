/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { lazy, Suspense, useState } from 'react'
import { useAppStore } from './stores/appStore'
import { useUiStore } from './stores/uiStore'
import { EncryptionProvider } from './hooks/useEncryption'
import { useAppBootstrap } from './components/shell/useAppBootstrap'
import { SplashScreen } from './components/shell/SplashScreen'
import { Titlebar } from './components/shell/Titlebar'
import { Toasts } from './components/shell/Toasts'
import { UpdateDialog } from './components/shell/UpdateDialog'
import { useGlobalShortcuts } from './components/shell/useGlobalShortcuts'
import { HomeScreen } from './components/home/HomeScreen'
import { DialogHost, RegionBoundary, Spinner } from './components/ui'
import './components/shell/shell.css'

// The workspace (editor, terminal, agent) loads when a workspace opens; dialogs on first use.
const WorkspaceView = lazy(() => import('./components/workspace/WorkspaceView').then(m => ({ default: m.WorkspaceView })))
const SettingsDialog = lazy(() => import('./components/settings/SettingsDialog'))
const CollaborationDialog = lazy(() => import('./components/collaboration/CollaborationDialog'))
const ExtensionsDialog = lazy(() => import('./components/extensions/ExtensionsDialog'))
const CommandPalette = lazy(() => import('./components/palette/CommandPalette'))

export default function App() {
    const { ready } = useAppBootstrap()
    const [splashDone, setSplashDone] = useState(false)
    const currentSpace = useAppStore(s => s.currentSpace)
    const showSettings = useAppStore(s => s.showSettings)
    const setShowSettings = useAppStore(s => s.setShowSettings)
    const { collaborationOpen, extensionsOpen, paletteOpen } = useUiStore()
    useGlobalShortcuts()

    if (!splashDone) {
        return <SplashScreen ready={ready} onDone={() => setSplashDone(true)} />
    }

    return (
        <EncryptionProvider spaceId={currentSpace?.id ?? null}>
            <div className="app">
                <RegionBoundary name="Title bar" compact>
                    <Titlebar />
                </RegionBoundary>
                <main className="app__body">
                    {currentSpace ? (
                        <Suspense fallback={<div className="app__loading"><Spinner label="Opening workspace" /></div>}>
                            <WorkspaceView key={currentSpace.id} space={currentSpace} />
                        </Suspense>
                    ) : (
                        <RegionBoundary name="Home">
                            <HomeScreen />
                        </RegionBoundary>
                    )}
                </main>
            </div>

            <Toasts />
            <UpdateDialog />
            <DialogHost />
            <Suspense fallback={null}>
                {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
                {collaborationOpen && <CollaborationDialog />}
                {extensionsOpen && <ExtensionsDialog />}
                {paletteOpen && <CommandPalette />}
            </Suspense>
        </EncryptionProvider>
    )
}

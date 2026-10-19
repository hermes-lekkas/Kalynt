/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The code view: activity bar, side bar, editor with its panel, the agent
 * panel and the status bar. Behaviour lives in the hooks; this file only
 * wires them together and lays out the regions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { editor as MonacoEditor } from 'monaco-editor'
import type { Space } from '../../stores/appStore'
import { useLayoutStore, LAYOUT_LIMITS } from '../../stores/layoutStore'
import { useEditorStatusStore } from '../../stores/editorStatusStore'
import { usePermissions } from '../../hooks/usePermissions'
import { RegionBoundary, Resizer, Spinner } from '../ui'
import { AgentPanel } from '../agent/AgentPanel'
import { useWorkspaceFolder } from './hooks/useWorkspaceFolder'
import { useOpenFiles } from './hooks/useOpenFiles'
import { useRunner } from './hooks/useRunner'
import { useWorkspaceIndex } from './hooks/useWorkspaceIndex'
import { useIdeCommands, type IdeActions } from './hooks/useIdeCommands'
import { useIdeShortcuts } from './hooks/useIdeShortcuts'
import { useGit } from './git/useGit'
import { createEntry } from './explorer/fileOps'
import { ActivityBar } from './ActivityBar'
import { SidePanel } from './SidePanel'
import { EditorArea } from './editor/EditorArea'
import { BottomPanel } from './BottomPanel'
import { StatusBar } from './StatusBar'
import './ide.css'

interface IDEWorkspaceProps {
    space: Space
    /** False while another main view (tasks, history…) is showing. */
    active: boolean
}

type RevealTarget = { path: string; kind: 'file' | 'dir' }

export function IDEWorkspace({ space, active }: IDEWorkspaceProps) {
    const layout = useLayoutStore()
    const { canEdit, canUseAgent } = usePermissions()
    const { folder, switching, openFolder, closeFolder } = useWorkspaceFolder(space.id)
    const [reveal, setReveal] = useState<RevealTarget | null>(null)
    const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
    const sideRef = useRef<HTMLElement>(null)
    const rightRef = useRef<HTMLElement>(null)

    const revealInExplorer = useCallback((path: string, kind: RevealTarget['kind']) => {
        useLayoutStore.getState().showSidePanel('files')
        setReveal({ path, kind })
    }, [])
    const revealDirectory = useCallback((path: string) => revealInExplorer(path, 'dir'), [revealInExplorer])
    const revealFile = useCallback((path: string) => revealInExplorer(path, 'file'), [revealInExplorer])

    const disposeModel = useCallback((path: string) => {
        import('./editor/CodeEditor').then(m => m.disposeModel(path)).catch(() => undefined)
    }, [])

    const files = useOpenFiles({ spaceId: space.id, folder, onRevealDirectory: revealDirectory, onDisposeModel: disposeModel })
    const runner = useRunner({ folder, activeFile: files.activeFile, saveFile: files.saveFile })
    const index = useWorkspaceIndex(folder, files.openFile)
    const git = useGit(folder, active && layout.sidebarOpen && layout.sidePanel === 'git')

    useEffect(() => {
        if (!files.activeFile) useEditorStatusStore.getState().reset()
        else useEditorStatusStore.getState().setLanguage(files.activeFile.language)
    }, [files.activeFile])

    const runEditorAction = useCallback((actionId: string) => {
        const ed = editorRef.current
        if (!ed) return
        ed.focus()
        ed.getAction(actionId)?.run()
    }, [])

    const { openFile } = files
    const newFile = useCallback(async () => {
        if (!folder) return
        const path = await createEntry(folder, 'file')
        if (path) openFile(path)
    }, [folder, openFile])

    const actions = useMemo<IdeActions>(() => ({
        files, runner, folder, newFile, runEditorAction,
        openFolder: () => { openFolder() },
        closeFolder: () => { files.closeMany().then(ok => { if (ok) closeFolder() }) },
        gitPush: () => { git.push() },
        gitPull: () => { git.pull() }
    }), [files, runner, folder, newFile, runEditorAction, openFolder, closeFolder, git])

    useIdeCommands(actions)
    useIdeShortcuts(active, actions)

    return (
        <div className="ide">
            <div className="ide__main">
                <ActivityBar gitChanges={git.changes.length} />

                <aside ref={sideRef} className="ide__side" style={{ width: layout.sidebarWidth }} hidden={!layout.sidebarOpen} aria-label="Side bar">
                    <SidePanel
                        panel={layout.sidePanel}
                        visible={active && layout.sidebarOpen}
                        folder={folder}
                        indexFiles={index.files}
                        activePath={files.activePath}
                        reveal={reveal}
                        onRevealed={() => setReveal(null)}
                        git={git}
                        onOpenFile={files.openFile}
                        onOpenFolder={actions.openFolder}
                        onCloseFolder={actions.closeFolder}
                        onRenamed={files.renamePath}
                        onDeleted={files.handleDeleted}
                    />
                </aside>
                {layout.sidebarOpen && (
                    <Resizer
                        axis="x"
                        direction={1}
                        label="Resize side bar"
                        value={layout.sidebarWidth}
                        min={LAYOUT_LIMITS.sidebar.min}
                        max={LAYOUT_LIMITS.sidebar.max}
                        defaultValue={LAYOUT_LIMITS.sidebar.default}
                        onChange={layout.setSidebarWidth}
                        panelRef={sideRef}
                    />
                )}

                <div className="ide__center">
                    <RegionBoundary name="Editor">
                        {switching ? (
                            <div className="ide__switching"><Spinner label="Opening folder" /></div>
                        ) : (
                            <EditorArea
                                files={files}
                                runner={runner}
                                folder={folder}
                                canEdit={canEdit}
                                onOpenFolder={actions.openFolder}
                                onRevealDirectory={revealDirectory}
                                onRevealFile={revealFile}
                                onActivateEditor={ed => { editorRef.current = ed }}
                                runEditorAction={runEditorAction}
                            />
                        )}
                    </RegionBoundary>
                    <BottomPanel folder={folder} runner={runner} active={active} />
                </div>

                {layout.rightOpen && (
                    <Resizer
                        axis="x"
                        direction={-1}
                        label="Resize agent panel"
                        value={layout.rightWidth}
                        min={LAYOUT_LIMITS.right.min}
                        max={LAYOUT_LIMITS.right.max}
                        defaultValue={LAYOUT_LIMITS.right.default}
                        onChange={layout.setRightWidth}
                        panelRef={rightRef}
                    />
                )}
                <aside ref={rightRef} className="ide__right" style={{ width: layout.rightWidth }} hidden={!layout.rightOpen} aria-label="Agent and team">
                    <RegionBoundary name="Agent panel">
                        <AgentPanel
                            space={space}
                            folder={folder}
                            files={index.files}
                            canUseAgent={canUseAgent}
                            visible={active && layout.rightOpen}
                        />
                    </RegionBoundary>
                </aside>
            </div>

            <RegionBoundary name="Status bar" compact>
                <StatusBar
                    spaceId={space.id}
                    git={git}
                    runner={runner}
                    hasFile={!!files.activeFile}
                    dirtyCount={files.files.filter(f => f.isDirty).length}
                    onGoToLine={() => runEditorAction('editor.action.gotoLine')}
                />
            </RegionBoundary>
        </div>
    )
}

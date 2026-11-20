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
import { useEditorStatusStore, type LineEnding } from '../../stores/editorStatusStore'
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
import { EditorArea, type EditorPaneId } from './editor/EditorArea'
import { BottomPanel } from './BottomPanel'
import { StatusBar } from './StatusBar'
import { samePath } from './languages'
import './ide.css'

interface IDEWorkspaceProps {
    space: Space
    /** False while another main view (tasks, history…) is showing. */
    active: boolean
}

type RevealTarget = { path: string; kind: 'file' | 'dir' }

export function IDEWorkspace({ space, active }: IDEWorkspaceProps) {
    // Granular layout selectors keep editor-pref changes from re-rendering the workspace shell.
    const sidebarOpen = useLayoutStore(s => s.sidebarOpen)
    const sidebarWidth = useLayoutStore(s => s.sidebarWidth)
    const sidePanel = useLayoutStore(s => s.sidePanel)
    const setSidebarWidth = useLayoutStore(s => s.setSidebarWidth)
    const rightOpen = useLayoutStore(s => s.rightOpen)
    const rightWidth = useLayoutStore(s => s.rightWidth)
    const setRightWidth = useLayoutStore(s => s.setRightWidth)
    const splitEditor = useLayoutStore(s => s.splitEditor)
    const setEditorPref = useLayoutStore(s => s.setEditorPref)

    const { canEdit, canUseAgent } = usePermissions()
    const { folder, switching, openFolder, closeFolder } = useWorkspaceFolder(space.id)
    const [reveal, setReveal] = useState<RevealTarget | null>(null)
    const [focusedPane, setFocusedPane] = useState<EditorPaneId>('primary')
    const [secondaryPath, setSecondaryPath] = useState<string | null>(null)

    const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
    const editorsByPaneRef = useRef<Record<EditorPaneId, { editor: MonacoEditor.IStandaloneCodeEditor; path: string } | null>>({
        primary: null,
        secondary: null
    })
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

    const handleRenamedPath = useCallback((oldPath: string, newPath: string) => {
        const oldNorm = oldPath.replace(/\\/g, '/')
        const newNorm = newPath.replace(/\\/g, '/')
        setSecondaryPath(prev => {
            if (!prev) return prev
            const p = prev.replace(/\\/g, '/')
            return p === oldNorm || p.startsWith(oldNorm + '/') ? newNorm + p.slice(oldNorm.length) : prev
        })
    }, [])

    const formatBeforeSave = useCallback(async (path: string) => {
        const entries = Object.values(editorsByPaneRef.current)
        const match = entries.find(entry => entry && samePath(entry.path, path))?.editor ?? editorRef.current
        const action = match?.getAction('editor.action.formatDocument')
        if (action) await action.run()
    }, [])

    const files = useOpenFiles({
        spaceId: space.id,
        folder,
        canEdit,
        onRevealDirectory: revealDirectory,
        onDisposeModel: disposeModel,
        onFormatBeforeSave: formatBeforeSave,
        onRenamedPath: handleRenamedPath
    })
    const runner = useRunner({ folder, activeFile: files.activeFile, saveFile: files.saveFile })
    const index = useWorkspaceIndex(folder, files.openFile)
    const git = useGit(folder, active && sidebarOpen && sidePanel === 'git')

    const focusedPath = (splitEditor && focusedPane === 'secondary' && secondaryPath)
        ? secondaryPath
        : files.activePath
    const focusedFile = files.files.find(f => f.path === focusedPath) ?? files.activeFile

    useEffect(() => {
        if (!focusedFile) {
            useEditorStatusStore.getState().reset()
        } else {
            const store = useEditorStatusStore.getState()
            store.setLanguage(focusedFile.language)
            store.setActivePath(focusedFile.path)
        }
    }, [focusedFile])

    // Reset split secondary path on workspace folder switch.
    useEffect(() => {
        setSecondaryPath(null)
        setFocusedPane('primary')
        editorsByPaneRef.current = { primary: null, secondary: null }
    }, [space.id, folder])

    const handleActivateEditor = useCallback((ed: MonacoEditor.IStandaloneCodeEditor, pane: EditorPaneId, path: string) => {
        editorsByPaneRef.current[pane] = { editor: ed, path }
        editorRef.current = ed
    }, [])

    const runEditorAction = useCallback((actionId: string) => {
        const ed = editorsByPaneRef.current[focusedPane]?.editor ?? editorRef.current
        if (!ed) return
        ed.focus()
        void ed.getAction(actionId)?.run()
    }, [focusedPane])

    const { openFile } = files
    const newFile = useCallback(async () => {
        if (!folder || !canEdit) return
        const path = await createEntry(folder, 'file')
        if (path) void openFile(path)
    }, [folder, canEdit, openFile])

    useEffect(() => {
        const onOpenFileSide = (e: Event) => {
            const detail = (e as CustomEvent<{ path?: string }>).detail
            if (!detail?.path) return
            e.preventDefault()
            void openFile(detail.path, undefined, undefined, { preserveActive: true }).then(openedPath => {
                if (!openedPath) return
                setSecondaryPath(openedPath)
                useLayoutStore.getState().setEditorPref({ splitEditor: true })
                setFocusedPane('secondary')
            })
        }
        window.addEventListener('kalynt-open-file-side', onOpenFileSide)
        return () => window.removeEventListener('kalynt-open-file-side', onOpenFileSide)
    }, [openFile])

    const handleOpenFolder = useCallback(async () => {
        if (files.files.some(f => f.isDirty)) {
            const ok = await files.confirmDirtyBeforeSwitch()
            if (!ok) return
        }
        await openFolder()
    }, [files, openFolder])

    const saveFocusedFile = useCallback(() => {
        if (!canEdit) return
        if (focusedPath) void files.saveFile(focusedPath)
    }, [canEdit, focusedPath, files])

    const closeFocusedTab = useCallback(() => {
        if (splitEditor && focusedPane === 'secondary' && secondaryPath) {
            // Closing a split pane showing the same file as primary just closes the split.
            if (samePath(secondaryPath, files.activePath)) {
                setEditorPref({ splitEditor: false })
                setFocusedPane('primary')
                return
            }
            void files.closeFile(secondaryPath)
            return
        }
        if (files.activePath) void files.closeFile(files.activePath)
    }, [splitEditor, focusedPane, secondaryPath, files, setEditorPref])

    const toggleCurrentBreakpoint = useCallback(() => {
        if (!focusedPath) return
        const ed = editorsByPaneRef.current[focusedPane]?.editor ?? editorRef.current
        const line = ed?.getPosition()?.lineNumber ?? useEditorStatusStore.getState().line
        if (line > 0) runner.toggleBreakpoint(focusedPath, line)
    }, [focusedPath, focusedPane, runner])

    const handleChangeLanguage = useCallback((language: string) => {
        if (focusedPath) files.setFileLanguage(focusedPath, language)
    }, [focusedPath, files])

    const handleChangeEol = useCallback((eol: LineEnding) => {
        if (!canEdit) return
        window.dispatchEvent(new CustomEvent('kalynt-set-eol', { detail: { eol } }))
    }, [canEdit])

    const actions = useMemo<IdeActions>(() => ({
        files,
        runner,
        folder,
        canEdit,
        newFile,
        saveFocusedFile,
        closeFocusedTab,
        toggleCurrentBreakpoint,
        runEditorAction,
        openFolder: () => { void handleOpenFolder() },
        closeFolder: () => { void files.closeMany().then(ok => { if (ok) closeFolder() }) },
        gitPush: () => { void git.push() },
        gitPull: () => { void git.pull() }
    }), [
        files, runner, folder, canEdit, newFile, saveFocusedFile, closeFocusedTab,
        toggleCurrentBreakpoint, runEditorAction, handleOpenFolder, closeFolder, git
    ])

    useIdeCommands(actions)
    useIdeShortcuts(active, actions)

    const onDragSide = useCallback((px: number) => {
        if (sideRef.current) sideRef.current.style.width = `${px}px`
    }, [])

    const onDragRight = useCallback((px: number) => {
        if (rightRef.current) rightRef.current.style.width = `${px}px`
    }, [])

    return (
        <div className="ide">
            <div className="ide__main">
                <ActivityBar gitChanges={git.changes.length} debugActive={runner.isDebugging} />

                <aside ref={sideRef} className="ide__side" style={{ width: sidebarWidth }} hidden={!sidebarOpen} aria-label="Side bar">
                    <SidePanel
                        panel={sidePanel}
                        visible={active && sidebarOpen}
                        folder={folder}
                        indexFiles={index.files}
                        activePath={files.activePath}
                        reveal={reveal}
                        onRevealed={() => setReveal(null)}
                        git={git}
                        buffers={files}
                        runner={runner}
                        onOpenFile={files.openFile}
                        onOpenFolder={actions.openFolder}
                        onCloseFolder={actions.closeFolder}
                        onRenamed={files.renamePath}
                        onDeleted={files.handleDeleted}
                    />
                </aside>
                {sidebarOpen && (
                    <Resizer
                        axis="x"
                        direction={1}
                        label="Resize side bar"
                        value={sidebarWidth}
                        min={LAYOUT_LIMITS.sidebar.min}
                        max={LAYOUT_LIMITS.sidebar.max}
                        defaultValue={LAYOUT_LIMITS.sidebar.default}
                        onDrag={onDragSide}
                        onChange={setSidebarWidth}
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
                                focusedPane={focusedPane}
                                secondaryPath={secondaryPath}
                                onSecondaryPathChange={setSecondaryPath}
                                onFocusPane={setFocusedPane}
                                onOpenFolder={actions.openFolder}
                                onRevealDirectory={revealDirectory}
                                onRevealFile={revealFile}
                                onActivateEditor={handleActivateEditor}
                                runEditorAction={runEditorAction}
                            />
                        )}
                    </RegionBoundary>
                    <BottomPanel folder={folder} runner={runner} active={active} />
                </div>

                {rightOpen && (
                    <Resizer
                        axis="x"
                        direction={-1}
                        label="Resize agent panel"
                        value={rightWidth}
                        min={LAYOUT_LIMITS.right.min}
                        max={LAYOUT_LIMITS.right.max}
                        defaultValue={LAYOUT_LIMITS.right.default}
                        onDrag={onDragRight}
                        onChange={setRightWidth}
                        panelRef={rightRef}
                    />
                )}
                <aside ref={rightRef} className="ide__right" style={{ width: rightWidth }} hidden={!rightOpen} aria-label="Agent and team">
                    <RegionBoundary name="Agent panel">
                        <AgentPanel
                            space={space}
                            folder={folder}
                            files={index.files}
                            canUseAgent={canUseAgent}
                            visible={active && rightOpen}
                        />
                    </RegionBoundary>
                </aside>
            </div>

            <RegionBoundary name="Status bar" compact>
                <StatusBar
                    spaceId={space.id}
                    git={git}
                    runner={runner}
                    hasFile={!!focusedFile}
                    canEdit={canEdit}
                    dirtyCount={files.files.filter(f => f.isDirty).length}
                    onGoToLine={() => runEditorAction('editor.action.gotoLine')}
                    onChangeLanguage={handleChangeLanguage}
                    onChangeEol={handleChangeEol}
                />
            </RegionBoundary>
        </div>
    )
}

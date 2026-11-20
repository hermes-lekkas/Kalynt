/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Lock, X } from 'lucide-react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useLayoutStore } from '../../../stores/layoutStore'
import { IconButton, Menu, Resizer, Spinner, useMenuAnchor } from '../../ui'
import type { OpenFilesApi } from '../hooks/useOpenFiles'
import type { RunnerApi } from '../hooks/useRunner'
import { FileGlyph } from '../explorer/fileIcons'
import { useInlineCompletions } from './inlineCompletions'
import { EditorTabs } from './EditorTabs'
import { Breadcrumbs } from './Breadcrumbs'
import { EditorToolbar } from './EditorToolbar'
import { EditorEmpty } from './EditorEmpty'
import { dirName, relativePath } from '../languages'

const CodeEditor = lazy(() => import('./CodeEditor'))

export type EditorPaneId = 'primary' | 'secondary'

interface EditorAreaProps {
    files: OpenFilesApi
    runner: RunnerApi
    folder: string | null
    canEdit: boolean
    focusedPane: EditorPaneId
    secondaryPath: string | null
    onSecondaryPathChange: (path: string | null) => void
    onFocusPane: (pane: EditorPaneId) => void
    onOpenFolder: () => void
    onRevealDirectory: (path: string) => void
    onRevealFile: (path: string) => void
    onActivateEditor: (editor: MonacoEditor.IStandaloneCodeEditor, pane: EditorPaneId, path: string) => void
    runEditorAction: (actionId: string) => void
}

export function EditorArea({
    files,
    runner,
    folder,
    canEdit,
    focusedPane,
    secondaryPath,
    onSecondaryPathChange,
    onFocusPane,
    onOpenFolder,
    onRevealDirectory,
    onRevealFile,
    onActivateEditor,
    runEditorAction
}: EditorAreaProps) {
    // Register AI inline completion provider ONCE at EditorArea level (never per CodeEditor instance).
    useInlineCompletions()

    const splitEditor = useLayoutStore(s => s.splitEditor)
    const splitRatio = useLayoutStore(s => s.splitRatio)
    const setEditorPref = useLayoutStore(s => s.setEditorPref)

    const [dragRatio, setDragRatio] = useState<number | null>(null)
    const [width, setWidth] = useState(0)
    const panesRef = useRef<HTMLDivElement>(null)
    const secondaryPicker = useMenuAnchor()

    const active = files.activeFile
    // Allow splitting even with 1 file open (same file side-by-side).
    const showSplit = splitEditor && !!active

    // Keep the secondary pane pointed at a valid open file, permitting same-file splits.
    useEffect(() => {
        if (!showSplit) return
        const stillOpen = secondaryPath !== null && files.files.some(f => f.path === secondaryPath)
        if (!stillOpen) {
            const other = files.files.find(f => f.path !== files.activePath)
            onSecondaryPathChange(other?.path ?? files.activePath ?? null)
        }
    }, [showSplit, files.files, files.activePath, secondaryPath, onSecondaryPathChange])

    // If split closes while secondary had focus, return focus tracking to primary.
    useEffect(() => {
        if (!showSplit && focusedPane === 'secondary') {
            onFocusPane('primary')
        }
    }, [showSplit, focusedPane, onFocusPane])

    const secondary = showSplit ? files.files.find(f => f.path === secondaryPath) ?? null : null
    const liveRatio = dragRatio ?? splitRatio

    useEffect(() => {
        const el = panesRef.current
        if (!el) return
        setWidth(Math.round(el.getBoundingClientRect().width))
        const observer = new ResizeObserver(entries => setWidth(Math.round(entries[0].contentRect.width)))
        observer.observe(el)
        return () => observer.disconnect()
    }, [active === null])

    const handleSplitWith = useCallback((path: string) => {
        onSecondaryPathChange(path)
        setEditorPref({ splitEditor: true })
        onFocusPane('secondary')
    }, [onSecondaryPathChange, setEditorPref, onFocusPane])

    const handleCloseSplit = useCallback(() => {
        setEditorPref({ splitEditor: false })
        onFocusPane('primary')
    }, [setEditorPref, onFocusPane])

    if (!active) {
        return (
            <section className="editor-area" aria-label="Editor">
                <EditorEmpty hasFolder={!!folder} onOpenFolder={onOpenFolder} />
            </section>
        )
    }

    const editorFor = (file: typeof active, pane: EditorPaneId) => (
        <Suspense fallback={<div className="editor-pane__loading"><Spinner label="Loading editor" /></div>}>
            <CodeEditor
                file={file}
                readOnly={!canEdit}
                isFocused={!secondary || focusedPane === pane}
                breakpoints={runner.breakpoints.get(file.path) ?? []}
                reveal={(!secondary || focusedPane === pane) ? files.reveal : null}
                onChange={files.updateContent}
                onToggleBreakpoint={runner.toggleBreakpoint}
                onRevealed={files.clearReveal}
                onActivate={ed => onActivateEditor(ed, pane, file.path)}
                onFocusPane={() => onFocusPane(pane)}
            />
        </Suspense>
    )

    const primaryFocused = !secondary || focusedPane === 'primary'
    const secondaryFocused = !!secondary && focusedPane === 'secondary'

    return (
        <section className="editor-area" aria-label="Editor">
            <div className="editor-area__panes" ref={panesRef}>
                <div
                    className={`editor-pane ${secondary && primaryFocused ? 'is-focused' : ''}`}
                    style={secondary ? { flex: `0 0 ${liveRatio * 100}%` } : undefined}
                    onMouseDown={() => { if (focusedPane !== 'primary') onFocusPane('primary') }}
                >
                    <EditorTabs
                        files={files.files}
                        activePath={files.activePath}
                        folder={folder}
                        onSelect={path => { onFocusPane('primary'); files.setActivePath(path) }}
                        onClose={path => { void files.closeFile(path) }}
                        onCloseOthers={path => { void files.closeMany(path) }}
                        onCloseToRight={path => { void files.closeToRight(path) }}
                        onCloseSaved={files.closeSaved}
                        onCloseAll={() => { void files.closeMany() }}
                        onReorder={files.reorderFiles}
                        onSplitWith={handleSplitWith}
                        onReveal={onRevealFile}
                    />
                    <div className="editor-area__bar">
                        <Breadcrumbs path={active.path} folder={folder} onRevealDirectory={onRevealDirectory} />
                        {!canEdit && (
                            <span className="editor-area__readonly" title="Your role in this workspace is read-only">
                                <Lock size={12} aria-hidden /> Read only
                            </span>
                        )}
                        <EditorToolbar
                            runner={runner}
                            language={active.language}
                            hasFolder={!!folder}
                            canSplit={files.files.length > 0}
                            runEditorAction={runEditorAction}
                        />
                    </div>
                    <div className="editor-pane__body">{editorFor(active, 'primary')}</div>
                </div>

                {secondary && (
                    <>
                        <Resizer
                            axis="x"
                            direction={1}
                            label="Resize split editor"
                            value={Math.round(liveRatio * Math.max(width, 1))}
                            min={Math.round(Math.max(width, 1) * 0.2)}
                            max={Math.round(Math.max(width, 1) * 0.8)}
                            defaultValue={Math.round(Math.max(width, 1) / 2)}
                            onDrag={px => { if (width > 0) setDragRatio(px / width) }}
                            onChange={px => {
                                setDragRatio(null)
                                setEditorPref({ splitRatio: width > 0 ? px / width : 0.5 })
                            }}
                        />
                        <div
                            className={`editor-pane editor-pane--secondary ${secondaryFocused ? 'is-focused' : ''}`}
                            onMouseDown={() => { if (focusedPane !== 'secondary') onFocusPane('secondary') }}
                        >
                            <div className="editor-pane__tabs" role="region" aria-label="Split editor header">
                                <button
                                    type="button"
                                    className={`editor-pane__tab ${secondaryFocused ? 'is-active' : ''} ${secondary.isDirty ? 'is-dirty' : ''}`}
                                    onClick={secondaryPicker.toggle}
                                    aria-haspopup="menu"
                                    aria-expanded={secondaryPicker.open}
                                    title={relativePath(secondary.path, folder)}
                                >
                                    <FileGlyph name={secondary.name} size={14} className="editor-tab__icon" />
                                    <span className="editor-tab__name">{secondary.name}</span>
                                    {secondary.isDirty && <span className="editor-pane__dirty-dot" aria-label="Unsaved changes" />}
                                    <ChevronDown size={13} className="editor-pane__chevron" aria-hidden />
                                </button>
                                <Menu
                                    open={secondaryPicker.open}
                                    anchor={secondaryPicker.anchor}
                                    onClose={secondaryPicker.close}
                                    placement="bottom-start"
                                    width={260}
                                    ariaLabel="Select file for split pane"
                                    items={files.files.map(f => ({
                                        label: f.name,
                                        hint: f.isDirty ? 'unsaved' : relativePath(dirName(f.path), folder) || undefined,
                                        icon: <FileGlyph name={f.name} size={14} />,
                                        checked: f.path === secondary.path,
                                        onSelect: () => {
                                            onSecondaryPathChange(f.path)
                                            onFocusPane('secondary')
                                        }
                                    }))}
                                />
                                <div className="editor-pane__tabs-actions">
                                    <IconButton
                                        size="sm"
                                        label="Close split editor"
                                        icon={<X size={14} />}
                                        onClick={handleCloseSplit}
                                    />
                                </div>
                            </div>
                            <div className="editor-area__bar editor-area__bar--secondary">
                                <Breadcrumbs path={secondary.path} folder={folder} onRevealDirectory={onRevealDirectory} />
                            </div>
                            <div className="editor-pane__body">{editorFor(secondary, 'secondary')}</div>
                        </div>
                    </>
                )}
            </div>
        </section>
    )
}

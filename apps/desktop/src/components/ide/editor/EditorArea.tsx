/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Lock } from 'lucide-react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useLayoutStore } from '../../../stores/layoutStore'
import { Resizer, Select, Spinner } from '../../ui'
import type { OpenFilesApi } from '../hooks/useOpenFiles'
import type { RunnerApi } from '../hooks/useRunner'
import { EditorTabs } from './EditorTabs'
import { Breadcrumbs } from './Breadcrumbs'
import { EditorToolbar } from './EditorToolbar'
import { EditorEmpty } from './EditorEmpty'
import { relativePath } from '../languages'

const CodeEditor = lazy(() => import('./CodeEditor'))

interface EditorAreaProps {
    files: OpenFilesApi
    runner: RunnerApi
    folder: string | null
    canEdit: boolean
    onOpenFolder: () => void
    onRevealDirectory: (path: string) => void
    onRevealFile: (path: string) => void
    onActivateEditor: (editor: MonacoEditor.IStandaloneCodeEditor) => void
    runEditorAction: (actionId: string) => void
}

export function EditorArea({
    files, runner, folder, canEdit, onOpenFolder, onRevealDirectory, onRevealFile, onActivateEditor, runEditorAction
}: EditorAreaProps) {
    const { splitEditor, splitRatio, setEditorPref } = useLayoutStore()
    const [secondaryPath, setSecondaryPath] = useState<string | null>(null)
    const [width, setWidth] = useState(0)
    const panesRef = useRef<HTMLDivElement>(null)
    const active = files.activeFile
    const showSplit = splitEditor && files.files.length > 1

    // Keep the second pane on a different, still-open file.
    useEffect(() => {
        if (!showSplit) return
        const stillOpen = files.files.some(f => f.path === secondaryPath)
        if (!stillOpen || secondaryPath === files.activePath) {
            const next = files.files.find(f => f.path !== files.activePath)
            setSecondaryPath(next?.path ?? null)
        }
    }, [showSplit, files.files, files.activePath, secondaryPath])

    const secondary = showSplit ? files.files.find(f => f.path === secondaryPath) ?? null : null

    useEffect(() => {
        const el = panesRef.current
        if (!el) return
        const observer = new ResizeObserver(entries => setWidth(Math.round(entries[0].contentRect.width)))
        observer.observe(el)
        return () => observer.disconnect()
    }, [active === null])

    if (!active) {
        return (
            <section className="editor-area" aria-label="Editor">
                <EditorEmpty hasFolder={!!folder} onOpenFolder={onOpenFolder} />
            </section>
        )
    }

    const editorFor = (file: typeof active) => (
        <Suspense fallback={<div className="editor-pane__loading"><Spinner label="Loading editor" /></div>}>
            <CodeEditor
                file={file}
                readOnly={!canEdit}
                breakpoints={runner.breakpoints.get(file.path) ?? []}
                reveal={files.reveal}
                onChange={files.updateContent}
                onToggleBreakpoint={runner.toggleBreakpoint}
                onRevealed={files.clearReveal}
                onActivate={onActivateEditor}
            />
        </Suspense>
    )

    return (
        <section className="editor-area" aria-label="Editor">
            <EditorTabs
                files={files.files}
                activePath={files.activePath}
                folder={folder}
                onSelect={files.setActivePath}
                onClose={path => { files.closeFile(path) }}
                onCloseOthers={path => { files.closeMany(path) }}
                onCloseAll={() => { files.closeMany() }}
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
                    canSplit={files.files.length > 1}
                    runEditorAction={runEditorAction}
                />
            </div>
            <div className="editor-area__panes" ref={panesRef}>
                <div className="editor-pane" style={secondary ? { width: `${splitRatio * 100}%` } : undefined}>
                    {editorFor(active)}
                </div>
                {secondary && (
                    <>
                        <Resizer
                            axis="x"
                            direction={1}
                            label="Resize split editor"
                            value={Math.round(splitRatio * Math.max(width, 1))}
                            min={Math.round(width * 0.25)}
                            max={Math.round(width * 0.75)}
                            defaultValue={Math.round(width / 2)}
                            onChange={px => setEditorPref({ splitRatio: width ? px / width : 0.5 })}
                        />
                        <div className="editor-pane editor-pane--secondary">
                            <div className="editor-pane__head">
                                <Select
                                    size="sm"
                                    aria-label="File in the second pane"
                                    value={secondary.path}
                                    onChange={e => setSecondaryPath(e.target.value)}
                                >
                                    {files.files.map(f => (
                                        <option key={f.path} value={f.path}>{relativePath(f.path, folder)}{f.isDirty ? ' (unsaved)' : ''}</option>
                                    ))}
                                </Select>
                            </div>
                            <div className="editor-pane__body">{editorFor(secondary)}</div>
                        </div>
                    </>
                )}
            </div>
        </section>
    )
}

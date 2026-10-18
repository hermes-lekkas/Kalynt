/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Monaco editor bound to one open file. Each file gets its own model (keyed
 * by its file URI) so undo history and scroll position survive tab switches.
 * Loaded lazily: importing this module loads Monaco.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useAppStore } from '../../../stores/appStore'
import { useLayoutStore } from '../../../stores/layoutStore'
import { useEditorStatusStore } from '../../../stores/editorStatusStore'
import type { OpenFile } from '../../../types/ide'
import { Spinner } from '../../ui'
import { monaco, EDITOR_THEMES } from './monacoSetup'
import { useInlineCompletions } from './inlineCompletions'
import type { RevealRequest } from '../hooks/useOpenFiles'

export interface CodeEditorProps {
    file: OpenFile
    readOnly?: boolean
    breakpoints: number[]
    reveal: RevealRequest | null
    onChange: (path: string, value: string) => void
    onToggleBreakpoint: (path: string, line: number) => void
    onRevealed: () => void
    /** Receives the editor when it mounts or gains focus, for commands like Format. */
    onActivate: (editor: MonacoEditor.IStandaloneCodeEditor) => void
}

export function modelUri(path: string): string {
    return monaco.Uri.file(path).toString()
}

/** Frees the Monaco model of a closed file. */
export function disposeModel(path: string) {
    monaco.editor.getModel(monaco.Uri.file(path))?.dispose()
}

function useMonacoOptions(readOnly: boolean): MonacoEditor.IStandaloneEditorConstructionOptions {
    const { wordWrap, minimap, stickyScroll, editorFontSize } = useLayoutStore()
    const [perf, setPerf] = useState<Record<string, unknown>>(() => {
        try { return JSON.parse(localStorage.getItem('kalynt-monaco-optimization') || '{}') } catch { return {} }
    })

    // The main process may ask for lighter editor settings under memory pressure.
    useEffect(() => {
        const onOptimize = (e: Event) => setPerf((e as CustomEvent).detail ?? {})
        window.addEventListener('kalynt-monaco-optimize', onOptimize)
        return () => window.removeEventListener('kalynt-monaco-optimize', onOptimize)
    }, [])

    return {
        readOnly,
        fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
        fontSize: editorFontSize,
        lineHeight: Math.round(editorFontSize * 1.6),
        fontLigatures: true,
        wordWrap: wordWrap ? 'on' : 'off',
        minimap: { enabled: minimap, renderCharacters: false, scale: 1 },
        stickyScroll: { enabled: stickyScroll },
        glyphMargin: true,
        lineNumbersMinChars: 3,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        renderLineHighlight: 'line',
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: 'active', indentation: true },
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        smoothScrolling: true,
        padding: { top: 8, bottom: 8 },
        inlineSuggest: { enabled: true },
        quickSuggestions: true,
        suggestOnTriggerCharacters: true,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        overviewRulerBorder: false,
        ...perf
    }
}

export default function CodeEditor({
    file, readOnly = false, breakpoints, reveal, onChange, onToggleBreakpoint, onRevealed, onActivate
}: CodeEditorProps) {
    const theme = useAppStore(s => s.theme)
    const options = useMonacoOptions(readOnly)
    const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
    const decorations = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null)
    const fileRef = useRef(file)
    fileRef.current = file
    const handlers = useRef({ onToggleBreakpoint, onActivate })
    handlers.current = { onToggleBreakpoint, onActivate }
    useInlineCompletions()

    const reportCursor = useCallback((ed: MonacoEditor.IStandaloneCodeEditor) => {
        const position = ed.getPosition()
        const selection = ed.getSelection()
        const length = selection ? ed.getModel()?.getValueLengthInRange(selection) ?? 0 : 0
        if (position) useEditorStatusStore.getState().setCursor(position.lineNumber, position.column, length)
    }, [])

    const handleMount: OnMount = (ed) => {
        editorRef.current = ed
        decorations.current = ed.createDecorationsCollection([])
        handlers.current.onActivate(ed)
        useEditorStatusStore.getState().setLanguage(fileRef.current.language)
        reportCursor(ed)

        ed.onDidFocusEditorText(() => {
            handlers.current.onActivate(ed)
            useEditorStatusStore.getState().setLanguage(fileRef.current.language)
            reportCursor(ed)
        })
        ed.onDidChangeCursorSelection(() => { if (ed.hasTextFocus()) reportCursor(ed) })
        // Switching tabs swaps the model; report the new file's cursor right away.
        ed.onDidChangeModel(() => {
            useEditorStatusStore.getState().setLanguage(fileRef.current.language)
            reportCursor(ed)
        })
        ed.onMouseDown(e => {
            if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
                handlers.current.onToggleBreakpoint(fileRef.current.path, e.target.position.lineNumber)
            }
        })
    }

    useEffect(() => {
        decorations.current?.set(breakpoints.map(line => ({
            range: new monaco.Range(line, 1, line, 1),
            options: {
                isWholeLine: false,
                glyphMarginClassName: 'ide-breakpoint',
                glyphMarginHoverMessage: { value: 'Breakpoint. Click to remove.' },
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
            }
        })))
    }, [breakpoints, file.path])

    useEffect(() => {
        const ed = editorRef.current
        if (!ed || !reveal || reveal.path !== file.path) return
        const frame = requestAnimationFrame(() => {
            ed.revealLineInCenter(reveal.line)
            ed.setPosition({ lineNumber: reveal.line, column: 1 })
            ed.focus()
            onRevealed()
        })
        return () => cancelAnimationFrame(frame)
    }, [reveal, file.path, onRevealed])

    return (
        <Editor
            height="100%"
            path={modelUri(file.path)}
            language={file.language}
            value={file.content}
            theme={theme === 'light' ? EDITOR_THEMES.light : EDITOR_THEMES.dark}
            options={options}
            keepCurrentModel
            onMount={handleMount}
            onChange={value => { if (value !== undefined) onChange(fileRef.current.path, value) }}
            loading={<Spinner label="Loading editor" />}
        />
    )
}

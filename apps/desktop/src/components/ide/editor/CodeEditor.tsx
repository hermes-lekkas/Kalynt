/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Monaco editor bound to one open file. Each file gets its own model (keyed
 * by its file URI) so undo history and scroll position survive tab switches.
 * Loaded lazily: importing this module loads Monaco.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditor, IDisposable } from 'monaco-editor'
import { useAppStore } from '../../../stores/appStore'
import { useLayoutStore } from '../../../stores/layoutStore'
import { useEditorStatusStore, type LineEnding } from '../../../stores/editorStatusStore'
import type { OpenFile } from '../../../types/ide'
import { Spinner } from '../../ui'
import { monaco, EDITOR_THEMES } from './monacoSetup'
import { isCancellationError } from './monacoReliability'
import type { RevealRequest } from '../hooks/useOpenFiles'
import { samePath } from '../languages'

export interface CodeEditorProps {
    file: OpenFile
    readOnly?: boolean
    /** True when this editor pane is the focused pane (receives goto/insert events). */
    isFocused?: boolean
    breakpoints: number[]
    reveal: RevealRequest | null
    onChange: (path: string, value: string) => void
    onToggleBreakpoint: (path: string, line: number) => void
    onRevealed: () => void
    /** Receives the editor when it mounts or gains focus, for commands like Format. */
    onActivate: (editor: MonacoEditor.IStandaloneCodeEditor) => void
    /** Called when this editor gains keyboard focus. */
    onFocusPane?: () => void
}

interface DebugLocation {
    path: string
    line: number
}

const DEFAULT_FONT_FAMILY = "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace"

export function modelUri(path: string): string {
    return monaco.Uri.file(path).toString()
}

function isModelAttachedToAnyEditor(model: MonacoEditor.ITextModel): boolean {
    const editors = monaco.editor.getEditors?.() ?? []
    return editors.some(ed => ed.getModel() === model)
}

/**
 * Frees the Monaco model of a closed file once no live editor pane references it.
 * Deferring disposal across the current tick avoids disposing a model out from
 * under a split pane or unmounting editor during tab-close / workspace-switch.
 */
export function disposeModel(path: string) {
    const uri = monaco.Uri.file(path)
    const model = monaco.editor.getModel(uri)
    if (!model || model.isDisposed()) return
    if (!isModelAttachedToAnyEditor(model)) {
        model.dispose()
        return
    }
    setTimeout(() => {
        const current = monaco.editor.getModel(uri)
        if (!current || current.isDisposed()) return
        if (!isModelAttachedToAnyEditor(current)) {
            current.dispose()
        }
    }, 0)
}

function useMonacoOptions(readOnly: boolean): MonacoEditor.IStandaloneEditorConstructionOptions {
    const wordWrap = useLayoutStore(s => s.wordWrap)
    const minimap = useLayoutStore(s => s.minimap)
    const stickyScroll = useLayoutStore(s => s.stickyScroll)
    const editorFontSize = useLayoutStore(s => s.editorFontSize)
    const tabSize = useLayoutStore(s => s.tabSize)
    const insertSpaces = useLayoutStore(s => s.insertSpaces)
    const lineNumbers = useLayoutStore(s => s.lineNumbers)
    const renderWhitespace = useLayoutStore(s => s.renderWhitespace)
    const fontFamily = useLayoutStore(s => s.fontFamily)
    const [perf, setPerf] = useState<Record<string, unknown>>({})

    // The main process may ask for lighter editor settings under memory pressure (session-only).
    useEffect(() => {
        const onOptimize = (e: Event) => setPerf((e as CustomEvent).detail ?? {})
        window.addEventListener('kalynt-monaco-optimize', onOptimize)
        return () => window.removeEventListener('kalynt-monaco-optimize', onOptimize)
    }, [])

    return useMemo<MonacoEditor.IStandaloneEditorConstructionOptions>(() => ({
        readOnly,
        fontFamily: fontFamily.trim() || DEFAULT_FONT_FAMILY,
        fontSize: editorFontSize,
        lineHeight: Math.round(editorFontSize * 1.6),
        fontLigatures: true,
        wordWrap: wordWrap ? 'on' : 'off',
        minimap: { enabled: minimap, renderCharacters: false, scale: 1 },
        stickyScroll: { enabled: stickyScroll },
        lineNumbers,
        renderWhitespace,
        glyphMargin: true,
        lineNumbersMinChars: 3,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize,
        insertSpaces,
        detectIndentation: false,
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
    }), [readOnly, fontFamily, editorFontSize, wordWrap, minimap, stickyScroll, lineNumbers, renderWhitespace, tabSize, insertSpaces, perf])
}

export default function CodeEditor({
    file, readOnly = false, isFocused = true, breakpoints, reveal, onChange, onToggleBreakpoint, onRevealed, onActivate, onFocusPane
}: CodeEditorProps) {
    const resolvedTheme = useAppStore(s => s.resolvedTheme)
    const tabSize = useLayoutStore(s => s.tabSize)
    const insertSpaces = useLayoutStore(s => s.insertSpaces)
    const options = useMonacoOptions(readOnly)
    const [editorReady, setEditorReady] = useState(false)
    const [debugLocation, setDebugLocation] = useState<DebugLocation | null>(null)

    const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
    const decorations = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null)
    const debugDecorations = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null)
    const disposablesRef = useRef<IDisposable[]>([])
    const fileRef = useRef(file)
    fileRef.current = file
    const readOnlyRef = useRef(readOnly)
    readOnlyRef.current = readOnly
    const isFocusedRef = useRef(isFocused)
    isFocusedRef.current = isFocused
    const handlers = useRef({ onToggleBreakpoint, onActivate, onFocusPane })
    handlers.current = { onToggleBreakpoint, onActivate, onFocusPane }

    const reportModelStatus = useCallback((ed: MonacoEditor.IStandaloneCodeEditor) => {
        const position = ed.getPosition()
        const selection = ed.getSelection()
        const model = ed.getModel()
        const length = selection && model ? model.getValueLengthInRange(selection) : 0
        const store = useEditorStatusStore.getState()
        if (position) store.setCursor(position.lineNumber, position.column, length)
        if (model) {
            const eol: LineEnding = model.getEndOfLineSequence() === monaco.editor.EndOfLineSequence.CRLF ? 'CRLF' : 'LF'
            store.setEol(eol)
        }
        store.setLanguage(fileRef.current.language)
        store.setActivePath(fileRef.current.path)
    }, [])

    const disposeListeners = useCallback(() => {
        disposablesRef.current.forEach(d => d.dispose())
        disposablesRef.current = []
    }, [])

    useEffect(() => () => {
        disposeListeners()
        decorations.current?.clear()
        debugDecorations.current?.clear()
        decorations.current = null
        debugDecorations.current = null
        editorRef.current = null
    }, [disposeListeners])

    const handleMount: OnMount = (ed) => {
        disposeListeners()
        editorRef.current = ed
        decorations.current = ed.createDecorationsCollection([])
        debugDecorations.current = ed.createDecorationsCollection([])

        const model = ed.getModel()
        if (model) {
            const { tabSize: ts, insertSpaces: ins } = useLayoutStore.getState()
            model.updateOptions({ tabSize: ts, insertSpaces: ins })
        }

        if (isFocusedRef.current) {
            handlers.current.onActivate(ed)
            reportModelStatus(ed)
        }

        disposablesRef.current = [
            ed.onDidFocusEditorText(() => {
                handlers.current.onFocusPane?.()
                handlers.current.onActivate(ed)
                reportModelStatus(ed)
            }),
            ed.onDidChangeCursorSelection(() => {
                if (ed.hasTextFocus()) reportModelStatus(ed)
            }),
            // Switching tabs swaps the model; sync indentation and report the new file's cursor right away.
            ed.onDidChangeModel(() => {
                const nextModel = ed.getModel()
                if (nextModel) {
                    const { tabSize: ts, insertSpaces: ins } = useLayoutStore.getState()
                    nextModel.updateOptions({ tabSize: ts, insertSpaces: ins })
                }
                if (isFocusedRef.current) reportModelStatus(ed)
            }),
            ed.onMouseDown(e => {
                if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
                    handlers.current.onToggleBreakpoint(fileRef.current.path, e.target.position.lineNumber)
                }
            })
        ]

        setEditorReady(true)
    }

    // Keep active model indentation options synced when user changes tabSize / insertSpaces.
    useEffect(() => {
        if (!editorReady) return
        editorRef.current?.getModel()?.updateOptions({ tabSize, insertSpaces })
    }, [editorReady, tabSize, insertSpaces, file.path])

    // Sync language mode updates (e.g. from StatusBar language picker) into the live Monaco model.
    useEffect(() => {
        if (!editorReady) return
        const model = editorRef.current?.getModel()
        if (model && model.getLanguageId() !== file.language) {
            monaco.editor.setModelLanguage(model, file.language)
        }
        if (isFocusedRef.current) {
            useEditorStatusStore.getState().setLanguage(file.language)
        }
    }, [editorReady, file.language, file.path])

    // Breakpoint gutter decorations — depends on editorReady so initial mount always renders them.
    useEffect(() => {
        if (!editorReady) return
        decorations.current?.set(breakpoints.map(line => ({
            range: new monaco.Range(line, 1, line, 1),
            options: {
                isWholeLine: false,
                glyphMarginClassName: 'ide-breakpoint',
                glyphMarginHoverMessage: { value: 'Breakpoint. Click to remove.' },
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
            }
        })))
    }, [editorReady, breakpoints, file.path])

    // Active debugger stopped execution line highlight.
    useEffect(() => {
        if (!editorReady) return
        if (!debugLocation || !samePath(debugLocation.path, file.path)) {
            debugDecorations.current?.set([])
            return
        }
        debugDecorations.current?.set([{
            range: new monaco.Range(debugLocation.line, 1, debugLocation.line, 1),
            options: {
                isWholeLine: true,
                className: 'ide-debug-line',
                glyphMarginClassName: 'ide-debug-glyph',
                glyphMarginHoverMessage: { value: 'Current stopped execution line' },
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
            }
        }])
        editorRef.current?.revealLineInCenterIfOutsideViewport(debugLocation.line)
    }, [editorReady, debugLocation, file.path])

    // Reveal requested line + column — depends on editorReady so first mount always jumps cleanly.
    useEffect(() => {
        const ed = editorRef.current
        if (!editorReady || !ed || !reveal || !samePath(reveal.path, file.path)) return
        const frame = requestAnimationFrame(() => {
            if (editorRef.current !== ed || !ed.getModel()) return
            const col = Math.max(1, reveal.column ?? 1)
            ed.revealLineInCenter(reveal.line)
            ed.setPosition({ lineNumber: reveal.line, column: col })
            ed.focus()
            onRevealed()
        })
        return () => cancelAnimationFrame(frame)
    }, [editorReady, reveal, file.path, onRevealed])

    // Custom window events: goto line, goto symbol, insert at cursor, debug execution line, EOL switch.
    useEffect(() => {
        const onGotoLine = (e: Event) => {
            if (!isFocusedRef.current) return
            const ed = editorRef.current
            const detail = (e as CustomEvent<{ line?: number; column?: number }>).detail
            if (!ed || !detail || typeof detail.line !== 'number' || detail.line < 1) return
            const col = Math.max(1, detail.column ?? 1)
            requestAnimationFrame(() => {
                if (editorRef.current !== ed || !ed.getModel()) return
                ed.revealLineInCenter(detail.line!)
                ed.setPosition({ lineNumber: detail.line!, column: col })
                ed.focus()
            })
        }
        const onGotoSymbol = (e: Event) => {
            if (!isFocusedRef.current) return
            const ed = editorRef.current
            if (!ed) return
            const detail = (e as CustomEvent<{ line?: number; column?: number; name?: string; query?: string }>).detail
            if (detail && typeof detail.line === 'number' && detail.line > 0) {
                const col = Math.max(1, detail.column ?? 1)
                requestAnimationFrame(() => {
                    if (editorRef.current !== ed || !ed.getModel()) return
                    ed.revealLineInCenter(detail.line!)
                    ed.setPosition({ lineNumber: detail.line!, column: col })
                    ed.focus()
                })
                return
            }
            requestAnimationFrame(() => {
                if (editorRef.current !== ed || !ed.getModel()) return
                ed.focus()
                const action = ed.getAction('editor.action.quickOutline')
                if (action) {
                    void Promise.resolve(action.run()).catch(error => {
                        if (!isCancellationError(error)) {
                            console.warn('[CodeEditor] Quick outline failed:', error)
                        }
                    })
                }
            })
        }
        const onInsertAtCursor = (e: Event) => {
            if (e.defaultPrevented || !isFocusedRef.current || readOnlyRef.current) return
            const ed = editorRef.current
            if (!ed) return
            const detail = (e as CustomEvent<{ code?: string; text?: string; language?: string }>).detail
            const text = detail?.code ?? detail?.text
            if (typeof text !== 'string' || !text) return
            const selection = ed.getSelection()
            if (!selection) return
            e.preventDefault()
            ed.executeEdits('kalynt-insert-at-cursor', [{ range: selection, text, forceMoveMarkers: true }])
            ed.pushUndoStop()
            ed.focus()
        }
        const onDebugLocation = (e: Event) => {
            const detail = (e as CustomEvent<DebugLocation | null>).detail
            if (!detail || typeof detail.path !== 'string' || typeof detail.line !== 'number') {
                setDebugLocation(null)
            } else {
                setDebugLocation({ path: detail.path, line: detail.line })
            }
        }
        const onSetEol = (e: Event) => {
            if (!isFocusedRef.current || readOnlyRef.current) return
            const ed = editorRef.current
            const model = ed?.getModel()
            const detail = (e as CustomEvent<{ eol?: LineEnding }>).detail
            if (!model || (detail?.eol !== 'LF' && detail?.eol !== 'CRLF')) return
            const seq = detail.eol === 'CRLF'
                ? monaco.editor.EndOfLineSequence.CRLF
                : monaco.editor.EndOfLineSequence.LF
            model.pushEOL(seq)
            useEditorStatusStore.getState().setEol(detail.eol)
        }

        window.addEventListener('kalynt-goto-line', onGotoLine)
        window.addEventListener('kalynt-goto-symbol', onGotoSymbol)
        window.addEventListener('kalynt-insert-at-cursor', onInsertAtCursor)
        window.addEventListener('kalynt-debug-location', onDebugLocation)
        window.addEventListener('kalynt-set-eol', onSetEol)
        return () => {
            window.removeEventListener('kalynt-goto-line', onGotoLine)
            window.removeEventListener('kalynt-goto-symbol', onGotoSymbol)
            window.removeEventListener('kalynt-insert-at-cursor', onInsertAtCursor)
            window.removeEventListener('kalynt-debug-location', onDebugLocation)
            window.removeEventListener('kalynt-set-eol', onSetEol)
        }
    }, [])

    return (
        <Editor
            height="100%"
            path={modelUri(file.path)}
            language={file.language}
            value={file.content}
            theme={resolvedTheme === 'light' ? EDITOR_THEMES.light : EDITOR_THEMES.dark}
            options={options}
            keepCurrentModel
            onMount={handleMount}
            onChange={value => { if (value !== undefined) onChange(fileRef.current.path, value) }}
            loading={<Spinner label="Loading editor" />}
        />
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Lazy-loaded Monaco DiffEditor wrapper so DiffDialog does not pull Monaco into
 * the initial renderer bundle. Manages diff editor & model ownership explicitly
 * so both models are detached (`setModel(null)`) BEFORE disposal and models
 * belonging to the main CodeEditor are never touched or disposed.
 */
import { useEffect, useMemo, useRef } from 'react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useAppStore } from '../../../stores/appStore'
import { useLayoutStore } from '../../../stores/layoutStore'
import { EDITOR_THEMES, monaco } from '../editor/monacoSetup'
import { mountManagedDiffEditor, type ManagedDiffController } from './monacoDiffLifecycle'

interface MonacoDiffViewProps {
    original: string
    modified: string
    language: string
    sideBySide: boolean
}

export default function MonacoDiffView({ original, modified, language, sideBySide }: MonacoDiffViewProps) {
    const theme = useAppStore(s => s.theme)
    const editorFontSize = useLayoutStore(s => s.editorFontSize)
    const containerRef = useRef<HTMLDivElement>(null)
    const controllerRef = useRef<ManagedDiffController<MonacoEditor.IDiffEditorConstructionOptions> | null>(null)
    const initialRef = useRef({ original, modified, language })
    initialRef.current = { original, modified, language }

    const options = useMemo<MonacoEditor.IDiffEditorConstructionOptions>(() => ({
        readOnly: true,
        originalEditable: false,
        renderSideBySide: sideBySide,
        automaticLayout: true,
        fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
        fontSize: editorFontSize,
        lineHeight: Math.round(editorFontSize * 1.55),
        fontLigatures: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderIndicators: true,
        ignoreTrimWhitespace: false,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        overviewRulerBorder: false
    }), [sideBySide, editorFontSize])

    const optionsRef = useRef(options)
    optionsRef.current = options
    const themeName = theme === 'light' ? EDITOR_THEMES.light : EDITOR_THEMES.dark
    const themeRef = useRef(themeName)
    themeRef.current = themeName

    useEffect(() => {
        const container = containerRef.current
        if (!container) return
        const { original: initOrig, modified: initMod, language: initLang } = initialRef.current
        const controller = mountManagedDiffEditor(monaco, container, {
            original: initOrig,
            modified: initMod,
            language: initLang,
            options: optionsRef.current,
            theme: themeRef.current
        })
        controllerRef.current = controller
        return () => {
            controllerRef.current = null
            controller.dispose()
        }
    }, [])

    useEffect(() => {
        controllerRef.current?.updateContent(original, modified, language)
    }, [original, modified, language])

    useEffect(() => {
        controllerRef.current?.updateOptions(options)
    }, [options])

    useEffect(() => {
        controllerRef.current?.updateTheme(themeName)
    }, [themeName])

    return (
        <div
            ref={containerRef}
            className="git-diff-view__editor"
            style={{ width: '100%', height: '100%' }}
        />
    )
}

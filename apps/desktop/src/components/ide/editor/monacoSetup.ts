/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Loads Monaco from the bundled npm package instead of a CDN so the editor
 * works offline, wires its web workers through Vite, and registers the
 * Kalynt editor themes. Import this module before rendering any editor.
 */
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
        if (label === 'json') return new JsonWorker()
        if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
        if (label === 'typescript' || label === 'javascript') return new TsWorker()
        return new EditorWorker()
    }
}

loader.config({ monaco })

export const EDITOR_THEMES = { dark: 'kalynt-dark', light: 'kalynt-light' } as const

monaco.editor.defineTheme(EDITOR_THEMES.dark, {
    base: 'vs-dark',
    inherit: true,
    rules: [
        { token: 'comment', foreground: '8A8699', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'B69CFF' },
        { token: 'keyword.control', foreground: 'B69CFF' },
        { token: 'storage', foreground: 'B69CFF' },
        { token: 'string', foreground: '8FD3A8' },
        { token: 'number', foreground: 'F0B47C' },
        { token: 'regexp', foreground: 'F0B47C' },
        { token: 'type', foreground: '6FC3DF' },
        { token: 'type.identifier', foreground: '6FC3DF' },
        { token: 'tag', foreground: 'E57FB5' },
        { token: 'attribute.name', foreground: 'E8C27A' },
        { token: 'delimiter', foreground: 'B0ADBD' }
    ],
    colors: {
        'editor.background': '#15141A',
        'editor.foreground': '#E4E2EB',
        'editor.lineHighlightBackground': '#1C1B23',
        'editor.lineHighlightBorder': '#00000000',
        'editor.selectionBackground': '#8B6CFF40',
        'editor.inactiveSelectionBackground': '#8B6CFF24',
        'editor.findMatchBackground': '#E9B44C55',
        'editor.findMatchHighlightBackground': '#E9B44C26',
        'editorCursor.foreground': '#A48DFF',
        'editorLineNumber.foreground': '#4E4B5A',
        'editorLineNumber.activeForeground': '#B0ADBD',
        'editorIndentGuide.background1': '#24232B',
        'editorIndentGuide.activeBackground1': '#3B3946',
        'editorGutter.background': '#15141A',
        'editorWidget.background': '#222129',
        'editorWidget.border': '#3B3946',
        'editorSuggestWidget.background': '#222129',
        'editorSuggestWidget.border': '#3B3946',
        'editorSuggestWidget.selectedBackground': '#312F3B',
        'editorHoverWidget.background': '#222129',
        'editorHoverWidget.border': '#3B3946',
        'editorStickyScroll.background': '#18171E',
        'editorStickyScrollHover.background': '#222129',
        'minimap.background': '#15141A',
        'scrollbarSlider.background': '#3B394666',
        'scrollbarSlider.hoverBackground': '#5E5B6B88',
        'scrollbarSlider.activeBackground': '#5E5B6BAA',
        'editorOverviewRuler.border': '#00000000',
        'focusBorder': '#A48DFF'
    }
})

monaco.editor.defineTheme(EDITOR_THEMES.light, {
    base: 'vs',
    inherit: true,
    rules: [
        { token: 'comment', foreground: '6B6880', fontStyle: 'italic' },
        { token: 'keyword', foreground: '5B3DD9' },
        { token: 'keyword.control', foreground: '5B3DD9' },
        { token: 'storage', foreground: '5B3DD9' },
        { token: 'string', foreground: '1F7A4D' },
        { token: 'number', foreground: 'A3570F' },
        { token: 'type', foreground: '1A6F96' },
        { token: 'type.identifier', foreground: '1A6F96' },
        { token: 'tag', foreground: 'B02A6E' },
        { token: 'attribute.name', foreground: '8A5A00' }
    ],
    colors: {
        'editor.background': '#FFFFFF',
        'editor.foreground': '#1C1B23',
        'editor.lineHighlightBackground': '#F6F5F9',
        'editor.lineHighlightBorder': '#00000000',
        'editor.selectionBackground': '#6A4BE833',
        'editorCursor.foreground': '#5B3DD9',
        'editorLineNumber.foreground': '#A3A0B3',
        'editorLineNumber.activeForeground': '#4A4759',
        'editorIndentGuide.background1': '#EEEDF3',
        'editorIndentGuide.activeBackground1': '#CBC8D6',
        'editorWidget.background': '#FFFFFF',
        'editorWidget.border': '#CBC8D6',
        'editorSuggestWidget.selectedBackground': '#E5E3EE',
        'editorStickyScroll.background': '#FBFAFD',
        'minimap.background': '#FFFFFF',
        'focusBorder': '#6A4BE8'
    }
})

export { monaco }

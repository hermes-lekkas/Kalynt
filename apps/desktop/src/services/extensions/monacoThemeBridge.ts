/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Registers the browser/Electron Monaco theme bridge onto themeService without
 * pulling monaco-editor CSS/font assets into Node-only store unit tests.
 */
import type * as Monaco from 'monaco-editor'
import type { ResolvedTheme } from '../../stores/appStore'
import {
    BUILTIN_MONACO_THEMES,
    mapThemeToMonacoData,
    registerMonacoThemeApplier,
    uiThemeBase,
    type LoadedExtensionTheme
} from './themeService'

let monacoTouched = false

registerMonacoThemeApplier({
    async apply(theme: LoadedExtensionTheme) {
        if (typeof window === 'undefined') return
        try {
            const { monaco, EDITOR_THEMES } = await import('../../components/ide/editor/monacoSetup')
            const base = uiThemeBase(theme.uiTheme)
            const targetName = base === 'light' ? EDITOR_THEMES.light : EDITOR_THEMES.dark
            const data = mapThemeToMonacoData(theme) as Monaco.editor.IStandaloneThemeData
            monaco.editor.defineTheme(targetName, data)
            monaco.editor.defineTheme('kalynt-ext-theme', data)
            monaco.editor.setTheme(targetName)
            monacoTouched = true
        } catch {
            // Headless or test environment without Monaco workers
        }
    },
    async restore(resolvedBase: ResolvedTheme) {
        if (!monacoTouched || typeof window === 'undefined') return
        try {
            const { monaco, EDITOR_THEMES } = await import('../../components/ide/editor/monacoSetup')
            monaco.editor.defineTheme(EDITOR_THEMES.dark, BUILTIN_MONACO_THEMES.dark as Monaco.editor.IStandaloneThemeData)
            monaco.editor.defineTheme(EDITOR_THEMES.light, BUILTIN_MONACO_THEMES.light as Monaco.editor.IStandaloneThemeData)
            monaco.editor.setTheme(resolvedBase === 'light' ? EDITOR_THEMES.light : EDITOR_THEMES.dark)
            monacoTouched = false
        } catch {
            // Headless or test environment
        }
    }
})

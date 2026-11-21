/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Loads Monaco from the bundled npm package instead of a CDN so the editor
 * works offline, wires its web workers through Vite, configures modern TS/JS
 * IntelliSense + workspace type syncing, connects diagnostics & LSP providers,
 * and registers WCAG-legible Kalynt editor themes.
 */
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { attachMonacoDiagnostics } from '../../../stores/diagnosticsStore'
import { lspClient } from '../../../services/lspClient'
import {
    WORKSPACE_TYPE_FILE_RE,
    discoverWorkspaceTypeFilesFromApi,
    installMonacoCancellationHandler,
    isCancellationError,
    normalizeFsPath,
    prioritizeWorkspaceTypeFiles,
    resolveTsConfigBaseUrl,
    stripJsonc
} from './monacoReliability'

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
        'editorLineNumber.foreground': '#7c7890',
        'editorLineNumber.activeForeground': '#D6D3E3',
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
        'editorLineNumber.foreground': '#6e6a82',
        'editorLineNumber.activeForeground': '#2F2C3D',
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

// ---------------------------------------------------------------------------
// TypeScript & JavaScript IntelliSense defaults
// ---------------------------------------------------------------------------
const tsLang = monaco.languages.typescript

const BASE_COMPILER_OPTIONS: monaco.languages.typescript.CompilerOptions = {
    jsx: tsLang.JsxEmit.ReactJSX,
    target: tsLang.ScriptTarget.ESNext,
    module: tsLang.ModuleKind.ESNext,
    moduleResolution: tsLang.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    allowJs: true,
    resolveJsonModule: true,
    noEmit: true,
    allowNonTsExtensions: true,
    isolatedModules: true,
    skipLibCheck: true
}

function applyCompilerOptions(overrides: Partial<monaco.languages.typescript.CompilerOptions> = {}) {
    const merged: monaco.languages.typescript.CompilerOptions = {
        ...BASE_COMPILER_OPTIONS,
        ...overrides,
        noEmit: true,
        allowNonTsExtensions: true
    }
    tsLang.typescriptDefaults.setCompilerOptions(merged)
    tsLang.javascriptDefaults.setCompilerOptions(merged)
}

tsLang.typescriptDefaults.setEagerModelSync(true)
tsLang.javascriptDefaults.setEagerModelSync(true)
tsLang.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false
})
tsLang.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false
})
applyCompilerOptions()

// Wire live Monaco diagnostics feed + non-TS LSP providers + cancellation guard once.
installMonacoCancellationHandler()
attachMonacoDiagnostics(monaco)
lspClient.registerProviders(monaco)

// ---------------------------------------------------------------------------
// Workspace tsconfig.json & extraLib synchronization (bounded & debounced)
// ---------------------------------------------------------------------------
const MAX_EXTRA_LIB_FILES = 140
const MAX_EXTRA_LIB_BYTES = 128 * 1024
const MAX_TOTAL_EXTRA_LIB_BYTES = 4 * 1024 * 1024
const EXTRA_LIB_DEBOUNCE_MS = 320

let syncGeneration = 0
let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null
let activeExtraLibs: monaco.IDisposable[] = []
const fileExtraLibs = new Map<string, monaco.IDisposable[]>()

function mapJsxEmit(value?: unknown): monaco.languages.typescript.JsxEmit | undefined {
    switch (String(value ?? '').toLowerCase()) {
        case 'preserve': return tsLang.JsxEmit.Preserve
        case 'react': return tsLang.JsxEmit.React
        case 'react-native': return tsLang.JsxEmit.ReactNative
        case 'react-jsx': return tsLang.JsxEmit.ReactJSX
        case 'react-jsxdev': return tsLang.JsxEmit.ReactJSXDev
        case 'none': return tsLang.JsxEmit.None
        default: return undefined
    }
}

function mapScriptTarget(value?: unknown): monaco.languages.typescript.ScriptTarget | undefined {
    switch (String(value ?? '').toLowerCase()) {
        case 'es5': return tsLang.ScriptTarget.ES5
        case 'es6':
        case 'es2015': return tsLang.ScriptTarget.ES2015
        case 'es2016': return tsLang.ScriptTarget.ES2016
        case 'es2017': return tsLang.ScriptTarget.ES2017
        case 'es2018': return tsLang.ScriptTarget.ES2018
        case 'es2019': return tsLang.ScriptTarget.ES2019
        case 'es2020': return tsLang.ScriptTarget.ES2020
        case 'esnext': return tsLang.ScriptTarget.ESNext
        default: return undefined
    }
}

function mapModuleKind(value?: unknown): monaco.languages.typescript.ModuleKind | undefined {
    switch (String(value ?? '').toLowerCase()) {
        case 'commonjs': return tsLang.ModuleKind.CommonJS
        case 'amd': return tsLang.ModuleKind.AMD
        case 'umd': return tsLang.ModuleKind.UMD
        case 'system': return tsLang.ModuleKind.System
        case 'es6':
        case 'es2015': return tsLang.ModuleKind.ES2015
        case 'es2020':
        case 'es2022':
        case 'esnext':
        case 'nodenext':
        case 'preserve': return tsLang.ModuleKind.ESNext
        default: return undefined
    }
}

function mapTsConfigOptions(
    raw: Record<string, unknown>,
    folder: string
): Partial<monaco.languages.typescript.CompilerOptions> {
    const out: Partial<monaco.languages.typescript.CompilerOptions> = {}
    const jsx = mapJsxEmit(raw.jsx)
    if (jsx !== undefined) out.jsx = jsx
    const target = mapScriptTarget(raw.target)
    if (target !== undefined) out.target = target
    const mod = mapModuleKind(raw.module)
    if (mod !== undefined) out.module = mod
    if (typeof raw.strict === 'boolean') out.strict = raw.strict
    if (typeof raw.allowJs === 'boolean') out.allowJs = raw.allowJs
    if (typeof raw.checkJs === 'boolean') out.checkJs = raw.checkJs
    if (typeof raw.esModuleInterop === 'boolean') out.esModuleInterop = raw.esModuleInterop
    if (typeof raw.allowSyntheticDefaultImports === 'boolean') {
        out.allowSyntheticDefaultImports = raw.allowSyntheticDefaultImports
    }
    if (typeof raw.resolveJsonModule === 'boolean') out.resolveJsonModule = raw.resolveJsonModule
    if (typeof raw.experimentalDecorators === 'boolean') out.experimentalDecorators = raw.experimentalDecorators
    if (typeof raw.useDefineForClassFields === 'boolean') out.useDefineForClassFields = raw.useDefineForClassFields
    if (Array.isArray(raw.lib)) {
        out.lib = raw.lib.filter((entry): entry is string => typeof entry === 'string')
    }
    let hasPaths = false
    if (raw.paths && typeof raw.paths === 'object' && !Array.isArray(raw.paths)) {
        const paths: Record<string, string[]> = {}
        for (const [alias, targets] of Object.entries(raw.paths as Record<string, unknown>)) {
            if (Array.isArray(targets)) {
                paths[alias] = targets.filter((t): t is string => typeof t === 'string')
            }
        }
        if (Object.keys(paths).length > 0) {
            out.paths = paths
            hasPaths = true
        }
    }
    const resolvedBaseUrl = resolveTsConfigBaseUrl(
        folder,
        raw.baseUrl,
        hasPaths,
        fsPath => monaco.Uri.file(fsPath).toString()
    )
    if (resolvedBaseUrl) {
        out.baseUrl = resolvedBaseUrl
    }
    return out
}

function disposeWorkspaceExtraLibs(): void {
    activeExtraLibs.forEach(d => d.dispose())
    activeExtraLibs = []
    fileExtraLibs.forEach(list => list.forEach(d => d.dispose()))
    fileExtraLibs.clear()
}

async function discoverWorkspaceTypeFiles(folder: string): Promise<string[]> {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    return discoverWorkspaceTypeFilesFromApi(folder, api, MAX_EXTRA_LIB_FILES * 2)
}

async function runWorkspaceTypeSync(folder: string, generation: number): Promise<void> {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    if (!api?.fs?.readFile) return

    const normalizedRoot = normalizeFsPath(folder)

    // 1. Read tsconfig.json (or jsconfig.json) compilerOptions if present.
    let overrides: Partial<monaco.languages.typescript.CompilerOptions> = {}
    for (const configFile of ['tsconfig.json', 'jsconfig.json']) {
        const cfgRes = await api.fs.readFile(`${normalizedRoot}/${configFile}`).catch(() => null)
        if (generation !== syncGeneration) return
        if (cfgRes?.success && typeof cfgRes.content === 'string') {
            try {
                const parsed = JSON.parse(stripJsonc(cfgRes.content)) as { compilerOptions?: Record<string, unknown> }
                if (parsed?.compilerOptions && typeof parsed.compilerOptions === 'object') {
                    overrides = mapTsConfigOptions(parsed.compilerOptions, normalizedRoot)
                }
            } catch {
                // Invalid tsconfig; fall back cleanly to defaults.
            }
            break
        }
    }
    if (generation !== syncGeneration) return
    applyCompilerOptions(overrides)

    // 2. Sync bounded workspace TS/JS files via addExtraLib.
    const candidates = await discoverWorkspaceTypeFiles(normalizedRoot)
    if (generation !== syncGeneration) return

    // Prioritize declaration files first, then TS files, then JS files.
    const prioritized = prioritizeWorkspaceTypeFiles(candidates, MAX_EXTRA_LIB_FILES)

    disposeWorkspaceExtraLibs()
    let totalBytes = 0
    const CONCURRENCY = 8

    for (let i = 0; i < prioritized.length; i += CONCURRENCY) {
        if (generation !== syncGeneration || totalBytes >= MAX_TOTAL_EXTRA_LIB_BYTES) return
        const batch = prioritized.slice(i, i + CONCURRENCY)
        const reads = await Promise.all(
            batch.map(async filePath => {
                const res = await api.fs.readFile(filePath).catch(() => null)
                if (!res?.success || typeof res.content !== 'string') return null
                return { filePath, content: res.content }
            })
        )
        if (generation !== syncGeneration) return
        for (const item of reads) {
            if (!item) continue
            const bytes = item.content.length
            if (bytes === 0 || bytes > MAX_EXTRA_LIB_BYTES) continue
            if (totalBytes + bytes > MAX_TOTAL_EXTRA_LIB_BYTES) break
            totalBytes += bytes
            const uri = monaco.Uri.file(item.filePath).toString()
            const dTs = tsLang.typescriptDefaults.addExtraLib(item.content, uri)
            const dJs = tsLang.javascriptDefaults.addExtraLib(item.content, uri)
            activeExtraLibs.push(dTs, dJs)
            fileExtraLibs.set(item.filePath, [dTs, dJs])
        }
    }
}

/**
 * Syncs workspace `tsconfig.json`/`jsconfig.json` compilerOptions and TS/JS files
 * into Monaco's TypeScript/JavaScript language services (bounded & debounced).
 * Returns a cleanup function that cancels pending syncs and clears extraLibs.
 */
export function syncWorkspaceTypes(folder: string | null): () => void {
    const gen = ++syncGeneration
    if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer)
        syncDebounceTimer = null
    }
    lspClient.setWorkspace(folder)

    if (!folder) {
        disposeWorkspaceExtraLibs()
        applyCompilerOptions()
        return () => undefined
    }

    syncDebounceTimer = setTimeout(() => {
        syncDebounceTimer = null
        void runWorkspaceTypeSync(folder, gen).catch(error => {
            if (!isCancellationError(error)) {
                console.warn('[Monaco] Workspace type sync failed:', error)
            }
        })
    }, EXTRA_LIB_DEBOUNCE_MS)

    return () => {
        if (syncGeneration === gen) {
            syncGeneration++
            if (syncDebounceTimer) {
                clearTimeout(syncDebounceTimer)
                syncDebounceTimer = null
            }
            disposeWorkspaceExtraLibs()
            applyCompilerOptions()
        }
    }
}

/** Updates a single workspace file's extraLib entry when saved or edited externally. */
export function updateWorkspaceExtraLib(filePath: string, content: string): void {
    if (!WORKSPACE_TYPE_FILE_RE.test(filePath)) return
    if (content.length > MAX_EXTRA_LIB_BYTES) return
    const normalized = filePath.replace(/\\/g, '/')
    const existing = fileExtraLibs.get(normalized)
    if (existing) {
        existing.forEach(d => d.dispose())
        activeExtraLibs = activeExtraLibs.filter(d => !existing.includes(d))
    }
    const uri = monaco.Uri.file(normalized).toString()
    const dTs = tsLang.typescriptDefaults.addExtraLib(content, uri)
    const dJs = tsLang.javascriptDefaults.addExtraLib(content, uri)
    activeExtraLibs.push(dTs, dJs)
    fileExtraLibs.set(normalized, [dTs, dJs])
}

export { monaco }

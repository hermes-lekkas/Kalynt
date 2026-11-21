/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Loads, converts, applies, and restores VS Code color themes contributed by
 * installed extensions across both Kalynt UI CSS variables and Monaco Editor.
 */
import { useAppStore, type ExtensionThemeSelection, type ResolvedTheme } from '../../stores/appStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { extensionService } from './extensionService'

export interface MonacoTokenRule {
    token: string
    foreground?: string
    background?: string
    fontStyle?: string
}

export interface MonacoThemeData {
    base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'
    inherit: boolean
    rules: MonacoTokenRule[]
    colors: Record<string, string>
}

export interface MonacoThemeApplier {
    apply: (theme: LoadedExtensionTheme) => Promise<void>
    restore: (resolvedBase: ResolvedTheme) => Promise<void>
}

export interface ContributedThemeEntry {
    id: string
    label: string
    uiTheme: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'
    path: string
    extensionId: string
    extensionName?: string
}

export interface ThemeTokenColorRule {
    name?: string
    scope?: string | string[]
    settings: {
        foreground?: string
        background?: string
        fontStyle?: string
    }
}

export interface LoadedExtensionTheme {
    id: string
    extensionId: string
    extensionName: string
    label: string
    uiTheme: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'
    colors: Record<string, string>
    tokenColors: ThemeTokenColorRule[]
}

const VALID_COLOR = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([^;{}]+\))$/

const APPLIED_CSS_VARS = [
    '--bg',
    '--surface',
    '--raised',
    '--hover',
    '--active',
    '--line',
    '--line-strong',
    '--text',
    '--text-2',
    '--text-3',
    '--text-4',
    '--focus',
    '--agent',
    '--agent-solid',
    '--primary',
    '--on-primary',
    '--success',
    '--warning',
    '--danger',
    '--info',
    '--diff-add',
    '--diff-remove'
] as const

/** Built-in Kalynt Monaco themes (kept in sync with monacoSetup.ts for clean restoration). */
export const BUILTIN_MONACO_THEMES: Record<ResolvedTheme, MonacoThemeData> = {
    dark: {
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
    },
    light: {
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
    }
}

export function uiThemeBase(uiTheme?: string): ResolvedTheme {
    return uiTheme === 'vs' || uiTheme === 'hc-light' ? 'light' : 'dark'
}

function sanitizeColor(value: string | undefined): string | undefined {
    if (!value) return undefined
    const trimmed = value.trim()
    return VALID_COLOR.test(trimmed) ? trimmed : undefined
}

function pickColor(colors: Record<string, string>, keys: string[]): string | undefined {
    for (const key of keys) {
        const val = sanitizeColor(colors[key])
        if (val) return val
    }
    return undefined
}

/** Maps a VS Code theme's `colors` table to Kalynt CSS custom properties. */
export function mapThemeToCssVariables(theme: LoadedExtensionTheme): Record<string, string> {
    const c = theme.colors ?? {}
    const vars: Record<string, string> = {}
    const assign = (cssVar: (typeof APPLIED_CSS_VARS)[number], keys: string[]) => {
        const val = pickColor(c, keys)
        if (val) vars[cssVar] = val
    }

    assign('--bg', ['editor.background'])
    assign('--surface', ['sideBar.background', 'activityBar.background', 'panel.background', 'titleBar.activeBackground', 'editor.background'])
    assign('--raised', ['editorWidget.background', 'dropdown.background', 'input.background', 'sideBar.background'])
    assign('--hover', ['list.hoverBackground', 'toolbar.hoverBackground', 'editor.lineHighlightBackground'])
    assign('--active', ['list.activeSelectionBackground', 'editor.selectionBackground', 'list.inactiveSelectionBackground'])
    assign('--line', ['panel.border', 'sideBar.border', 'editorGroup.border', 'titleBar.border'])
    assign('--line-strong', ['input.border', 'dropdown.border', 'contrastBorder', 'editorWidget.border', 'panel.border'])
    assign('--text', ['editor.foreground', 'foreground'])
    assign('--text-2', ['sideBar.foreground', 'foreground', 'editor.foreground'])
    assign('--text-3', ['descriptionForeground', 'editorLineNumber.foreground', 'tab.inactiveForeground'])
    assign('--text-4', ['editorLineNumber.foreground', 'disabledForeground'])
    assign('--focus', ['focusBorder', 'button.background'])
    assign('--agent', ['textLink.foreground', 'button.background', 'focusBorder'])
    assign('--agent-solid', ['button.background', 'focusBorder'])
    assign('--primary', ['button.background', 'textLink.foreground'])
    assign('--on-primary', ['button.foreground'])
    assign('--success', ['gitDecoration.addedResourceForeground', 'terminal.ansiGreen'])
    assign('--warning', ['editorWarning.foreground', 'gitDecoration.modifiedResourceForeground'])
    assign('--danger', ['editorError.foreground', 'errorForeground', 'gitDecoration.deletedResourceForeground'])
    assign('--info', ['editorInfo.foreground', 'textLink.foreground'])
    assign('--diff-add', ['diffEditor.insertedTextBackground'])
    assign('--diff-remove', ['diffEditor.removedTextBackground'])

    return vars
}

/**
 * Maps TextMate scopes commonly found in VS Code themes onto Monaco Monarch token names.
 * Monaco matches token prefixes, so preserving both mapped Monarch tokens and top-level
 * TextMate scopes gives broad syntax highlighting coverage.
 */
const SCOPE_TO_MONACO_TOKENS: Array<[RegExp, string[]]> = [
    [/^comment(?:\.|$)/, ['comment']],
    [/^string(?:\.|$)/, ['string']],
    [/^constant\.numeric(?:\.|$)/, ['number']],
    [/^string\.regexp(?:\.|$)/, ['regexp']],
    [/^keyword\.control(?:\.|$)/, ['keyword.control', 'keyword']],
    [/^keyword\.operator(?:\.|$)/, ['operator', 'delimiter']],
    [/^keyword(?:\.|$)/, ['keyword']],
    [/^storage(?:\.|$)/, ['storage', 'keyword']],
    [/^entity\.name\.type(?:\.|$)|^support\.type(?:\.|$)|^entity\.name\.class(?:\.|$)/, ['type', 'type.identifier']],
    [/^entity\.name\.function(?:\.|$)|^support\.function(?:\.|$)/, ['identifier.function', 'function']],
    [/^entity\.name\.tag(?:\.|$)/, ['tag']],
    [/^entity\.other\.attribute-name(?:\.|$)/, ['attribute.name']],
    [/^variable(?:\.|$)/, ['variable', 'identifier']],
    [/^constant\.language(?:\.|$)|^constant\.other(?:\.|$)/, ['constant', 'keyword']],
    [/^punctuation(?:\.|$)/, ['delimiter']]
]

function normalizeMonacoHex(color: string | undefined): string | undefined {
    const clean = sanitizeColor(color)
    if (!clean || !clean.startsWith('#')) return undefined
    return clean.slice(1)
}

/** Converts a loaded VS Code color theme into a Monaco standalone theme data object. */
export function mapThemeToMonacoData(theme: LoadedExtensionTheme): MonacoThemeData {
    const base: MonacoThemeData['base'] = theme.uiTheme === 'vs' ? 'vs'
        : theme.uiTheme === 'hc-light' ? 'hc-light'
            : theme.uiTheme === 'hc-black' ? 'hc-black'
                : 'vs-dark'

    const rules: MonacoTokenRule[] = []
    const seen = new Set<string>()

    for (const entry of theme.tokenColors ?? []) {
        const foreground = normalizeMonacoHex(entry.settings?.foreground)
        const background = normalizeMonacoHex(entry.settings?.background)
        const fontStyle = typeof entry.settings?.fontStyle === 'string' ? entry.settings.fontStyle.trim() : undefined
        if (!foreground && !background && !fontStyle) continue

        const rawScopes = Array.isArray(entry.scope)
            ? entry.scope
            : typeof entry.scope === 'string'
                ? entry.scope.split(',')
                : ['']

        for (const rawScope of rawScopes) {
            const scope = rawScope.trim()
            const targets: string[] = scope ? [scope] : ['']
            for (const [pattern, mapped] of SCOPE_TO_MONACO_TOKENS) {
                if (pattern.test(scope)) targets.push(...mapped)
            }
            for (const token of targets) {
                const key = `${token}|${foreground ?? ''}|${background ?? ''}|${fontStyle ?? ''}`
                if (seen.has(key)) continue
                seen.add(key)
                rules.push({
                    token,
                    ...(foreground ? { foreground } : {}),
                    ...(background ? { background } : {}),
                    ...(fontStyle ? { fontStyle } : {})
                })
            }
        }
    }

    const colors: Record<string, string> = {}
    for (const [key, val] of Object.entries(theme.colors ?? {})) {
        const clean = sanitizeColor(val)
        if (clean) colors[key] = clean
    }

    return {
        base,
        inherit: true,
        rules,
        colors
    }
}

let monacoApplier: MonacoThemeApplier | null = null
let activeLoadedTheme: LoadedExtensionTheme | null = null
let watchersAttached = false

export function registerMonacoThemeApplier(applier: MonacoThemeApplier): void {
    monacoApplier = applier
    if (activeLoadedTheme) {
        void applier.apply(activeLoadedTheme)
    }
}

function clearDomThemeOverrides(): void {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    for (const cssVar of APPLIED_CSS_VARS) {
        root.style.removeProperty(cssVar)
    }
    delete root.dataset.extensionTheme
}

function applyDomThemeOverrides(theme: LoadedExtensionTheme): void {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    clearDomThemeOverrides()
    root.dataset.theme = uiThemeBase(theme.uiTheme)
    root.dataset.extensionTheme = theme.id
    const vars = mapThemeToCssVariables(theme)
    for (const [prop, value] of Object.entries(vars)) {
        root.style.setProperty(prop, value)
    }
}

async function applyMonacoExtensionTheme(theme: LoadedExtensionTheme): Promise<void> {
    activeLoadedTheme = theme
    if (monacoApplier) {
        await monacoApplier.apply(theme)
    }
}

export async function restoreBuiltinTheme(resolvedBase: ResolvedTheme): Promise<void> {
    activeLoadedTheme = null
    clearDomThemeOverrides()
    if (typeof document !== 'undefined') {
        document.documentElement.dataset.theme = resolvedBase
    }
    if (monacoApplier) {
        await monacoApplier.restore(resolvedBase)
    }
}

/** Selects and applies a contributed VS Code extension theme, persisting it across restarts. */
export async function selectExtensionTheme(entry: ContributedThemeEntry | ExtensionThemeSelection): Promise<boolean> {
    const loaded = await extensionService.loadTheme(entry.extensionId, entry.id)
    if (!loaded) {
        useNotificationStore.getState().addNotification(`Couldn't load theme "${entry.label}".`, 'error')
        return false
    }
    const selection: ExtensionThemeSelection = {
        id: loaded.id,
        extensionId: loaded.extensionId,
        label: loaded.label,
        uiTheme: loaded.uiTheme
    }
    useAppStore.getState().setExtensionTheme(selection)
    applyDomThemeOverrides(loaded)
    await applyMonacoExtensionTheme(loaded)
    return true
}

/**
 * Verifies the persisted contributed theme on startup or whenever installed/enabled
 * extensions change. Falls back cleanly to built-in Dark/Light if removed or disabled.
 */
export async function syncActiveExtensionTheme(): Promise<void> {
    const state = useAppStore.getState()
    const active = state.extensionTheme
    if (!active) {
        await restoreBuiltinTheme(state.resolvedTheme)
        return
    }

    // Ensure extensions are scanned at least once before checking availability
    await extensionService.scanExtensions()
    const loaded = await extensionService.loadTheme(active.extensionId, active.id)
    if (loaded) {
        applyDomThemeOverrides(loaded)
        await applyMonacoExtensionTheme(loaded)
        return
    }

    // Active theme extension was uninstalled or disabled: fall back cleanly to built-in Dark/Light
    const fallbackBase = uiThemeBase(active.uiTheme)
    useAppStore.getState().setTheme(fallbackBase)
    await restoreBuiltinTheme(fallbackBase)
    useNotificationStore.getState().addNotification(
        `Theme "${active.label}" is no longer available. Switched back to ${fallbackBase === 'light' ? 'Light' : 'Dark'} theme.`,
        'info'
    )
}

/** Attaches extension lifecycle watchers once so theme removal triggers automatic fallback. */
export function ensureExtensionThemeWatchers(): void {
    if (watchersAttached) return
    watchersAttached = true
    extensionService.onContributionsChanged(() => {
        void syncActiveExtensionTheme()
    })
    extensionService.onInstalledChange(() => {
        void syncActiveExtensionTheme()
    })
    extensionService.onDeactivated(() => {
        void syncActiveExtensionTheme()
    })
}

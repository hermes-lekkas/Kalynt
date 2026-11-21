/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Reading installed extensions from the extensions folder, merging their
 * contributed commands, menus, keybindings, views and themes, and loading
 * contributed VS Code color theme JSON/JSONC definitions.
 */
import * as path from 'path'
import * as fs from 'fs'

// Extension metadata
export interface ExtensionMetadata {
  id: string
  name: string
  displayName: string
  version: string
  description: string
  publisher: string
  main?: string
  contributes: unknown
  activationEvents: string[]
  extensionPath: string
  isBuiltin: boolean
  isActive: boolean
}

export interface ContributedCommand {
  command: string
  title: string
  category?: string
  extensionId?: string
  extensionName?: string
}

export interface ContributedTheme {
  id?: string
  label: string
  uiTheme: string
  path: string
  extensionId?: string
  extensionName?: string
  extensionPath?: string
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

// Extension contribution
export interface ExtensionContribution {
  commands?: ContributedCommand[]
  menus?: Record<string, Array<{
    command: string
    when?: string
    group?: string
  }>>
  keybindings?: Array<{
    command: string
    key: string
    when?: string
  }>
  views?: Record<string, Array<{
    id: string
    name: string
    when?: string
  }>>
  configuration?: Record<string, unknown>
  themes?: ContributedTheme[]
  grammars?: Array<{
    language?: string
    scopeName: string
    path: string
  }>
  snippets?: Array<{
    language: string
    path: string
  }>
  languages?: Array<{
    id: string
    aliases?: string[]
    extensions?: string[]
  }>
}

/** Stable identifier for a contributed theme within an extension. */
export function buildThemeId(extensionId: string, theme: { id?: string; label?: string; path?: string }, index: number): string {
  const key = (typeof theme.id === 'string' && theme.id.trim())
    || (typeof theme.label === 'string' && theme.label.trim())
    || (typeof theme.path === 'string' && theme.path.trim())
    || String(index)
  return `${extensionId}::${key}`
}

function normalizeUiTheme(raw: unknown): 'vs' | 'vs-dark' | 'hc-black' | 'hc-light' {
  if (raw === 'vs' || raw === 'vs-dark' || raw === 'hc-black' || raw === 'hc-light') return raw
  return 'vs-dark'
}

/**
 * Strips single-line comments, block comments, and trailing commas from VS Code
 * JSONC theme files without corrupting string literals (such as URLs or hex codes).
 */
export function parseJsonc(raw: string): unknown {
  const input = raw.replace(/^\uFEFF/, '')
  let out = ''
  let i = 0
  let inString = false
  let escaped = false

  while (i < input.length) {
    const ch = input[i]
    const next = input[i + 1]

    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      i++
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }

    if (ch === '/' && next === '/') {
      i += 2
      while (i < input.length && input[i] !== '\n' && input[i] !== '\r') i++
      continue
    }

    if (ch === '/' && next === '*') {
      i += 2
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++
      i += 2
      continue
    }

    out += ch
    i++
  }

  // Remove trailing commas before } or ] outside strings
  let cleaned = ''
  inString = false
  escaped = false
  for (let j = 0; j < out.length; j++) {
    const ch = out[j]
    if (inString) {
      cleaned += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      cleaned += ch
      continue
    }
    if (ch === ',') {
      let k = j + 1
      while (k < out.length && /\s/.test(out[k])) k++
      if (out[k] === '}' || out[k] === ']') continue
    }
    cleaned += ch
  }

  return JSON.parse(cleaned)
}

function readThemeFileRecursive(
  filePath: string,
  extensionRoot: string,
  visited: Set<string>
): { colors: Record<string, string>; tokenColors: ThemeTokenColorRule[] } {
  const resolved = path.resolve(filePath)
  const rootResolved = path.resolve(extensionRoot)
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`Theme path escapes extension directory: ${filePath}`)
  }
  if (visited.has(resolved)) {
    return { colors: {}, tokenColors: [] }
  }
  visited.add(resolved)

  if (!fs.existsSync(resolved)) {
    throw new Error(`Theme file not found: ${resolved}`)
  }

  const parsed = parseJsonc(fs.readFileSync(resolved, 'utf-8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid theme JSON in ${resolved}`)
  }

  const obj = parsed as Record<string, unknown>
  let baseColors: Record<string, string> = {}
  let baseTokenColors: ThemeTokenColorRule[] = []

  if (typeof obj.include === 'string' && obj.include.trim()) {
    const parentPath = path.resolve(path.dirname(resolved), obj.include)
    const parent = readThemeFileRecursive(parentPath, extensionRoot, visited)
    baseColors = parent.colors
    baseTokenColors = parent.tokenColors
  }

  const ownColors: Record<string, string> = {}
  if (obj.colors && typeof obj.colors === 'object' && !Array.isArray(obj.colors)) {
    for (const [key, val] of Object.entries(obj.colors as Record<string, unknown>)) {
      if (typeof val === 'string' && val.trim()) {
        ownColors[key] = val.trim()
      }
    }
  }

  const ownTokenColors: ThemeTokenColorRule[] = []
  if (Array.isArray(obj.tokenColors)) {
    for (const entry of obj.tokenColors) {
      if (!entry || typeof entry !== 'object') continue
      const rule = entry as Record<string, unknown>
      if (!rule.settings || typeof rule.settings !== 'object' || Array.isArray(rule.settings)) continue
      const settingsObj = rule.settings as Record<string, unknown>
      const settings: ThemeTokenColorRule['settings'] = {}
      if (typeof settingsObj.foreground === 'string') settings.foreground = settingsObj.foreground
      if (typeof settingsObj.background === 'string') settings.background = settingsObj.background
      if (typeof settingsObj.fontStyle === 'string') settings.fontStyle = settingsObj.fontStyle
      const scope = typeof rule.scope === 'string' || Array.isArray(rule.scope)
        ? rule.scope as string | string[]
        : undefined
      ownTokenColors.push({
        ...(typeof rule.name === 'string' ? { name: rule.name } : {}),
        ...(scope !== undefined ? { scope } : {}),
        settings
      })
    }
  }

  return {
    colors: { ...baseColors, ...ownColors },
    tokenColors: [...baseTokenColors, ...ownTokenColors]
  }
}

/** Loads and resolves a contributed VS Code color theme JSON/JSONC file for an extension. */
export function loadContributedTheme(extension: ExtensionMetadata, themeIdOrLabel: string): LoadedExtensionTheme | null {
  const contributes = extension.contributes as ExtensionContribution | undefined
  const themes = contributes?.themes
  if (!Array.isArray(themes) || themes.length === 0) return null

  const index = themes.findIndex((t, idx) =>
    buildThemeId(extension.id, t, idx) === themeIdOrLabel
    || t.id === themeIdOrLabel
    || t.label === themeIdOrLabel
    || t.path === themeIdOrLabel
  )
  if (index === -1) return null

  const entry = themes[index]
  if (!entry.path || typeof entry.path !== 'string') return null

  const fullPath = path.resolve(extension.extensionPath, entry.path)
  const { colors, tokenColors } = readThemeFileRecursive(fullPath, extension.extensionPath, new Set())

  return {
    id: buildThemeId(extension.id, entry, index),
    extensionId: extension.id,
    extensionName: extension.displayName || extension.name,
    label: entry.label || entry.id || extension.displayName || extension.name,
    uiTheme: normalizeUiTheme(entry.uiTheme),
    colors,
    tokenColors
  }
}

/** Reads one extension folder's package.json into metadata, or null if it is not a usable extension. */
export function readMetadata(extensionPath: string): ExtensionMetadata | null {
  const packageJsonPath = path.join(extensionPath, 'package.json')
  if (!fs.existsSync(packageJsonPath)) return null

  try {
    const rawData = fs.readFileSync(packageJsonPath, 'utf-8')
    const manifest = JSON.parse(rawData)
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      console.warn(`[ExtensionHost] Invalid manifest in ${extensionPath}: not an object`)
      return null
    }

    if (!manifest.engines?.vscode) return null

    // Only set `main` when the manifest explicitly declares a JS entrypoint;
    // declarative extensions (themes, grammars, snippets) have no `main` file.
    const main = typeof manifest.main === 'string' && manifest.main.trim().length > 0
      ? manifest.main.trim()
      : undefined

    return {
      id: `${manifest.publisher}.${manifest.name}`,
      name: manifest.name,
      displayName: manifest.displayName || manifest.name,
      version: manifest.version,
      description: manifest.description || '',
      publisher: manifest.publisher || 'unknown',
      main,
      contributes: manifest.contributes || {},
      activationEvents: Array.isArray(manifest.activationEvents) ? manifest.activationEvents : [],
      extensionPath,
      isBuiltin: false,
      isActive: false
    }
  } catch (error) {
    console.error(`[ExtensionHost] Failed to load extension ${extensionPath}:`, error)
    return null
  }
}

/** Scans an extensions folder and returns its extensions keyed by id. */
export function scanExtensionDir(extensionsDir: string): Map<string, ExtensionMetadata> {
  const extensions = new Map<string, ExtensionMetadata>()

  try {
    if (!fs.existsSync(extensionsDir)) return extensions
    const entries = fs.readdirSync(extensionsDir)

    for (const entry of entries) {
      const extensionPath = path.join(extensionsDir, entry)
      const stat = fs.statSync(extensionPath)

      if (!stat.isDirectory()) continue

      const metadata = readMetadata(extensionPath)
      if (metadata) {
        extensions.set(metadata.id, metadata)
      }
    }
  } catch (error) {
    console.error('[ExtensionHost] Failed to scan extensions:', error)
  }

  return extensions
}

/** Merges the contributions of all enabled installed extensions into one aggregate. */
export function mergeContributions(
  allExtensions: ExtensionMetadata[],
  disabledIds?: ReadonlySet<string>
): ExtensionContribution {
  const contributions: ExtensionContribution = {
    commands: [],
    menus: {},
    keybindings: [],
    views: {},
    configuration: {},
    themes: [],
    grammars: [],
    snippets: [],
    languages: []
  }

  for (const extension of allExtensions) {
    if (disabledIds?.has(extension.id)) continue
    const contributes = extension.contributes as ExtensionContribution | undefined
    if (!contributes) continue

    const extensionName = extension.displayName || extension.name

    if (Array.isArray(contributes.commands)) {
      contributions.commands!.push(...contributes.commands.map(cmd => ({
        ...cmd,
        extensionId: extension.id,
        extensionName
      })))
    }

    if (contributes.menus) {
      for (const [menu, items] of Object.entries(contributes.menus)) {
        if (!contributions.menus![menu]) {
          contributions.menus![menu] = []
        }
        contributions.menus![menu].push(...items)
      }
    }

    if (Array.isArray(contributes.keybindings)) {
      contributions.keybindings!.push(...contributes.keybindings)
    }

    if (contributes.views) {
      for (const [container, views] of Object.entries(contributes.views)) {
        if (!contributions.views![container]) {
          contributions.views![container] = []
        }
        contributions.views![container].push(...views)
      }
    }

    if (Array.isArray(contributes.themes)) {
      contributions.themes!.push(...contributes.themes.map((theme, idx) => ({
        ...theme,
        id: buildThemeId(extension.id, theme, idx),
        uiTheme: normalizeUiTheme(theme.uiTheme),
        extensionId: extension.id,
        extensionName,
        extensionPath: extension.extensionPath
      })))
    }

    if (Array.isArray(contributes.grammars)) {
      contributions.grammars!.push(...contributes.grammars.map(grammar => ({
        ...grammar,
        extensionId: extension.id,
        extensionPath: extension.extensionPath
      })))
    }

    if (Array.isArray(contributes.snippets)) {
      contributions.snippets!.push(...contributes.snippets.map(snippet => ({
        ...snippet,
        extensionId: extension.id,
        extensionPath: extension.extensionPath
      })))
    }

    if (Array.isArray(contributes.languages)) {
      contributions.languages!.push(...contributes.languages)
    }
  }

  return contributions
}

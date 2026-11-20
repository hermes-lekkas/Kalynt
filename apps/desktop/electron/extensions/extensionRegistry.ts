/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Reading installed extensions from the extensions folder and merging their
 * contributed commands, menus, keybindings, views and themes.
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

// Extension contribution
export interface ExtensionContribution {
  commands?: Array<{
    command: string
    title: string
    category?: string
  }>
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
  themes?: Array<{
    label: string
    uiTheme: string
    path: string
  }>
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

/** Merges the contributions of all installed extensions into one aggregate. */
export function mergeContributions(allExtensions: ExtensionMetadata[]): ExtensionContribution {
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
    const contributes = extension.contributes as ExtensionContribution | undefined
    if (!contributes) continue

    if (contributes.commands) {
      contributions.commands!.push(...contributes.commands.map(cmd => ({
        ...cmd,
        extensionId: extension.id
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

    if (contributes.keybindings) {
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

    if (contributes.themes) {
      contributions.themes!.push(...contributes.themes.map(theme => ({
        ...theme,
        extensionId: extension.id,
        extensionPath: extension.extensionPath
      })))
    }

    if (contributes.grammars) {
      contributions.grammars!.push(...contributes.grammars.map(grammar => ({
        ...grammar,
        extensionId: extension.id,
        extensionPath: extension.extensionPath
      })))
    }

    if (contributes.snippets) {
      contributions.snippets!.push(...contributes.snippets.map(snippet => ({
        ...snippet,
        extensionId: extension.id,
        extensionPath: extension.extensionPath
      })))
    }

    if (contributes.languages) {
      contributions.languages!.push(...contributes.languages)
    }
  }

  return contributions
}

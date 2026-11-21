/**
 * Extension Service (Renderer Process)
 * Manages extensions in the renderer process and communicates with the extension host
 */

import { ExtensionMetadata, ExtensionContributes, ExtensionGallery, ExtensionQueryOptions } from '../../types/extensions'
import { useNotificationStore } from '../../stores/notificationStore'
import { marketplaceService } from './marketplaceService'

// VS Code API types for extensions
export interface VSCodeAPI {
  version: string
  commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): { dispose(): void }
    executeCommand<T>(command: string, ...args: unknown[]): Promise<T | undefined>
    getCommands(filterInternal?: boolean): Promise<string[]>
  }
  window: {
    showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>
    showWarningMessage(message: string, ...items: string[]): Promise<string | undefined>
    showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>
    showQuickPick<T extends { label: string }>(items: T[], options?: { placeHolder?: string }): Promise<T | undefined>
    showInputBox(options?: { prompt?: string; value?: string }): Promise<string | undefined>
    createOutputChannel(name: string): OutputChannel
    createTerminal(name?: string, shellPath?: string, shellArgs?: string[]): Terminal
  }
  workspace: {
    getConfiguration(section?: string): WorkspaceConfiguration
    onDidChangeConfiguration: Event<ConfigurationChangeEvent>
    getWorkspaceFolders(): WorkspaceFolder[] | undefined
    onDidChangeWorkspaceFolders: Event<WorkspaceFoldersChangeEvent>
  }
  languages: {
    registerCompletionItemProvider(selector: DocumentSelector, provider: CompletionItemProvider, ...triggerCharacters: string[]): { dispose(): void }
    registerHoverProvider(selector: DocumentSelector, provider: HoverProvider): { dispose(): void }
    registerDefinitionProvider(selector: DocumentSelector, provider: DefinitionProvider): { dispose(): void }
  }
  debug: {
    registerDebugConfigurationProvider(debugType: string, provider: DebugConfigurationProvider): { dispose(): void }
    onDidStartDebugSession: Event<DebugSession>
    onDidTerminateDebugSession: Event<DebugSession>
  }
  env: {
    appName: string
    appRoot: string
    language: string
    machineId: string
    sessionId: string
    shell: string
  }
  extensions: {
    getExtension<T>(extensionId: string): Extension<T> | undefined
    all: Extension<unknown>[]
    onDidChange: Event<void>
  }
  Uri: {
    file(path: string): URI
    parse(uri: string): URI
  }
  Disposable: {
    from(...disposables: Array<{ dispose(): void }>): { dispose(): void }
  }
  EventEmitter: new <T>() => {
    event: Event<T>
    fire(data: T): void
    dispose(): void
  }
}

// Supporting types
export interface OutputChannel {
  name: string
  append(value: string): void
  appendLine(value: string): void
  clear(): void
  show(): void
  hide(): void
  dispose(): void
}

export interface Terminal {
  name: string
  sendText(text: string, addNewLine?: boolean): void
  show(): void
  hide(): void
  dispose(): void
}

export interface WorkspaceConfiguration {
  get<T>(key: string): T | undefined
  get<T>(key: string, defaultValue: T): T
  update(key: string, value: unknown): Promise<void>
  has(key: string): boolean
}

export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string): boolean
}

export interface WorkspaceFolder {
  uri: URI
  name: string
  index: number
}

export interface WorkspaceFoldersChangeEvent {
  added: WorkspaceFolder[]
  removed: WorkspaceFolder[]
}

export interface DocumentSelector {
  language?: string
  scheme?: string
  pattern?: string
}

export interface CompletionItemProvider {
  provideCompletionItems(document: TextDocument, position: Position): Promise<CompletionItem[] | undefined>
}

export interface HoverProvider {
  provideHover(document: TextDocument, position: Position): Promise<Hover | undefined>
}

export interface DefinitionProvider {
  provideDefinition(document: TextDocument, position: Position): Promise<Location | undefined>
}

export interface TextDocument {
  uri: URI
  languageId: string
  version: number
  getText(): string
  lineAt(line: number): TextLine
  offsetAt(position: Position): number
  positionAt(offset: number): Position
}

export interface TextLine {
  text: string
  lineNumber: number
  firstNonWhitespaceCharacterIndex: number
  isEmptyOrWhitespace: boolean
}

export interface Position {
  line: number
  character: number
}

export interface CompletionItem {
  label: string
  kind?: CompletionItemKind
  detail?: string
  documentation?: string
  insertText?: string
}

export enum CompletionItemKind {
  Text = 0,
  Method = 1,
  Function = 2,
  Constructor = 3,
  Field = 4,
  Variable = 5,
  Class = 6,
  Interface = 7,
  Module = 8,
  Property = 9,
  Unit = 10,
  Value = 11,
  Enum = 12,
  Keyword = 13,
  Snippet = 14,
  Color = 15,
  Reference = 17,
  File = 16,
  Folder = 18,
  EnumMember = 19,
  Constant = 20,
  Struct = 21,
  Event = 22,
  Operator = 23,
  TypeParameter = 24
}

export interface Hover {
  contents: string
}

export interface Location {
  uri: URI
  range: Range
}

export interface Range {
  start: Position
  end: Position
}

export interface URI {
  scheme: string
  authority: string
  path: string
  query: string
  fragment: string
  fsPath: string
  toString(): string
}

export interface DebugConfigurationProvider {
  provideDebugConfigurations?(): Promise<DebugConfiguration[]>
  resolveDebugConfiguration?(folder: WorkspaceFolder | undefined, debugConfiguration: DebugConfiguration): Promise<DebugConfiguration | undefined>
}

export interface DebugConfiguration {
  type: string
  name: string
  request: 'launch' | 'attach'
  [key: string]: unknown
}

export interface DebugSession {
  id: string
  type: string
  name: string
  customRequest(command: string, args?: unknown): Promise<unknown>
}

export interface Extension<T> {
  id: string
  extensionUri: URI
  extensionPath: string
  isActive: boolean
  packageJSON: unknown
  exports: T
  activate(): Promise<T>
}

export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Array<{ dispose(): void }>) => { dispose(): void }

// Extension Service
class ExtensionService {
  private extensions: Map<string, ExtensionMetadata> = new Map()
  private activeExtensions: Set<string> = new Set()
  private installedListeners: Array<(extensions: ExtensionMetadata[]) => void> = []
  private activatedListeners: Array<(id: string) => void> = []
  private deactivatedListeners: Array<(id: string) => void> = []
  private contributionsListeners: Array<() => void> = []

  constructor() {
    this.setupIPCListeners()
  }

  private emitContributionsChanged(): void {
    this.contributionsListeners.forEach(listener => listener())
  }

  private setupIPCListeners(): void {
    // Listen for extension host messages from main process via typed preload APIs
    const ext = window.electronAPI?.extensions
    if (!ext) return

    ext.onActivated?.((data: { id: string }) => {
      this.activeExtensions.add(data.id)
      this.activatedListeners.forEach(listener => listener(data.id))
      this.emitContributionsChanged()
    })

    ext.onDeactivated?.((data: { id: string }) => {
      this.activeExtensions.delete(data.id)
      this.deactivatedListeners.forEach(listener => listener(data.id))
      this.emitContributionsChanged()
    })

    ext.onContributionsChanged?.(() => {
      this.emitContributionsChanged()
    })

    ext.onShowMessage?.((data: { type: string; message: string }) => {
      const type = data.type === 'warning' || data.type === 'error' ? data.type : 'info'
      this.showNotification(type, data.message)
    })
  }

  private showNotification(type: 'info' | 'warning' | 'error', message: string): void {
    // Route extension messages to the app's notification system
    useNotificationStore.getState().addNotification(message, type)
  }

  // Public API

  /**
   * Initialize extension service
   */
  async initialize(): Promise<void> {
    await this.scanExtensions()
    await this.startExtensionHost()
  }

  /**
   * Start the extension host process
   */
  async startExtensionHost(): Promise<void> {
    try {
      await window.electronAPI?.extensions?.startHost()
    } catch (error) {
      console.error('[ExtensionService] Failed to start extension host:', error)
      throw error
    }
  }

  /**
   * Stop the extension host process
   */
  async stopExtensionHost(): Promise<void> {
    try {
      await window.electronAPI?.extensions?.stopHost()
      this.activeExtensions.clear()
    } catch (error) {
      console.error('[ExtensionService] Failed to stop extension host:', error)
      throw error
    }
  }

  /**
   * Scan for installed extensions
   */
  async scanExtensions(): Promise<ExtensionMetadata[]> {
    try {
      const result = await window.electronAPI?.extensions?.scan()
      const extensions = (Array.isArray(result) ? result : []) as ExtensionMetadata[]

      this.extensions.clear()
      extensions.forEach(ext => {
        this.extensions.set(ext.id, ext)
      })

      this.installedListeners.forEach(listener => listener(extensions))
      return extensions
    } catch (error) {
      console.error('[ExtensionService] Failed to scan extensions:', error)
      return []
    }
  }

  /**
   * Get all installed extensions
   */
  getExtensions(): ExtensionMetadata[] {
    return Array.from(this.extensions.values())
  }

  /**
   * Get active extensions
   */
  async getActiveExtensions(): Promise<ExtensionMetadata[]> {
    try {
      const result = await window.electronAPI?.extensions?.active()
      return (Array.isArray(result) ? result : []) as ExtensionMetadata[]
    } catch (error) {
      console.error('[ExtensionService] Failed to get active extensions:', error)
      return []
    }
  }

  /**
   * Get extension by ID
   */
  getExtension(id: string): ExtensionMetadata | undefined {
    return this.extensions.get(id)
  }

  /**
   * Activate an extension
   */
  async activateExtension(id: string): Promise<unknown> {
    const extension = this.extensions.get(id)
    if (!extension) {
      throw new Error(`Extension not found: ${id}`)
    }

    if (this.activeExtensions.has(id)) {
      return
    }

    try {
      const result = await window.electronAPI?.extensions?.activate(id)
      this.activeExtensions.add(id)
      return result
    } catch (error) {
      console.error(`[ExtensionService] Failed to activate extension ${id}:`, error)
      throw error
    }
  }

  /**
   * Deactivate (disable) an extension
   */
  async deactivateExtension(id: string): Promise<void> {
    const extension = this.extensions.get(id)
    if (!extension) {
      return
    }

    try {
      await window.electronAPI?.extensions?.deactivate(id)
      this.activeExtensions.delete(id)
      this.emitContributionsChanged()
    } catch (error) {
      console.error(`[ExtensionService] Failed to deactivate extension ${id}:`, error)
      throw error
    }
  }

  /**
   * Execute a command contributed by an installed extension (activates it on demand).
   */
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    const api = window.electronAPI?.extensions
    if (!api?.executeCommand) {
      throw new Error('Extension commands require the desktop app.')
    }
    return api.executeCommand(command, ...args)
  }

  /**
   * Load a contributed VS Code color theme JSON/JSONC definition from an installed extension.
   */
  async loadTheme(extensionId: string, themeId: string): Promise<import('./themeService').LoadedExtensionTheme | null> {
    const api = window.electronAPI?.extensions
    if (!api?.loadTheme) return null
    try {
      return (await api.loadTheme(extensionId, themeId)) ?? null
    } catch (error) {
      console.error(`[ExtensionService] Failed to load theme ${themeId} from ${extensionId}:`, error)
      return null
    }
  }

  /**
   * Install extension from VSIX file
   */
  async installFromVSIX(vsixPath: string): Promise<ExtensionMetadata> {
    try {
      const extension = await window.electronAPI?.extensions?.install(vsixPath) as ExtensionMetadata
      this.extensions.set(extension.id, extension)
      this.installedListeners.forEach(listener => listener(this.getExtensions()))
      this.emitContributionsChanged()
      return extension
    } catch (error) {
      console.error('[ExtensionService] Failed to install extension:', error)
      throw error
    }
  }

  /**
   * Install extension from marketplace
   */
  async installFromMarketplace(extensionId: string, version?: string): Promise<ExtensionMetadata> {
    console.log('[ExtensionService] Installing extension:', extensionId, 'version:', version)
    
    // Handle both "publisher.name" and "namespace.name" formats
    const parts = extensionId.split('.')
    if (parts.length < 2) {
      throw new Error(`Invalid extension ID format: ${extensionId}. Expected: namespace.name`)
    }
    
    // For IDs like "redhat.java", namespace=redhat, name=java
    // For IDs like "ms-python.python", namespace=ms-python, name=python  
    const name = parts.pop()! // Last part is the name
    const namespace = parts.join('.') // Everything else is the namespace
    
    console.log('[ExtensionService] Parsed namespace:', namespace, 'name:', name)
    
    // Resolve the actual download URL (handles 'latest' version)
    const downloadUrl = await marketplaceService.getActualDownloadUrl(
      namespace, 
      name, 
      version || 'latest'
    )
    
    // Get temp path
    const tempDir = await window.electronAPI?.app?.getPath('temp')
    const actualVersion = version || 'latest'
    const tempPath = `${tempDir}/${namespace}.${name}-${actualVersion}.vsix`
    
    console.log('[ExtensionService] Downloading from:', downloadUrl)
    console.log('[ExtensionService] Saving to:', tempPath)
    
    // Download via main process (bypasses CORS)
    await window.electronAPI?.extensions?.download(downloadUrl, tempPath)

    // Note: We can't verify the file size here because fs.stat may have workspace restrictions
    // The error from installFromVSIX will give us the actual error if the file is invalid

    // Install
    return this.installFromVSIX(tempPath)
  }

  /**
   * Uninstall extension
   */
  async uninstallExtension(id: string): Promise<void> {
    const extension = this.extensions.get(id)
    if (!extension) {
      throw new Error(`Extension not found: ${id}`)
    }

    // Deactivate first
    if (this.activeExtensions.has(id)) {
      await this.deactivateExtension(id)
    }

    try {
      await window.electronAPI?.extensions?.uninstall(id)
      this.extensions.delete(id)
      this.installedListeners.forEach(listener => listener(this.getExtensions()))
      this.emitContributionsChanged()
    } catch (error) {
      console.error(`[ExtensionService] Failed to uninstall extension ${id}:`, error)
      throw error
    }
  }

  /**
   * Get all extension contributions
   */
  async getContributions(): Promise<ExtensionContributes> {
    try {
      return (await window.electronAPI?.extensions?.contributions() ?? {}) as ExtensionContributes
    } catch (error) {
      console.error('[ExtensionService] Failed to get contributions:', error)
      return {}
    }
  }

  /**
   * Check if extension is active
   */
  isActive(id: string): boolean {
    return this.activeExtensions.has(id)
  }

  /**
   * Search marketplace for extensions
   */
  async searchMarketplace(options: ExtensionQueryOptions): Promise<ExtensionGallery[]> {
    return marketplaceService.searchExtensions(options)
  }

  /**
   * Get popular extensions from marketplace
   */
  async getPopularExtensions(limit?: number): Promise<ExtensionGallery[]> {
    return marketplaceService.getPopularExtensions(limit)
  }

  /**
   * Get recommended extensions
   */
  async getRecommendedExtensions(): Promise<ExtensionGallery[]> {
    const installedIds = Array.from(this.extensions.keys())
    return marketplaceService.getRecommendedExtensions(installedIds)
  }

  // Event listeners

  onInstalledChange(listener: (extensions: ExtensionMetadata[]) => void): () => void {
    this.installedListeners.push(listener)
    return () => {
      const index = this.installedListeners.indexOf(listener)
      if (index > -1) {
        this.installedListeners.splice(index, 1)
      }
    }
  }

  onActivated(listener: (id: string) => void): () => void {
    this.activatedListeners.push(listener)
    return () => {
      const index = this.activatedListeners.indexOf(listener)
      if (index > -1) {
        this.activatedListeners.splice(index, 1)
      }
    }
  }

  onDeactivated(listener: (id: string) => void): () => void {
    this.deactivatedListeners.push(listener)
    return () => {
      const index = this.deactivatedListeners.indexOf(listener)
      if (index > -1) {
        this.deactivatedListeners.splice(index, 1)
      }
    }
  }

  onContributionsChanged(listener: () => void): () => void {
    this.contributionsListeners.push(listener)
    return () => {
      const index = this.contributionsListeners.indexOf(listener)
      if (index > -1) {
        this.contributionsListeners.splice(index, 1)
      }
    }
  }

  // Private helpers
}

// Export singleton
export const extensionService = new ExtensionService()
export default extensionService

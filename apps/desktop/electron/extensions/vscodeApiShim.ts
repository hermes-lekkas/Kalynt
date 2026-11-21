/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * A VS Code-compatible API shim handed to extensions running in the
 * extension host. Covers core primitives, commands, window channels/status bar,
 * workspace config/folders/fs, and persistent ExtensionContext mementos.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** What the shim needs from the extension host to talk to the main process. */
export interface CommandBridge {
  sendMessage(message: { type: string; payload?: unknown }): void
  nextMessageId(): number
  pendingResponses: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
  registerCommandHandler: (extensionId: string, command: string, callback: (...args: unknown[]) => unknown) => void
  unregisterCommandHandler: (extensionId: string, command: string) => void
  getRegisteredCommands?: (filterInternal?: boolean) => string[]
  getWorkspaceFolders?: () => Array<{ uri: Uri; name: string; index: number }> | undefined
  configurationStore?: Map<string, unknown>
}

export interface Memento {
  keys(): readonly string[]
  get<T>(key: string): T | undefined
  get<T>(key: string, defaultValue: T): T
  update(key: string, value: unknown): Promise<void>
}

export interface GlobalMemento extends Memento {
  setKeysForSync(keys: readonly string[]): void
}

export interface SecretStorage {
  get(key: string): Promise<string | undefined>
  store(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  onDidChange: Event<{ key: string }>
}

export type Event<T> = (
  listener: (e: T) => unknown,
  thisArgs?: unknown,
  disposables?: Array<{ dispose(): void }>
) => Disposable

/** The extension context passed to activate(), as the shim exposes it. */
export interface ShimExtensionContext {
  subscriptions: Array<{ dispose(): void }>
  extensionPath: string
  extensionUri?: Uri
  asAbsolutePath?: (relativePath: string) => string
  storagePath?: string
  globalStoragePath?: string
  storageUri?: Uri
  globalStorageUri?: Uri
  logPath?: string
  logUri?: Uri
  globalState?: GlobalMemento
  workspaceState?: Memento
  secrets?: SecretStorage
  extensionMode?: ExtensionMode
  packageJSON?: Record<string, unknown>
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3
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
  File = 16,
  Reference = 17,
  Folder = 18,
  EnumMember = 19,
  Constant = 20,
  Struct = 21,
  Event = 22,
  Operator = 23,
  TypeParameter = 24
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64
}

export class Position {
  constructor(public line: number, public character: number) {}
  isBefore(other: Position) { return this.line < other.line || (this.line === other.line && this.character < other.character) }
  isBeforeOrEqual(other: Position) { return this.line < other.line || (this.line === other.line && this.character <= other.character) }
  isAfter(other: Position) { return !this.isBeforeOrEqual(other) }
  isAfterOrEqual(other: Position) { return !this.isBefore(other) }
  isEqual(other: Position) { return this.line === other.line && this.character === other.character }
  compareTo(other: Position) { return this.isBefore(other) ? -1 : (this.isAfter(other) ? 1 : 0) }
  translate(lineDelta: number = 0, characterDelta: number = 0) { return new Position(this.line + lineDelta, this.character + characterDelta) }
  with(change: { line?: number; character?: number }) { return new Position(change.line ?? this.line, change.character ?? this.character) }
}

export class Range {
  start: Position
  end: Position
  constructor(startLine: number | Position, startChar: number | Position, endLine?: number, endChar?: number) {
    if (startLine instanceof Position && startChar instanceof Position) {
      this.start = startLine
      this.end = startChar
    } else if (typeof startLine === 'number' && typeof startChar === 'number' && typeof endLine === 'number' && typeof endChar === 'number') {
      this.start = new Position(startLine, startChar)
      this.end = new Position(endLine, endChar)
    } else {
      throw new Error('Invalid arguments for Range constructor')
    }
  }
  get isEmpty() { return this.start.isEqual(this.end) }
  get isSingleLine() { return this.start.line === this.end.line }
  contains(positionOrRange: Position | Range) {
    if (positionOrRange instanceof Position) {
      return positionOrRange.isAfterOrEqual(this.start) && positionOrRange.isBeforeOrEqual(this.end)
    }
    return positionOrRange.start.isAfterOrEqual(this.start) && positionOrRange.end.isBeforeOrEqual(this.end)
  }
  isEqual(other: Range) {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end)
  }
}

export class Selection extends Range {
  anchor: Position
  active: Position
  isReversed: boolean
  constructor(anchor: Position, active: Position) {
    super(anchor, active)
    this.anchor = anchor
    this.active = active
    this.isReversed = anchor.isAfter(active)
  }
}

export class Disposable {
  private disposed = false
  constructor(private readonly callOnDispose: () => void) {}
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.callOnDispose()
  }
  static from(...disposables: { dispose: () => unknown }[]) {
    return new Disposable(() => {
      for (const d of disposables) d.dispose()
    })
  }
}

export class EventEmitter<T> {
  private listeners: Array<{ fn: (e: T) => unknown; thisArgs?: unknown }> = []

  get event(): Event<T> {
    return (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Array<{ dispose(): void }>) => {
      const entry = { fn: listener, thisArgs }
      this.listeners.push(entry)
      const disposable = new Disposable(() => {
        const index = this.listeners.indexOf(entry)
        if (index > -1) this.listeners.splice(index, 1)
      })
      if (Array.isArray(disposables)) {
        disposables.push(disposable)
      }
      return disposable
    }
  }

  fire(data: T): void {
    const snapshot = this.listeners.slice()
    for (const entry of snapshot) {
      entry.fn.call(entry.thisArgs, data)
    }
  }

  dispose(): void {
    this.listeners = []
  }
}

export class Uri {
  constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
    public readonly fragment: string
  ) {}
  get fsPath() {
    return this.scheme === 'file'
      ? (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(this.path) ? this.path.substring(1) : this.path)
      : this.path
  }
  toString() {
    return `${this.scheme}://${this.authority}${this.path}${this.query ? '?' + this.query : ''}${this.fragment ? '#' + this.fragment : ''}`
  }
  toJSON() {
    return {
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment
    }
  }
  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    )
  }
  static file(filePath: string) {
    const normalized = filePath.replace(/\\/g, '/')
    return new Uri('file', '', normalized.startsWith('/') ? normalized : `/${normalized}`, '', '')
  }
  static parse(uri: string) {
    try {
      const url = new URL(uri)
      return new Uri(
        url.protocol.replace(':', ''),
        url.host,
        decodeURIComponent(url.pathname),
        url.search.replace(/^\?/, ''),
        url.hash.replace(/^#/, '')
      )
    } catch {
      return new Uri('file', '', uri, '', '')
    }
  }
  static joinPath(uri: Uri, ...pathSegments: string[]) {
    return uri.with({ path: path.posix.join(uri.path, ...pathSegments.map(s => s.replace(/\\/g, '/'))) })
  }
  static from(components: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }) {
    return new Uri(
      components.scheme,
      components.authority ?? '',
      components.path ?? '',
      components.query ?? '',
      components.fragment ?? ''
    )
  }
  static revive(data: any) {
    return data instanceof Uri
      ? data
      : new Uri(data.scheme, data.authority ?? '', data.path ?? '', data.query ?? '', data.fragment ?? '')
  }
}

export class CancellationTokenSource {
  private _cancelled = false
  private readonly _emitter = new EventEmitter<void>()
  readonly token: {
    readonly isCancellationRequested: boolean
    readonly onCancellationRequested: Event<void>
  }

  constructor() {
    const self = this
    this.token = {
      get isCancellationRequested() {
        return self._cancelled
      },
      onCancellationRequested: (listener, thisArgs, disposables) => {
        if (self._cancelled) {
          listener.call(thisArgs)
          return new Disposable(() => {})
        }
        return self._emitter.event(listener, thisArgs, disposables)
      }
    }
  }

  cancel(): void {
    if (!this._cancelled) {
      this._cancelled = true
      this._emitter.fire()
    }
  }

  dispose(): void {
    this._emitter.dispose()
  }
}

export class MarkdownString {
  isTrusted?: boolean
  supportThemeIcons?: boolean
  supportHtml?: boolean
  baseUri?: Uri
  constructor(public value: string = '', supportThemeIcons: boolean = false) {
    this.supportThemeIcons = supportThemeIcons
  }
  appendText(value: string): this {
    this.value += value.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&')
    return this
  }
  appendMarkdown(value: string): this {
    this.value += value
    return this
  }
  appendCodeblock(value: string, language: string = ''): this {
    this.value += `\n\`\`\`${language}\n${value}\n\`\`\`\n`
    return this
  }
}

export class SnippetString {
  constructor(public value: string = '') {}
  appendText(str: string): this {
    this.value += str.replace(/[$}\\]/g, '\\$&')
    return this
  }
  appendTabstop(number: number = 0): this {
    this.value += `$${number}`
    return this
  }
  appendPlaceholder(value: string | ((snippet: SnippetString) => unknown), number: number = 0): this {
    if (typeof value === 'function') {
      const nested = new SnippetString()
      value(nested)
      this.value += `\${${number}:${nested.value}}`
    } else {
      this.value += `\${${number}:${value}}`
    }
    return this
  }
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  static readonly File = new ThemeIcon('file')
  static readonly Folder = new ThemeIcon('folder')
  constructor(public readonly id: string, public readonly color?: ThemeColor) {}
}

export class Diagnostic {
  source?: string
  code?: string | number | { value: string | number; target: Uri }
  relatedInformation?: unknown[]
  tags?: number[]
  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity = DiagnosticSeverity.Error
  ) {}
}

export class CompletionItem {
  detail?: string
  documentation?: string | MarkdownString
  sortText?: string
  filterText?: string
  preselect?: boolean
  insertText?: string | SnippetString
  range?: Range | { inserting: Range; replacing: Range }
  commitCharacters?: string[]
  keepWhitespace?: boolean
  textEdit?: TextEdit
  additionalTextEdits?: TextEdit[]
  command?: { title: string; command: string; arguments?: unknown[] }
  tags?: number[]
  constructor(
    public label: string | { label: string; detail?: string; description?: string },
    public kind?: CompletionItemKind
  ) {}
}

export class TreeItem {
  id?: string
  label?: string | { label: string; highlights?: [number, number][] }
  iconPath?: string | Uri | { light: string | Uri; dark: string | Uri } | ThemeIcon
  description?: string | boolean
  resourceUri?: Uri
  tooltip?: string | MarkdownString
  command?: { title: string; command: string; arguments?: unknown[] }
  collapsibleState?: TreeItemCollapsibleState
  contextValue?: string
  accessibilityInformation?: { label: string; role?: string }

  constructor(
    labelOrUri: string | { label: string; highlights?: [number, number][] } | Uri,
    collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None
  ) {
    if (labelOrUri instanceof Uri) {
      this.resourceUri = labelOrUri
      this.label = path.basename(labelOrUri.fsPath)
    } else {
      this.label = labelOrUri
    }
    this.collapsibleState = collapsibleState
  }
}

export class Hover {
  constructor(
    public contents: string | MarkdownString | Array<string | MarkdownString>,
    public range?: Range
  ) {}
}

export class Location {
  constructor(public uri: Uri, public range: Range | Position) {}
}

export class TextEdit {
  constructor(public range: Range, public newText: string) {}
  static replace(range: Range, newText: string) { return new TextEdit(range, newText) }
  static insert(position: Position, newText: string) { return new TextEdit(new Range(position, position), newText) }
  static delete(range: Range) { return new TextEdit(range, '') }
}

export class CodeAction {
  edit?: WorkspaceEdit
  diagnostics?: Diagnostic[]
  command?: { title: string; command: string; arguments?: unknown[] }
  isPreferred?: boolean
  disabled?: { reason: string }
  constructor(public title: string, public kind?: string) {}
}

export class ParameterInformation {
  constructor(public label: string | [number, number], public documentation?: string | MarkdownString) {}
}

export class SignatureInformation {
  parameters: ParameterInformation[] = []
  activeParameter?: number
  constructor(public label: string, public documentation?: string | MarkdownString) {}
}

export class SymbolInformation {
  tags?: number[]
  constructor(
    public name: string,
    public kind: number,
    public containerName: string,
    public location: Location
  ) {}
}

export class WorkspaceEdit {
  private readonly edits = new Map<string, { uri: Uri; edits: TextEdit[] }>()
  replace(uri: Uri, range: Range, newText: string): void {
    this.addEdit(uri, TextEdit.replace(range, newText))
  }
  insert(uri: Uri, position: Position, newText: string): void {
    this.addEdit(uri, TextEdit.insert(position, newText))
  }
  delete(uri: Uri, range: Range): void {
    this.addEdit(uri, TextEdit.delete(range))
  }
  set(uri: Uri, edits: TextEdit[]): void {
    this.edits.set(uri.toString(), { uri, edits: edits.slice() })
  }
  get(uri: Uri): TextEdit[] {
    return this.edits.get(uri.toString())?.edits.slice() ?? []
  }
  has(uri: Uri): boolean {
    return this.edits.has(uri.toString())
  }
  entries(): Array<[Uri, TextEdit[]]> {
    return Array.from(this.edits.values()).map(v => [v.uri, v.edits.slice()])
  }
  get size(): number {
    return this.edits.size
  }
  private addEdit(uri: Uri, edit: TextEdit): void {
    const key = uri.toString()
    const entry = this.edits.get(key)
    if (entry) entry.edits.push(edit)
    else this.edits.set(key, { uri, edits: [edit] })
  }
}

/**
 * File-backed Memento implementation for ExtensionContext.globalState & workspaceState.
 */
export function createMemento(storageFilePath?: string): GlobalMemento {
  const data = new Map<string, unknown>()
  const syncedKeys = new Set<string>()
  let loaded = false

  const ensureLoaded = () => {
    if (loaded) return
    loaded = true
    if (!storageFilePath) return
    try {
      if (fs.existsSync(storageFilePath)) {
        const parsed = JSON.parse(fs.readFileSync(storageFilePath, 'utf-8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            data.set(k, v)
          }
        }
      }
    } catch {
      // Ignore corrupt state file and start fresh
    }
  }

  const persist = async () => {
    if (!storageFilePath) return
    try {
      await fs.promises.mkdir(path.dirname(storageFilePath), { recursive: true })
      const obj = Object.fromEntries(data.entries())
      await fs.promises.writeFile(storageFilePath, JSON.stringify(obj, null, 2), 'utf-8')
    } catch {
      // Non-fatal if storage directory is read-only
    }
  }

  return {
    keys(): readonly string[] {
      ensureLoaded()
      return Array.from(data.keys())
    },
    get<T>(key: string, defaultValue?: T): T {
      ensureLoaded()
      return (data.has(key) ? data.get(key) : defaultValue) as T
    },
    async update(key: string, value: unknown): Promise<void> {
      ensureLoaded()
      if (value === undefined) {
        data.delete(key)
      } else {
        data.set(key, value)
      }
      await persist()
    },
    setKeysForSync(keys: readonly string[]): void {
      syncedKeys.clear()
      for (const k of keys) syncedKeys.add(k)
    }
  }
}

export function createSecretStorage(): SecretStorage {
  const store = new Map<string, string>()
  const emitter = new EventEmitter<{ key: string }>()
  return {
    async get(key: string): Promise<string | undefined> {
      return store.get(key)
    },
    async store(key: string, value: string): Promise<void> {
      store.set(key, value)
      emitter.fire({ key })
    },
    async delete(key: string): Promise<void> {
      if (store.delete(key)) {
        emitter.fire({ key })
      }
    },
    onDidChange: emitter.event
  }
}

let statusBarCounter = 0

/**
 * Builds the 'vscode' module object for one extension. Commands, messages,
 * output channels, status bar items, and configuration flow through `bridge`.
 */
export function createVSCodeAPI(extensionId: string, context: ShimExtensionContext, bridge: CommandBridge): unknown {
  const configStore = bridge.configurationStore ?? new Map<string, unknown>()
  const configChangeEmitter = new EventEmitter<{ affectsConfiguration(section: string): boolean }>()
  const workspaceFoldersChangeEmitter = new EventEmitter<{ added: unknown[]; removed: unknown[] }>()

  const resolveWorkspaceFolders = () => {
    if (bridge.getWorkspaceFolders) {
      return bridge.getWorkspaceFolders()
    }
    const envWorkspace = process.env.KALYNT_WORKSPACE_PATH
    if (envWorkspace) {
      return [{ uri: Uri.file(envWorkspace), name: path.basename(envWorkspace), index: 0 }]
    }
    return undefined
  }

  return {
    version: '1.85.0',

    // Extension context metadata
    extension: {
      id: extensionId,
      extensionPath: context.extensionPath,
      extensionUri: context.extensionUri ?? Uri.file(context.extensionPath),
      packageJSON: context.packageJSON ?? {}
    },

    // Enums
    DiagnosticSeverity,
    CompletionItemKind,
    TreeItemCollapsibleState,
    StatusBarAlignment,
    ExtensionMode,
    FileType,

    // Types
    Position,
    Range,
    Selection,
    Disposable,
    Uri,
    CancellationTokenSource,
    CodeAction,
    CompletionItem,
    Diagnostic,
    Hover,
    Location,
    MarkdownString,
    ParameterInformation,
    SignatureInformation,
    SnippetString,
    SymbolInformation,
    TextEdit,
    ThemeColor,
    ThemeIcon,
    TreeItem,
    WorkspaceEdit,

    // Commands
    commands: {
      registerCommand: (command: string, callback: (...args: unknown[]) => unknown, thisArg?: unknown) => {
        const bound = thisArg ? callback.bind(thisArg) : callback
        bridge.registerCommandHandler(extensionId, command, bound)
        bridge.sendMessage({
          type: 'register-command',
          payload: { extensionId, command }
        })

        const disposable = new Disposable(() => {
          bridge.unregisterCommandHandler(extensionId, command)
          bridge.sendMessage({
            type: 'unregister-command',
            payload: { extensionId, command }
          })
        })

        context.subscriptions.push(disposable)
        return disposable
      },
      executeCommand: (command: string, ...args: unknown[]) => {
        const messageId = bridge.nextMessageId()
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (bridge.pendingResponses.has(messageId)) {
              bridge.pendingResponses.delete(messageId)
              reject(new Error(`Command execution timeout: ${command}`))
            }
          }, 10000)

          bridge.pendingResponses.set(messageId, {
            resolve: (val) => {
              clearTimeout(timer)
              resolve(val)
            },
            reject: (err) => {
              clearTimeout(timer)
              reject(err)
            }
          })

          bridge.sendMessage({
            type: 'execute-command',
            payload: { command, args, messageId }
          })
        })
      },
      getCommands: async (filterInternal = false): Promise<string[]> => {
        const cmds = bridge.getRegisteredCommands?.(filterInternal) ?? []
        return filterInternal ? cmds.filter(c => !c.startsWith('_')) : cmds
      }
    },

    // Window
    window: {
      showInformationMessage: async (message: string, ...items: unknown[]) => {
        bridge.sendMessage({
          type: 'show-message',
          payload: { type: 'info', message, extensionId, items }
        })
        return undefined
      },
      showWarningMessage: async (message: string, ...items: unknown[]) => {
        bridge.sendMessage({
          type: 'show-message',
          payload: { type: 'warning', message, extensionId, items }
        })
        return undefined
      },
      showErrorMessage: async (message: string, ...items: unknown[]) => {
        bridge.sendMessage({
          type: 'show-message',
          payload: { type: 'error', message, extensionId, items }
        })
        return undefined
      },
      createOutputChannel: (name: string) => {
        let buffer = ''
        let disposed = false
        const channel = {
          name,
          append(value: string) {
            if (disposed) return
            buffer += value
            bridge.sendMessage({
              type: 'log-message',
              payload: { level: 'info', channel: name, extensionId, message: value }
            })
          },
          appendLine(value: string) {
            if (disposed) return
            const line = `${value}\n`
            buffer += line
            bridge.sendMessage({
              type: 'log-message',
              payload: { level: 'info', channel: name, extensionId, message: value }
            })
          },
          replace(value: string) {
            if (disposed) return
            buffer = value
          },
          clear() {
            buffer = ''
          },
          show(_preserveFocus?: boolean) {
            if (disposed) return
            bridge.sendMessage({
              type: 'log-message',
              payload: { level: 'info', channel: name, extensionId, message: `[OutputChannel:${name}] shown (${buffer.length} chars)` }
            })
          },
          hide() {
            // No-op in headless host
          },
          dispose() {
            disposed = true
            buffer = ''
          }
        }
        return channel
      },
      createStatusBarItem: (
        idOrAlignment?: string | StatusBarAlignment,
        alignmentOrPriority?: StatusBarAlignment | number,
        priorityArg?: number
      ) => {
        const id = typeof idOrAlignment === 'string'
          ? idOrAlignment
          : `${extensionId}.statusbar.${++statusBarCounter}`
        const alignment = typeof idOrAlignment === 'string'
          ? (typeof alignmentOrPriority === 'number' ? alignmentOrPriority : StatusBarAlignment.Left)
          : (typeof idOrAlignment === 'number' ? idOrAlignment : StatusBarAlignment.Left)
        const priority = typeof idOrAlignment === 'string'
          ? priorityArg
          : (typeof alignmentOrPriority === 'number' ? alignmentOrPriority : undefined)

        let visible = false
        let disposed = false

        const item = {
          id,
          alignment,
          priority,
          name: undefined as string | undefined,
          text: '',
          tooltip: undefined as string | MarkdownString | undefined,
          color: undefined as string | ThemeColor | undefined,
          backgroundColor: undefined as ThemeColor | undefined,
          command: undefined as string | { title: string; command: string; arguments?: unknown[] } | undefined,
          accessibilityInformation: undefined as { label: string; role?: string } | undefined,
          show() {
            if (disposed) return
            visible = true
            bridge.sendMessage({
              type: 'status-bar-update',
              payload: {
                id,
                extensionId,
                alignment,
                priority,
                text: item.text,
                tooltip: typeof item.tooltip === 'string' ? item.tooltip : item.tooltip?.value,
                command: typeof item.command === 'string' ? item.command : item.command?.command,
                visible
              }
            })
          },
          hide() {
            if (disposed) return
            visible = false
            bridge.sendMessage({
              type: 'status-bar-update',
              payload: { id, extensionId, visible: false }
            })
          },
          dispose() {
            if (disposed) return
            disposed = true
            visible = false
            bridge.sendMessage({
              type: 'status-bar-dispose',
              payload: { id, extensionId }
            })
          }
        }
        return item
      }
    },

    // Workspace
    workspace: {
      get workspaceFolders() {
        return resolveWorkspaceFolders()
      },
      get name() {
        const folders = resolveWorkspaceFolders()
        return folders && folders.length > 0 ? folders[0].name : undefined
      },
      getWorkspaceFolder: (uri: Uri) => {
        const folders = resolveWorkspaceFolders()
        if (!folders) return undefined
        const target = uri.fsPath.replace(/\\/g, '/')
        return folders.find(f => {
          const root = f.uri.fsPath.replace(/\\/g, '/')
          const prefix = root.endsWith('/') ? root : `${root}/`
          return target === root || target.startsWith(prefix)
        })
      },
      getConfiguration: (section?: string) => {
        const fullKey = (key: string) => (section ? `${section}.${key}` : key)
        return {
          get: <T>(key: string, defaultValue?: T): T | undefined => {
            const k = fullKey(key)
            return (configStore.has(k) ? configStore.get(k) : defaultValue) as T | undefined
          },
          has: (key: string): boolean => configStore.has(fullKey(key)),
          inspect: <T>(key: string) => {
            const k = fullKey(key)
            return {
              key: k,
              globalValue: configStore.get(k) as T | undefined
            }
          },
          update: async (key: string, value: unknown): Promise<void> => {
            const k = fullKey(key)
            if (value === undefined) configStore.delete(k)
            else configStore.set(k, value)
            configChangeEmitter.fire({
              affectsConfiguration: (s: string) => k === s || k.startsWith(`${s}.`) || s.startsWith(`${k}.`)
            })
          }
        }
      },
      onDidChangeConfiguration: configChangeEmitter.event,
      onDidChangeWorkspaceFolders: workspaceFoldersChangeEmitter.event,
      fs: {
        async stat(uri: Uri) {
          const s = await fs.promises.stat(uri.fsPath)
          return {
            type: s.isDirectory() ? FileType.Directory : s.isFile() ? FileType.File : FileType.Unknown,
            ctime: s.ctimeMs,
            mtime: s.mtimeMs,
            size: s.size
          }
        },
        async readFile(uri: Uri) {
          const buf = await fs.promises.readFile(uri.fsPath)
          return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        },
        async writeFile(uri: Uri, content: Uint8Array) {
          await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true })
          await fs.promises.writeFile(uri.fsPath, content)
        },
        async readDirectory(uri: Uri) {
          const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true })
          return entries.map(e => [
            e.name,
            e.isDirectory() ? FileType.Directory : e.isFile() ? FileType.File : FileType.Unknown
          ] as [string, FileType])
        },
        async createDirectory(uri: Uri) {
          await fs.promises.mkdir(uri.fsPath, { recursive: true })
        },
        async delete(uri: Uri, options?: { recursive?: boolean }) {
          await fs.promises.rm(uri.fsPath, { recursive: !!options?.recursive, force: true })
        }
      }
    },

    // Languages
    languages: {
      registerCompletionItemProvider: () => {
        const disposable = new Disposable(() => {})
        context.subscriptions.push(disposable)
        return disposable
      },
      registerHoverProvider: () => {
        const disposable = new Disposable(() => {})
        context.subscriptions.push(disposable)
        return disposable
      },
      registerDefinitionProvider: () => {
        const disposable = new Disposable(() => {})
        context.subscriptions.push(disposable)
        return disposable
      },
      createDiagnosticCollection: (name?: string) => {
        const entries = new Map<string, [Uri, Diagnostic[]]>()
        return {
          name: name ?? `${extensionId}.diagnostics`,
          set(uri: Uri, diagnostics?: Diagnostic[]) {
            if (!diagnostics) entries.delete(uri.toString())
            else entries.set(uri.toString(), [uri, diagnostics.slice()])
          },
          delete(uri: Uri) { entries.delete(uri.toString()) },
          clear() { entries.clear() },
          forEach(cb: (uri: Uri, diagnostics: Diagnostic[]) => void) {
            for (const [uri, diags] of entries.values()) cb(uri, diags)
          },
          get(uri: Uri) { return entries.get(uri.toString())?.[1] },
          has(uri: Uri) { return entries.has(uri.toString()) },
          dispose() { entries.clear() }
        }
      }
    },

    // Debug
    debug: {
      registerDebugConfigurationProvider: () => {
        const disposable = new Disposable(() => {})
        context.subscriptions.push(disposable)
        return disposable
      }
    },

    // Environment
    env: {
      appName: 'Kalynt',
      appRoot: context.extensionPath,
      language: 'en',
      machineId: 'unknown',
      sessionId: 'unknown',
      shell: process.platform === 'win32' ? 'powershell' : 'bash'
    },

    // Event
    EventEmitter
  }
}

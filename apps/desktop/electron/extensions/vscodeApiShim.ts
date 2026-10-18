/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * A minimal 'vscode' API surface handed to extensions running in the
 * extension host. Covers the pieces common extensions touch; everything
 * else is a stub.
 */
import * as path from 'path'

/** What the shim needs from the extension host to talk to the main process. */
export interface CommandBridge {
  sendMessage(message: { type: string; payload?: unknown; messageId?: number }): void
  nextMessageId(): number
  pendingResponses: Map<number, { resolve: (value: unknown) => void }>
}

/** The extension context passed to activate(), as the shim exposes it. */
export interface ShimExtensionContext {
  subscriptions: Array<{ dispose(): void }>
  extensionPath: string
}

class Position {
  constructor(public line: number, public character: number) {}
  isBefore(other: Position) { return this.line < other.line || (this.line === other.line && this.character < other.character) }
  isBeforeOrEqual(other: Position) { return this.line < other.line || (this.line === other.line && this.character <= other.character) }
  isAfter(other: Position) { return !this.isBeforeOrEqual(other) }
  isAfterOrEqual(other: Position) { return !this.isBefore(other) }
  isEqual(other: Position) { return this.line === other.line && this.character === other.character }
  compareTo(other: Position) { return this.isBefore(other) ? -1 : (this.isAfter(other) ? 1 : 0) }
  translate(lineDelta: number = 0, characterDelta: number = 0) { return new Position(this.line + lineDelta, this.character + characterDelta) }
  with(change: { line?: number, character?: number }) { return new Position(change.line ?? this.line, change.character ?? this.character) }
}

class Range {
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
  isEmpty() { return this.start.isEqual(this.end) }
  isSingleLine() { return this.start.line === this.end.line }
  contains(positionOrRange: Position | Range) {
    if (positionOrRange instanceof Position) {
      return positionOrRange.isAfterOrEqual(this.start) && positionOrRange.isBeforeOrEqual(this.end)
    }
    return positionOrRange.start.isAfterOrEqual(this.start) && positionOrRange.end.isBeforeOrEqual(this.end)
  }
}

class Selection extends Range {
  anchor: Position;
  active: Position;
  isReversed: boolean;
  constructor(anchor: Position, active: Position) {
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
    this.isReversed = anchor.isAfter(active);
  }
}

class Disposable {
  constructor(private callOnDispose: () => void) {}
  dispose() { this.callOnDispose() }
  static from(...disposables: { dispose: () => any }[]) {
    return new Disposable(() => {
      for (const d of disposables) d.dispose();
    });
  }
}

class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = []

  get event() {
    return (listener: (e: T) => void) => {
      this.listeners.push(listener)
      return {
        dispose: () => {
          const index = this.listeners.indexOf(listener)
          if (index > -1) this.listeners.splice(index, 1)
        }
      }
    }
  }

  fire(data: T): void {
    this.listeners.forEach(listener => listener(data))
  }

  dispose(): void {
    this.listeners = []
  }
}

class Uri {
  constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
    public readonly fragment: string
  ) {}
  get fsPath() { return this.scheme === 'file' ? (process.platform === 'win32' ? this.path.substring(1) : this.path) : this.path }
  toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? '?' + this.query : ''}${this.fragment ? '#' + this.fragment : ''}` }
  with(change: any) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    )
  }
  static file(path: string) {
    const normalized = path.replace(/\\/g, '/')
    return new Uri('file', '', normalized.startsWith('/') ? normalized : `/${normalized}`, '', '')
  }
  static parse(uri: string) {
    try {
      const url = new URL(uri)
      return new Uri(url.protocol.replace(':', ''), url.host, url.pathname, url.search, url.hash)
    } catch {
      return new Uri('file', '', uri, '', '')
    }
  }
  static joinPath(uri: Uri, ...pathSegments: string[]) {
    return uri.with({ path: path.join(uri.path, ...pathSegments).replace(/\\/g, '/') })
  }
  static from(components: any) {
    return new Uri(components.scheme, components.authority, components.path, components.query, components.fragment)
  }
  static revive(data: any) { return data instanceof Uri ? data : new Uri(data.scheme, data.authority, data.path, data.query, data.fragment) }
}

// Stubs for classes extensions reference but the shim does not implement.
class CancellationTokenSource { token = { onCancellationRequested: () => ({ dispose: () => {} }) } }
class CodeAction {}
class CompletionItem {}
class Diagnostic {}
class Hover {}
class Location {}
class MarkdownString {}
class ParameterInformation {}
class SignatureInformation {}
class SnippetString {}
class SymbolInformation {}
class TextEdit {}
class ThemeColor {}
class TreeItem {}
class WorkspaceEdit {}

/**
 * Builds the 'vscode' module object for one extension. Commands registered
 * through it are forwarded to the main process via `bridge`.
 */
export function createVSCodeAPI(extensionId: string, context: ShimExtensionContext, bridge: CommandBridge): unknown {
  return {
    version: '1.85.0',

    // Extension context
    extension: {
      id: extensionId,
      extensionPath: context.extensionPath,
      extensionUri: Uri.file(context.extensionPath),
      packageJSON: {}
    },

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
    TreeItem,
    WorkspaceEdit,

    // Commands
    commands: {
      registerCommand: (command: string, _callback: (...args: unknown[]) => unknown) => {
        bridge.sendMessage({
          type: 'register-command',
          payload: { extensionId, command }
        })

        const disposable = {
          dispose: () => {
            bridge.sendMessage({
              type: 'unregister-command',
              payload: { extensionId, command }
            })
          }
        }

        context.subscriptions.push(disposable)
        return disposable
      },
      executeCommand: (command: string, ...args: unknown[]) => {
        const messageId = bridge.nextMessageId()
        return new Promise((resolve, reject) => {
          bridge.pendingResponses.set(messageId, { resolve })
          bridge.sendMessage({
            type: 'execute-command',
            payload: { command, args },
            messageId
          })
          setTimeout(() => {
            if (bridge.pendingResponses.has(messageId)) {
              bridge.pendingResponses.delete(messageId)
              // HIGH-001 FIX: Properly reject the promise on timeout instead of resolving with undefined
              reject(new Error(`Command execution timeout: ${command}`))
            }
          }, 10000)
        })
      }
    },

    // Window
    window: {
      showInformationMessage: (message: string) => {
        bridge.sendMessage({
          type: 'show-message',
          payload: { type: 'info', message, extensionId }
        })
      },
      showWarningMessage: (message: string) => {
        bridge.sendMessage({
          type: 'show-message',
          payload: { type: 'warning', message, extensionId }
        })
      },
      showErrorMessage: (message: string) => {
        bridge.sendMessage({
          type: 'show-message',
          payload: { type: 'error', message, extensionId }
        })
      }
    },

    // Workspace
    workspace: {
      getConfiguration: (_section?: string) => ({
        get: (key: string, defaultValue?: unknown) => defaultValue,
        update: async () => {}
      }),
      onDidChangeConfiguration: {
        event: () => ({ dispose: () => {} })
      }
    },

    // Languages
    languages: {
      registerCompletionItemProvider: () => {
        const disposable = { dispose: () => {} }
        context.subscriptions.push(disposable)
        return disposable
      }
    },

    // Debug
    debug: {
      registerDebugConfigurationProvider: () => {
        const disposable = { dispose: () => {} }
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

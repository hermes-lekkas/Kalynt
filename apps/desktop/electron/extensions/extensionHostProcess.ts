/**
 * Extension Host Process
 * Runs in a separate Node.js process to isolate extensions from the main application
 * Based on VS Code's Extension Host architecture
 */

import * as path from 'path'
import * as fs from 'fs'
import Module from 'module'
import {
  createVSCodeAPI as returnVsCodeAPI,
  createMemento,
  createSecretStorage,
  ExtensionMode,
  Uri,
  type GlobalMemento,
  type Memento,
  type SecretStorage
} from './vscodeApiShim'

// Message types for communication with main process
interface HostMessage {
  type: string
  payload?: unknown
  error?: string
  messageId?: number
}

interface ExtensionModule {
  activate?: (context: ExtensionContext) => Promise<unknown> | unknown
  deactivate?: () => Promise<void> | void
}

interface ExtensionContext {
  subscriptions: Array<{ dispose(): void }>
  extensionPath: string
  extensionUri: Uri
  asAbsolutePath: (relativePath: string) => string
  storagePath: string
  globalStoragePath: string
  storageUri: Uri
  globalStorageUri: Uri
  logPath: string
  logUri: Uri
  globalState: GlobalMemento
  workspaceState: Memento
  secrets: SecretStorage
  extensionMode: ExtensionMode
  packageJSON: Record<string, unknown>
}

export class ExtensionHost {
  private extensions: Map<string, {
    module: ExtensionModule
    context: ExtensionContext
    manifest: Record<string, unknown>
    exports: unknown
  }> = new Map()

  private extensionPaths: Map<string, string> = new Map()
  private apiFactory: Map<string, unknown> = new Map()
  private commandHandlers: Map<string, { extensionId: string; callback: (...args: unknown[]) => unknown }> = new Map()
  private configurationStore: Map<string, unknown> = new Map()
  private workspaceFolders: Array<{ uri: Uri; name: string; index: number }> | undefined =
    process.env.KALYNT_WORKSPACE_PATH
      ? [{ uri: Uri.file(process.env.KALYNT_WORKSPACE_PATH), name: path.basename(process.env.KALYNT_WORKSPACE_PATH), index: 0 }]
      : undefined
  private nextRequestId = 1
  private pendingResponses: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }> = new Map()

  constructor() {
    this.hookModuleLoader()
    this.redirectConsole()
    this.setupMessageHandlers()
  }

  private redirectConsole(): void {
    const originalLog = console.log
    const originalWarn = console.warn
    const originalError = console.error

    console.log = (...args: unknown[]) => {
      this.sendMessage({
        type: 'log-message',
        payload: { level: 'info', message: args.map(String).join(' ') }
      })
      originalLog.apply(console, args)
    }

    console.warn = (...args: unknown[]) => {
      this.sendMessage({
        type: 'log-message',
        payload: { level: 'warn', message: args.map(String).join(' ') }
      })
      originalWarn.apply(console, args)
    }

    console.error = (...args: unknown[]) => {
      this.sendMessage({
        type: 'log-message',
        payload: { level: 'error', message: args.map(String).join(' ') }
      })
      originalError.apply(console, args)
    }
  }

  private hookModuleLoader(): void {
    const originalLoad = (Module as any)._load
    ;(Module as any)._load = (request: string, parent: any, isMain: boolean) => {
      if (request === 'vscode') {
        const filename = parent?.filename
        if (typeof filename === 'string' && filename.length > 0) {
          const extensionId = this.findExtensionIdByPath(filename)
          if (extensionId) {
            const api = this.apiFactory.get(extensionId)
            if (api) return api
          }
        }
      }
      return originalLoad.apply(Module, [request, parent, isMain])
    }
  }

  public findExtensionIdByPath(filePath: string): string | undefined {
    if (!filePath) return undefined
    const normalizedPath = filePath.replace(/\\/g, '/')
    let bestId: string | undefined
    let bestLength = -1

    for (const [id, rootPath] of this.extensionPaths) {
      const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
      const rootWithSep = `${normalizedRoot}/`
      if (
        (normalizedPath === normalizedRoot || normalizedPath.startsWith(rootWithSep)) &&
        normalizedRoot.length > bestLength
      ) {
        bestId = id
        bestLength = normalizedRoot.length
      }
    }
    return bestId
  }

  private setupMessageHandlers(): void {
    process.on('message', async (message: HostMessage) => {
      try {
        switch (message.type) {
          case 'load-extension':
            await this.handleLoadExtension(message.payload as { id: string; path: string })
            break
          case 'activate-extension':
            await this.handleActivateExtension(message.payload as { id: string })
            break
          case 'deactivate-extension':
            await this.handleDeactivateExtension(message.payload as { id: string })
            break
          case 'invoke-command':
            await this.handleInvokeCommand(
              message.payload as { extensionId: string; command: string; args?: unknown[]; invocationId?: number }
            )
            break
          case 'invoke-api':
            await this.handleInvokeAPI(
              message.payload as { extensionId: string; api: string; args?: unknown[]; messageId?: number }
            )
            break
          case 'command-result':
            this.handleCommandResult(message.payload as { messageId: number; result?: unknown; error?: string })
            break
          case 'update-workspace-folders': {
            const folders = (message.payload as { folders?: string[] })?.folders
            this.workspaceFolders = Array.isArray(folders) && folders.length > 0
              ? folders.map((f, index) => ({ uri: Uri.file(f), name: path.basename(f), index }))
              : undefined
            break
          }
          case 'dispose':
            await this.dispose()
            break
          default:
            this.sendError('unknown-message-type', `Unknown message type: ${message.type}`)
        }
      } catch (error) {
        this.sendError('handler-error', error instanceof Error ? error.message : String(error))
      }
    })

    // Signal ready to main process
    this.sendMessage({ type: 'ready' })
  }

  private createExtensionContext(extensionPath: string, manifest: Record<string, unknown>): ExtensionContext {
    const storagePath = path.join(extensionPath, '.kalynt', 'workspace-storage')
    const globalStoragePath = path.join(extensionPath, '.kalynt', 'global-storage')
    const logPath = path.join(extensionPath, '.kalynt', 'logs')

    return {
      subscriptions: [],
      extensionPath,
      extensionUri: Uri.file(extensionPath),
      asAbsolutePath: (relativePath: string) => path.join(extensionPath, relativePath),
      storagePath,
      globalStoragePath,
      storageUri: Uri.file(storagePath),
      globalStorageUri: Uri.file(globalStoragePath),
      logPath,
      logUri: Uri.file(logPath),
      globalState: createMemento(path.join(globalStoragePath, 'state.json')),
      workspaceState: createMemento(path.join(storagePath, 'state.json')),
      secrets: createSecretStorage(),
      extensionMode: ExtensionMode.Production,
      packageJSON: manifest
    }
  }

  private async handleLoadExtension(payload: { id: string; path: string }): Promise<void> {
    const { id, path: extensionPath } = payload

    try {
      if (!fs.existsSync(extensionPath)) {
        throw new Error(`Extension path does not exist: ${extensionPath}`)
      }

      const packageJsonPath = path.join(extensionPath, 'package.json')
      if (!fs.existsSync(packageJsonPath)) {
        throw new Error(`Extension missing package.json: ${extensionPath}`)
      }

      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))

      if (!manifest.engines?.vscode) {
        throw new Error(`Extension ${id} is not VS Code compatible (missing engines.vscode)`)
      }

      // Node resolves CommonJS module filenames through filesystem aliases.
      this.extensionPaths.set(id, fs.realpathSync(extensionPath))

      this.sendMessage({
        type: 'extension-loaded',
        payload: { id, manifest }
      })
    } catch (error) {
      const errorMsg = `Failed to load extension ${id}: ${error instanceof Error ? error.message : String(error)}`
      this.sendMessage({
        type: 'load-extension-failed',
        payload: { id, error: errorMsg }
      })
      this.sendError('load-extension-failed', errorMsg)
    }
  }

  private async handleActivateExtension(payload: { id: string }): Promise<void> {
    const { id } = payload
    const extensionPath = this.extensionPaths.get(id)

    if (!extensionPath) {
      const errorMsg = `Extension ${id} not loaded`
      this.sendMessage({ type: 'activate-failed', payload: { id, error: errorMsg } })
      this.sendError('activate-failed', errorMsg)
      return
    }

    try {
      if (this.extensions.has(id)) {
        this.sendMessage({
          type: 'extension-activated',
          payload: { id, exports: this.extensions.get(id)?.exports }
        })
        return
      }

      const packageJsonPath = path.join(extensionPath, 'package.json')
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>

      const context = this.createExtensionContext(extensionPath, manifest)

      // Handle declarative extensions without a JS entrypoint (e.g., themes, grammars, snippets)
      if (!manifest.main || typeof manifest.main !== 'string') {
        this.extensions.set(id, {
          module: {},
          context,
          manifest,
          exports: undefined
        })

        this.sendMessage({
          type: 'extension-activated',
          payload: { id, exports: undefined }
        })
        return
      }

      const mainFile = manifest.main
      let mainPath = path.join(extensionPath, mainFile)

      if (!fs.existsSync(mainPath)) {
        if (fs.existsSync(mainPath + '.js')) {
          mainPath += '.js'
        } else {
          throw new Error(`Extension main file not found: ${mainPath}`)
        }
      }

      const vscode = this.createVSCodeAPI(id, context)
      this.apiFactory.set(id, vscode)

      // Clear require cache to allow reload
      delete require.cache[require.resolve(mainPath)]

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const extensionModule: ExtensionModule = require(mainPath)

      let exports: unknown
      if (typeof extensionModule.activate === 'function') {
        exports = await Promise.resolve(extensionModule.activate(context))
      }

      this.extensions.set(id, {
        module: extensionModule,
        context,
        manifest,
        exports
      })

      this.sendMessage({
        type: 'extension-activated',
        payload: { id, exports: this.serializeSafe(exports) }
      })
    } catch (error) {
      this.apiFactory.delete(id)
      this.cleanupCommandsForExtension(id)
      const errorMsg = `Failed to activate extension ${id}: ${error instanceof Error ? error.message : String(error)}`
      this.sendMessage({
        type: 'activate-failed',
        payload: { id, error: errorMsg }
      })
      this.sendError('activate-failed', errorMsg)
    }
  }

  private async handleDeactivateExtension(payload: { id: string }): Promise<void> {
    const { id } = payload
    const extension = this.extensions.get(id)

    if (!extension) {
      this.sendError('deactivate-failed', `Extension ${id} not activated`)
      return
    }

    try {
      if (typeof extension.module.deactivate === 'function') {
        await Promise.resolve(extension.module.deactivate())
      }

      for (const subscription of extension.context.subscriptions) {
        try {
          subscription.dispose()
        } catch (error) {
          console.error(`Error disposing subscription for ${id}:`, error)
        }
      }

      this.cleanupCommandsForExtension(id)
      this.extensions.delete(id)
      this.apiFactory.delete(id)

      this.sendMessage({
        type: 'extension-deactivated',
        payload: { id }
      })
    } catch (error) {
      this.sendError('deactivate-failed', `Failed to deactivate extension ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private cleanupCommandsForExtension(extensionId: string): void {
    for (const [cmd, entry] of Array.from(this.commandHandlers.entries())) {
      if (entry.extensionId === extensionId) {
        this.commandHandlers.delete(cmd)
      }
    }
  }

  private async handleInvokeCommand(payload: {
    extensionId: string
    command: string
    args?: unknown[]
    invocationId?: number
  }): Promise<void> {
    const { command, args = [], invocationId } = payload
    const handler = this.commandHandlers.get(command)

    if (!handler) {
      const errorMsg = `Command handler not found in extension host: ${command}`
      if (invocationId !== undefined) {
        this.sendMessage({
          type: 'invoke-command-result',
          payload: { invocationId, error: errorMsg }
        })
      } else {
        this.sendError('invoke-command-failed', errorMsg)
      }
      return
    }

    try {
      const result = await Promise.resolve(handler.callback(...args))
      if (invocationId !== undefined) {
        this.sendMessage({
          type: 'invoke-command-result',
          payload: { invocationId, result: this.serializeSafe(result) }
        })
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (invocationId !== undefined) {
        this.sendMessage({
          type: 'invoke-command-result',
          payload: { invocationId, error: errorMsg }
        })
      } else {
        this.sendError('invoke-command-failed', errorMsg)
      }
    }
  }

  private async handleInvokeAPI(payload: {
    extensionId: string
    api: string
    args?: unknown[]
    messageId?: number
  }): Promise<void> {
    const { extensionId, api, args = [], messageId } = payload
    const extension = this.extensions.get(extensionId)

    if (!extension) {
      const errorMsg = `Extension ${extensionId} not activated`
      this.sendMessage({
        type: 'api-result',
        payload: { extensionId, api, messageId, error: errorMsg }
      })
      this.sendError('invoke-failed', errorMsg)
      return
    }

    try {
      const segments = String(api || '').split('.').filter(Boolean)
      let target: any = extension.exports
      let owner: any = extension.exports

      for (const segment of segments) {
        if (target == null || (typeof target !== 'object' && typeof target !== 'function')) {
          throw new Error(`API path "${api}" not found on extension ${extensionId} exports`)
        }
        if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
          throw new Error(`Disallowed API segment: ${segment}`)
        }
        owner = target
        target = target[segment]
      }

      if (typeof target !== 'function') {
        throw new Error(`API "${api}" on extension ${extensionId} is not callable`)
      }

      const result = await Promise.resolve(target.apply(owner, args))
      this.sendMessage({
        type: 'api-result',
        payload: { extensionId, api, messageId, result: this.serializeSafe(result) }
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.sendMessage({
        type: 'api-result',
        payload: { extensionId, api, messageId, error: errorMsg }
      })
      this.sendError('invoke-failed', errorMsg)
    }
  }

  private handleCommandResult(payload: { messageId: number; result?: unknown; error?: string }): void {
    const pending = this.pendingResponses.get(payload.messageId)
    if (pending) {
      this.pendingResponses.delete(payload.messageId)
      if (payload.error) {
        pending.reject(new Error(payload.error))
      } else {
        pending.resolve(payload.result)
      }
    }
  }

  private serializeSafe(value: unknown): unknown {
    if (value === undefined || value === null) return value
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return undefined
    }
  }

  /**
   * The 'vscode' module object handed to one extension. Commands and messages
   * flow through this host back to the main process.
   */
  private createVSCodeAPI(extensionId: string, context: ExtensionContext): unknown {
    return returnVsCodeAPI(extensionId, context, {
      sendMessage: (message) => this.sendMessage(message as HostMessage),
      nextMessageId: () => this.nextRequestId++,
      pendingResponses: this.pendingResponses,
      registerCommandHandler: (extId, command, callback) => {
        this.commandHandlers.set(command, { extensionId: extId, callback })
      },
      unregisterCommandHandler: (extId, command) => {
        const existing = this.commandHandlers.get(command)
        if (existing && existing.extensionId === extId) {
          this.commandHandlers.delete(command)
        }
      },
      getRegisteredCommands: (filterInternal = false) => {
        const all = Array.from(this.commandHandlers.keys())
        return filterInternal ? all.filter(c => !c.startsWith('_')) : all
      },
      getWorkspaceFolders: () => this.workspaceFolders,
      configurationStore: this.configurationStore
    })
  }

  private async dispose(): Promise<void> {
    const extensionIds = Array.from(this.extensions.keys())
    for (const id of extensionIds) {
      await this.handleDeactivateExtension({ id })
    }

    for (const pending of this.pendingResponses.values()) {
      pending.reject(new Error('Extension host disposed'))
    }
    this.pendingResponses.clear()
    this.commandHandlers.clear()
    this.extensions.clear()
    this.extensionPaths.clear()

    this.sendMessage({ type: 'disposed' })
    process.exit(0)
  }

  private sendMessage(message: HostMessage): void {
    if (process.send) {
      process.send(message)
    }
  }

  private sendError(code: string, message: string): void {
    this.sendMessage({
      type: 'error',
      error: `${code}: ${message}`
    })
  }
}

// Start the extension host unless explicitly disabled for unit tests
if (process.env.KALYNT_EXTENSION_HOST_NO_AUTOSTART !== '1') {
  new ExtensionHost()
}

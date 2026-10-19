/**
 * Extension Host Process
 * Runs in a separate Node.js process to isolate extensions from the main application
 * Based on VS Code's Extension Host architecture
 */

import * as path from 'path'
import * as fs from 'fs'
import Module from 'module'
import { createVSCodeAPI as returnVsCodeAPI } from './vscodeApiShim'

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
  asAbsolutePath: (relativePath: string) => string
  storagePath: string
  globalStoragePath: string
  logPath: string
}

class ExtensionHost {
  private extensions: Map<string, {
    module: ExtensionModule
    context: ExtensionContext
    manifest: unknown
    exports: unknown
  }> = new Map()

  private extensionPaths: Map<string, string> = new Map()
  private apiFactory: Map<string, unknown> = new Map()
  private nextRequestId = 1
  private pendingResponses: Map<number, { resolve: (value: unknown) => void }> = new Map()

  constructor() {
    this.hookModuleLoader()
    this.redirectConsole()
    this.setupMessageHandlers()
  }

  private redirectConsole(): void {
    const originalLog = console.log
    const originalWarn = console.warn
    const originalError = console.error

    console.log = (..._args: unknown[]) => {
      this.sendMessage({
        type: 'log-message',
        payload: { level: 'info', message: _args.map(String).join(' ') }
      })
      originalLog.apply(console, _args)
    }

    console.warn = (..._args: unknown[]) => {
      this.sendMessage({
        type: 'log-message',
        payload: { level: 'warn', message: _args.map(String).join(' ') }
      })
      originalWarn.apply(console, _args)
    }

    console.error = (..._args: unknown[]) => {
      this.sendMessage({
        type: 'log-message',
        payload: { level: 'error', message: _args.map(String).join(' ') }
      })
      originalError.apply(console, _args)
    }
  }

  private hookModuleLoader(): void {
    const originalLoad = (Module as any)._load
    ;(Module as any)._load = (request: string, parent: any, isMain: boolean) => {
      if (request === 'vscode') {
        const extensionId = this.findExtensionIdByPath(parent.filename)
        if (extensionId) {
          const api = this.apiFactory.get(extensionId)
          if (api) return api
        }
      }
      return originalLoad.apply(Module, [request, parent, isMain])
    }
  }

  private findExtensionIdByPath(filePath: string): string | undefined {
    const normalizedPath = filePath.replace(/\\/g, '/')
    for (const [id, rootPath] of this.extensionPaths) {
      const normalizedRoot = rootPath.replace(/\\/g, '/')
      if (normalizedPath.startsWith(normalizedRoot)) {
        return id
      }
    }
    return undefined
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
          case 'invoke-api':
            await this.handleInvokeAPI(message.payload as { extensionId: string; api: string; args: unknown[] })
            break
          case 'command-result':
            this.handleCommandResult(message.payload as { messageId: number; result: unknown })
            break
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

  private async handleLoadExtension(payload: { id: string; path: string }): Promise<void> {
    const { id, path: extensionPath } = payload

    try {
      // Validate extension path
      if (!fs.existsSync(extensionPath)) {
        throw new Error(`Extension path does not exist: ${extensionPath}`)
      }

      // Read package.json
      const packageJsonPath = path.join(extensionPath, 'package.json')
      if (!fs.existsSync(packageJsonPath)) {
        throw new Error(`Extension missing package.json: ${extensionPath}`)
      }

      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))

      // Validate it's a VS Code compatible extension
      if (!manifest.engines?.vscode) {
        throw new Error(`Extension ${id} is not VS Code compatible (missing engines.vscode)`)
      }

      // Store extension path
      this.extensionPaths.set(id, extensionPath)

      this.sendMessage({
        type: 'extension-loaded',
        payload: { id, manifest }
      })
    } catch (error) {
      this.sendError('load-extension-failed', `Failed to load extension ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async handleActivateExtension(payload: { id: string }): Promise<void> {
    const { id } = payload
    const extensionPath = this.extensionPaths.get(id)

    if (!extensionPath) {
      this.sendError('activate-failed', `Extension ${id} not loaded`)
      return
    }

    try {
      // Check if already activated
      if (this.extensions.has(id)) {
        this.sendMessage({
          type: 'extension-activated',
          payload: { id, exports: this.extensions.get(id)?.exports }
        })
        return
      }

      // Read manifest to find main entry point
      const packageJsonPath = path.join(extensionPath, 'package.json')
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
      
      // Handle extensions without a main file (e.g. themes, snippets)
      if (!manifest.main) {
        // Store extension with dummy module
        this.extensions.set(id, {
          module: {},
          context: {
            subscriptions: [],
            extensionPath,
            asAbsolutePath: (relativePath: string) => path.join(extensionPath, relativePath),
            storagePath: path.join(extensionPath, '.kalynt', 'workspace-storage'),
            globalStoragePath: path.join(extensionPath, '.kalynt', 'global-storage'),
            logPath: path.join(extensionPath, '.kalynt', 'logs')
          },
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

      // Create extension context
      const context: ExtensionContext = {
        subscriptions: [],
        extensionPath,
        asAbsolutePath: (relativePath: string) => path.join(extensionPath, relativePath),
        storagePath: path.join(extensionPath, '.kalynt', 'workspace-storage'),
        globalStoragePath: path.join(extensionPath, '.kalynt', 'global-storage'),
        logPath: path.join(extensionPath, '.kalynt', 'logs')
      }

      // Create a minimal vscode API
      const vscode = this.createVSCodeAPI(id, context)
      
      // Register API for loader
      this.apiFactory.set(id, vscode)

      // Clear require cache to allow reload
      delete require.cache[require.resolve(mainPath)]

      // Load the extension module
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const extensionModule: ExtensionModule = require(mainPath)

      // Call activate if it exists
      let exports: unknown
      if (typeof extensionModule.activate === 'function') {
        exports = await Promise.resolve(extensionModule.activate(context))
      }

      // Store extension
      this.extensions.set(id, {
        module: extensionModule,
        context,
        manifest,
        exports
      })

      this.sendMessage({
        type: 'extension-activated',
        payload: { id, exports }
      })
    } catch (error) {
      this.apiFactory.delete(id) // Cleanup on error
      this.sendError('activate-failed', `Failed to activate extension ${id}: ${error instanceof Error ? error.message : String(error)}`)
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
      // Call deactivate if it exists
      if (typeof extension.module.deactivate === 'function') {
        await Promise.resolve(extension.module.deactivate())
      }

      // Dispose all subscriptions
      for (const subscription of extension.context.subscriptions) {
        try {
          subscription.dispose()
        } catch (error) {
          console.error(`Error disposing subscription for ${id}:`, error)
        }
      }

      // Remove extension
      this.extensions.delete(id)
      this.apiFactory.delete(id) // Cleanup API

      this.sendMessage({
        type: 'extension-deactivated',
        payload: { id }
      })
    } catch (error) {
      this.sendError('deactivate-failed', `Failed to deactivate extension ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async handleInvokeAPI(payload: { extensionId: string; api: string; args: unknown[] }): Promise<void> {
    const { extensionId, api, args } = payload
    const extension = this.extensions.get(extensionId)

    if (!extension) {
      this.sendError('invoke-failed', `Extension ${extensionId} not activated`)
      return
    }

    // API invocation would go here for specific extension APIs
    this.sendMessage({
      type: 'api-result',
      payload: { extensionId, api, result: null }
    })
  }

  private handleCommandResult(payload: { messageId: number; result: unknown }): void {
    const pending = this.pendingResponses.get(payload.messageId)
    if (pending) {
      this.pendingResponses.delete(payload.messageId)
      pending.resolve(payload.result)
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
      pendingResponses: this.pendingResponses
    })
  }

  private async dispose(): Promise<void> {
    const extensionIds = Array.from(this.extensions.keys())
    for (const id of extensionIds) {
      await this.handleDeactivateExtension({ id })
    }

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

// Start the extension host
new ExtensionHost()

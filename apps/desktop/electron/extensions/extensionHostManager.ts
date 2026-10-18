/**
 * Extension Host Manager
 * Manages the extension host process and communication
 * Runs in the Electron main process
 */

import { fork, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { ipcMain, app, BrowserWindow } from 'electron'
import { downloadVsix, unpackVsix } from './extensionInstaller'
import { scanExtensionDir, mergeContributions } from './extensionRegistry'
import type { ExtensionMetadata, ExtensionContribution } from './extensionRegistry'

export type { ExtensionMetadata, ExtensionContribution } from './extensionRegistry'

interface ExtensionHostMessage {
  type: string
  payload?: unknown
  error?: string
}

interface ActiveExtension {
  metadata: ExtensionMetadata
  exports: unknown
  subscriptions: Array<{ dispose(): void }>
}

class ExtensionHostManager {
  private extensionHostProcess: ChildProcess | null = null
  private extensionsDir: string = ''
  private extensions: Map<string, ExtensionMetadata> = new Map()
  private activeExtensions: Map<string, ActiveExtension> = new Map()
  private loadedExtensions: Set<string> = new Set()
  private registeredCommands: Map<string, { extensionId: string; callback: (...args: unknown[]) => unknown }> = new Map()
  private isReady = false
  private messageQueue: Array<{ type: string; payload?: unknown; resolve?: (value: unknown) => void; reject?: (error: Error) => void }> = []
  private messageId = 0
  private pendingMessages: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }> = new Map()

  constructor() {
    this.setupIPCHandlers()
  }

  private initExtensionsDir(): void {
    if (!this.extensionsDir) {
      this.extensionsDir = path.join(app.getPath('userData'), 'extensions')
      if (!fs.existsSync(this.extensionsDir)) {
        fs.mkdirSync(this.extensionsDir, { recursive: true })
      }
    }
  }

  async start(): Promise<void> {
    this.initExtensionsDir()
    if (this.extensionHostProcess) {
      return
    }

    return new Promise((resolve, reject) => {
      const hostScriptPath = path.join(__dirname, 'extensionHostProcess.js')
      
      if (!fs.existsSync(hostScriptPath)) {
        reject(new Error(`Extension host script not found: ${hostScriptPath}`))
        return
      }

      // SECURITY FIX: Only pass whitelisted environment variables to extension host
      // This prevents leaking sensitive credentials like API keys to extensions
      const safeEnv: Record<string, string> = {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        USER: process.env.USER || '',
        TEMP: process.env.TEMP || '',
        TMP: process.env.TMP || '',
        LANG: process.env.LANG || '',
        LC_ALL: process.env.LC_ALL || '',
        NODE_ENV: process.env.NODE_ENV || 'production',
        KALYNT_EXTENSION_HOST: 'true'
      }

      this.extensionHostProcess = fork(hostScriptPath, [], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: safeEnv
      })

      this.extensionHostProcess.on('message', (message: ExtensionHostMessage) => {
        this.handleHostMessage(message)
      })

      this.extensionHostProcess.on('error', (error) => {
        console.error('[ExtensionHost] Process error:', error)
        reject(error)
      })

      this.extensionHostProcess.on('exit', (code) => {
        console.log(`[ExtensionHost] Process exited with code ${code}`)
        this.extensionHostProcess = null
        this.isReady = false
      })

      // Wait for ready signal
      const checkReady = setInterval(() => {
        if (this.isReady) {
          clearInterval(checkReady)
          resolve()
        }
      }, 100)

      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(checkReady)
        if (!this.isReady) {
          reject(new Error('Extension host failed to start within 10 seconds'))
        }
      }, 10000)
    })
  }

  async stop(): Promise<void> {
    if (!this.extensionHostProcess) {
      return
    }

    const activeIds = Array.from(this.activeExtensions.keys())
    for (const id of activeIds) {
      await this.deactivateExtension(id)
    }

    // Dispose the extension host
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.extensionHostProcess) {
          this.extensionHostProcess.kill('SIGTERM')
        }
        resolve()
      }, 5000)

      this.sendMessage({ type: 'dispose' })

      this.extensionHostProcess?.on('exit', () => {
        clearTimeout(timeout)
        this.extensionHostProcess = null
        this.isReady = false
        resolve()
      })
    })
  }

  private handleHostMessage(message: ExtensionHostMessage): void {
    switch (message.type) {
      case 'ready':
        this.isReady = true
        this.flushMessageQueue()
        break

      case 'extension-loaded':
        this.handleExtensionLoaded(message.payload as { id: string; manifest: unknown })
        break

      case 'extension-activated':
        this.handleExtensionActivated(message.payload as { id: string; exports: unknown })
        break

      case 'extension-deactivated':
        this.handleExtensionDeactivated(message.payload as { id: string })
        break

      case 'register-command':
        this.handleRegisterCommand(message.payload as { extensionId: string; command: string })
        break

      case 'execute-command': {
        const execPayload = message.payload as { command: string; args: unknown[]; messageId?: number }
        this.handleExecuteCommand(execPayload)
        break
      }

      case 'show-message':
        this.handleShowMessage(message.payload as { type: string; message: string; extensionId: string })
        break

      case 'error':
        console.error('[ExtensionHost] Error:', message.error)
        break

      default:
        console.warn('[ExtensionHost] Unknown message type:', message.type)
    }
  }

  private handleExtensionLoaded(payload: { id: string; manifest: unknown }): void {
    const extension = this.extensions.get(payload.id)
    if (extension) {
      console.log(`[ExtensionHost] Extension loaded: ${payload.id}`)
    }
  }

  private handleExtensionActivated(payload: { id: string; exports: unknown }): void {
    const metadata = this.extensions.get(payload.id)
    if (metadata) {
      metadata.isActive = true
      this.activeExtensions.set(payload.id, {
        metadata,
        exports: payload.exports,
        subscriptions: []
      })
      
      // Notify renderer
      this.notifyRenderer('activated', { id: payload.id })
    }
  }

  private handleExtensionDeactivated(payload: { id: string }): void {
    const metadata = this.extensions.get(payload.id)
    if (metadata) {
      metadata.isActive = false
      this.activeExtensions.delete(payload.id)
      
      const commandEntries = Array.from(this.registeredCommands.entries())
      for (const [command, info] of commandEntries) {
        if (info.extensionId === payload.id) {
          this.registeredCommands.delete(command)
        }
      }
      
      // Notify renderer
      this.notifyRenderer('deactivated', { id: payload.id })
    }
  }

  private handleRegisterCommand(payload: { extensionId: string; command: string }): void {
    this.registeredCommands.set(payload.command, {
      extensionId: payload.extensionId,
      callback: async (...args: unknown[]) => {
        // Forward command execution to extension host
        this.sendMessage({
          type: 'invoke-command',
          payload: { extensionId: payload.extensionId, command: payload.command, args }
        })
      }
    })
  }

  private handleExecuteCommand(payload: { command: string; args: unknown[]; messageId?: number }): void {
    const commandInfo = this.registeredCommands.get(payload.command)
    let result: unknown = undefined
    if (commandInfo) {
      result = commandInfo.callback(...payload.args)
    } else {
      result = this.executeMainCommand(payload.command, payload.args)
    }

    if (payload.messageId !== undefined) {
      Promise.resolve(result).then((resolvedResult) => {
        this.sendMessage({
          type: 'command-result',
          payload: { messageId: payload.messageId, result: resolvedResult }
        })
      })
    }
  }

  private executeMainCommand(command: string, _args: unknown[]): unknown {
    switch (command) {
      case 'workbench.action.reloadWindow':
        BrowserWindow.getAllWindows().forEach(win => win.reload())
        return true
      default:
        console.warn(`[ExtensionHost] Unknown command: ${command}`)
        return undefined
    }
  }

  private handleShowMessage(payload: { type: string; message: string; extensionId: string }): void {
    // Forward to renderer process
    this.notifyRenderer('show-message', payload)
  }

  private notifyRenderer(channel: string, data: unknown): void {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send(`extension:${channel}`, data)
    })
  }

  private sendMessage(message: { type: string; payload?: unknown }): void {
    if (this.extensionHostProcess?.connected) {
      this.extensionHostProcess.send(message)
    } else {
      this.messageQueue.push(message)
    }
  }

  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift()
      if (message) {
        this.extensionHostProcess?.send(message)
      }
    }
  }

  // Public API

  async scanExtensions(): Promise<ExtensionMetadata[]> {
    this.extensions = scanExtensionDir(this.extensionsDir)
    return this.getExtensions()
  }

  async loadExtension(id: string): Promise<void> {
    const extension = this.extensions.get(id)
    if (!extension) {
      throw new Error(`Extension not found: ${id}`)
    }

    if (this.loadedExtensions.has(id)) {
      return // Already loaded
    }

    this.sendMessage({
      type: 'load-extension',
      payload: { id, path: extension.extensionPath }
    })

    this.loadedExtensions.add(id)
  }

  async activateExtension(id: string): Promise<unknown> {
    const extension = this.extensions.get(id)
    if (!extension) {
      throw new Error(`Extension not found: ${id}`)
    }

    if (extension.isActive) {
      return this.activeExtensions.get(id)?.exports
    }

    // Ensure extension is loaded first
    if (!this.loadedExtensions.has(id)) {
      console.log(`[ExtensionHost] Loading extension before activation: ${id}`)
      await this.loadExtension(id)
      // Wait a bit for the extension to be loaded
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Extension activation timeout: ${id}`))
      }, 30000)

      const checkActivated = setInterval(() => {
        if (extension.isActive) {
          clearInterval(checkActivated)
          clearTimeout(timeout)
          resolve(this.activeExtensions.get(id)?.exports)
        }
      }, 100)

      this.sendMessage({
        type: 'activate-extension',
        payload: { id }
      })
    })
  }

  async deactivateExtension(id: string): Promise<void> {
    const extension = this.extensions.get(id)
    if (!extension || !extension.isActive) {
      return
    }

    this.sendMessage({
      type: 'deactivate-extension',
      payload: { id }
    })

    // Update local state
    extension.isActive = false
    this.activeExtensions.delete(id)
  }

  async installExtension(vsixPath: string): Promise<ExtensionMetadata> {
    const extensionId = await unpackVsix(vsixPath, this.extensionsDir, async id => {
      if (this.extensions.get(id)?.isActive) await this.deactivateExtension(id)
    })
    await this.scanExtensions()
    const extension = this.extensions.get(extensionId)
    if (!extension) throw new Error(`Failed to verify installation of extension ${extensionId}`)
    return extension
  }

  async uninstallExtension(id: string): Promise<void> {
    const extension = this.extensions.get(id)
    if (!extension) {
      throw new Error(`Extension not found: ${id}`)
    }

    // Deactivate if active
    if (extension.isActive) {
      await this.deactivateExtension(id)
    }

    // Remove extension directory
    if (fs.existsSync(extension.extensionPath)) {
      fs.rmSync(extension.extensionPath, { recursive: true, force: true })
    }

    this.extensions.delete(id)
    this.loadedExtensions.delete(id)
    this.activeExtensions.delete(id)
  }

  getExtensions(): ExtensionMetadata[] {
    return Array.from(this.extensions.values())
  }

  getActiveExtensions(): ExtensionMetadata[] {
    return Array.from(this.activeExtensions.values()).map(e => e.metadata)
  }

  getExtension(id: string): ExtensionMetadata | undefined {
    return this.extensions.get(id)
  }

  getContributions(): ExtensionContribution {
    return mergeContributions(this.getExtensions())
  }

  // Downloads in the main process (no CORS); only from Open VSX into the temp folder.
  async downloadFromUrl(url: string, targetPath: string): Promise<void> {
    await downloadVsix(url, targetPath)
  }

  // IPC Handlers
  private setupIPCHandlers(): void {
    ipcMain.handle('extensions:scan', async () => {
      return this.scanExtensions()
    })

    ipcMain.handle('extensions:activate', async (_, id: string) => {
      return this.activateExtension(id)
    })

    ipcMain.handle('extensions:deactivate', async (_, id: string) => {
      await this.deactivateExtension(id)
    })

    ipcMain.handle('extensions:install', async (_, vsixPath: string) => {
      return this.installExtension(vsixPath)
    })

    ipcMain.handle('extensions:uninstall', async (_, id: string) => {
      await this.uninstallExtension(id)
    })

    ipcMain.handle('extensions:list', async () => {
      return this.getExtensions()
    })

    ipcMain.handle('extensions:active', async () => {
      return this.getActiveExtensions()
    })

    ipcMain.handle('extensions:contributions', async () => {
      return this.getContributions()
    })

    ipcMain.handle('extensions:start-host', async () => {
      await this.start()
    })

    ipcMain.handle('extensions:stop-host', async () => {
      await this.stop()
    })

    ipcMain.handle('extensions:download', async (_, url: string, targetPath: string) => {
      await this.downloadFromUrl(url, targetPath)
    })
  }
}

// Singleton instance
export const extensionHostManager = new ExtensionHostManager()
export default extensionHostManager

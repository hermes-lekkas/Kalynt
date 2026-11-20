/**
 * Extension Host Manager
 * Manages the extension host process and communication
 * Runs in the Electron main process
 */

import { fork, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { ipcMain, app, BrowserWindow } from 'electron'
import { downloadVsix, unpackVsix } from './extensionInstaller'
import { scanExtensionDir, mergeContributions } from './extensionRegistry'
import type { ExtensionMetadata, ExtensionContribution } from './extensionRegistry'
import { sendToWindow } from '../utils/window'

export type { ExtensionMetadata, ExtensionContribution } from './extensionRegistry'

interface ExtensionHostMessage {
  type: string
  payload?: unknown
  error?: string
  messageId?: number
}

interface ActiveExtension {
  metadata: ExtensionMetadata
  exports: unknown
  subscriptions: Array<{ dispose(): void }>
}

interface PendingCallback {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class ExtensionHostManager {
  private extensionHostProcess: ChildProcess | null = null
  private extensionsDir: string = ''
  private extensions: Map<string, ExtensionMetadata> = new Map()
  private activeExtensions: Map<string, ActiveExtension> = new Map()
  private loadedExtensions: Set<string> = new Set()
  private registeredCommands: Map<string, { extensionId: string; callback: (...args: unknown[]) => unknown }> = new Map()
  private isReady = false
  private messageQueue: Array<{ type: string; payload?: unknown }> = []
  private messageId = 0
  private pendingMessages: Map<number, PendingCallback> = new Map()
  private pendingActivations: Map<string, PendingCallback[]> = new Map()
  private pendingLoads: Map<string, PendingCallback[]> = new Map()

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

      // SECURITY: Only pass whitelisted environment variables to extension host
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

      const child = fork(hostScriptPath, [], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: safeEnv
      })
      this.extensionHostProcess = child

      let settled = false
      const settle = (err?: Error) => {
        if (settled) return
        settled = true
        clearInterval(checkReady)
        clearTimeout(startTimeout)
        if (err) reject(err)
        else resolve()
      }

      child.on('message', (message: ExtensionHostMessage) => {
        this.handleHostMessage(message)
        if (this.isReady) {
          settle()
        }
      })

      child.on('error', (error) => {
        console.error('[ExtensionHost] Process error:', error)
        settle(error instanceof Error ? error : new Error(String(error)))
      })

      child.on('exit', (code) => {
        console.log(`[ExtensionHost] Process exited with code ${code}`)
        this.handleHostExit(code)
        if (!settled) {
          settle(new Error(`Extension host exited during startup with code ${code}`))
        }
      })

      const checkReady = setInterval(() => {
        if (this.isReady) {
          settle()
        }
      }, 100)

      const startTimeout = setTimeout(() => {
        if (!this.isReady) {
          settle(new Error('Extension host failed to start within 10 seconds'))
        }
      }, 10000)
    })
  }

  private handleHostExit(code: number | null): void {
    const previouslyActive = Array.from(this.activeExtensions.keys())

    this.extensionHostProcess = null
    this.isReady = false
    this.loadedExtensions.clear()
    this.activeExtensions.clear()
    this.registeredCommands.clear()
    this.messageQueue = []

    for (const meta of this.extensions.values()) {
      meta.isActive = false
    }

    const exitErr = new Error(`Extension host exited unexpectedly (code ${code})`)

    for (const [, pending] of this.pendingMessages) {
      clearTimeout(pending.timer)
      pending.reject(exitErr)
    }
    this.pendingMessages.clear()

    for (const [, list] of this.pendingActivations) {
      for (const pending of list) {
        clearTimeout(pending.timer)
        pending.reject(exitErr)
      }
    }
    this.pendingActivations.clear()

    for (const [, list] of this.pendingLoads) {
      for (const pending of list) {
        clearTimeout(pending.timer)
        pending.reject(exitErr)
      }
    }
    this.pendingLoads.clear()

    for (const id of previouslyActive) {
      this.notifyRenderer('deactivated', { id })
    }
  }

  async stop(): Promise<void> {
    if (!this.extensionHostProcess) {
      return
    }

    const activeIds = Array.from(this.activeExtensions.keys())
    for (const id of activeIds) {
      await this.deactivateExtension(id)
    }

    const child = this.extensionHostProcess
    if (!child) return

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch { /* ignore */ }
        resolve()
      }, 5000)

      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })

      this.sendMessage({ type: 'dispose' })
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

      case 'load-extension-failed':
        this.handleLoadExtensionFailed(message.payload as { id: string; error: string })
        break

      case 'extension-activated':
        this.handleExtensionActivated(message.payload as { id: string; exports: unknown })
        break

      case 'activate-failed':
        this.handleActivateFailed(message.payload as { id: string; error: string })
        break

      case 'extension-deactivated':
        this.handleExtensionDeactivated(message.payload as { id: string })
        break

      case 'register-command':
        this.handleRegisterCommand(message.payload as { extensionId: string; command: string })
        break

      case 'unregister-command':
        this.handleUnregisterCommand(message.payload as { extensionId: string; command: string })
        break

      case 'execute-command': {
        const execPayload = (message.payload || {}) as { command: string; args?: unknown[]; messageId?: number }
        const msgId = execPayload.messageId ?? message.messageId
        this.handleExecuteCommand({
          command: execPayload.command,
          args: Array.isArray(execPayload.args) ? execPayload.args : [],
          messageId: msgId
        })
        break
      }

      case 'invoke-command-result':
        this.handleInvokeCommandResult(
          message.payload as { invocationId: number; result?: unknown; error?: string }
        )
        break

      case 'api-result':
        this.handleInvokeCommandResult({
          invocationId: (message.payload as { messageId?: number })?.messageId ?? -1,
          result: (message.payload as { result?: unknown })?.result,
          error: (message.payload as { error?: string })?.error
        })
        break

      case 'show-message':
        this.handleShowMessage(message.payload as { type: string; message: string; extensionId: string })
        break

      case 'log-message':
        this.handleLogMessage(message.payload as { level?: string; message?: string; channel?: string })
        break

      case 'status-bar-update':
      case 'status-bar-dispose':
        this.notifyRenderer(message.type, message.payload)
        break

      case 'disposed':
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
    this.loadedExtensions.add(payload.id)
    this.resolvePending(this.pendingLoads, payload.id, undefined)
  }

  private handleLoadExtensionFailed(payload: { id: string; error: string }): void {
    this.loadedExtensions.delete(payload.id)
    this.rejectPending(this.pendingLoads, payload.id, new Error(payload.error || `Failed to load extension ${payload.id}`))
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

      this.notifyRenderer('activated', { id: payload.id })
    }
    this.resolvePending(this.pendingActivations, payload.id, payload.exports)
  }

  private handleActivateFailed(payload: { id: string; error: string }): void {
    const metadata = this.extensions.get(payload.id)
    if (metadata) {
      metadata.isActive = false
    }
    this.activeExtensions.delete(payload.id)
    this.rejectPending(
      this.pendingActivations,
      payload.id,
      new Error(payload.error || `Extension activation failed: ${payload.id}`)
    )
  }

  private handleExtensionDeactivated(payload: { id: string }): void {
    const metadata = this.extensions.get(payload.id)
    if (metadata) {
      metadata.isActive = false
    }
    this.activeExtensions.delete(payload.id)

    for (const [command, info] of Array.from(this.registeredCommands.entries())) {
      if (info.extensionId === payload.id) {
        this.registeredCommands.delete(command)
      }
    }

    this.notifyRenderer('deactivated', { id: payload.id })
  }

  private handleRegisterCommand(payload: { extensionId: string; command: string }): void {
    this.registeredCommands.set(payload.command, {
      extensionId: payload.extensionId,
      callback: (...args: unknown[]) => this.invokeHostCommand(payload.extensionId, payload.command, args)
    })
  }

  private handleUnregisterCommand(payload: { extensionId: string; command: string }): void {
    const existing = this.registeredCommands.get(payload.command)
    if (existing && existing.extensionId === payload.extensionId) {
      this.registeredCommands.delete(payload.command)
    }
  }

  private invokeHostCommand(extensionId: string, command: string, args: unknown[]): Promise<unknown> {
    const invocationId = ++this.messageId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingMessages.has(invocationId)) {
          this.pendingMessages.delete(invocationId)
          reject(new Error(`Extension command timed out: ${command}`))
        }
      }, 10000)

      this.pendingMessages.set(invocationId, { resolve, reject, timer })
      this.sendMessage({
        type: 'invoke-command',
        payload: { extensionId, command, args, invocationId }
      })
    })
  }

  private handleInvokeCommandResult(payload: { invocationId: number; result?: unknown; error?: string }): void {
    const pending = this.pendingMessages.get(payload.invocationId)
    if (!pending) return
    this.pendingMessages.delete(payload.invocationId)
    clearTimeout(pending.timer)
    if (payload.error) {
      pending.reject(new Error(payload.error))
    } else {
      pending.resolve(payload.result)
    }
  }

  private handleExecuteCommand(payload: { command: string; args: unknown[]; messageId?: number }): void {
    const commandInfo = this.registeredCommands.get(payload.command)
    let resultPromise: Promise<unknown>
    try {
      const result = commandInfo
        ? commandInfo.callback(...payload.args)
        : this.executeMainCommand(payload.command, payload.args)
      resultPromise = Promise.resolve(result)
    } catch (error) {
      resultPromise = Promise.reject(error)
    }

    if (payload.messageId !== undefined) {
      resultPromise
        .then((resolvedResult) => {
          this.sendMessage({
            type: 'command-result',
            payload: { messageId: payload.messageId, result: resolvedResult }
          })
        })
        .catch((error) => {
          this.sendMessage({
            type: 'command-result',
            payload: {
              messageId: payload.messageId,
              error: error instanceof Error ? error.message : String(error)
            }
          })
        })
    } else {
      resultPromise.catch((error) => {
        console.error(`[ExtensionHost] Command "${payload.command}" failed:`, error)
      })
    }
  }

  private executeMainCommand(command: string, _args: unknown[]): unknown {
    switch (command) {
      case 'workbench.action.reloadWindow':
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) win.reload()
        })
        return true
      default:
        console.warn(`[ExtensionHost] Unknown command: ${command}`)
        return undefined
    }
  }

  private handleShowMessage(payload: { type: string; message: string; extensionId: string }): void {
    this.notifyRenderer('show-message', payload)
  }

  private handleLogMessage(payload: { level?: string; message?: string; channel?: string }): void {
    const prefix = payload?.channel ? `[ExtensionHost:${payload.channel}]` : '[ExtensionHost]'
    const text = payload?.message ?? ''
    if (payload?.level === 'error') console.error(prefix, text)
    else if (payload?.level === 'warn') console.warn(prefix, text)
    else console.log(prefix, text)
  }

  private notifyRenderer(channel: string, data: unknown): void {
    BrowserWindow.getAllWindows().forEach(win => {
      sendToWindow(win, `extension:${channel}`, data)
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
      if (message && this.extensionHostProcess?.connected) {
        this.extensionHostProcess.send(message)
      }
    }
  }

  private resolvePending(map: Map<string, PendingCallback[]>, key: string, value: unknown): void {
    const list = map.get(key)
    if (!list) return
    map.delete(key)
    for (const pending of list) {
      clearTimeout(pending.timer)
      pending.resolve(value)
    }
  }

  private rejectPending(map: Map<string, PendingCallback[]>, key: string, error: Error): void {
    const list = map.get(key)
    if (!list) return
    map.delete(key)
    for (const pending of list) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  // Public API

  async scanExtensions(): Promise<ExtensionMetadata[]> {
    this.initExtensionsDir()
    const scanned = scanExtensionDir(this.extensionsDir)

    // Preserve active flags and keep activeExtensions metadata synced across rescans
    for (const [id, meta] of scanned) {
      const active = this.activeExtensions.get(id)
      if (active) {
        meta.isActive = true
        active.metadata = meta
      }
    }

    this.extensions = scanned
    return this.getExtensions()
  }

  async loadExtension(id: string): Promise<void> {
    const extension = this.extensions.get(id)
    if (!extension) {
      throw new Error(`Extension not found: ${id}`)
    }

    if (this.loadedExtensions.has(id)) {
      return
    }

    return new Promise((resolve, reject) => {
      const list = this.pendingLoads.get(id) ?? []
      const entry: PendingCallback = {
        resolve: () => resolve(),
        reject,
        timer: setTimeout(() => {
          const current = this.pendingLoads.get(id)
          if (current) {
            const idx = current.indexOf(entry)
            if (idx !== -1) current.splice(idx, 1)
            if (current.length === 0) this.pendingLoads.delete(id)
          }
          reject(new Error(`Extension load timeout: ${id}`))
        }, 10000)
      }
      list.push(entry)
      this.pendingLoads.set(id, list)

      this.sendMessage({
        type: 'load-extension',
        payload: { id, path: extension.extensionPath }
      })
    })
  }

  async activateExtension(id: string): Promise<unknown> {
    const extension = this.extensions.get(id)
    if (!extension) {
      throw new Error(`Extension not found: ${id}`)
    }

    if (extension.isActive) {
      return this.activeExtensions.get(id)?.exports
    }

    if (!this.loadedExtensions.has(id)) {
      console.log(`[ExtensionHost] Loading extension before activation: ${id}`)
      await this.loadExtension(id)
    }

    return new Promise((resolve, reject) => {
      const list = this.pendingActivations.get(id) ?? []
      const entry: PendingCallback = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const current = this.pendingActivations.get(id)
          if (current) {
            const idx = current.indexOf(entry)
            if (idx !== -1) current.splice(idx, 1)
            if (current.length === 0) this.pendingActivations.delete(id)
          }
          reject(new Error(`Extension activation timeout: ${id}`))
        }, 30000)
      }
      list.push(entry)
      this.pendingActivations.set(id, list)

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

    extension.isActive = false
    this.activeExtensions.delete(id)
    for (const [command, info] of Array.from(this.registeredCommands.entries())) {
      if (info.extensionId === id) {
        this.registeredCommands.delete(command)
      }
    }
  }

  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    const commandInfo = this.registeredCommands.get(command)
    if (commandInfo) {
      return commandInfo.callback(...args)
    }
    return this.executeMainCommand(command, args)
  }

  async installExtension(vsixPath: string): Promise<ExtensionMetadata> {
    this.initExtensionsDir()
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

    if (extension.isActive) {
      await this.deactivateExtension(id)
    }

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

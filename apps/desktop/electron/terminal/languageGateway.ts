/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// main-process/languageGateway.ts
// Uses vscode-jsonrpc directly (works in Electron without vscode dependency)
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    MessageConnection,
    InitializeRequest,
    InitializeParams,
    InitializedNotification,
    ShutdownRequest,
    ExitNotification
} from 'vscode-languageserver-protocol/node'
import path from 'node:path'
import {
    languageServerConfigurations,
    debugAdapterConfigurations
} from './languageConfigs'
import { DebugAdapterGateway } from './debugGateway'
import type { LanguageServerConfig, DebugAdapterConfig } from './languageConfigs'
import type { DebugStartOptions } from './debugGateway'

export type { LanguageServerConfig, DebugAdapterConfig } from './languageConfigs'
export type { DebugSession } from './debugGateway'

const LSP_INIT_TIMEOUT_MS = 15000
const LSP_SHUTDOWN_TIMEOUT_MS = 3000

export interface LanguageSession {
    id: string
    languageId: string
    connection: MessageConnection
    process: import('node:child_process').ChildProcess
    workspacePath: string
    capabilities?: unknown
    status: 'starting' | 'running' | 'stopped' | 'error'
}

export class LanguageRuntimeGateway extends EventEmitter {
    private readonly languageServers = new Map<string, LanguageSession>()
    private readonly languageConfigs: Map<string, LanguageServerConfig>
    private readonly debug: DebugAdapterGateway

    constructor() {
        super()
        this.languageConfigs = new Map(Object.entries(languageServerConfigurations))
        this.debug = new DebugAdapterGateway(debugAdapterConfigurations, this)
    }

    /**
     * Start a language server using direct JSON-RPC communication
     * Works in Electron without requiring the vscode module
     */
    async loadLanguageServer(options: {
        sessionId?: string
        languageId: string
        workspacePath: string
        rootUri?: string
        initializationOptions?: object
        options?: {
            rootUri?: string
            initializationOptions?: object
            timeoutMs?: number
        }
        timeoutMs?: number
    }): Promise<{ success: boolean; sessionId?: string; error?: string }> {
        const config = this.languageConfigs.get(options.languageId)
        if (!config) {
            return { success: false, error: `No language server configuration found for ${options.languageId}` }
        }

        const sessionId = options.sessionId || `lsp_${options.languageId}_${Date.now()}`

        // Reuse an already running session if the exact sessionId or same language+workspace is active
        const byId = this.languageServers.get(sessionId)
        if (byId && byId.status === 'running') {
            return { success: true, sessionId }
        }

        if (!options.sessionId) {
            for (const [existingId, existingSession] of Array.from(this.languageServers)) {
                if (
                    existingSession.languageId === options.languageId &&
                    existingSession.workspacePath === options.workspacePath &&
                    existingSession.status === 'running'
                ) {
                    return { success: true, sessionId: existingId }
                }
            }
        }

        let serverProcess: import('node:child_process').ChildProcess | null = null
        let connection: MessageConnection | null = null

        try {
            serverProcess = spawn(config.command, config.args || [], {
                cwd: options.workspacePath,
                env: { ...process.env, ...config.env },
                stdio: ['pipe', 'pipe', 'pipe']
            })

            connection = createMessageConnection(
                new StreamMessageReader(serverProcess.stdout!),
                new StreamMessageWriter(serverProcess.stdin!)
            )

            const session: LanguageSession = {
                id: sessionId,
                languageId: options.languageId,
                connection,
                process: serverProcess,
                workspacePath: options.workspacePath,
                status: 'starting'
            }

            let rejectInit: ((err: Error) => void) | null = null
            const earlyFailure = new Promise<never>((_resolve, reject) => {
                rejectInit = reject
            })
            // Prevent unhandled rejection if init resolves before an error/exit
            earlyFailure.catch(() => undefined)

            serverProcess.on('error', (error) => {
                console.error(`[LanguageGateway] Process error for ${options.languageId}:`, error)
                session.status = 'error'
                this.languageServers.delete(sessionId)
                this.emit('language_server_error', { sessionId, error: error.message || String(error) })
                rejectInit?.(error)
            })

            serverProcess.on('exit', (code) => {
                const wasStarting = session.status === 'starting'
                session.status = 'stopped'
                this.languageServers.delete(sessionId)
                this.emit('language_server_stopped', { sessionId, exitCode: code })
                if (wasStarting) {
                    rejectInit?.(new Error(`Language server ${options.languageId} exited before initialization (code ${code})`))
                }
            })

            serverProcess.stderr?.on('data', (data: Buffer) => {
                console.error(`[LSP ${options.languageId}]`, data.toString())
            })

            connection.listen()

            const explicitRootUri = options.rootUri ?? options.options?.rootUri
            const rootUri = explicitRootUri || pathToFileURL(path.resolve(options.workspacePath)).href
            const initParams: InitializeParams = {
                processId: process.pid,
                capabilities: {
                    textDocument: {
                        synchronization: { dynamicRegistration: true, didSave: true },
                        completion: { dynamicRegistration: true, completionItem: { snippetSupport: true } },
                        hover: { dynamicRegistration: true },
                        definition: { dynamicRegistration: true },
                        references: { dynamicRegistration: true },
                        documentSymbol: { dynamicRegistration: true },
                        codeAction: { dynamicRegistration: true },
                        formatting: { dynamicRegistration: true },
                        rangeFormatting: { dynamicRegistration: true },
                        rename: { dynamicRegistration: true },
                        publishDiagnostics: { relatedInformation: true }
                    },
                    workspace: {
                        workspaceFolders: true,
                        applyEdit: true,
                        didChangeConfiguration: { dynamicRegistration: true }
                    }
                },
                rootUri,
                workspaceFolders: [{
                    uri: rootUri,
                    name: path.basename(options.workspacePath)
                }],
                initializationOptions:
                    options.initializationOptions ??
                    options.options?.initializationOptions ??
                    config.initializationOptions
            }

            const timeoutMs = options.timeoutMs ?? options.options?.timeoutMs ?? LSP_INIT_TIMEOUT_MS
            let initTimer: ReturnType<typeof setTimeout> | undefined
            const timeoutPromise = new Promise<never>((_resolve, reject) => {
                initTimer = setTimeout(() => {
                    reject(new Error(`Language server ${options.languageId} initialization timed out after ${timeoutMs}ms`))
                }, timeoutMs)
            })

            let initResult: Awaited<ReturnType<typeof connection.sendRequest<typeof InitializeRequest.type>>>
            try {
                initResult = await Promise.race([
                    connection.sendRequest(InitializeRequest.type, initParams),
                    earlyFailure,
                    timeoutPromise
                ]) as any
            } finally {
                if (initTimer) clearTimeout(initTimer)
                rejectInit = null
            }

            session.capabilities = (initResult as any).capabilities

            connection.sendNotification(InitializedNotification.type, {})

            this.languageServers.set(sessionId, session)
            session.status = 'running'

            this.emit('language_server_started', {
                sessionId,
                languageId: options.languageId,
                capabilities: (initResult as any).capabilities
            })

            return { success: true, sessionId }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[LanguageGateway] Failed to start language server for ${options.languageId}:`, error)
            try { connection?.dispose() } catch { /* ignore */ }
            try {
                if (serverProcess && serverProcess.exitCode === null) {
                    serverProcess.kill('SIGKILL')
                }
            } catch { /* ignore */ }
            this.languageServers.delete(sessionId)
            return { success: false, error: message }
        }
    }

    /**
     * Start a debug session with proper retry logic for socket connections
     */
    async startDebugSession(options: DebugStartOptions): Promise<{ success: boolean; port?: number; error?: string }> {
        return this.debug.startDebugSession(options)
    }

    /**
     * Send LSP request through the message connection
     */
    async sendLSPRequest(sessionId: string, method: string, params: unknown): Promise<unknown> {
        const session = this.languageServers.get(sessionId)
        if (!session) {
            throw new Error(`Language session ${sessionId} not found`)
        }

        if (session.status !== 'running') {
            throw new Error(`Language session ${sessionId} is not running (status: ${session.status})`)
        }

        return session.connection.sendRequest(method, params as object)
    }

    /**
     * Send debug adapter request
     */
    async sendDebugRequest(sessionId: string, method: string, params: unknown): Promise<unknown> {
        return this.debug.sendDebugRequest(sessionId, method, params)
    }

    async getLanguageServers(): Promise<Array<{ languageId: string; sessionId: string; status: string }>> {
        return Array.from(this.languageServers.values()).map(session => ({
            languageId: session.languageId,
            sessionId: session.id,
            status: session.status
        }))
    }

    async getDebugSessions(): Promise<Array<{ languageId: string; sessionId: string; port?: number; status: string }>> {
        return this.debug.getDebugSessions()
    }

    async stopLanguageServer(sessionId: string): Promise<boolean> {
        const session = this.languageServers.get(sessionId)
        if (!session) return false

        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            await Promise.race([
                session.connection.sendRequest(ShutdownRequest.type),
                new Promise<void>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('LSP shutdown timed out')), LSP_SHUTDOWN_TIMEOUT_MS)
                })
            ])
            session.connection.sendNotification(ExitNotification.type)
            session.connection.dispose()
            session.process.kill()
            this.languageServers.delete(sessionId)
            return true
        } catch (error) {
            console.error(`[LanguageGateway] Error stopping language server ${sessionId}:`, error)
            try { session.connection.dispose() } catch { /* ignore */ }
            try { session.process.kill('SIGKILL') } catch { /* ignore */ }
            this.languageServers.delete(sessionId)
            return false
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    async stopDebugSession(sessionId: string): Promise<boolean> {
        return this.debug.stopDebugSession(sessionId)
    }

    configureLanguageServer(languageId: string, config: LanguageServerConfig): void {
        this.languageConfigs.set(languageId, config)
    }

    configureDebugAdapter(languageId: string, config: DebugAdapterConfig): void {
        this.debug.configureDebugAdapter(languageId, config)
    }

    getSupportedLanguages(): string[] {
        return Array.from(this.languageConfigs.keys())
    }

    async dispose(): Promise<void> {
        const stopPromises = Array.from(this.languageServers.keys()).map(id =>
            this.stopLanguageServer(id).then(() => undefined)
        )

        await this.debug.dispose()
        await Promise.all(stopPromises)

        this.languageServers.clear()
        this.removeAllListeners()
    }
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// main-process/languageGateway.ts
// Rewritten to use vscode-jsonrpc directly (works in Electron without vscode dependency)
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
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
        languageId: string
        workspacePath: string
        rootUri?: string
        initializationOptions?: object
    }): Promise<{ success: boolean; sessionId?: string; error?: string }> {
        try {
            const config = this.languageConfigs.get(options.languageId)
            if (!config) {
                return { success: false, error: `No language server configuration found for ${options.languageId}` }
            }

            const sessionId = `lsp_${options.languageId}_${Date.now()}`

            // Check if we already have a session for this language in this workspace
            for (const [existingId, existingSession] of Array.from(this.languageServers)) {
                if (existingSession.languageId === options.languageId &&
                    existingSession.workspacePath === options.workspacePath &&
                    existingSession.status === 'running') {
                    return { success: true, sessionId: existingId }
                }
            }

            // Spawn the language server process
            const serverProcess = spawn(config.command, config.args || [], {
                cwd: options.workspacePath,
                env: { ...process.env, ...config.env },
                stdio: ['pipe', 'pipe', 'pipe']
            })

            // Create JSON-RPC connection over stdio
            const connection = createMessageConnection(
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

            // Handle process errors
            serverProcess.on('error', (error) => {
                console.error(`[LanguageGateway] Process error for ${options.languageId}:`, error)
                session.status = 'error'
                this.emit('language_server_error', { sessionId, error: String(error) })
            })

            serverProcess.on('exit', (code) => {
                session.status = 'stopped'
                this.languageServers.delete(sessionId)
                this.emit('language_server_stopped', { sessionId, exitCode: code })
            })

            serverProcess.stderr?.on('data', (data: Buffer) => {
                console.error(`[LSP ${options.languageId}]`, data.toString())
            })

            // Start listening on the connection
            connection.listen()

            // Send initialize request
            const rootUri = options.rootUri || `file:///${options.workspacePath.replace(/\\/g, '/')}`
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
                initializationOptions: options.initializationOptions || config.initializationOptions
            }

            const initResult = await connection.sendRequest(InitializeRequest.type, initParams)
            session.capabilities = initResult.capabilities

            // Send initialized notification
            connection.sendNotification(InitializedNotification.type, {})

            // Store session after successful initialization
            this.languageServers.set(sessionId, session)
            session.status = 'running'

            this.emit('language_server_started', {
                sessionId,
                languageId: options.languageId,
                capabilities: initResult.capabilities
            })

            return { success: true, sessionId }
        } catch (error) {
            console.error(`[LanguageGateway] Failed to start language server for ${options.languageId}:`, error)
            return { success: false, error: String(error) }
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

        try {
            // Send shutdown request followed by exit notification (LSP protocol)
            await session.connection.sendRequest(ShutdownRequest.type)
            session.connection.sendNotification(ExitNotification.type)
            session.connection.dispose()
            session.process.kill()
            this.languageServers.delete(sessionId)
            return true
        } catch (error) {
            console.error(`[LanguageGateway] Error stopping language server ${sessionId}:`, error)
            // Force kill if graceful shutdown fails
            session.process.kill('SIGKILL')
            this.languageServers.delete(sessionId)
            return false
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
        // Stop all language servers gracefully
        const stopPromises: Promise<void>[] = []

        for (const [sessionId, session] of Array.from(this.languageServers)) {
            stopPromises.push(
                (async () => {
                    try {
                        await session.connection.sendRequest(ShutdownRequest.type)
                        session.connection.sendNotification(ExitNotification.type)
                        session.connection.dispose()
                        session.process.kill()
                    } catch (error) {
                        console.error(`[LanguageGateway] Error disposing language server ${sessionId}:`, error)
                        session.process.kill('SIGKILL')
                    }
                })()
            )
        }

        await this.debug.dispose()
        await Promise.all(stopPromises)

        this.languageServers.clear()
        this.removeAllListeners()
    }
}

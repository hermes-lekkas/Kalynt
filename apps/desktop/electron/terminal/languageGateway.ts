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
    debugAdapterConfigurations,
    resolvePythonExecutable
} from './languageConfigs'
import { DebugAdapterGateway } from './debugGateway'
import type { LanguageServerConfig, DebugAdapterConfig } from './languageConfigs'
import type { DebugStartOptions } from './debugGateway'

export type { LanguageServerConfig, DebugAdapterConfig } from './languageConfigs'
export type { DebugSession } from './debugGateway'

const LSP_INIT_TIMEOUT_MS = 15000
const LSP_SHUTDOWN_TIMEOUT_MS = 3000
const MAX_STARTUP_STDERR_CHARS = 4096

/**
 * Standard LSP methods that MUST be sent as JSON-RPC notifications (no `id`, no response expected).
 */
export const LSP_NOTIFICATION_METHODS = new Set<string>([
    'initialized',
    'exit',
    '$/cancelRequest',
    '$/setTrace',
    'textDocument/didOpen',
    'textDocument/didChange',
    'textDocument/didSave',
    'textDocument/didClose',
    'workspace/didChangeConfiguration',
    'workspace/didChangeWatchedFiles',
    'workspace/didChangeWorkspaceFolders'
])

function formatStartupFailure(
    languageId: string,
    command: string,
    args: string[],
    error: unknown,
    stderrOutput: string
): { error: string; actionableHint?: string } {
    const errObj = error as NodeJS.ErrnoException | undefined
    const rawMsg = error instanceof Error ? error.message : String(error)
    const stderrTrimmed = stderrOutput.trim()
    const isPythonPylsp = languageId === 'python' && args.includes('pylsp')

    if (errObj?.code === 'ENOENT' || rawMsg.includes('ENOENT')) {
        if (languageId === 'python') {
            return {
                error: `Python executable '${command}' was not found on PATH or in the workspace environment.`,
                actionableHint: 'Install Python 3 (or create a workspace .venv) and install python-lsp-server: python3 -m pip install python-lsp-server'
            }
        }
        return {
            error: `Language server '${command}' for ${languageId} is not installed or not on PATH.`,
            actionableHint: `Install '${command}' and ensure it is available on PATH to enable ${languageId} language features.`
        }
    }

    if (isPythonPylsp && /No module named ['"]?pylsp['"]?/i.test(stderrTrimmed)) {
        const pyDisplay = path.basename(command) || 'python3'
        return {
            error: `Python language server (pylsp) is not installed for ${command}.`,
            actionableHint: `Install it to enable Python language features: ${pyDisplay} -m pip install python-lsp-server`
        }
    }

    if (stderrTrimmed) {
        const firstLine = stderrTrimmed.split(/\r?\n/).find(l => l.trim().length > 0)?.trim()
        if (firstLine && !rawMsg.includes(firstLine)) {
            return {
                error: `${rawMsg}: ${firstLine}`,
                actionableHint: isPythonPylsp
                    ? `Verify python-lsp-server is installed: ${path.basename(command) || 'python3'} -m pip install python-lsp-server`
                    : undefined
            }
        }
    }

    return { error: rawMsg }
}

function safeDisposeConnection(connection: MessageConnection | null | undefined): void {
    if (!connection) return
    try {
        connection.end()
    } catch {
        // Already ended or stream closed
    }
    try {
        connection.dispose()
    } catch {
        // Already disposed
    }
}

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
    }): Promise<{ success: boolean; sessionId?: string; error?: string; actionableHint?: string }> {
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

        let resolvedCommand = config.command
        const resolvedArgs = config.args || []
        if (options.languageId === 'python' && (resolvedCommand === 'python' || resolvedCommand === 'python3')) {
            const discovered = await resolvePythonExecutable(options.workspacePath)
            if (!discovered) {
                const detail = formatStartupFailure(
                    options.languageId,
                    resolvedCommand,
                    resolvedArgs,
                    Object.assign(new Error(`spawn ${resolvedCommand} ENOENT`), { code: 'ENOENT' }),
                    ''
                )
                this.emit('language_server_error', {
                    sessionId,
                    languageId: options.languageId,
                    error: detail.error,
                    actionableHint: detail.actionableHint
                })
                return { success: false, error: detail.error, actionableHint: detail.actionableHint }
            }
            resolvedCommand = discovered
        }

        let serverProcess: import('node:child_process').ChildProcess | null = null
        let connection: MessageConnection | null = null
        let startupStderr = ''

        try {
            serverProcess = spawn(resolvedCommand, resolvedArgs, {
                cwd: options.workspacePath,
                env: { ...process.env, ...config.env },
                stdio: ['pipe', 'pipe', 'pipe']
            })

            // Prevent uncaught stream errors (e.g. EPIPE / ERR_STREAM_DESTROYED) when child exits early
            serverProcess.stdin?.on('error', () => undefined)
            serverProcess.stdout?.on('error', () => undefined)
            serverProcess.stderr?.on('error', () => undefined)

            serverProcess.stderr?.on('data', (data: Buffer) => {
                const text = data.toString()
                if (startupStderr.length < MAX_STARTUP_STDERR_CHARS) {
                    startupStderr += text.slice(0, MAX_STARTUP_STDERR_CHARS - startupStderr.length)
                }
                console.error(`[LSP ${options.languageId}]`, text)
            })

            // Wait for the OS spawn to succeed or fail (ENOENT) BEFORE attaching JSON-RPC
            // so we never write an initialize request into an already-destroyed stdin stream.
            await new Promise<void>((resolve, reject) => {
                if (serverProcess!.pid) {
                    resolve()
                    return
                }
                const onSpawn = () => {
                    cleanup()
                    resolve()
                }
                const onError = (err: Error) => {
                    cleanup()
                    reject(err)
                }
                const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
                    cleanup()
                    reject(new Error(`Language server ${options.languageId} exited before startup (${code !== null ? `code ${code}` : `signal ${signal}`})`))
                }
                const cleanup = () => {
                    serverProcess!.off('spawn', onSpawn)
                    serverProcess!.off('error', onError)
                    serverProcess!.off('exit', onExit)
                }
                serverProcess!.once('spawn', onSpawn)
                serverProcess!.once('error', onError)
                serverProcess!.once('exit', onExit)
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

            connection.onError((err) => {
                const error = Array.isArray(err) ? err[0] : err
                const message = error instanceof Error ? error.message : String(error)
                if (session.status === 'starting') {
                    rejectInit?.(error instanceof Error ? error : new Error(message))
                } else if (session.status === 'running') {
                    session.status = 'error'
                    this.languageServers.delete(sessionId)
                    safeDisposeConnection(connection)
                    this.emit('language_server_error', {
                        sessionId,
                        languageId: options.languageId,
                        error: message
                    })
                }
            })

            connection.onClose(() => {
                if (session.status === 'starting') {
                    rejectInit?.(new Error(`Language server ${options.languageId} closed its connection during initialization`))
                } else if (session.status === 'running') {
                    session.status = 'stopped'
                    this.languageServers.delete(sessionId)
                }
            })

            // Forward all server-pushed notifications (including textDocument/publishDiagnostics)
            connection.onNotification((method, params) => {
                this.emit('lsp_notification', {
                    sessionId,
                    languageId: options.languageId,
                    method,
                    params
                })
            })

            serverProcess.on('error', (error) => {
                console.error(`[LanguageGateway] Process error for ${options.languageId}:`, error)
                session.status = 'error'
                this.languageServers.delete(sessionId)
                safeDisposeConnection(connection)
                this.emit('language_server_error', {
                    sessionId,
                    languageId: options.languageId,
                    error: error.message || String(error)
                })
                rejectInit?.(error)
            })

            serverProcess.on('exit', (code, signal) => {
                const wasStarting = session.status === 'starting'
                session.status = 'stopped'
                this.languageServers.delete(sessionId)
                safeDisposeConnection(connection)
                this.emit('language_server_stopped', { sessionId, exitCode: code })
                if (wasStarting) {
                    const reason = code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`
                    rejectInit?.(new Error(`Language server ${options.languageId} exited before initialization (${reason})`))
                }
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
            timeoutPromise.catch(() => undefined)

            // Guard against process exiting in the microtask before initialize is written
            if (serverProcess.exitCode !== null || serverProcess.killed || serverProcess.stdin?.destroyed) {
                throw new Error(`Language server ${options.languageId} exited before initialization (code ${serverProcess.exitCode ?? 'unknown'})`)
            }

            const initRequest = connection.sendRequest(InitializeRequest.type, initParams)
            // Always attach a rejection handler so losing Promise.race never causes an unhandled rejection
            initRequest.catch(() => undefined)

            let initResult: Awaited<ReturnType<typeof connection.sendRequest<typeof InitializeRequest.type>>>
            try {
                initResult = await Promise.race([
                    initRequest,
                    earlyFailure,
                    timeoutPromise
                ]) as any
            } finally {
                if (initTimer) clearTimeout(initTimer)
                rejectInit = null
            }

            session.capabilities = (initResult as any).capabilities

            await connection.sendNotification(InitializedNotification.type, {})

            this.languageServers.set(sessionId, session)
            session.status = 'running'

            this.emit('language_server_started', {
                sessionId,
                languageId: options.languageId,
                capabilities: (initResult as any).capabilities
            })

            return { success: true, sessionId }
        } catch (error) {
            const detail = formatStartupFailure(options.languageId, resolvedCommand, resolvedArgs, error, startupStderr)
            console.error(`[LanguageGateway] Failed to start language server for ${options.languageId}:`, detail.error)
            safeDisposeConnection(connection)
            try {
                if (serverProcess && serverProcess.exitCode === null) {
                    serverProcess.kill('SIGKILL')
                }
            } catch { /* ignore */ }
            this.languageServers.delete(sessionId)
            this.emit('language_server_error', {
                sessionId,
                languageId: options.languageId,
                error: detail.error,
                actionableHint: detail.actionableHint
            })
            return { success: false, error: detail.error, actionableHint: detail.actionableHint }
        }
    }

    /**
     * Start a debug session with proper retry logic for socket connections
     */
    async startDebugSession(options: DebugStartOptions): Promise<{ success: boolean; port?: number; error?: string }> {
        return this.debug.startDebugSession(options)
    }

    /**
     * Send an LSP JSON-RPC notification (no `id` field, no response expected).
     */
    async sendLSPNotification(sessionId: string, method: string, params?: unknown): Promise<void> {
        const session = this.languageServers.get(sessionId)
        if (!session) {
            throw new Error(`Language session ${sessionId} not found`)
        }

        if (session.status !== 'running') {
            throw new Error(`Language session ${sessionId} is not running (status: ${session.status})`)
        }

        if (session.process.exitCode !== null || session.process.stdin?.destroyed || !session.process.stdin?.writable) {
            session.status = 'stopped'
            this.languageServers.delete(sessionId)
            safeDisposeConnection(session.connection)
            throw new Error(`Language session ${sessionId} stdin is closed`)
        }

        try {
            if (params === undefined) {
                await session.connection.sendNotification(method)
            } else {
                await session.connection.sendNotification(method, params as object)
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.includes('ERR_STREAM_DESTROYED') || msg.includes('EPIPE') || msg.includes('disposed')) {
                session.status = 'stopped'
                this.languageServers.delete(sessionId)
                safeDisposeConnection(session.connection)
            }
            throw err
        }
    }

    /**
     * Send LSP request through the message connection.
     * Standard LSP notification methods are automatically dispatched as notifications.
     */
    async sendLSPRequest(sessionId: string, method: string, params: unknown): Promise<unknown> {
        if (LSP_NOTIFICATION_METHODS.has(method)) {
            await this.sendLSPNotification(sessionId, method, params)
            return null
        }

        const session = this.languageServers.get(sessionId)
        if (!session) {
            throw new Error(`Language session ${sessionId} not found`)
        }

        if (session.status !== 'running') {
            throw new Error(`Language session ${sessionId} is not running (status: ${session.status})`)
        }

        if (session.process.exitCode !== null || session.process.stdin?.destroyed || !session.process.stdin?.writable) {
            session.status = 'stopped'
            this.languageServers.delete(sessionId)
            safeDisposeConnection(session.connection)
            throw new Error(`Language session ${sessionId} stdin is closed`)
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
            if (session.process.exitCode === null && !session.process.stdin?.destroyed) {
                const shutdownReq = session.connection.sendRequest(ShutdownRequest.type)
                shutdownReq.catch(() => undefined)
                await Promise.race([
                    shutdownReq,
                    new Promise<void>((_resolve, reject) => {
                        timer = setTimeout(() => reject(new Error('LSP shutdown timed out')), LSP_SHUTDOWN_TIMEOUT_MS)
                    })
                ])
                await session.connection.sendNotification(ExitNotification.type).catch(() => undefined)
            }
            safeDisposeConnection(session.connection)
            if (session.process.exitCode === null) {
                session.process.kill()
            }
            this.languageServers.delete(sessionId)
            return true
        } catch (error) {
            console.error(`[LanguageGateway] Error stopping language server ${sessionId}:`, error)
            safeDisposeConnection(session.connection)
            try {
                if (session.process.exitCode === null) session.process.kill('SIGKILL')
            } catch { /* ignore */ }
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

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Debug-adapter runtime: spawns DAP adapters over stdio or socket, frames
 * the DAP message stream and routes requests/responses/events. Events are
 * emitted on the owning gateway's emitter.
 */
import { spawn, ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import path from 'node:path'
import type { DebugAdapterConfig } from './languageConfigs'

export interface DebugSession {
    id: string
    languageId: string
    process: ChildProcess
    port?: number
    socket?: net.Socket
    configuration: object
    status: 'starting' | 'running' | 'stopped' | 'error'
    // DAP Protocol State
    seq: number
    pendingRequests: Map<number, { resolve: (res: any) => void; reject: (err: any) => void }>
    buffer: string
}

export interface DebugStartOptions {
    sessionId: string
    languageId: string
    program: string
    args?: string[]
    cwd?: string
    stopOnEntry?: boolean
    port?: number
}

export class DebugAdapterGateway {
    private readonly debugSessions = new Map<string, DebugSession>()
    private readonly debugConfigs: Map<string, DebugAdapterConfig>

    constructor(configs: Record<string, DebugAdapterConfig>, private readonly events: EventEmitter) {
        this.debugConfigs = new Map(Object.entries(configs))
    }

    /**
     * Start a debug session with proper retry logic for socket connections
     */
    async startDebugSession(options: DebugStartOptions): Promise<{ success: boolean; port?: number; error?: string }> {
        try {
            const config = this.debugConfigs.get(options.languageId)
            if (!config) {
                return { success: false, error: `No debug adapter configuration found for ${options.languageId}` }
            }

            // Warn about placeholder configurations
            if (options.languageId === 'node' || options.languageId === 'java') {
                console.warn(`[LanguageGateway] WARNING: ${options.languageId} debug adapter uses a placeholder configuration.`)
                console.warn(`  The command '${config.command}' may not be installed.`)
                if (options.languageId === 'node') {
                    console.warn(`  Node.js debugging requires 'vscode-js-debug' or similar DAP adapter.`)
                    console.warn(`  Configure via: gateway.configureDebugAdapter('node', { ... })`)
                } else {
                    console.warn(`  Java debugging requires 'com.microsoft.java.debug.plugin' or similar.`)
                    console.warn(`  Configure via: gateway.configureDebugAdapter('java', { ... })`)
                }
                this.events.emit('debug_warning', {
                    languageId: options.languageId,
                    message: `${options.languageId} debugger requires additional configuration`
                })
            }

            const port = config.transport === 'socket'
                ? (options.port || await this.findAvailablePort())
                : undefined
            const sessionId = options.sessionId || `debug_${options.languageId}_${Date.now()}`

            // Replace variables in command arguments
            // Handle ${args} specially to preserve array structure
            const processedArgs = (config.args || []).flatMap(arg => {
                if (arg === '${args}') {
                    return options.args || []
                }
                if (arg.includes('${args}')) {
                    // If ${args} is part of a larger string, join with spaces
                    // This is risky with paths containing spaces but sometimes needed
                    return arg
                        .replace(/\$\{port\}/g, String(port || 0))
                        .replace(/\$\{program\}/g, options.program)
                        .replace(/\$\{args\}/g, (options.args || []).join(' '))
                }
                return arg
                    .replace(/\$\{port\}/g, String(port || 0))
                    .replace(/\$\{program\}/g, options.program)
            })

            // Spawn debug adapter process
            const debugProcess = spawn(config.command, processedArgs, {
                cwd: options.cwd || process.cwd(),
                env: { ...process.env, ...config.env },
                stdio: config.transport === 'stdio' ? ['pipe', 'pipe', 'pipe'] : 'pipe'
            })

            const session: DebugSession = {
                id: sessionId,
                languageId: options.languageId,
                process: debugProcess,
                port,
                configuration: {
                    type: config.type,
                    request: 'launch',
                    name: `Debug ${path.basename(options.program)}`,
                    program: options.program,
                    args: options.args,
                    cwd: options.cwd,
                    stopOnEntry: options.stopOnEntry,
                    port
                },
                status: 'starting',
                seq: 0,
                pendingRequests: new Map(),
                buffer: ''
            }

            this.debugSessions.set(sessionId, session)

            // Handle process exit
            debugProcess.on('exit', (code: number | null) => {
                session.status = 'stopped'
                if (session.socket) {
                    session.socket.destroy()
                }
                this.debugSessions.delete(sessionId)
                this.events.emit('debug_session_stopped', { sessionId, exitCode: code })
            })

            debugProcess.stderr?.on('data', (data: Buffer) => {
                console.error(`[DebugAdapter ${options.languageId}]`, data.toString())
            })

            // Handle based on transport type
            if (config.transport === 'stdio') {
                // Stdio transport - ready immediately
                session.status = 'running'
                this.setupDebugListeners(session)
                this.events.emit('debug_session_started', {
                    sessionId,
                    languageId: options.languageId,
                    configuration: session.configuration,
                    transport: 'stdio'
                })
            } else {
                // Socket transport - need to connect with retry
                await this.connectWithRetry(port!, session, sessionId, options, debugProcess)
            }

            return { success: true, port }
        } catch (error) {
            console.error(`[LanguageGateway] Failed to start debug session for ${options.languageId}:`, error)
            return { success: false, error: String(error) }
        }
    }

    /**
     * Connect to debug adapter with retry logic
     * Handles the race condition where adapter needs time to start
     */
    private connectWithRetry(
        port: number,
        session: DebugSession,
        sessionId: string,
        options: { languageId: string },
        debugProcess: ChildProcess,
        maxRetries = 15,
        retryDelayMs = 200
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            let retries = 0

            const attemptConnect = (): void => {
                const socket = net.createConnection({ port })
                    .on('connect', () => {
                        session.status = 'running'
                        session.socket = socket
                        this.setupDebugListeners(session)
                        this.events.emit('debug_session_started', {
                            sessionId,
                            languageId: options.languageId,
                            port,
                            configuration: session.configuration,
                            transport: 'socket'
                        })
                        resolve()
                    })
                    .on('error', (error) => {
                        socket.destroy()

                        if (retries < maxRetries) {
                            retries++
                            console.log(`[Debug] Connection retry ${retries}/${maxRetries} for port ${port}`)
                            setTimeout(attemptConnect, retryDelayMs)
                        } else {
                            console.error(`[DebugAdapter] Failed to connect after ${maxRetries} retries:`, error)
                            session.status = 'error'
                            debugProcess.kill()
                            this.events.emit('debug_session_error', {
                                sessionId,
                                error: `Failed to connect to debug adapter: ${error.message}`
                            })
                            reject(error)
                        }
                    })
            }

            // Start connection attempts
            attemptConnect()
        })
    }

    /**
     * Setup listeners for DAP message stream
     */
    private setupDebugListeners(session: DebugSession) {
        const onData = (data: Buffer) => {
            session.buffer += data.toString('utf8')

            // eslint-disable-next-line no-constant-condition
            while (true) {
                // Check for Content-Length header
                const lengthMatch = session.buffer.match(/Content-Length: (\d+)\r\n\r\n/)
                if (!lengthMatch) break

                const headerLength = lengthMatch[0].length
                const contentLength = parseInt(lengthMatch[1], 10)

                // Check if we have the full message
                if (session.buffer.length >= headerLength + contentLength) {
                    const rawMessage = session.buffer.slice(headerLength, headerLength + contentLength)
                    session.buffer = session.buffer.slice(headerLength + contentLength)

                    try {
                        const message = JSON.parse(rawMessage)
                        this.handleDebugMessage(session, message)
                    } catch (e) {
                        console.error('[LanguageGateway] Failed to parse DAP message', e)
                    }
                } else {
                    break // Wait for more data
                }
            }
        }

        if (session.socket) {
            session.socket.on('data', onData)
        } else {
            session.process.stdout?.on('data', onData)
        }
    }

    /**
     * Handle parsed DAP message
     */
    private handleDebugMessage(session: DebugSession, message: any) {
        if (message.type === 'response') {
            const requestSeq = message.request_seq
            if (session.pendingRequests.has(requestSeq)) {
                const { resolve, reject } = session.pendingRequests.get(requestSeq)!
                if (message.success) {
                    resolve(message)
                } else {
                    reject(new Error(message.message || 'Debug request failed'))
                }
                session.pendingRequests.delete(requestSeq)
            }
        } else if (message.type === 'event') {
            this.events.emit('debug_event', {
                sessionId: session.id,
                event: message.event,
                body: message.body
            })
        }
    }

    /**
     * Send debug adapter request
     */
    async sendDebugRequest(sessionId: string, method: string, params: unknown): Promise<unknown> {
        const session = this.debugSessions.get(sessionId)
        if (!session) {
            throw new Error(`Debug session ${sessionId} not found`)
        }

        const seq = ++session.seq
        const request = {
            seq,
            type: 'request',
            command: method,
            arguments: params
        }

        const json = JSON.stringify(request)
        const message = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`

        return new Promise((resolve, reject) => {
            // Set timeout for request
            const timeout = setTimeout(() => {
                if (session.pendingRequests.has(seq)) {
                    session.pendingRequests.delete(seq)
                    reject(new Error(`Debug request ${method} timed out`))
                }
            }, 10000)

            session.pendingRequests.set(seq, {
                resolve: (res) => {
                    clearTimeout(timeout)
                    resolve(res)
                },
                reject: (err) => {
                    clearTimeout(timeout)
                    reject(err)
                }
            })

            try {
                if (session.socket) {
                    session.socket.write(message)
                } else if (session.process.stdin) {
                    session.process.stdin.write(message)
                } else {
                    throw new Error('No transport available for debug session')
                }
            } catch (error) {
                clearTimeout(timeout)
                session.pendingRequests.delete(seq)
                reject(error)
            }
        })
    }

    async getDebugSessions(): Promise<Array<{ languageId: string; sessionId: string; port?: number; status: string }>> {
        return Array.from(this.debugSessions.values()).map(session => ({
            languageId: session.languageId,
            sessionId: session.id,
            port: session.port,
            status: session.status
        }))
    }

    async stopDebugSession(sessionId: string): Promise<boolean> {
        const session = this.debugSessions.get(sessionId)
        if (!session) return false

        try {
            if (session.socket) {
                session.socket.destroy()
            }
            session.process.kill()
            this.debugSessions.delete(sessionId)
            return true
        } catch (error) {
            console.error(`[LanguageGateway] Error stopping debug session ${sessionId}:`, error)
            return false
        }
    }

    private async findAvailablePort(): Promise<number> {
        return new Promise((resolve) => {
            const server = net.createServer()
            server.listen(0, () => {
                const port = (server.address() as net.AddressInfo).port
                server.close(() => resolve(port))
            })
        })
    }

    configureDebugAdapter(languageId: string, config: DebugAdapterConfig): void {
        this.debugConfigs.set(languageId, config)
    }

    async dispose(): Promise<void> {
        // Stop all debug sessions
        for (const [sessionId, session] of Array.from(this.debugSessions)) {
            try {
                if (session.socket) {
                    session.socket.destroy()
                }
                session.process.kill()
            } catch (error) {
                console.error(`[LanguageGateway] Error disposing debug session ${sessionId}:`, error)
            }
        }

        this.debugSessions.clear()
    }
}

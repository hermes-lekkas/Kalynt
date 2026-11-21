/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Debug-adapter runtime: spawns DAP adapters over stdio or socket, frames
 * the DAP message stream with UTF-8 byte lengths, and routes requests/responses/events.
 * Events are emitted on the owning gateway's emitter.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import path from 'node:path'
import type { DebugAdapterConfig } from './languageConfigs'

const HEADER_DELIMITER = Buffer.from('\r\n\r\n', 'ascii')

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
    buffer: Buffer
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

    private rejectPendingRequests(session: DebugSession, reason: string): void {
        if (session.pendingRequests.size === 0) return
        const err = new Error(reason)
        const pending = Array.from(session.pendingRequests.values())
        session.pendingRequests.clear()
        for (const req of pending) {
            req.reject(err)
        }
    }

    /**
     * Start a debug session with proper retry logic for socket connections
     */
    async startDebugSession(options: DebugStartOptions): Promise<{ success: boolean; port?: number; error?: string }> {
        const config = this.debugConfigs.get(options.languageId)
        if (!config) {
            return { success: false, error: `No debug adapter configuration found for ${options.languageId}` }
        }

        const sessionId = options.sessionId || `debug_${options.languageId}_${Date.now()}`

        try {
            const port = config.transport === 'socket'
                ? (options.port || await this.findAvailablePort())
                : undefined

            // Replace variables in command arguments, preserving array structure for ${args}
            const processedArgs = (config.args || []).flatMap(arg => {
                if (arg === '${args}') {
                    return options.args || []
                }
                if (arg.includes('${args}')) {
                    return arg
                        .replace(/\$\{port\}/g, String(port || 0))
                        .replace(/\$\{program\}/g, options.program)
                        .replace(/\$\{args\}/g, (options.args || []).join(' '))
                }
                return arg
                    .replace(/\$\{port\}/g, String(port || 0))
                    .replace(/\$\{program\}/g, options.program)
            })

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
                buffer: Buffer.alloc(0)
            }

            this.debugSessions.set(sessionId, session)

            let spawnError: Error | null = null
            // Attach error handler immediately so ENOENT never crashes Electron main process
            debugProcess.on('error', (error: Error) => {
                spawnError = error
                session.status = 'error'
                if (session.socket) {
                    session.socket.destroy()
                }
                this.rejectPendingRequests(session, `Debug adapter process error: ${error.message}`)
                this.debugSessions.delete(sessionId)
                this.events.emit('debug_session_error', {
                    sessionId,
                    error: error.message
                })
            })

            debugProcess.on('exit', (code: number | null) => {
                if (session.status !== 'error') {
                    session.status = 'stopped'
                }
                if (session.socket) {
                    session.socket.destroy()
                }
                this.rejectPendingRequests(session, `Debug session ${sessionId} exited with code ${code}`)
                this.debugSessions.delete(sessionId)
                this.events.emit('debug_session_stopped', { sessionId, exitCode: code })
            })

            debugProcess.stderr?.on('data', (data: Buffer) => {
                console.error(`[DebugAdapter ${options.languageId}]`, data.toString())
            })

            if (config.transport === 'stdio') {
                // Wait for either 'spawn' or immediate 'error' so ENOENT surfaces cleanly
                await new Promise<void>((resolve, reject) => {
                    if (spawnError) { reject(spawnError); return }
                    if (debugProcess.pid) { resolve(); return }
                    const onSpawn = () => {
                        debugProcess.off('error', onErr)
                        resolve()
                    }
                    const onErr = (err: Error) => {
                        debugProcess.off('spawn', onSpawn)
                        reject(err)
                    }
                    debugProcess.once('spawn', onSpawn)
                    debugProcess.once('error', onErr)
                })

                session.status = 'running'
                this.setupDebugListeners(session)
                this.events.emit('debug_session_started', {
                    sessionId,
                    languageId: options.languageId,
                    configuration: session.configuration,
                    transport: 'stdio'
                })
            } else {
                await this.connectWithRetry(port!, session, sessionId, options, debugProcess)
            }

            return { success: true, port }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[LanguageGateway] Failed to start debug session for ${options.languageId}:`, error)
            this.debugSessions.delete(sessionId)
            return { success: false, error: message }
        }
    }

    /**
     * Connect to debug adapter with retry logic.
     * Aborts promptly if the adapter process errors or exits.
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
            let settled = false
            let retryTimer: ReturnType<typeof setTimeout> | undefined
            let activeSocket: net.Socket | null = null

            const cleanup = () => {
                if (retryTimer) clearTimeout(retryTimer)
                debugProcess.off('error', onProcessFail)
                debugProcess.off('exit', onProcessExit)
            }

            const finish = (err?: Error) => {
                if (settled) return
                settled = true
                cleanup()
                if (err) {
                    activeSocket?.destroy()
                    reject(err)
                } else {
                    resolve()
                }
            }

            const onProcessFail = (err: Error) => {
                finish(new Error(`Debug adapter failed to spawn: ${err.message}`))
            }

            const onProcessExit = (code: number | null) => {
                finish(new Error(`Debug adapter exited before listening on port ${port} (code ${code})`))
            }

            debugProcess.once('error', onProcessFail)
            debugProcess.once('exit', onProcessExit)

            if (session.status === 'error' || session.status === 'stopped' || debugProcess.exitCode !== null) {
                finish(new Error(`Debug adapter process is not running`))
                return
            }

            const attemptConnect = (): void => {
                if (settled) return
                const socket = net.createConnection({ host: '127.0.0.1', port })
                activeSocket = socket

                socket
                    .on('connect', () => {
                        if (settled) {
                            socket.destroy()
                            return
                        }
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
                        finish()
                    })
                    .on('error', (error) => {
                        socket.destroy()
                        if (settled) return

                        if (retries < maxRetries && debugProcess.exitCode === null) {
                            retries++
                            retryTimer = setTimeout(attemptConnect, retryDelayMs)
                        } else {
                            console.error(`[DebugAdapter] Failed to connect after ${retries} retries:`, error)
                            session.status = 'error'
                            try { debugProcess.kill() } catch { /* ignore */ }
                            this.events.emit('debug_session_error', {
                                sessionId,
                                error: `Failed to connect to debug adapter: ${error.message}`
                            })
                            finish(error)
                        }
                    })
            }

            attemptConnect()
        })
    }

    /**
     * Setup listeners for DAP message stream using strict UTF-8 byte-length framing.
     */
    private setupDebugListeners(session: DebugSession) {
        const onData = (data: Buffer) => {
            session.buffer = session.buffer.length === 0 ? data : Buffer.concat([session.buffer, data])

            while (session.buffer.length > 0) {
                const headerEnd = session.buffer.indexOf(HEADER_DELIMITER)
                if (headerEnd === -1) break

                const headerText = session.buffer.subarray(0, headerEnd).toString('ascii')
                const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i)
                const bodyStart = headerEnd + HEADER_DELIMITER.length

                if (!lengthMatch) {
                    // Skip malformed header block
                    session.buffer = session.buffer.subarray(bodyStart)
                    continue
                }

                const contentLength = Number.parseInt(lengthMatch[1], 10)
                if (Number.isNaN(contentLength) || contentLength < 0) {
                    session.buffer = session.buffer.subarray(bodyStart)
                    continue
                }

                // Wait until we have all `contentLength` UTF-8 bytes
                if (session.buffer.length < bodyStart + contentLength) {
                    break
                }

                const rawMessage = session.buffer
                    .subarray(bodyStart, bodyStart + contentLength)
                    .toString('utf8')
                session.buffer = session.buffer.subarray(bodyStart + contentLength)

                try {
                    const message = JSON.parse(rawMessage)
                    this.handleDebugMessage(session, message)
                } catch (e) {
                    console.error('[LanguageGateway] Failed to parse DAP message', e)
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
            const pending = session.pendingRequests.get(requestSeq)
            if (pending) {
                session.pendingRequests.delete(requestSeq)
                if (message.success) {
                    pending.resolve(message)
                } else {
                    pending.reject(new Error(message.message || 'Debug request failed'))
                }
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
        const payloadBytes = Buffer.byteLength(json, 'utf8')
        const message = `Content-Length: ${payloadBytes}\r\n\r\n${json}`

        return new Promise((resolve, reject) => {
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
                    session.socket.write(message, 'utf8')
                } else if (session.process.stdin) {
                    session.process.stdin.write(message, 'utf8')
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
            this.rejectPendingRequests(session, `Debug session ${sessionId} stopped`)
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
        return new Promise((resolve, reject) => {
            const server = net.createServer()
            server.once('error', reject)
            server.listen(0, '127.0.0.1', () => {
                const port = (server.address() as net.AddressInfo).port
                server.close(() => resolve(port))
            })
        })
    }

    configureDebugAdapter(languageId: string, config: DebugAdapterConfig): void {
        this.debugConfigs.set(languageId, config)
    }

    async dispose(): Promise<void> {
        for (const [sessionId, session] of Array.from(this.debugSessions)) {
            try {
                this.rejectPendingRequests(session, `Debug gateway disposed`)
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

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * One Debug Adapter Protocol connection, over a process's stdio or a TCP
 * socket. Messages are framed by Content-Length, which counts bytes, so the
 * buffer is kept as bytes until a whole message has arrived.
 */
import { EventEmitter } from 'events'
import * as net from 'net'
import type { ChildProcess } from 'child_process'
import treeKill from 'tree-kill'

export interface DapMessage {
    seq: number
    type: 'request' | 'response' | 'event'
    command?: string
    event?: string
    request_seq?: number
    success?: boolean
    message?: string
    arguments?: any
    body?: any
}

interface Pending {
    resolve: (message: DapMessage) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
}

const HEADER = 'Content-Length:'
const MAX_NOISE = 64 * 1024

/**
 * Events: 'event' (DapMessage), 'request' (a reverse request from the adapter),
 * 'output' (text, 'stdout' | 'stderr') for console text outside the protocol,
 * and 'close' once the adapter is gone.
 */
export class DapConnection extends EventEmitter {
    process?: ChildProcess
    socket?: net.Socket
    private buffer = Buffer.alloc(0)
    private seq = 1
    private readonly pending = new Map<number, Pending>()
    private closed = false

    /** DAP over the process's stdio, or over `socket` with the process's output as console text. */
    attach(proc: ChildProcess | undefined, socket?: net.Socket) {
        this.process = proc
        this.socket = socket
        const feed = (chunk: Buffer) => this.receive(chunk)
        const text = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => this.emit('output', chunk.toString(), stream)

        if (socket) {
            socket.on('data', feed)
            socket.on('error', err => this.emit('output', `Debugger connection error: ${err.message}\n`, 'stderr'))
            socket.on('close', () => this.shutdown())
            proc?.stdout?.on('data', text('stdout'))
        } else {
            proc?.stdout?.on('data', feed)
            proc?.stdin?.on('error', () => undefined)
        }
        proc?.stderr?.on('data', text('stderr'))
        proc?.on('exit', () => this.shutdown())
        proc?.on('error', err => {
            this.emit('output', `Debugger failed to start: ${err.message}\n`, 'stderr')
            this.shutdown()
        })
    }

    get isClosed() {
        return this.closed
    }

    private receive(chunk: Buffer) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
        for (;;) {
            const start = this.buffer.indexOf(HEADER)
            if (start === -1) {
                if (this.buffer.length > MAX_NOISE) this.flushNoise(this.buffer.length)
                return
            }
            if (start > 0) this.flushNoise(start)

            const headerEnd = this.buffer.indexOf('\r\n\r\n')
            if (headerEnd === -1) return
            const match = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('ascii'))
            if (!match) {
                this.flushNoise(headerEnd + 4)
                continue
            }
            const bodyStart = headerEnd + 4
            const bodyEnd = bodyStart + Number(match[1])
            if (this.buffer.length < bodyEnd) return
            const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8')
            this.buffer = this.buffer.subarray(bodyEnd)
            try {
                this.dispatch(JSON.parse(body))
            } catch (err) {
                console.error('[Debug] Unreadable DAP message:', err)
            }
        }
    }

    private flushNoise(length: number) {
        const noise = this.buffer.subarray(0, length).toString()
        this.buffer = this.buffer.subarray(length)
        if (noise.trim()) this.emit('output', noise, 'stdout')
    }

    private dispatch(message: DapMessage) {
        if (message.type === 'response') {
            const pending = this.pending.get(message.request_seq!)
            if (!pending) return
            this.pending.delete(message.request_seq!)
            clearTimeout(pending.timer)
            if (message.success) pending.resolve(message)
            else pending.reject(new Error(message.message || `${message.command} failed`))
        } else if (message.type === 'event') {
            this.emit('event', message)
        } else if (message.type === 'request') {
            this.emit('request', message)
        }
    }

    private write(message: object) {
        const json = JSON.stringify(message)
        const packet = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`
        if (this.socket && !this.socket.destroyed) this.socket.write(packet)
        else if (this.process?.stdin?.writable) this.process.stdin.write(packet)
        else throw new Error('The debugger is not running')
    }

    request(command: string, args?: unknown, timeoutMs = 10_000): Promise<DapMessage> {
        if (this.closed) return Promise.reject(new Error('The debugger is not running'))
        const seq = this.seq++
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(seq)
                reject(new Error(`The debugger didn't answer '${command}' within ${Math.round(timeoutMs / 1000)}s`))
            }, timeoutMs)
            this.pending.set(seq, { resolve, reject, timer })
            try {
                this.write({ seq, type: 'request', command, arguments: args })
            } catch (err) {
                clearTimeout(timer)
                this.pending.delete(seq)
                reject(err as Error)
            }
        })
    }

    /** Answers a reverse request from the adapter. */
    respond(request: DapMessage, success: boolean, body?: unknown, message?: string) {
        try {
            this.write({ seq: this.seq++, type: 'response', request_seq: request.seq, command: request.command, success, body, message })
        } catch {
            // Adapter already gone.
        }
    }

    /** Waits for one adapter event, or rejects after the timeout or when the adapter stops. */
    waitForEvent(name: string, timeoutMs = 10_000): Promise<DapMessage> {
        return new Promise<DapMessage>((resolve, reject) => {
            const onEvent = (message: DapMessage) => {
                if (message.event !== name) return
                cleanup()
                resolve(message)
            }
            const onClose = () => { cleanup(); reject(new Error('The debugger stopped')) }
            const timer = setTimeout(() => { cleanup(); reject(new Error(`No '${name}' event from the debugger`)) }, timeoutMs)
            const cleanup = () => {
                clearTimeout(timer)
                this.off('event', onEvent)
                this.off('close', onClose)
            }
            if (this.closed) { cleanup(); reject(new Error('The debugger stopped')); return }
            this.on('event', onEvent)
            this.on('close', onClose)
        })
    }

    private shutdown() {
        if (this.closed) return
        this.closed = true
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer)
            pending.reject(new Error('The debugger stopped'))
        }
        this.pending.clear()
        this.emit('close')
    }

    /** Ends the connection and the adapter process. */
    dispose() {
        this.socket?.destroy()
        const pid = this.process?.pid
        if (pid && this.process?.exitCode === null) treeKill(pid, 'SIGKILL', () => undefined)
        this.shutdown()
    }
}

/** Connects to an adapter listening on localhost, retrying while it starts. */
export async function connectWithRetry(port: number, attempts = 10, delayMs = 500, isAlive: () => boolean = () => true): Promise<net.Socket> {
    let lastError: Error | null = null
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (!isAlive()) break
        try {
            return await new Promise<net.Socket>((resolve, reject) => {
                const socket = net.connect(port, '127.0.0.1')
                const timer = setTimeout(() => { socket.destroy(); reject(new Error('timed out')) }, 2000)
                socket.once('connect', () => { clearTimeout(timer); resolve(socket) })
                socket.once('error', err => { clearTimeout(timer); socket.destroy(); reject(err) })
            })
        } catch (err) {
            lastError = err as Error
            await new Promise(r => setTimeout(r, delayMs))
        }
    }
    throw new Error(`Couldn't connect to the debugger on port ${port}${lastError ? `: ${lastError.message}` : ''}`)
}

/** A free localhost port for adapters that listen on TCP. */
export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.unref()
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as net.AddressInfo
            server.close(() => resolve(port))
        })
    })
}

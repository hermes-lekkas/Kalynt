/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { app, BrowserWindow } from 'electron'
import { EventEmitter } from 'events'

interface JSONRPCRequest {
    jsonrpc: string
    id: number | null
    method: string
    params?: any
}

interface JSONRPCMessage {
    jsonrpc: string
    id?: number
    method?: string
    result?: any
    params?: any
    error?: { code: number; message: string }
}

class NativeHelperService extends EventEmitter {
    private process: ChildProcess | null = null
    private requestId = 0
    private pendingRequests = new Map<number, { resolve: (res: any) => void, reject: (err: Error) => void }>()
    private buffer = ''
    private mainWindow: BrowserWindow | null = null

    constructor() {
        super()
        if (process.platform === 'darwin') {
            this.init()
        }
    }

    private init() {
        const helperPath = app.isPackaged
            ? path.join(process.resourcesPath, 'bin', 'KalyntHelper')
            : path.join(app.getAppPath(), '..', '..', 'packages', 'native-macos', '.build', 'debug', 'KalyntHelper')

        if (!fs.existsSync(helperPath)) {
            console.warn('[NativeHelper] Swift binary not found. Native features disabled.')
            return
        }

        try {
            const proc = spawn(helperPath)
            this.process = proc

            proc.on('error', (error) => {
                console.error('[NativeHelper] Process error:', error)
                if (this.process === proc) this.process = null
                this.rejectAllPending(new Error(`Native helper error: ${error.message}`))
            })

            proc.stdin?.on('error', (error) => {
                console.error('[NativeHelper] Stdin error:', error)
            })

            proc.stdout?.on('data', (data) => {
                this.buffer += data.toString()
                this.processBuffer()
            })

            proc.stderr?.on('data', (data) => {
                console.error('[NativeHelper] Error:', data.toString())
            })

            proc.on('close', (code) => {
                console.log(`[NativeHelper] Closed with code ${code}`)
                if (this.process === proc) this.process = null
                this.buffer = ''
                this.rejectAllPending(new Error(`Native helper exited with code ${code ?? 'unknown'}`))
            })
        } catch (error) {
            console.error('[NativeHelper] Failed to spawn:', error)
        }
    }

    private rejectAllPending(error: Error) {
        for (const [, pending] of this.pendingRequests) {
            pending.reject(error)
        }
        this.pendingRequests.clear()
    }

    private processBuffer() {
        const lines = this.buffer.split('\n')
        this.buffer = lines.pop() || ''

        for (const line of lines) {
            if (!line.trim()) continue
            try {
                const message = JSON.parse(line) as JSONRPCMessage
                
                if (message.id !== undefined && message.id !== null) {
                    // It's a response
                    const pending = this.pendingRequests.get(message.id)
                    if (pending) {
                        if (message.error) {
                            pending.reject(new Error(message.error.message))
                        } else {
                            pending.resolve(message.result)
                        }
                        this.pendingRequests.delete(message.id)
                    }
                } else if (message.method) {
                    // It's a notification/event
                    this.emit(message.method, message.params)
                }
            } catch (error) {
                console.error('[NativeHelper] Parse error:', error, line)
            }
        }
    }

    async request(method: string, params?: any): Promise<any> {
        if (!this.process || !this.process.stdin?.writable) {
            throw new Error('Native helper not running')
        }

        const id = ++this.requestId
        const req: JSONRPCRequest = {
            jsonrpc: '2.0',
            id,
            method,
            params
        }

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject })
            try {
                this.process?.stdin?.write(JSON.stringify(req) + '\n', (err) => {
                    if (err) {
                        const pending = this.pendingRequests.get(id)
                        if (pending) {
                            this.pendingRequests.delete(id)
                            pending.reject(err)
                        }
                    }
                })
            } catch (err) {
                this.pendingRequests.delete(id)
                reject(err instanceof Error ? err : new Error(String(err)))
            }
        })
    }

    isAvailable(): boolean {
        return this.process !== null
    }

    setMainWindow(window: BrowserWindow | null): void {
        this.mainWindow = window
    }

    getMainWindow(): BrowserWindow | null {
        return this.mainWindow
    }

    dispose() {
        this.rejectAllPending(new Error('Native helper disposed'))
        this.buffer = ''
        this.mainWindow = null
        if (this.process) {
            try { this.process.kill() } catch { /* already gone */ }
            this.process = null
        }
    }
}

export const nativeHelperService = new NativeHelperService()

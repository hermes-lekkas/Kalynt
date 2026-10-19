/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Debug sessions. The start-up follows the order adapters expect:
 * initialize, launch (answered later by some adapters), wait for
 * 'initialized', set breakpoints, configurationDone, then the launch answer.
 */
import { spawn, type ChildProcess } from 'child_process'
import type { BrowserWindow } from 'electron'
import type { Breakpoint, DebugConfiguration, StackFrame, Variable } from '../../../src/types/debug'
import { sendToWindow } from '../../utils/window'
import { killProcessTree } from '../code-exec/binaries'
import { AdapterMissingError, debugEnv, launchAdapter } from './adapters'
import { prepareNativeProgram, resolveVariables } from './configurations'
import type { DapConnection, DapMessage } from './transport'

export interface InitialBreakpoints {
    file: string
    lines: number[]
}

export interface WatchExpression {
    id: string
    expression: string
    result?: string
    type?: string
    error?: string
}

interface Session {
    id: string
    configuration: DebugConfiguration
    connection: DapConnection
    threadId?: number
    breakpoints: Map<string, Breakpoint[]>
    watches: WatchExpression[]
    /** Programs the adapter asked us to start through runInTerminal. */
    debuggees: ChildProcess[]
}

// Launch configuration keys that only mean something to the editor.
const EDITOR_ONLY_KEYS = new Set(['type', 'request', 'name', 'preLaunchTask', 'postDebugTask', 'internalConsoleOptions', 'presentation'])

const toDapBreakpoints = (breakpoints: Breakpoint[]) =>
    breakpoints.map(bp => ({ line: bp.line, column: bp.column, condition: bp.condition, hitCondition: bp.hitCondition, logMessage: bp.logMessage }))

export class DebugSessionManager {
    private readonly sessions = new Map<string, Session>()
    private counter = 0

    constructor(private readonly getWindow: () => BrowserWindow | null) {}

    private send(channel: string, payload: unknown) {
        sendToWindow(this.getWindow(), channel, payload)
    }

    private get(sessionId: string): Session {
        const session = this.sessions.get(sessionId)
        if (!session) throw new Error('Debug session not found')
        return session
    }

    async startSession(configuration: DebugConfiguration, workspacePath: string, activeFile?: string, initial: InitialBreakpoints[] = []): Promise<string> {
        const sessionId = `debug-${++this.counter}`
        const output = (text: string, category = 'console') => this.send('debug:output', { sessionId, category, output: text })

        let resolved = resolveVariables(configuration, workspacePath, activeFile)
        let connection: DapConnection
        try {
            resolved = await prepareNativeProgram(resolved, text => output(text))
            connection = await launchAdapter(resolved, workspacePath)
        } catch (error) {
            // The failure is returned to the caller; only the install hint is an event.
            if (error instanceof AdapterMissingError) {
                this.send('debug:adapter-missing', { type: error.type, requiredBinary: error.requiredBinary, installInstructions: error.installInstructions })
            }
            throw error
        }

        const session: Session = { id: sessionId, configuration: resolved, connection, breakpoints: new Map(), watches: [], debuggees: [] }
        this.sessions.set(sessionId, session)
        this.wire(session)

        try {
            // Listen first: some adapters (GDB) send 'initialized' right behind the initialize answer.
            const initialized = connection.waitForEvent('initialized', 15_000)
            initialized.catch(() => undefined)
            const init = await connection.request('initialize', {
                clientID: 'kalynt', clientName: 'Kalynt', adapterID: resolved.type, locale: 'en-US',
                pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
                supportsVariableType: true, supportsVariablePaging: true, supportsRunInTerminalRequest: true
            })
            const launchArgs = Object.fromEntries(Object.entries(resolved).filter(([key]) => !EDITOR_ONLY_KEYS.has(key)))
            // Not awaited yet: debugpy and others answer only after configurationDone.
            const launched = connection.request(resolved.request === 'attach' ? 'attach' : 'launch', launchArgs, 60_000)
            launched.catch(() => undefined)

            await Promise.race([initialized, launched.then(() => initialized)])
            for (const { file, lines } of initial) {
                const breakpoints = lines.map((line, i) => ({ id: `bp-${i}`, file, line, enabled: true, verified: false } as Breakpoint))
                session.breakpoints.set(file, breakpoints)
                await connection.request('setBreakpoints', { source: { path: file }, breakpoints: toDapBreakpoints(breakpoints) })
                    .catch(err => output(`Couldn't set breakpoints in ${file}: ${err.message}\n`, 'stderr'))
            }
            if (init.body?.supportsConfigurationDoneRequest !== false) await connection.request('configurationDone', {})
            await launched

            this.send('debug:started', { sessionId, configuration: resolved })
            return sessionId
        } catch (error) {
            await this.stopSession(sessionId)
            throw error
        }
    }

    private wire(session: Session) {
        const { id: sessionId, connection } = session
        connection.on('output', (text: string, stream: string) => this.send('debug:output', { sessionId, category: stream, output: text }))
        connection.on('event', (event: DapMessage) => {
            this.send('debug:event', { sessionId, ...event })
            switch (event.event) {
                case 'stopped':
                    if (event.body?.threadId !== undefined) session.threadId = event.body.threadId
                    this.send('debug:stopped', { sessionId, ...event.body })
                    break
                case 'continued':
                    this.send('debug:continued', { sessionId, ...event.body })
                    break
                case 'output':
                    if (event.body?.category !== 'telemetry') this.send('debug:output', { sessionId, ...event.body })
                    break
                case 'breakpoint':
                    this.send('debug:breakpoint', { sessionId, ...event.body })
                    break
                case 'terminated':
                    void this.stopSession(sessionId)
                    break
            }
        })
        connection.on('request', (request: DapMessage) => this.handleReverseRequest(session, request))
        connection.on('close', () => {
            if (this.sessions.has(sessionId)) void this.stopSession(sessionId)
        })
    }

    /** Requests the adapter sends to us: runInTerminal starts the program here and streams its output. */
    private handleReverseRequest(session: Session, request: DapMessage) {
        if (request.command !== 'runInTerminal') {
            session.connection.respond(request, false, undefined, `${request.command} is not supported`)
            return
        }
        const { args = [], cwd, env } = request.arguments ?? {}
        if (!Array.isArray(args) || !args.length) {
            session.connection.respond(request, false, undefined, 'Nothing to run')
            return
        }
        const extra = Object.fromEntries(Object.entries(env ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>
        const proc = spawn(args[0], args.slice(1), { cwd: cwd || undefined, env: debugEnv(extra), windowsHide: true })
        session.debuggees.push(proc)
        proc.stdin?.on('error', () => undefined)
        const forward = (category: string) => (data: Buffer) => this.send('debug:output', { sessionId: session.id, category, output: data.toString() })
        proc.stdout?.on('data', forward('stdout'))
        proc.stderr?.on('data', forward('stderr'))
        proc.on('error', err => {
            this.send('debug:output', { sessionId: session.id, category: 'stderr', output: `Couldn't start the program: ${err.message}\n` })
        })
        session.connection.respond(request, true, { processId: proc.pid })
    }

    async setBreakpoints(sessionId: string, file: string, breakpoints: Breakpoint[]): Promise<void> {
        const session = this.get(sessionId)
        session.breakpoints.set(file, breakpoints)
        await session.connection.request('setBreakpoints', { source: { path: file }, breakpoints: toDapBreakpoints(breakpoints) })
    }

    private thread(session: Session, threadId?: number) {
        return { threadId: threadId ?? session.threadId ?? 1 }
    }

    async control(sessionId: string, action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause', threadId?: number): Promise<void> {
        const session = this.get(sessionId)
        await session.connection.request(action, this.thread(session, threadId))
    }

    async getCallStack(sessionId: string, threadId?: number): Promise<StackFrame[]> {
        const session = this.get(sessionId)
        const response = await session.connection.request('stackTrace', this.thread(session, threadId))
        return response.body?.stackFrames ?? []
    }

    async getVariables(sessionId: string, variablesReference: number): Promise<Variable[]> {
        const response = await this.get(sessionId).connection.request('variables', { variablesReference })
        return response.body?.variables ?? []
    }

    async evaluate(sessionId: string, expression: string, frameId?: number): Promise<any> {
        const response = await this.get(sessionId).connection.request('evaluate', { expression, frameId, context: 'watch' })
        return response.body
    }

    addWatch(sessionId: string, expression: string): WatchExpression {
        const watch = { id: `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, expression }
        this.get(sessionId).watches.push(watch)
        return watch
    }

    removeWatch(sessionId: string, watchId: string): boolean {
        const session = this.get(sessionId)
        const before = session.watches.length
        session.watches = session.watches.filter(w => w.id !== watchId)
        return session.watches.length < before
    }

    getWatches(sessionId: string): WatchExpression[] {
        return this.sessions.get(sessionId)?.watches ?? []
    }

    clearWatches(sessionId: string) {
        const session = this.sessions.get(sessionId)
        if (session) session.watches = []
    }

    async updateWatches(sessionId: string, frameId?: number): Promise<WatchExpression[]> {
        const session = this.get(sessionId)
        for (const watch of session.watches) {
            try {
                const result = await this.evaluate(sessionId, watch.expression, frameId)
                Object.assign(watch, { result: result?.result, type: result?.type, error: undefined })
            } catch (error) {
                Object.assign(watch, { result: undefined, error: (error as Error).message })
            }
        }
        return session.watches
    }

    /** Ends a session: asks the adapter to stop the program, then closes everything. */
    async stopSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session) return
        this.sessions.delete(sessionId)
        const { connection } = session
        if (!connection.isClosed) {
            await connection.request('disconnect', { terminateDebuggee: true }, 3000).catch(() => undefined)
        }
        connection.dispose()
        await Promise.all(session.debuggees.map(killProcessTree))
        this.send('debug:terminated', { sessionId })
    }

    async stopAllSessions(): Promise<number> {
        const ids = [...this.sessions.keys()]
        await Promise.all(ids.map(id => this.stopSession(id)))
        return ids.length
    }
}

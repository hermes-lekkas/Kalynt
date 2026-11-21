/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Debug sessions. The start-up follows the order adapters expect:
 * initialize, launch (answered later by some adapters), wait for
 * 'initialized', set breakpoints, configurationDone, then the launch answer.
 */
import { spawn, type ChildProcess } from 'child_process'
import type { BrowserWindow } from 'electron'
import type { Breakpoint, DebugConfiguration, Scope, StackFrame, Variable } from '../../../src/types/debug'
import { sendToWindow } from '../../utils/window'
import { killProcessTree } from '../code-exec/binaries'
import { AdapterMissingError, debugEnv, launchAdapter } from './adapters'
import { prepareNativeProgram, resolveVariables } from './configurations'
import { DapConnection, connectWithRetry, type DapMessage } from './transport'

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
    /** Child DAP connections spawned via `startDebugging` (e.g. vscode-js-debug targets). */
    children: DapConnection[]
    /** Connection currently holding the paused/active target thread. */
    activeConnection: DapConnection
    threadId?: number
    breakpoints: Map<string, Breakpoint[]>
    watches: WatchExpression[]
    /** Programs the adapter asked us to start through runInTerminal. */
    debuggees: ChildProcess[]
}

// Launch configuration keys that only mean something to the editor.
const EDITOR_ONLY_KEYS = new Set(['type', 'request', 'name', 'preLaunchTask', 'postDebugTask', 'internalConsoleOptions', 'presentation'])
const NODE_ADAPTER_TYPES = new Set(['node', 'pwa-node', 'node-terminal'])

const toDapBreakpoints = (breakpoints: Breakpoint[]) =>
    breakpoints.map(bp => ({ line: bp.line, column: bp.column, condition: bp.condition, hitCondition: bp.hitCondition, logMessage: bp.logMessage }))

export function buildLaunchArguments(resolved: DebugConfiguration, workspacePath: string): Record<string, unknown> {
    const launchArgs = Object.fromEntries(Object.entries(resolved).filter(([key]) => !EDITOR_ONLY_KEYS.has(key)))
    if (NODE_ADAPTER_TYPES.has(resolved.type)) {
        // js-debug-dap routes launch/attach handlers by `type` (e.g. 'pwa-node').
        launchArgs.type = resolved.type === 'node' ? 'pwa-node' : resolved.type
        if (resolved.request !== 'attach') {
            if (!launchArgs.cwd) launchArgs.cwd = workspacePath
            if (!launchArgs.console) launchArgs.console = 'internalConsole'
            if (!launchArgs.skipFiles) launchArgs.skipFiles = ['<node_internals>/**']
        }
    }
    return launchArgs
}

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

        const session: Session = {
            id: sessionId,
            configuration: resolved,
            connection,
            children: [],
            activeConnection: connection,
            breakpoints: new Map(),
            watches: [],
            debuggees: []
        }
        this.sessions.set(sessionId, session)
        this.wire(session, connection, false)

        let phase = 'initialize'
        try {
            // Listen first: some adapters (GDB) send 'initialized' right behind the initialize answer.
            const initialized = connection.waitForEvent('initialized', 15_000)
            initialized.catch(() => undefined)
            const adapterID = NODE_ADAPTER_TYPES.has(resolved.type) && resolved.type === 'node' ? 'pwa-node' : resolved.type
            const init = await connection.request('initialize', {
                clientID: 'kalynt', clientName: 'Kalynt', adapterID, locale: 'en-US',
                pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
                supportsVariableType: true, supportsVariablePaging: true,
                supportsRunInTerminalRequest: true, supportsStartDebuggingRequest: true
            })
            phase = resolved.request === 'attach' ? 'attach' : 'launch'
            const launchArgs = buildLaunchArguments(resolved, workspacePath)
            // Not awaited yet: debugpy and js-debug answer only after configurationDone.
            const launched = connection.request(phase, launchArgs, 60_000)
            launched.catch(() => undefined)

            phase = 'waiting for initialized'
            await Promise.race([initialized, launched.then(() => initialized)])
            phase = 'setBreakpoints'
            for (const { file, lines } of initial) {
                const breakpoints = lines.map((line, i) => ({ id: `bp-${i}`, file, line, enabled: true, verified: false } as Breakpoint))
                session.breakpoints.set(file, breakpoints)
                await connection.request('setBreakpoints', { source: { path: file }, breakpoints: toDapBreakpoints(breakpoints) })
                    .catch(err => output(`Couldn't set breakpoints in ${file}: ${err.message}\n`, 'stderr'))
            }
            phase = 'configurationDone'
            if (init.body?.supportsConfigurationDoneRequest !== false) await connection.request('configurationDone', {})
            phase = resolved.request === 'attach' ? 'attach response' : 'launch response'
            await launched

            this.send('debug:started', { sessionId, configuration: resolved })
            return sessionId
        } catch (error) {
            const rawMessage = error instanceof Error ? error.message : String(error)
            const detailed = rawMessage.includes(phase)
                ? rawMessage
                : `Debug adapter failed during ${phase}: ${rawMessage}`
            output(`${detailed}\n`, 'stderr')
            await this.stopSession(sessionId)
            throw new Error(detailed)
        }
    }

    private wire(session: Session, connection: DapConnection, isChild: boolean) {
        const sessionId = session.id
        connection.on('output', (text: string, stream: string) => this.send('debug:output', { sessionId, category: stream, output: text }))
        connection.on('adapter-error', (error: string) => this.send('debug:error', { sessionId, error }))
        connection.on('response', (response: DapMessage) => this.send('debug:response', { sessionId, ...response }))
        connection.on('event', (event: DapMessage) => {
            this.send('debug:event', { sessionId, ...event })
            switch (event.event) {
                case 'stopped':
                    session.activeConnection = connection
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
                    if (isChild) {
                        session.children = session.children.filter(c => c !== connection)
                        connection.dispose()
                        if (session.activeConnection === connection) {
                            session.activeConnection = session.children[session.children.length - 1] ?? session.connection
                        }
                    } else {
                        void this.stopSession(sessionId)
                    }
                    break
            }
        })
        connection.on('request', (request: DapMessage) => this.handleReverseRequest(session, connection, request))
        connection.on('close', () => {
            if (isChild) {
                session.children = session.children.filter(c => c !== connection)
                if (session.activeConnection === connection) {
                    session.activeConnection = session.children[session.children.length - 1] ?? session.connection
                }
            } else if (this.sessions.has(sessionId)) {
                void this.stopSession(sessionId)
            }
        })
    }

    /**
     * Handles reverse requests from the adapter:
     * - `runInTerminal`: starts the program and streams its output.
     * - `startDebugging`: opens a child DAP session on the adapter's TCP server (used by vscode-js-debug).
     */
    private handleReverseRequest(session: Session, sourceConn: DapConnection, request: DapMessage) {
        if (request.command === 'startDebugging') {
            void this.handleStartDebugging(session, sourceConn, request)
            return
        }
        if (request.command !== 'runInTerminal') {
            sourceConn.respond(request, false, undefined, `${request.command} is not supported`)
            return
        }
        const { args = [], cwd, env } = request.arguments ?? {}
        if (!Array.isArray(args) || !args.length) {
            sourceConn.respond(request, false, undefined, 'Nothing to run')
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
            const message = `Couldn't start the program: ${err.message}`
            this.send('debug:output', { sessionId: session.id, category: 'stderr', output: `${message}\n` })
            this.send('debug:error', { sessionId: session.id, error: message })
        })
        sourceConn.respond(request, true, { processId: proc.pid })
    }

    private async handleStartDebugging(session: Session, sourceConn: DapConnection, request: DapMessage): Promise<void> {
        const port = sourceConn.serverPort ?? session.connection.serverPort
        const host = sourceConn.serverHost ?? session.connection.serverHost ?? '127.0.0.1'
        if (!port) {
            sourceConn.respond(request, false, undefined, 'startDebugging requires a socket-based debug adapter')
            return
        }

        const childRequestType = request.arguments?.request === 'attach' ? 'attach' : 'launch'
        const childConfig = (request.arguments?.configuration && typeof request.arguments.configuration === 'object')
            ? { ...request.arguments.configuration }
            : {}

        // Acknowledge immediately per DAP spec so the parent binder does not stall waiting to accept the child socket.
        sourceConn.respond(request, true)

        let childConn: DapConnection | null = null
        try {
            const socket = await connectWithRetry(port, 10, 200, () => this.sessions.has(session.id) && !session.connection.isClosed)
            childConn = new DapConnection()
            childConn.serverHost = host
            childConn.serverPort = port
            childConn.attach(undefined, socket)
            session.children.push(childConn)
            session.activeConnection = childConn
            this.wire(session, childConn, true)

            const childInitialized = childConn.waitForEvent('initialized', 15_000)
            childInitialized.catch(() => undefined)
            const childInit = await childConn.request('initialize', {
                clientID: 'kalynt', clientName: 'Kalynt',
                adapterID: typeof childConfig.type === 'string' ? childConfig.type : 'pwa-node',
                locale: 'en-US', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
                supportsVariableType: true, supportsVariablePaging: true,
                supportsRunInTerminalRequest: true, supportsStartDebuggingRequest: true
            })
            const childLaunched = childConn.request(childRequestType, childConfig, 60_000)
            childLaunched.catch(() => undefined)

            await Promise.race([childInitialized, childLaunched.then(() => childInitialized)])
            for (const [file, breakpoints] of session.breakpoints.entries()) {
                await childConn.request('setBreakpoints', { source: { path: file }, breakpoints: toDapBreakpoints(breakpoints) })
                    .catch(err => this.send('debug:output', {
                        sessionId: session.id,
                        category: 'stderr',
                        output: `Couldn't set breakpoints in ${file}: ${err.message}\n`
                    }))
            }
            if (childInit.body?.supportsConfigurationDoneRequest !== false) {
                await childConn.request('configurationDone', {})
            }
            await childLaunched
        } catch (error) {
            const message = `Child debug target failed (${childRequestType}): ${error instanceof Error ? error.message : String(error)}`
            this.send('debug:output', { sessionId: session.id, category: 'stderr', output: `${message}\n` })
            if (childConn) {
                session.children = session.children.filter(c => c !== childConn)
                childConn.dispose()
                if (session.activeConnection === childConn) {
                    session.activeConnection = session.children[session.children.length - 1] ?? session.connection
                }
            }
        }
    }

    private targetConnection(session: Session): DapConnection {
        if (!session.activeConnection.isClosed) return session.activeConnection
        const liveChild = session.children.find(c => !c.isClosed)
        if (liveChild) {
            session.activeConnection = liveChild
            return liveChild
        }
        return session.connection
    }

    async setBreakpoints(sessionId: string, file: string, breakpoints: Breakpoint[]): Promise<void> {
        const session = this.get(sessionId)
        session.breakpoints.set(file, breakpoints)
        const targets = [session.connection, ...session.children].filter(c => !c.isClosed)
        await Promise.all(targets.map(conn =>
            conn.request('setBreakpoints', { source: { path: file }, breakpoints: toDapBreakpoints(breakpoints) })
        ))
    }

    private thread(session: Session, threadId?: number) {
        return { threadId: threadId ?? session.threadId ?? 1 }
    }

    async control(sessionId: string, action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause', threadId?: number): Promise<void> {
        const session = this.get(sessionId)
        await this.targetConnection(session).request(action, this.thread(session, threadId))
    }

    async getCallStack(sessionId: string, threadId?: number): Promise<StackFrame[]> {
        const session = this.get(sessionId)
        const response = await this.targetConnection(session).request('stackTrace', this.thread(session, threadId))
        return response.body?.stackFrames ?? []
    }

    async getScopes(sessionId: string, frameId: number): Promise<Scope[]> {
        const session = this.get(sessionId)
        const response = await this.targetConnection(session).request('scopes', { frameId })
        return response.body?.scopes ?? []
    }

    async getVariables(sessionId: string, variablesReference: number): Promise<Variable[]> {
        const session = this.get(sessionId)
        const response = await this.targetConnection(session).request('variables', { variablesReference })
        return response.body?.variables ?? []
    }

    async evaluate(sessionId: string, expression: string, frameId?: number): Promise<any> {
        const session = this.get(sessionId)
        const response = await this.targetConnection(session).request('evaluate', { expression, frameId, context: 'watch' })
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
        const children = [...session.children]
        session.children = []
        await Promise.all(children.map(async (child) => {
            if (!child.isClosed) {
                await child.request('disconnect', { terminateDebuggee: true }, 2000).catch(() => undefined)
            }
            child.dispose()
        }))
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

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// main-process/terminal.ts
import * as pty from 'node-pty'
import type { BrowserWindow } from 'electron'
import { EventEmitter } from 'node:events'
import { ShellIntegrationService, type CommandRecord, type ShellIntegrationData } from './shellIntegration'
import { LanguageRuntimeGateway } from './languageGateway'
import { TaskRunnerService } from './taskRunner'
import { TerminalSessionManager, isValidSessionId } from './terminalManager'
import { resolveSpawnTarget, getDefaultShell } from './terminalEnv'
import { sendToWindow } from '../utils/window'

// Enhanced terminal interface
export interface KalyntTerminal extends pty.IPty {
    id: string
    title: string
    shell: string
    cwd: string
    env: { [key: string]: string }
    status: 'running' | 'stopped' | 'error'
    lastExitCode?: number
    processType?: 'shell' | 'task' | 'debug'
    metadata?: {
        languageId?: string
        taskId?: string
        debugSessionId?: string
        projectType?: string
    }
}

export class TerminalService extends EventEmitter {
    private readonly terminals = new Map<string, KalyntTerminal>()
    public shellIntegration: ShellIntegrationService
    public languageGateway: LanguageRuntimeGateway
    public readonly taskRunner: TaskRunnerService
    public readonly sessionManager: TerminalSessionManager
    private readonly terminalHistory = new Map<string, string[]>()
    private readonly maxHistorySize = 1000
    // Track cleanup timeouts to prevent race conditions
    private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

    constructor(
        private readonly getMainWindow: () => BrowserWindow | null,
        private readonly getWorkspacePath: () => string | null
    ) {
        super()
        this.shellIntegration = new ShellIntegrationService()
        this.languageGateway = new LanguageRuntimeGateway()
        this.taskRunner = new TaskRunnerService()
        this.sessionManager = new TerminalSessionManager()

        // Keep session records synchronized with shell integration
        this.shellIntegration.on('command_recorded', (command: CommandRecord) => {
            if (command.command) {
                this.sessionManager.addToCommandHistory(command.terminalId, command.command, command.exitCode)
            }
        })

        this.shellIntegration.on('integration_data', (event: ShellIntegrationData) => {
            if (event.type === 'cwd_change' && event.data?.cwd) {
                const terminal = this.terminals.get(event.terminalId)
                if (terminal) {
                    terminal.cwd = event.data.cwd
                }
                this.sessionManager.updateSession(event.terminalId, { cwd: event.data.cwd })
            }
        })
    }

    private send(channel: string, payload: unknown): void {
        sendToWindow(this.getMainWindow(), channel, payload)
    }

    async spawnTerminal(options: {
        id: string
        shell?: string
        cwd?: string
        cols?: number
        rows?: number
        env?: { [key: string]: string }
        title?: string
        processType?: 'shell' | 'task' | 'debug'
        metadata?: any
    }): Promise<{ success: boolean; pid?: number; error?: string }> {
        try {
            // A running terminal with this id is reattached; a stopped one is replaced.
            const existing = this.terminals.get(options.id)
            if (existing && existing.status === 'stopped') {
                clearTimeout(this.cleanupTimers.get(options.id))
                this.cleanupTimers.delete(options.id)
                this.terminals.delete(options.id)
                this.terminalHistory.delete(options.id)
                this.shellIntegration.detachFromTerminal(options.id)
            } else if (existing) {
                const terminal = existing
                this.send('terminal:restored', {
                    id: options.id,
                    pid: terminal.pid,
                    title: terminal.title
                })
                return { success: true, pid: terminal.pid }
            }

            // Determine shell, working directory and environment (with PATH enhancement)
            const { shell, cwd, env } = resolveSpawnTarget({
                shell: options.shell,
                cwd: options.cwd,
                workspacePath: this.getWorkspacePath(),
                env: options.env,
                id: options.id
            })

            const cols = options.cols || 80
            const rows = options.rows || 24

            // Prepare shell integration args/env before spawning (no post-spawn PTY write injection)
            const integrationSpawn = this.shellIntegration.prepareSpawn(options.id, shell, env)

            let ptyProcess: KalyntTerminal
            try {
                ptyProcess = pty.spawn(shell, integrationSpawn.args, {
                    name: 'xterm-256color',
                    cols,
                    rows,
                    cwd,
                    env: integrationSpawn.env,
                    encoding: 'utf8',
                    handleFlowControl: true,
                    useConpty: process.platform === 'win32'
                }) as KalyntTerminal
            } catch (spawnError) {
                this.shellIntegration.detachFromTerminal(options.id)
                throw spawnError
            }

            // Enhance with metadata
            ptyProcess.id = options.id
            ptyProcess.title = options.title || `Terminal ${options.id}`
            ptyProcess.shell = shell
            ptyProcess.cwd = cwd
            ptyProcess.env = integrationSpawn.env
            ptyProcess.status = 'running'
            ptyProcess.processType = options.processType || 'shell'
            ptyProcess.metadata = options.metadata || {}

            // Store terminal
            this.terminals.set(options.id, ptyProcess)
            this.terminalHistory.set(options.id, [])

            // Register/update session in sessionManager so saveTerminalState works
            if (isValidSessionId(options.id)) {
                if (this.sessionManager.getSession(options.id)) {
                    this.sessionManager.updateSession(options.id, {
                        title: ptyProcess.title,
                        shell,
                        cwd,
                        cols,
                        rows,
                        status: 'running',
                        processType: ptyProcess.processType,
                        metadata: ptyProcess.metadata
                    })
                } else {
                    this.sessionManager.createSession({
                        id: options.id,
                        title: ptyProcess.title,
                        shell,
                        cwd,
                        env,
                        cols,
                        rows,
                        processType: ptyProcess.processType,
                        metadata: ptyProcess.metadata
                    })
                }
            }

            // Setup shell integration
            this.shellIntegration.attachToTerminal(options.id, ptyProcess, shell)

            // Setup event handlers
            this.setupTerminalEvents(options.id, ptyProcess)

            // Notify renderer
            this.send('terminal:spawned', {
                id: options.id,
                pid: ptyProcess.pid,
                title: ptyProcess.title,
                cwd,
                shell
            })

            console.log(`[Terminal] Spawned ${shell} with PID ${ptyProcess.pid} in ${cwd}`)
            return { success: true, pid: ptyProcess.pid }
        } catch (error) {
            console.error('[Terminal] Spawn error:', error)
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    }

    private setupTerminalEvents(id: string, terminal: KalyntTerminal) {
        terminal.onData((data) => {
            this.handleTerminalData(id, data)
        })

        terminal.onExit(({ exitCode, signal }) => {
            this.handleTerminalExit(id, exitCode, signal)
        })
    }

    private handleTerminalData(id: string, data: string) {
        // Store in history
        const history = this.terminalHistory.get(id) || []
        history.push(data)
        if (history.length > this.maxHistorySize) {
            history.splice(0, history.length - this.maxHistorySize)
        }
        this.terminalHistory.set(id, history)

        // Send to renderer
        this.send('terminal:data', {
            id,
            data,
            type: 'output'
        })

        // Process shell integration sequences
        this.shellIntegration.processData(id, data)
    }

    private handleTerminalExit(id: string, exitCode: number, signal?: number) {
        const terminal = this.terminals.get(id)
        if (!terminal) return

        // Clear any existing cleanup timer for this terminal
        const existingTimer = this.cleanupTimers.get(id)
        if (existingTimer) {
            clearTimeout(existingTimer)
            this.cleanupTimers.delete(id)
        }

        terminal.status = 'stopped'
        terminal.lastExitCode = exitCode

        // Detach shell integration immediately so closed PTYs do not leak
        this.shellIntegration.detachFromTerminal(id)
        this.sessionManager.stopSession(id)

        this.send('terminal:exit', {
            id,
            exitCode,
            signal,
            title: terminal.title
        })

        // Track cleanup timer and check terminal existence before deletion
        const cleanupTimer = setTimeout(() => {
            const currentTerminal = this.terminals.get(id)
            if (currentTerminal?.status === 'stopped') {
                this.terminals.delete(id)
                this.terminalHistory.delete(id)
            }
            this.cleanupTimers.delete(id)
        }, 30000)

        this.cleanupTimers.set(id, cleanupTimer)
    }

    async executeTask(options: {
        id: string
        command: string
        cwd?: string
        shell?: string
        env?: { [key: string]: string }
        languageId?: string
        taskType?: 'build' | 'test' | 'run' | 'debug'
    }): Promise<{ success: boolean; executionId?: string; error?: string }> {
        const task = {
            id: options.id,
            label: options.command,
            type: 'shell' as const,
            command: options.command,
            cwd: options.cwd,
            env: options.env,
            group: options.taskType
        }

        return this.taskRunner.executeTask({
            id: options.id,
            task,
            terminalService: this,
            getMainWindow: this.getMainWindow
        })
    }

    async startDebugSession(options: {
        sessionId: string
        languageId: string
        program: string
        args?: string[]
        cwd?: string
        stopOnEntry?: boolean
    }): Promise<{ success: boolean; port?: number; error?: string }> {
        return this.languageGateway.startDebugSession(options)
    }

    async loadLanguageServer(options: {
        sessionId?: string
        languageId: string
        workspacePath: string
        rootUri?: string
    }): Promise<{ success: boolean; sessionId?: string; error?: string }> {
        return this.languageGateway.loadLanguageServer(options)
    }

    // Getters and utility methods
    getTerminal(id: string): KalyntTerminal | undefined {
        return this.terminals.get(id)
    }

    getAllTerminals(): KalyntTerminal[] {
        return Array.from(this.terminals.values())
    }

    getTerminalHistory(id: string): string[] {
        return this.terminalHistory.get(id) || []
    }

    async writeToTerminal(id: string, data: string): Promise<boolean> {
        const terminal = this.terminals.get(id)
        if (!terminal || terminal.status !== 'running') return false

        terminal.write(data)
        return true
    }

    async resizeTerminal(id: string, cols: number, rows: number): Promise<boolean> {
        const terminal = this.terminals.get(id)
        if (!terminal || terminal.status !== 'running') return false

        try {
            terminal.resize(cols, rows)
            this.sessionManager.updateSession(id, { cols, rows })
            return true
        } catch (error) {
            console.error(`[Terminal] Resize error for ${id}:`, error)
            return false
        }
    }

    async killTerminal(id: string, signal?: string): Promise<boolean> {
        const terminal = this.terminals.get(id)
        if (!terminal) return false

        try {
            // The exit handler tells the renderer and cleans up; removing the entry
            // here would swallow that exit event.
            terminal.kill(signal as any)
            return true
        } catch (error) {
            console.error(`[Terminal] Kill error for ${id}:`, error)
            return false
        }
    }

    async sendSignal(id: string, signal: string): Promise<boolean> {
        const terminal = this.terminals.get(id)
        if (!terminal || terminal.status !== 'running') return false

        try {
            if (process.platform !== 'win32') {
                process.kill(terminal.pid, signal as any)
            } else {
                terminal.kill()
            }
            return true
        } catch (error) {
            console.error(`[Terminal] Signal error for ${id}:`, error)
            return false
        }
    }

    async getTerminalInfo(id: string) {
        const terminal = this.terminals.get(id)
        if (!terminal) return null

        return {
            id: terminal.id,
            pid: terminal.pid,
            title: terminal.title,
            shell: terminal.shell,
            cwd: terminal.cwd,
            status: terminal.status,
            lastExitCode: terminal.lastExitCode,
            processType: terminal.processType,
            metadata: terminal.metadata ? JSON.parse(JSON.stringify(terminal.metadata)) : {},
            cols: (terminal as any)._cols,
            rows: (terminal as any)._rows
        }
    }

    async clearTerminalHistory(id: string): Promise<boolean> {
        if (!this.terminalHistory.has(id)) return false

        this.terminalHistory.set(id, [])
        return true
    }

    async forkTerminal(sourceId: string, newId: string): Promise<boolean> {
        const source = this.terminals.get(sourceId)
        if (!source) return false

        return (await this.spawnTerminal({
            id: newId,
            shell: source.shell,
            cwd: source.cwd,
            env: source.env,
            title: `Fork of ${source.title}`,
            processType: source.processType,
            metadata: { ...source.metadata, forkedFrom: sourceId }
        })).success
    }

    async sendTerminalSequence(id: string, sequence: string): Promise<boolean> {
        const terminal = this.terminals.get(id)
        if (!terminal || terminal.status !== 'running') return false

        switch (sequence) {
            case 'break':
                terminal.write('\x03') // Ctrl+C
                break
            case 'suspend':
                terminal.write('\x1a') // Ctrl+Z
                break
            case 'clear':
                terminal.write('\x1b[H\x1b[2J') // Clear screen
                break
            case 'reset':
                terminal.write('\x1bc') // Reset terminal
                break
            default:
                terminal.write(sequence)
        }

        return true
    }

    async broadcastToTerminals(data: string, filter?: (term: KalyntTerminal) => boolean): Promise<number> {
        let count = 0
        for (const [_id, terminal] of Array.from(this.terminals)) {
            if (terminal.status !== 'running') continue
            if (!filter || filter(terminal)) {
                terminal.write(data)
                count++
            }
        }
        return count
    }

    // Advanced terminal operations
    async saveTerminalState(id: string): Promise<{ success: boolean; state?: any; error?: string }> {
        const terminal = this.terminals.get(id)
        if (!terminal) {
            return { success: false, error: 'Terminal not found' }
        }

        const state = {
            id: terminal.id,
            pid: terminal.pid,
            title: terminal.title,
            shell: terminal.shell,
            cwd: terminal.cwd,
            env: terminal.env,
            status: terminal.status,
            processType: terminal.processType,
            metadata: terminal.metadata,
            history: this.terminalHistory.get(id),
            timestamp: Date.now()
        }

        if (isValidSessionId(state.id)) {
            if (!this.sessionManager.getSession(state.id)) {
                this.sessionManager.createSession({
                    id: state.id,
                    title: state.title,
                    shell: state.shell,
                    cwd: state.cwd,
                    env: state.env,
                    processType: state.processType,
                    metadata: state.metadata
                })
            } else {
                this.sessionManager.updateSession(state.id, {
                    title: state.title,
                    shell: state.shell,
                    cwd: state.cwd,
                    status: state.status === 'running' ? 'running' : 'stopped',
                    metadata: state.metadata
                })
            }
            this.sessionManager.saveSession(state.id)
        }

        return { success: true, state }
    }

    async restoreTerminalState(state: any): Promise<{ success: boolean; id?: string; error?: string }> {
        try {
            const restoredId = state?.id || `restored-${Date.now()}`
            const result = await this.spawnTerminal({
                id: restoredId,
                shell: state?.shell,
                cwd: state?.cwd,
                env: state?.env,
                title: state?.title,
                processType: state?.processType,
                metadata: state?.metadata
            })

            if (!result.success) {
                return { success: false, error: result.error }
            }

            if (Array.isArray(state?.history)) {
                this.terminalHistory.set(restoredId, state.history)
                this.send('terminal:history', {
                    id: restoredId,
                    history: state.history
                })
            }

            return { success: true, id: restoredId }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    }

    public getDefaultShell(): string {
        return getDefaultShell()
    }

    // Cleanup all terminals and owned subsystems
    async dispose(): Promise<void> {
        for (const timer of this.cleanupTimers.values()) {
            clearTimeout(timer)
        }
        this.cleanupTimers.clear()

        for (const [id, terminal] of Array.from(this.terminals)) {
            try {
                terminal.kill()
            } catch (error) {
                console.error(`[Terminal] Error killing terminal ${id}:`, error)
            }
        }

        this.terminals.clear()
        this.terminalHistory.clear()
        this.shellIntegration.dispose()
        this.sessionManager.dispose()
        this.taskRunner.dispose()
        await this.languageGateway.dispose()

        this.removeAllListeners()
    }
}

// Export factory function for easy initialization
export function createTerminalService(
    getMainWindow: () => BrowserWindow | null,
    getWorkspacePath: () => string | null
): TerminalService {
    return new TerminalService(getMainWindow, getWorkspacePath)
}

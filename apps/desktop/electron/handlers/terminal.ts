/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ipcMain as globalIpcMain } from 'electron'
import type { BrowserWindow as BrowserWindowType } from 'electron'
import treeKill from 'tree-kill'
import { TerminalService, type KalyntTerminal } from '../terminal/terminalService'
import { sendToWindow } from '../utils/window'

let terminalService: TerminalService | null = null
let eventsWired = false

function buildBroadcastFilter(filter?: string): ((term: KalyntTerminal) => boolean) | undefined {
    const trimmed = typeof filter === 'string' ? filter.trim() : ''
    if (!trimmed || trimmed.toLowerCase() === 'all') return undefined

    const lower = trimmed.toLowerCase()
    if (lower === 'shell' || lower === 'task' || lower === 'debug') {
        return (term) => term.processType === lower
    }

    return (term) =>
        term.id === trimmed ||
        term.title.toLowerCase().includes(lower) ||
        term.shell.toLowerCase().includes(lower) ||
        term.cwd.toLowerCase().includes(lower)
}

export function registerTerminalHandlers(
    ipcMainArg: Electron.IpcMain,
    getMainWindow: () => BrowserWindowType | null,
    getCurrentWorkspacePath: () => string | null
) {
    const ipc = ipcMainArg || globalIpcMain

    if (!terminalService) {
        terminalService = new TerminalService(getMainWindow, getCurrentWorkspacePath)
    }

    // ==========================================
    // Terminal APIs
    // ==========================================
    ipc.handle('terminal:spawn', async (_event, options) => {
        return terminalService!.spawnTerminal(options)
    })

    ipc.handle('terminal:write', async (_event, options) => {
        const success = await terminalService!.writeToTerminal(options.id, options.data)
        return success ? { success: true } : { success: false, error: `Terminal ${options.id} not found or not running` }
    })

    // Alias for writeOutput - same as write for compatibility
    ipc.handle('terminal:writeOutput', async (_event, options) => {
        const success = await terminalService!.writeToTerminal(options.id, options.data)
        return success ? { success: true } : { success: false, error: `Terminal ${options.id} not found or not running` }
    })

    ipc.handle('terminal:resize', async (_event, options) => {
        const success = await terminalService!.resizeTerminal(options.id, options.cols, options.rows)
        return success ? { success: true } : { success: false, error: `Failed to resize terminal ${options.id}` }
    })

    ipc.handle('terminal:kill', async (_event, idOrOptions) => {
        const id = typeof idOrOptions === 'object' && idOrOptions !== null ? idOrOptions.id : idOrOptions
        const signal = typeof idOrOptions === 'object' && idOrOptions !== null ? idOrOptions.signal : undefined
        const success = await terminalService!.killTerminal(id, signal)
        return success ? { success: true } : { success: false, error: `Terminal ${id} not found` }
    })

    ipc.handle('terminal:sendSignal', async (_event, options) => {
        const success = await terminalService!.sendSignal(options.id, options.signal)
        return success ? { success: true } : { success: false, error: `Failed to send signal to terminal ${options.id}` }
    })

    ipc.handle('terminal:getInfo', async (_event, id) => {
        const info = await terminalService!.getTerminalInfo(id)
        return info ? { success: true, info } : { success: false, error: `Terminal ${id} not found` }
    })

    ipc.handle('terminal:getAll', async () => {
        const terminals = terminalService!.getAllTerminals()
        const serialized = (await Promise.all(terminals.map(t => terminalService!.getTerminalInfo(t.id)))).filter(Boolean)
        return { success: true, terminals: serialized }
    })

    ipc.handle('terminal:fork', async (_event, options) => {
        const success = await terminalService!.forkTerminal(options.sourceId, options.newId)
        return success ? { success: true } : { success: false, error: `Failed to fork terminal ${options.sourceId}` }
    })

    ipc.handle('terminal:sendSequence', async (_event, options) => {
        const success = await terminalService!.sendTerminalSequence(options.id, options.sequence)
        return success ? { success: true } : { success: false, error: `Terminal ${options.id} not found or not running` }
    })

    ipc.handle('terminal:clearHistory', async (_event, id) => {
        const success = await terminalService!.clearTerminalHistory(id)
        return success ? { success: true } : { success: false, error: `Terminal ${id} history not found` }
    })

    ipc.handle('terminal:saveState', async (_event, id) => {
        return terminalService!.saveTerminalState(id)
    })

    ipc.handle('terminal:restoreState', async (_event, state) => {
        return terminalService!.restoreTerminalState(state)
    })

    ipc.handle('terminal:broadcast', async (_event, options) => {
        try {
            const filterFn = buildBroadcastFilter(options?.filter)
            const count = await terminalService!.broadcastToTerminals(options?.data ?? '', filterFn)
            return { success: true, count }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    ipc.handle('terminal:getCommandHistory', async (_event, terminalId) => {
        const history = terminalService!.shellIntegration.getCommandHistory(terminalId)
        return { success: true, history }
    })

    ipc.handle('terminal:getCurrentCommand', async (_event, terminalId) => {
        const command = terminalService!.shellIntegration.getCurrentCommand(terminalId)
        return { success: true, command }
    })

    ipc.handle('terminal:getDefaultShell', async () => {
        return { success: true, shell: terminalService!.getDefaultShell() }
    })

    // ==========================================
    // Language Runtime APIs
    // ==========================================
    ipc.handle('runtime:startLSP', async (_event, options) => {
        try {
            return await terminalService!.languageGateway.loadLanguageServer(options)
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    ipc.handle('runtime:stopLSP', async (_event, sessionId) => {
        const success = await terminalService!.languageGateway.stopLanguageServer(sessionId)
        return success ? { success: true } : { success: false, error: `Language server ${sessionId} not found` }
    })

    ipc.handle('runtime:sendLSPRequest', async (_event, options) => {
        try {
            const result = await terminalService!.languageGateway.sendLSPRequest(
                options.sessionId,
                options.method,
                options.params
            )
            return { success: true, result }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    ipc.handle('runtime:getLanguageServers', async () => {
        const servers = await terminalService!.languageGateway.getLanguageServers()
        return { success: true, servers }
    })

    ipc.handle('runtime:startDebug', async (_event, options) => {
        try {
            const merged = options?.options && typeof options.options === 'object'
                ? { ...options.options, ...options }
                : options
            return await terminalService!.languageGateway.startDebugSession(merged)
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    ipc.handle('runtime:stopDebug', async (_event, sessionId) => {
        const success = await terminalService!.languageGateway.stopDebugSession(sessionId)
        return success ? { success: true } : { success: false, error: `Debug session ${sessionId} not found` }
    })

    ipc.handle('runtime:sendDebugRequest', async (_event, options) => {
        try {
            const result = await terminalService!.languageGateway.sendDebugRequest(
                options.sessionId,
                options.method,
                options.params
            )
            return { success: true, result }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    ipc.handle('runtime:getDebugSessions', async () => {
        const sessions = await terminalService!.languageGateway.getDebugSessions()
        return { success: true, sessions }
    })

    // ==========================================
    // Task Runner APIs
    // ==========================================
    ipc.handle('tasks:detectTasks', async (_event, workspacePath) => {
        try {
            const tasks = await terminalService!.taskRunner.detectTasks(workspacePath)
            return { success: true, tasks }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    ipc.handle('tasks:executeTask', async (_event, options) => {
        try {
            return await terminalService!.taskRunner.executeTask({
                id: options?.taskId || options?.id || options?.task?.id || `task_${Date.now()}`,
                task: options?.task,
                terminalService: terminalService!,
                getMainWindow
            })
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    ipc.handle('tasks:killTask', async (_event, executionId) => {
        const success = await terminalService!.taskRunner.killTaskExecution(executionId)
        return success ? { success: true } : { success: false, error: `Task execution ${executionId} not found` }
    })

    ipc.handle('tasks:getExecutions', async () => {
        const executions = await terminalService!.taskRunner.getTaskExecutions()
        const serialized = executions.map(ex => {
            const { process: _process, ...rest } = ex
            return JSON.parse(JSON.stringify(rest))
        })
        return { success: true, executions: serialized }
    })

    ipc.handle('tasks:getExecution', async (_event, executionId) => {
        const execution = await terminalService!.taskRunner.getTaskExecution(executionId)
        if (!execution) return { success: false, error: `Task execution ${executionId} not found` }
        const { process: _process, ...rest } = execution
        return { success: true, execution: JSON.parse(JSON.stringify(rest)) }
    })

    // ==========================================
    // Session Management APIs
    // ==========================================
    ipc.handle('sessions:createSession', async (_event, options) => {
        try {
            const session = terminalService!.sessionManager.createSession(options)
            return { success: true, session }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    ipc.handle('sessions:getSession', async (_event, sessionId) => {
        const session = terminalService!.sessionManager.getSession(sessionId)
        return session ? { success: true, session } : { success: false, error: `Session ${sessionId} not found` }
    })

    ipc.handle('sessions:updateSession', async (_event, options) => {
        const success = terminalService!.sessionManager.updateSession(options.sessionId, options.updates)
        return success ? { success: true } : { success: false, error: `Session ${options.sessionId} not found` }
    })

    ipc.handle('sessions:deleteSession', async (_event, sessionId) => {
        const success = terminalService!.sessionManager.deleteSession(sessionId)
        return success ? { success: true } : { success: false, error: `Session ${sessionId} not found` }
    })

    ipc.handle('sessions:getAllSessions', async () => {
        const sessions = terminalService!.sessionManager.getAllSessions()
        return { success: true, sessions }
    })

    ipc.handle('sessions:getActiveSessions', async () => {
        const sessions = terminalService!.sessionManager.getActiveSessions()
        return { success: true, sessions }
    })

    ipc.handle('sessions:saveSession', async (_event, sessionId) => {
        const success = terminalService!.sessionManager.saveSession(sessionId)
        return success ? { success: true } : { success: false, error: `Failed to save session ${sessionId}` }
    })

    ipc.handle('sessions:loadSession', async (_event, sessionId) => {
        const session = terminalService!.sessionManager.loadSession(sessionId)
        return session ? { success: true, session } : { success: false, error: `Session ${sessionId} not found` }
    })

    ipc.handle('sessions:exportSession', async (_event, options) => {
        const success = terminalService!.sessionManager.exportSession(
            options.sessionId,
            options.exportPath,
            getCurrentWorkspacePath()
        )
        return success
            ? { success: true }
            : { success: false, error: 'Failed to export session (invalid session or disallowed export path)' }
    })

    ipc.handle('sessions:importSession', async (_event, importPath) => {
        const sessionId = terminalService!.sessionManager.importSession(
            importPath,
            getCurrentWorkspacePath()
        )
        return sessionId
            ? { success: true, sessionId }
            : { success: false, error: 'Failed to import session (invalid file or disallowed import path)' }
    })

    ipc.handle('sessions:getStats', async () => {
        const stats = terminalService!.sessionManager.getSessionStats()
        return { success: true, stats }
    })

    ipc.handle('sessions:clearOldSessions', async (_event, maxAgeHours) => {
        const count = terminalService!.sessionManager.clearOldSessions(maxAgeHours)
        return { success: true, count }
    })

    // ==========================================
    // Event Forwarding
    // ==========================================
    if (!eventsWired) {
        eventsWired = true
        setupEventForwarding(terminalService, getMainWindow)
    }
}

function setupEventForwarding(service: TerminalService, getMainWindow: () => BrowserWindowType | null) {
    const send = (channel: string, data: unknown) => {
        sendToWindow(getMainWindow(), channel, data)
    }

    // Shell Integration Events
    service.shellIntegration.on('command_recorded', (command) => {
        send('terminal:commandFinished', { terminalId: command.terminalId, command })
    })
    service.shellIntegration.on('decorations_available', (data) => {
        send('terminal:decorationsAvailable', data)
    })

    // Language Gateway Events
    service.languageGateway.on('language_server_started', (data) => {
        send('runtime:languageServerStarted', data)
    })
    service.languageGateway.on('language_server_stopped', (data) => {
        send('runtime:languageServerStopped', data)
    })
    service.languageGateway.on('language_server_error', (data) => {
        send('runtime:languageServerError', data)
    })
    service.languageGateway.on('debug_session_started', (data) => {
        send('runtime:debugSessionStarted', data)
    })
    service.languageGateway.on('debug_session_stopped', (data) => {
        send('runtime:debugSessionStopped', data)
    })
    service.languageGateway.on('debug_session_error', (data) => {
        send('runtime:debugSessionError', data)
    })
    service.languageGateway.on('debug_event', (data) => {
        send('runtime:debugEvent', data)
    })

    // Task Runner Events
    service.taskRunner.on('task_output', (data) => {
        send('tasks:output', data)
    })
    service.taskRunner.on('task_completed', (data) => {
        send('tasks:completed', {
            executionId: data.executionId,
            exitCode: data.exitCode,
            status: data.status,
            duration: data.duration
        })
    })
    service.taskRunner.on('task_error', (data) => {
        send('tasks:error', data)
    })
    service.taskRunner.on('task_cancelled', (data) => {
        send('tasks:cancelled', data)
    })

    // Session Manager Events
    service.sessionManager.on('session_created', (session) => {
        send('sessions:created', { session })
    })
    service.sessionManager.on('session_updated', (data) => {
        send('sessions:updated', data)
    })
    service.sessionManager.on('session_deleted', (sessionId) => {
        send('sessions:deleted', { sessionId })
    })

    // Group Events
    service.sessionManager.on('group_created', (group) => {
        send('sessions:groupCreated', { group })
    })
    service.sessionManager.on('group_updated', (data) => {
        send('sessions:groupUpdated', data)
    })
}

/**
 * Kills every terminal and everything started inside it.
 * @returns Number of terminals killed
 */
export async function killAllTerminals(): Promise<number> {
    if (!terminalService) return 0
    const terminals = terminalService.getAllTerminals().filter(t => t.status !== 'stopped')
    await Promise.all(terminals.map(terminal => new Promise<void>(resolve => {
        const pid = terminal.pid
        treeKill(pid, 'SIGKILL', () => {
            terminalService?.killTerminal(terminal.id).catch(() => undefined).finally(resolve)
        })
    })))
    return terminals.length
}

/**
 * Fully disposes the terminal service and all owned subsystems
 * (PTYs, shell integration temp files, session manager, LSP/DAP gateways, task runner).
 */
export async function disposeTerminalService(): Promise<void> {
    if (!terminalService) return
    const service = terminalService
    terminalService = null
    eventsWired = false
    await service.dispose()
}

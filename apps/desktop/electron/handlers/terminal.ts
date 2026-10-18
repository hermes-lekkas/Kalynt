/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ipcMain } from 'electron'
import type { BrowserWindow as BrowserWindowType } from 'electron'
import treeKill from 'tree-kill'
import { TerminalService } from '../terminal/terminalService'

let terminalService: TerminalService | null = null

export function registerTerminalHandlers(
    _ipcMain: Electron.IpcMain, // We use the global ipcMain in the implementation below or pass it (it's passed but we can close over it)
    getMainWindow: () => BrowserWindowType | null,
    getCurrentWorkspacePath: () => string | null
) {
    // Initialize Terminal Service
    if (!terminalService) {
        terminalService = new TerminalService(getMainWindow, getCurrentWorkspacePath)
    }

    // ==========================================
    // Terminal APIs
    // ==========================================
    ipcMain.handle('terminal:spawn', async (_event, options) => {
        return terminalService!.spawnTerminal(options)
    })

    ipcMain.handle('terminal:write', async (_event, options) => {
        return terminalService!.writeToTerminal(options.id, options.data)
    })

    // Alias for writeOutput - same as write for compatibility
    ipcMain.handle('terminal:writeOutput', async (_event, options) => {
        return terminalService!.writeToTerminal(options.id, options.data)
    })

    ipcMain.handle('terminal:resize', async (_event, options) => {
        return terminalService!.resizeTerminal(options.id, options.cols, options.rows)
    })

    ipcMain.handle('terminal:kill', async (_event, id) => {
        // Handle object form {id, signal} or string id
        if (typeof id === 'object') {
            return terminalService!.killTerminal(id.id, id.signal)
        }
        return terminalService!.killTerminal(id)
    })

    ipcMain.handle('terminal:sendSignal', async (_event, options) => {
        return terminalService!.sendSignal(options.id, options.signal)
    })

    ipcMain.handle('terminal:getInfo', async (_event, id) => {
        const info = await terminalService!.getTerminalInfo(id)
        return { success: !!info, info }
    })

    ipcMain.handle('terminal:getAll', async () => {
        const terminals = terminalService!.getAllTerminals()
        // Map to serializable format
        const serialized = await Promise.all(terminals.map(t => terminalService!.getTerminalInfo(t.id)))
        return { success: true, terminals: serialized }
    })

    ipcMain.handle('terminal:fork', async (_event, options) => {
        const success = await terminalService!.forkTerminal(options.sourceId, options.newId)
        return { success }
    })

    ipcMain.handle('terminal:sendSequence', async (_event, options) => {
        const success = await terminalService!.sendTerminalSequence(options.id, options.sequence)
        return { success }
    })

    ipcMain.handle('terminal:clearHistory', async (_event, id) => {
        const success = await terminalService!.clearTerminalHistory(id)
        return { success }
    })

    ipcMain.handle('terminal:saveState', async (_event, id) => {
        return terminalService!.saveTerminalState(id)
    })

    ipcMain.handle('terminal:restoreState', async (_event, state) => {
        return terminalService!.restoreTerminalState(state)
    })

    ipcMain.handle('terminal:broadcast', async (_event, options) => {
        const count = await terminalService!.broadcastToTerminals(options.data)
        return { success: true, count }
    })

    ipcMain.handle('terminal:getCommandHistory', async (_event, terminalId) => {
        const history = terminalService!.shellIntegration.getCommandHistory(terminalId)
        return { success: true, history }
    })

    ipcMain.handle('terminal:getCurrentCommand', async (_event, terminalId) => {
        const command = terminalService!.shellIntegration.getCurrentCommand(terminalId)
        return { success: true, command }
    })

    ipcMain.handle('terminal:getDefaultShell', async () => {
        return { success: true, shell: (terminalService as any).getDefaultShell() }
    })

    // ==========================================
    // Language Runtime APIs
    // ==========================================
    ipcMain.handle('runtime:startLSP', async (_event, options) => {
        return terminalService!.languageGateway.loadLanguageServer(options)
    })

    ipcMain.handle('runtime:stopLSP', async (_event, sessionId) => {
        return terminalService!.languageGateway.stopLanguageServer(sessionId)
    })

    ipcMain.handle('runtime:sendLSPRequest', async (_event, options) => {
        return terminalService!.languageGateway.sendLSPRequest(options.sessionId, options.method, options.params)
    })

    ipcMain.handle('runtime:getLanguageServers', async () => {
        const servers = await terminalService!.languageGateway.getLanguageServers()
        return { success: true, servers }
    })

    ipcMain.handle('runtime:startDebug', async (_event, options) => {
        return terminalService!.languageGateway.startDebugSession(options)
    })

    ipcMain.handle('runtime:stopDebug', async (_event, sessionId) => {
        return terminalService!.languageGateway.stopDebugSession(sessionId)
    })

    ipcMain.handle('runtime:sendDebugRequest', async (_event, options) => {
        return terminalService!.languageGateway.sendDebugRequest(options.sessionId, options.method, options.params)
    })

    ipcMain.handle('runtime:getDebugSessions', async () => {
        const sessions = await terminalService!.languageGateway.getDebugSessions()
        return { success: true, sessions }
    })

    // ==========================================
    // Task Runner APIs
    // ==========================================
    ipcMain.handle('tasks:detectTasks', async (_event, workspacePath) => {
        const tasks = await terminalService!.taskRunner.detectTasks(workspacePath)
        return { success: true, tasks }
    })

    ipcMain.handle('tasks:executeTask', async (_event, options) => {
        return terminalService!.taskRunner.executeTask({
            ...options,
            terminalService: terminalService,
            getMainWindow: getMainWindow
        })
    })

    ipcMain.handle('tasks:killTask', async (_event, executionId) => {
        const success = await terminalService!.taskRunner.killTaskExecution(executionId)
        return { success }
    })

    ipcMain.handle('tasks:getExecutions', async () => {
        const executions = await terminalService!.taskRunner.getTaskExecutions()
        const serialized = executions.map(ex => {
            const { process: _process, ...rest } = ex
            return JSON.parse(JSON.stringify(rest))
        })
        return { success: true, executions: serialized }
    })

    ipcMain.handle('tasks:getExecution', async (_event, executionId) => {
        const execution = await terminalService!.taskRunner.getTaskExecution(executionId)
        if (!execution) return { success: false }
        const { process: _process, ...rest } = execution
        return { success: true, execution: JSON.parse(JSON.stringify(rest)) }
    })

    // ==========================================
    // Session Management APIs
    // ==========================================
    ipcMain.handle('sessions:createSession', async (_event, options) => {
        const session = terminalService!.sessionManager.createSession(options)
        return { success: true, session }
    })

    ipcMain.handle('sessions:getSession', async (_event, sessionId) => {
        const session = terminalService!.sessionManager.getSession(sessionId)
        return { success: !!session, session }
    })

    ipcMain.handle('sessions:updateSession', async (_event, options) => {
        const success = terminalService!.sessionManager.updateSession(options.sessionId, options.updates)
        return { success }
    })

    ipcMain.handle('sessions:deleteSession', async (_event, sessionId) => {
        const success = terminalService!.sessionManager.deleteSession(sessionId)
        return { success }
    })

    ipcMain.handle('sessions:getAllSessions', async () => {
        const sessions = terminalService!.sessionManager.getAllSessions()
        return { success: true, sessions }
    })

    ipcMain.handle('sessions:getActiveSessions', async () => {
        const sessions = terminalService!.sessionManager.getActiveSessions()
        return { success: true, sessions }
    })

    ipcMain.handle('sessions:saveSession', async (_event, sessionId) => {
        const success = terminalService!.sessionManager.saveSession(sessionId)
        return { success }
    })

    ipcMain.handle('sessions:loadSession', async (_event, sessionId) => {
        const session = terminalService!.sessionManager.loadSession(sessionId)
        return { success: !!session, session }
    })

    ipcMain.handle('sessions:exportSession', async (_event, options) => {
        const success = terminalService!.sessionManager.exportSession(options.sessionId, options.exportPath)
        return { success }
    })

    ipcMain.handle('sessions:importSession', async (_event, importPath) => {
        const sessionId = terminalService!.sessionManager.importSession(importPath)
        return { success: !!sessionId, sessionId }
    })

    ipcMain.handle('sessions:getStats', async () => {
        const stats = terminalService!.sessionManager.getSessionStats()
        return { success: true, stats }
    })

    ipcMain.handle('sessions:clearOldSessions', async (_event, maxAgeHours) => {
        const count = terminalService!.sessionManager.clearOldSessions(maxAgeHours)
        return { success: true, count }
    })

    // ==========================================
    // Event Forwarding
    // ==========================================
    setupEventForwarding(terminalService, getMainWindow)
}

function setupEventForwarding(service: TerminalService, getMainWindow: () => BrowserWindowType | null) {
    const send = (channel: string, data: any) => {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
            win.webContents.send(channel, data)
        }
    }

    // Shell Integration Events
    service.shellIntegration.on('command_recorded', (command) => {
        send('terminal:commandFinished', command)
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
    service.languageGateway.on('debug_session_started', (data) => {
        send('runtime:debugSessionStarted', data)
    })
    service.languageGateway.on('debug_session_stopped', (data) => {
        send('runtime:debugSessionStopped', data)
    })
    service.languageGateway.on('debug_session_error', (data) => {
        send('runtime:debugSessionError', data)
    })

    // Task Runner Events
    service.taskRunner.on('task_output', (data) => {
        send('tasks:output', data)
    })
    service.taskRunner.on('task_completed', (data) => {
        send('tasks:completed', data)
    })
    service.taskRunner.on('task_error', (data) => {
        send('tasks:error', data)
    })
    service.taskRunner.on('task_cancelled', (data) => {
        send('tasks:cancelled', data)
    })

    // Session Manager Events
    service.sessionManager.on('session_created', (session) => {
        send('sessions:created', session)
    })
    service.sessionManager.on('session_updated', (data) => {
        send('sessions:updated', data)
    })
    service.sessionManager.on('session_deleted', (sessionId) => {
        send('sessions:deleted', { sessionId })
    })

    // Group Events
    service.sessionManager.on('group_created', (group) => {
        send('sessions:groupCreated', group)
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

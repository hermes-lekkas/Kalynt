/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * IPC for debugging. Sessions, adapters and the protocol live in ./debug/.
 */
import { ipcMain, BrowserWindow } from 'electron'
import path from 'node:path'
import type { Breakpoint, DebugConfiguration } from '../../src/types/debug'
import { DebugSessionManager, type InitialBreakpoints } from './debug/sessions'
import { getAllConfigurations } from './debug/configurations'
import { validatePath } from '../utils/pathValidator'

let manager: DebugSessionManager | null = null

/** Ends every debug session and the programs they started. */
export async function stopAllDebugSessions(): Promise<number> {
    return manager ? manager.stopAllSessions() : 0
}

type Handler = (...args: any[]) => Promise<Record<string, unknown>> | Record<string, unknown>

export function setupDebugHandlers(
    ipc: typeof ipcMain,
    getMainWindow: () => BrowserWindow | null,
    getWorkspacePath: () => string | null
) {
    const sessions = (manager = new DebugSessionManager(getMainWindow))

    const resolveWorkspace = (requested?: string): string => {
        const current = getWorkspacePath()
        if (!current) throw new Error('No workspace open')
        return requested ? validatePath(current, requested) : path.resolve(current)
    }

    const handle = (channel: string, fn: Handler) => {
        ipc.handle(channel, async (_event, ...args) => {
            try {
                return { success: true, ...(await fn(...args)) }
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) }
            }
        })
    }

    handle('debug:getConfigurations', (workspacePath?: string) => ({ configurations: getAllConfigurations(resolveWorkspace(workspacePath)) }))

    handle('debug:start', async (configuration: DebugConfiguration, workspacePath?: string, activeFile?: string, breakpoints?: InitialBreakpoints[]) => {
        const safeWorkspace = resolveWorkspace(workspacePath)
        const safeActiveFile = activeFile ? validatePath(safeWorkspace, activeFile) : undefined
        const safeBreakpoints = Array.isArray(breakpoints)
            ? breakpoints.map(bp => ({ ...bp, file: validatePath(safeWorkspace, bp.file) }))
            : []
        return {
            sessionId: await sessions.startSession(configuration, safeWorkspace, safeActiveFile, safeBreakpoints)
        }
    })

    handle('debug:stop', async (sessionId: string) => {
        await sessions.stopSession(sessionId)
        return {}
    })

    handle('debug:setBreakpoints', async (sessionId: string, file: string, breakpoints: Breakpoint[]) => {
        const safeFile = validatePath(resolveWorkspace(), file)
        await sessions.setBreakpoints(sessionId, safeFile, breakpoints)
        return {}
    })

    const controls = { 'debug:continue': 'continue', 'debug:stepOver': 'next', 'debug:stepInto': 'stepIn', 'debug:stepOut': 'stepOut', 'debug:pause': 'pause' } as const
    for (const [channel, action] of Object.entries(controls)) {
        handle(channel, async (sessionId: string, threadId?: number) => {
            await sessions.control(sessionId, action, threadId)
            return {}
        })
    }

    handle('debug:getCallStack', async (sessionId: string, threadId?: number) => ({ callStack: await sessions.getCallStack(sessionId, threadId) }))
    handle('debug:getVariables', async (sessionId: string, ref: number) => ({ variables: await sessions.getVariables(sessionId, ref) }))
    handle('debug:evaluate', async (sessionId: string, expression: string, frameId?: number) => ({ result: await sessions.evaluate(sessionId, expression, frameId) }))

    handle('debug:addWatch', (sessionId: string, expression: string) => ({ watch: sessions.addWatch(sessionId, expression) }))
    handle('debug:removeWatch', (sessionId: string, watchId: string) => {
        if (!sessions.removeWatch(sessionId, watchId)) throw new Error('Watch not found')
        return {}
    })
    handle('debug:getWatches', (sessionId: string) => ({ watches: sessions.getWatches(sessionId) }))
    handle('debug:updateWatches', async (sessionId: string, frameId?: number) => ({ watches: await sessions.updateWatches(sessionId, frameId) }))
    handle('debug:clearWatches', (sessionId: string) => {
        sessions.clearWatches(sessionId)
        return {}
    })
}

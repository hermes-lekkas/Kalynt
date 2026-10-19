/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Main-process services for the AI agent: shell commands, file discovery,
 * web access and conversation storage.
 */
import type { IpcMain } from 'electron'
import { registerAgentExecHandlers } from './exec'
import { registerAgentFileHandlers } from './files'
import { registerAgentWebHandlers } from './web'
import { registerAgentSessionHandlers } from './sessions'

export { stopAllAgentProcesses } from './exec'

export function registerAgentHandlers(ipcMain: IpcMain, getWorkspace: () => string | null): void {
    registerAgentExecHandlers(ipcMain, getWorkspace)
    registerAgentFileHandlers(ipcMain, getWorkspace)
    registerAgentWebHandlers(ipcMain)
    registerAgentSessionHandlers(ipcMain)
}

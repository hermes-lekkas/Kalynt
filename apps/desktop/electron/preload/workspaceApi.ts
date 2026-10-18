/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Terminals, language runtimes, files, code execution, packages and git.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { subscribe } from './subscribe'
import type { TerminalAPI, RuntimeAPI, TasksAPI, SessionsAPI } from './types'

export const workspaceApi = {

    // ==========================================
    // Enhanced Terminal API
    // ==========================================
    terminal: {
        spawn: (options: any) => ipcRenderer.invoke('terminal:spawn', options),
        write: (options: { id: string; data: string }) => ipcRenderer.invoke('terminal:write', options),
        writeOutput: (options: { id: string; data: string }) => ipcRenderer.invoke('terminal:writeOutput', options),
        resize: (options: { id: string; cols: number; rows: number }) => ipcRenderer.invoke('terminal:resize', options),
        kill: (id: string, signal?: string) => ipcRenderer.invoke('terminal:kill', { id, signal }),
        sendSignal: (id: string, signal: string) => ipcRenderer.invoke('terminal:sendSignal', { id, signal }),
        getInfo: (id: string) => ipcRenderer.invoke('terminal:getInfo', id),
        getAll: () => ipcRenderer.invoke('terminal:getAll'),
        fork: (sourceId: string, newId: string) => ipcRenderer.invoke('terminal:fork', { sourceId, newId }),
        sendSequence: (id: string, sequence: string) => ipcRenderer.invoke('terminal:sendSequence', { id, sequence }),
        clearHistory: (id: string) => ipcRenderer.invoke('terminal:clearHistory', id),
        saveState: (id: string) => ipcRenderer.invoke('terminal:saveState', id),
        restoreState: (state: any) => ipcRenderer.invoke('terminal:restoreState', state),
        broadcast: (data: string, filter?: string) => ipcRenderer.invoke('terminal:broadcast', { data, filter }),
        getCommandHistory: (terminalId: string) => ipcRenderer.invoke('terminal:getCommandHistory', terminalId),
        getCurrentCommand: (terminalId: string) => ipcRenderer.invoke('terminal:getCurrentCommand', terminalId),
        getDefaultShell: () => ipcRenderer.invoke('terminal:getDefaultShell'),
        // Events
        onData: (callback: (data: { id: string; data: string; type: string }) => void) => {
            return subscribe('terminal:data', callback)
        },
        onExit: (callback: (data: { id: string; exitCode: number; signal?: number; title: string }) => void) => {
            return subscribe('terminal:exit', callback)
        },
        onSpawned: (callback: (data: { id: string; pid: number; title: string; cwd: string; shell: string }) => void) => {
            return subscribe('terminal:spawned', callback)
        },
        onRestored: (callback: (data: { id: string; pid: number; title: string }) => void) => {
            return subscribe('terminal:restored', callback)
        },
        onCommandFinished: (callback: (data: { terminalId: string; command: any }) => void) => {
            return subscribe('terminal:commandFinished', callback)
        },
        onDecorationsAvailable: (callback: (data: { terminalId: string; commandId: string; decorations: any[] }) => void) => {
            return subscribe('terminal:decorationsAvailable', callback)
        },
        removeListeners: () => {
            ipcRenderer.removeAllListeners('terminal:data')
            ipcRenderer.removeAllListeners('terminal:exit')
            ipcRenderer.removeAllListeners('terminal:spawned')
            ipcRenderer.removeAllListeners('terminal:restored')
            ipcRenderer.removeAllListeners('terminal:commandFinished')
            ipcRenderer.removeAllListeners('terminal:decorationsAvailable')
        }
    } as TerminalAPI,


    // ==========================================
    // Language Runtime API
    // ==========================================
    runtime: {
        startLSP: (sessionId: string, languageId: string, workspacePath: string, options?: any) =>
            ipcRenderer.invoke('runtime:startLSP', { sessionId, languageId, workspacePath, options }),
        stopLSP: (sessionId: string) => ipcRenderer.invoke('runtime:stopLSP', sessionId),
        sendLSPRequest: (sessionId: string, method: string, params: any) =>
            ipcRenderer.invoke('runtime:sendLSPRequest', { sessionId, method, params }),
        getLanguageServers: () => ipcRenderer.invoke('runtime:getLanguageServers'),
        startDebug: (sessionId: string, languageId: string, program: string, options?: any) =>
            ipcRenderer.invoke('runtime:startDebug', { sessionId, languageId, program, options }),
        stopDebug: (sessionId: string) => ipcRenderer.invoke('runtime:stopDebug', sessionId),
        sendDebugRequest: (sessionId: string, method: string, params: any) =>
            ipcRenderer.invoke('runtime:sendDebugRequest', { sessionId, method, params }),
        getDebugSessions: () => ipcRenderer.invoke('runtime:getDebugSessions'),
        // Events
        onLanguageServerStarted: (callback: (data: { sessionId: string; languageId: string; capabilities: any }) => void) => {
            return subscribe('runtime:languageServerStarted', callback)
        },
        onLanguageServerStopped: (callback: (data: { sessionId: string; exitCode: number }) => void) => {
            return subscribe('runtime:languageServerStopped', callback)
        },
        onDebugSessionStarted: (callback: (data: { sessionId: string; languageId: string; port: number; configuration: any }) => void) => {
            return subscribe('runtime:debugSessionStarted', callback)
        },
        onDebugSessionStopped: (callback: (data: { sessionId: string; exitCode: number }) => void) => {
            return subscribe('runtime:debugSessionStopped', callback)
        },
        onDebugSessionError: (callback: (data: { sessionId: string; error: string }) => void) => {
            return subscribe('runtime:debugSessionError', callback)
        },
        removeListeners: () => {
            ipcRenderer.removeAllListeners('runtime:languageServerStarted')
            ipcRenderer.removeAllListeners('runtime:languageServerStopped')
            ipcRenderer.removeAllListeners('runtime:debugSessionStarted')
            ipcRenderer.removeAllListeners('runtime:debugSessionStopped')
            ipcRenderer.removeAllListeners('runtime:debugSessionError')
        }
    } as RuntimeAPI,


    // ==========================================
    // Task Runner API
    // ==========================================
    tasks: {
        detectTasks: (workspacePath: string) => ipcRenderer.invoke('tasks:detectTasks', workspacePath),
        executeTask: (taskId: string, task: any) => ipcRenderer.invoke('tasks:executeTask', { taskId, task }),
        killTask: (executionId: string) => ipcRenderer.invoke('tasks:killTask', executionId),
        getExecutions: () => ipcRenderer.invoke('tasks:getExecutions'),
        getExecution: (executionId: string) => ipcRenderer.invoke('tasks:getExecution', executionId),
        // Events
        onTaskOutput: (callback: (data: { executionId: string; type: 'stdout' | 'stderr'; data: string }) => void) => {
            return subscribe('tasks:output', callback)
        },
        onTaskCompleted: (callback: (data: { executionId: string; exitCode: number; status: string; duration: number }) => void) => {
            return subscribe('tasks:completed', callback)
        },
        onTaskError: (callback: (data: { executionId: string; error: string }) => void) => {
            return subscribe('tasks:error', callback)
        },
        onTaskCancelled: (callback: (data: { executionId: string }) => void) => {
            return subscribe('tasks:cancelled', callback)
        },
        removeListeners: () => {
            ipcRenderer.removeAllListeners('tasks:output')
            ipcRenderer.removeAllListeners('tasks:completed')
            ipcRenderer.removeAllListeners('tasks:error')
            ipcRenderer.removeAllListeners('tasks:cancelled')
        }
    } as TasksAPI,


    // ==========================================
    // Session Management API
    // ==========================================
    sessions: {
        createSession: (options: any) => ipcRenderer.invoke('sessions:createSession', options),
        getSession: (sessionId: string) => ipcRenderer.invoke('sessions:getSession', sessionId),
        updateSession: (sessionId: string, updates: any) => ipcRenderer.invoke('sessions:updateSession', { sessionId, updates }),
        deleteSession: (sessionId: string) => ipcRenderer.invoke('sessions:deleteSession', sessionId),
        getAllSessions: () => ipcRenderer.invoke('sessions:getAllSessions'),
        getActiveSessions: () => ipcRenderer.invoke('sessions:getActiveSessions'),
        saveSession: (sessionId: string) => ipcRenderer.invoke('sessions:saveSession', sessionId),
        loadSession: (sessionId: string) => ipcRenderer.invoke('sessions:loadSession', sessionId),
        exportSession: (sessionId: string, exportPath: string) => ipcRenderer.invoke('sessions:exportSession', { sessionId, exportPath }),
        importSession: (importPath: string) => ipcRenderer.invoke('sessions:importSession', importPath),
        getStats: () => ipcRenderer.invoke('sessions:getStats'),
        clearOldSessions: (maxAgeHours?: number) => ipcRenderer.invoke('sessions:clearOldSessions', maxAgeHours),
        // Events
        onSessionCreated: (callback: (data: { session: any }) => void) => {
            return subscribe('sessions:created', callback)
        },
        onSessionUpdated: (callback: (data: { sessionId: string; updates: any }) => void) => {
            return subscribe('sessions:updated', callback)
        },
        onSessionDeleted: (callback: (data: { sessionId: string }) => void) => {
            return subscribe('sessions:deleted', callback)
        },
        removeListeners: () => {
            ipcRenderer.removeAllListeners('sessions:created')
            ipcRenderer.removeAllListeners('sessions:updated')
            ipcRenderer.removeAllListeners('sessions:deleted')
        }
    } as SessionsAPI,


    // ==========================================
    // File System APIs (Enhanced)
    // ==========================================
    fs: {
        openFolder: () => ipcRenderer.invoke('fs:openFolder'),
        setWorkspace: (workspacePath: string) => ipcRenderer.invoke('fs:setWorkspace', workspacePath),
        readDir: (dirPath: string) => ipcRenderer.invoke('fs:readDir', dirPath),
        stat: (filePath: string) => ipcRenderer.invoke('fs:stat', filePath),
        readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
        readBinaryFile: (filePath: string) => ipcRenderer.invoke('fs:readBinaryFile', filePath),
        writeFile: (options: any) => ipcRenderer.invoke('fs:writeFile', options),
        createFile: (filePath: string) => ipcRenderer.invoke('fs:createFile', filePath),
        createDir: (dirPath: string) => ipcRenderer.invoke('fs:createDir', dirPath),
        delete: (itemPath: string) => ipcRenderer.invoke('fs:delete', itemPath),
        rename: (options: any) => ipcRenderer.invoke('fs:rename', options),
        watchDir: (options: any) => ipcRenderer.invoke('fs:watchDir', options),
        unwatchDir: (id: string) => ipcRenderer.invoke('fs:unwatchDir', id),
        onChange: (callback: (data: any) => void) => {
            const subscription = (_event: IpcRendererEvent, data: any) => callback(data)
            ipcRenderer.on('fs:change', subscription)
            return () => {
                ipcRenderer.removeListener('fs:change', subscription)
            }
        },
        removeListeners: () => {
            ipcRenderer.removeAllListeners('fs:change')
        },
        backupWorkspace: () => ipcRenderer.invoke('fs:backup'),
        search: (options: { searchPath: string; pattern: string; filePattern?: string; maxResults?: number }) => 
            ipcRenderer.invoke('fs:search', options)
    },

    // ==========================================
    // Code Execution APIs (Enhanced)
    // ==========================================
    code: {
        execute: (options: any) => ipcRenderer.invoke('code:execute', options),
        kill: (id: string) => ipcRenderer.invoke('code:kill', id),
        runCommand: (cwd: string, command: string, id?: string) => ipcRenderer.invoke('code:runCommand', cwd, command, id),
        onOutput: (callback: (data: any) => void) => {
            return subscribe('code:output', callback)
        },
        onExit: (callback: (data: any) => void) => {
            return subscribe('code:exit', callback)
        },
        removeListeners: () => {
            ipcRenderer.removeAllListeners('code:output')
            ipcRenderer.removeAllListeners('code:exit')
        },
        clearCache: () => ipcRenderer.invoke('code:clearCache')
    },

    // ==========================================
    // Dependency Management APIs
    // ==========================================
    deps: {
        detect: (workspacePath: string) => ipcRenderer.invoke('deps:detect', workspacePath),
        getForLanguage: (languageId: string) => ipcRenderer.invoke('deps:getForLanguage', languageId),
        install: (packageName: string, options: { workspacePath: string; global?: boolean; dev?: boolean; version?: string }) =>
            ipcRenderer.invoke('deps:install', packageName, options),
        installAll: (workspacePath: string) => ipcRenderer.invoke('deps:installAll', workspacePath),
        uninstall: (packageName: string, workspacePath: string) => ipcRenderer.invoke('deps:uninstall', packageName, workspacePath),
        update: (packageName: string | null, workspacePath: string) => ipcRenderer.invoke('deps:update', packageName, workspacePath),
        list: (workspacePath: string) => ipcRenderer.invoke('deps:list', workspacePath),
        init: (managerName: string, workspacePath: string) => ipcRenderer.invoke('deps:init', managerName, workspacePath),
        getSupportedManagers: () => ipcRenderer.invoke('deps:getSupportedManagers'),
        kill: (operationId: string) => ipcRenderer.invoke('deps:kill', operationId),
        onOutput: (callback: (data: { operationId: string; type: string; data: string }) => void) => {
            return subscribe('deps:output', callback)
        },
        onComplete: (callback: (data: { operationId: string; success: boolean; exitCode?: number; error?: string }) => void) => {
            return subscribe('deps:complete', callback)
        },
        removeListeners: () => {
            ipcRenderer.removeAllListeners('deps:output')
            ipcRenderer.removeAllListeners('deps:complete')
        }
    },

    // ==========================================
    // Git APIs
    // ==========================================
    git: {
        status: (repoPath: string) => ipcRenderer.invoke('git:status', repoPath),
        log: (options: any) => ipcRenderer.invoke('git:log', options),
        diff: (options: any) => ipcRenderer.invoke('git:diff', options),
        add: (options: any) => ipcRenderer.invoke('git:add', options),
        commit: (options: any) => ipcRenderer.invoke('git:commit', options),
        branch: (repoPath: string) => ipcRenderer.invoke('git:branch', repoPath),
        checkout: (options: any) => ipcRenderer.invoke('git:checkout', options),
        reset: (options: any) => ipcRenderer.invoke('git:reset', options),
        push: (repoPath: string) => ipcRenderer.invoke('git:push', repoPath),
        pull: (repoPath: string) => ipcRenderer.invoke('git:pull', repoPath),
        init: (repoPath: string) => ipcRenderer.invoke('git:init', repoPath),
        discard: (options: any) => ipcRenderer.invoke('git:discard', options),
        createBranch: (options: any) => ipcRenderer.invoke('git:createBranch', options),
        fetch: (repoPath: string) => ipcRenderer.invoke('git:fetch', repoPath),
        remote: (repoPath: string) => ipcRenderer.invoke('git:remote', repoPath)
    }
}

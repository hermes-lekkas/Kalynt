/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Shapes of the preload API groups that are typed explicitly.
 */

// Enhanced terminal interface
export interface TerminalAPI {
    spawn: (options: {
        id: string
        shell?: string
        cwd?: string
        cols?: number
        rows?: number
        env?: { [key: string]: string }
        title?: string
        processType?: 'shell' | 'task' | 'debug'
        metadata?: any
    }) => Promise<{ success: boolean; pid?: number; error?: string }>

    write: (options: { id: string; data: string }) => Promise<{ success: boolean; error?: string }>

    writeOutput: (options: { id: string; data: string }) => Promise<{ success: boolean; error?: string }>

    resize: (options: { id: string; cols: number; rows: number }) => Promise<{ success: boolean; error?: string }>

    kill: (id: string, signal?: string) => Promise<{ success: boolean; error?: string }>

    sendSignal: (id: string, signal: string) => Promise<{ success: boolean; error?: string }>

    getInfo: (id: string) => Promise<{ success: boolean; info?: any; error?: string }>

    getAll: () => Promise<{ success: boolean; terminals?: any[]; error?: string }>

    fork: (sourceId: string, newId: string) => Promise<{ success: boolean; error?: string }>

    sendSequence: (id: string, sequence: string) => Promise<{ success: boolean; error?: string }>

    clearHistory: (id: string) => Promise<{ success: boolean; error?: string }>

    saveState: (id: string) => Promise<{ success: boolean; state?: any; error?: string }>

    restoreState: (state: any) => Promise<{ success: boolean; id?: string; error?: string }>

    broadcast: (data: string, filter?: string) => Promise<{ success: boolean; count?: number; error?: string }>

    // Shell integration
    getCommandHistory: (terminalId: string) => Promise<{ success: boolean; history?: any[]; error?: string }>

    getCurrentCommand: (terminalId: string) => Promise<{ success: boolean; command?: any; error?: string }>

    getDefaultShell: () => Promise<{ success: boolean; shell: string; error?: string }>

    // Events
    onData: (callback: (data: { id: string; data: string; type: string }) => void) => () => void

    onExit: (callback: (data: { id: string; exitCode: number; signal?: number; title: string }) => void) => () => void

    onSpawned: (callback: (data: { id: string; pid: number; title: string; cwd: string; shell: string }) => void) => () => void

    onRestored: (callback: (data: { id: string; pid: number; title: string }) => void) => () => void

    onCommandFinished: (callback: (data: { terminalId: string; command: any }) => void) => () => void

    onDecorationsAvailable: (callback: (data: { terminalId: string; commandId: string; decorations: any[] }) => void) => () => void

    removeListeners: () => void
}

// Language runtime interface
export interface RuntimeAPI {
    // Language servers
    startLSP: (sessionId: string, languageId: string, workspacePath: string, options?: any) => Promise<{ success: boolean; error?: string }>

    stopLSP: (sessionId: string) => Promise<{ success: boolean; error?: string }>

    sendLSPRequest: (sessionId: string, method: string, params: any) => Promise<{ success: boolean; result?: any; error?: string }>

    getLanguageServers: () => Promise<{ success: boolean; servers?: any[]; error?: string }>

    // Debug sessions
    startDebug: (sessionId: string, languageId: string, program: string, options?: any) => Promise<{ success: boolean; port?: number; error?: string }>

    stopDebug: (sessionId: string) => Promise<{ success: boolean; error?: string }>

    sendDebugRequest: (sessionId: string, method: string, params: any) => Promise<{ success: boolean; result?: any; error?: string }>

    getDebugSessions: () => Promise<{ success: boolean; sessions?: any[]; error?: string }>

    // Events
    onLanguageServerStarted: (callback: (data: { sessionId: string; languageId: string; capabilities: any }) => void) => () => void

    onLanguageServerStopped: (callback: (data: { sessionId: string; exitCode: number }) => void) => () => void

    onDebugSessionStarted: (callback: (data: { sessionId: string; languageId: string; port: number; configuration: any }) => void) => () => void

    onDebugSessionStopped: (callback: (data: { sessionId: string; exitCode: number }) => void) => () => void

    onDebugSessionError: (callback: (data: { sessionId: string; error: string }) => void) => () => void

    removeListeners: () => void
}

// Task runner interface
export interface TasksAPI {
    detectTasks: (workspacePath: string) => Promise<{ success: boolean; tasks?: any[]; error?: string }>

    executeTask: (taskId: string, task: any) => Promise<{ success: boolean; executionId?: string; error?: string }>

    killTask: (executionId: string) => Promise<{ success: boolean; error?: string }>

    getExecutions: () => Promise<{ success: boolean; executions?: any[]; error?: string }>

    getExecution: (executionId: string) => Promise<{ success: boolean; execution?: any; error?: string }>

    // Events
    onTaskOutput: (callback: (data: { executionId: string; type: 'stdout' | 'stderr'; data: string }) => void) => () => void

    onTaskCompleted: (callback: (data: { executionId: string; exitCode: number; status: string; duration: number }) => void) => () => void

    onTaskError: (callback: (data: { executionId: string; error: string }) => void) => () => void

    onTaskCancelled: (callback: (data: { executionId: string }) => void) => () => void

    removeListeners: () => void
}

// Session management interface
export interface SessionsAPI {
    createSession: (options: any) => Promise<{ success: boolean; session?: any; error?: string }>

    getSession: (sessionId: string) => Promise<{ success: boolean; session?: any; error?: string }>

    updateSession: (sessionId: string, updates: any) => Promise<{ success: boolean; error?: string }>

    deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>

    getAllSessions: () => Promise<{ success: boolean; sessions?: any[]; error?: string }>

    getActiveSessions: () => Promise<{ success: boolean; sessions?: any[]; error?: string }>

    saveSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>

    loadSession: (sessionId: string) => Promise<{ success: boolean; session?: any; error?: string }>

    exportSession: (sessionId: string, exportPath: string) => Promise<{ success: boolean; error?: string }>

    importSession: (importPath: string) => Promise<{ success: boolean; sessionId?: string; error?: string }>

    getStats: () => Promise<{ success: boolean; stats?: any; error?: string }>

    clearOldSessions: (maxAgeHours?: number) => Promise<{ success: boolean; count?: number; error?: string }>

    // Events
    onSessionCreated: (callback: (data: { session: any }) => void) => () => void

    onSessionUpdated: (callback: (data: { sessionId: string; updates: any }) => void) => () => void

    onSessionDeleted: (callback: (data: { sessionId: string }) => void) => () => void

    removeListeners: () => void
}

// Enhanced Electron API with all terminal capabilities

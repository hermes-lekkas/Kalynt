/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
/// <reference types="vite/client" />

declare global {
  interface ImportMetaEnv {
    readonly VITE_OPENAI_API_URL?: string
    readonly VITE_ANTHROPIC_API_URL?: string
    readonly VITE_GOOGLE_API_URL?: string
    readonly VITE_GITHUB_API_URL?: string
    readonly VITE_MODEL_REGISTRY_URL?: string
    readonly VITE_MODEL_UPDATE_URL?: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

declare module '*.wasm?url' {
  const content: string;
  export default content;
}

declare module '*.wasm' {
  const content: string;
  export default content;
}

export interface FileSystemItem {
  name: string
  path: string
  isDirectory: boolean
  isFile: boolean
  size?: number
  lastModified?: number
}

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
  getCommandHistory: (terminalId: string) => Promise<{ success: boolean; history?: any[]; error?: string }>
  getCurrentCommand: (terminalId: string) => Promise<{ success: boolean; command?: any; error?: string }>
  getDefaultShell: () => Promise<{ success: boolean; shell: string; error?: string }>
  onData: (callback: (data: { id: string; data: string; type: string }) => void) => void
  onExit: (callback: (data: { id: string; exitCode: number; signal?: number; title: string }) => void) => void
  onSpawned: (callback: (data: { id: string; pid: number; title: string; cwd: string; shell: string }) => void) => void
  onRestored: (callback: (data: { id: string; pid: number; title: string }) => void) => void
  onCommandFinished: (callback: (data: { terminalId: string; command: any }) => void) => void
  onDecorationsAvailable: (callback: (data: { terminalId: string; commandId: string; decorations: any[] }) => void) => void
  removeListeners: () => void
}

export interface RuntimeAPI {
  startLSP: (sessionId: string, languageId: string, workspacePath: string, options?: any) => Promise<{ success: boolean; error?: string }>
  stopLSP: (sessionId: string) => Promise<{ success: boolean; error?: string }>
  sendLSPRequest: (sessionId: string, method: string, params: any) => Promise<{ success: boolean; result?: any; error?: string }>
  getLanguageServers: () => Promise<{ success: boolean; servers?: any[]; error?: string }>
  startDebug: (sessionId: string, languageId: string, program: string, options?: any) => Promise<{ success: boolean; port?: number; error?: string }>
  stopDebug: (sessionId: string) => Promise<{ success: boolean; error?: string }>
  sendDebugRequest: (sessionId: string, method: string, params: any) => Promise<{ success: boolean; result?: any; error?: string }>
  getDebugSessions: () => Promise<{ success: boolean; sessions?: any[]; error?: string }>
  check: (runtimeId: string, version?: string) => Promise<{ success: boolean; installed?: boolean; isInstalled?: boolean; version?: string; managedByKalynt?: boolean; error?: string }>
  downloadAndInstall: (runtimeId: string, version?: string, options?: any) => Promise<{ success: boolean; error?: string }>
  uninstall: (runtimeId: string, version?: string) => Promise<{ success: boolean; error?: string }>
  onDownloadProgress: (callback: (data: { runtimeId: string; version?: string; bytesDownloaded?: number; totalBytes?: number; progress?: number; speed: number }) => void) => () => void
  onStatus: (callback: (data: { runtimeId: string; version?: string; status: 'downloading' | 'installing' | 'completed' | 'failed'; message?: string; error?: string }) => void) => () => void
  onLog: (callback: (data: { runtimeId: string; version?: string; level: string; message: string }) => void) => () => void
  onLanguageServerStarted: (callback: (data: { sessionId: string; languageId: string; capabilities: any }) => void) => void
  onLanguageServerStopped: (callback: (data: { sessionId: string; exitCode: number }) => void) => void
  onDebugSessionStarted: (callback: (data: { sessionId: string; languageId: string; port: number; configuration: any }) => void) => void
  onDebugSessionStopped: (callback: (data: { sessionId: string; exitCode: number }) => void) => void
  onDebugSessionError: (callback: (data: { sessionId: string; error: string }) => void) => void
  removeListeners: () => void
}

export interface TasksAPI {
  detectTasks: (workspacePath: string) => Promise<{ success: boolean; tasks?: any[]; error?: string }>
  executeTask: (taskId: string, task: any) => Promise<{ success: boolean; executionId?: string; error?: string }>
  killTask: (executionId: string) => Promise<{ success: boolean; error?: string }>
  getExecutions: () => Promise<{ success: boolean; executions?: any[]; error?: string }>
  getExecution: (executionId: string) => Promise<{ success: boolean; execution?: any; error?: string }>
  onTaskOutput: (callback: (data: { executionId: string; type: 'stdout' | 'stderr'; data: string }) => void) => void
  onTaskCompleted: (callback: (data: { executionId: string; exitCode: number; status: string; duration: number }) => void) => void
  onTaskError: (callback: (data: { executionId: string; error: string }) => void) => void
  onTaskCancelled: (callback: (data: { executionId: string }) => void) => void
  removeListeners: () => void
}

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
  onSessionCreated: (callback: (data: { session: any }) => void) => void
  onSessionUpdated: (callback: (data: { sessionId: string; updates: any }) => void) => void
  onSessionDeleted: (callback: (data: { sessionId: string }) => void) => void
  removeListeners: () => void
}

export interface UpdateAPI {
  configureToken: (token: string) => Promise<{ success: boolean; message?: string; error?: string }>
  checkForUpdates: () => Promise<{
    success: boolean
    updateAvailable?: boolean
    updateInfo?: {
      version: string
      releaseNotes?: string
      releaseDate: string
      releaseName?: string
    }
    currentVersion?: string
    error?: string
  }>
  downloadUpdate: () => Promise<{ success: boolean; error?: string }>
  installUpdate: () => Promise<{ success: boolean; error?: string }>
  getVersion: () => Promise<{ success: boolean; version?: string; error?: string }>
  getStatus: () => Promise<{ success: boolean; checking?: boolean; downloading?: boolean; error?: string }>
  onUpdateChecking: (callback: () => void) => void
  onUpdateAvailable: (callback: (info: {
    version: string
    releaseNotes?: string
    releaseDate: string
    releaseName?: string
  }) => void) => void
  onUpdateNotAvailable: (callback: (info: { version: string }) => void) => void
  onDownloadProgress: (callback: (progress: {
    bytesPerSecond: number
    percent: number
    transferred: number
    total: number
  }) => void) => void
  onUpdateDownloaded: (callback: (info: {
    version: string
    releaseNotes?: string
    releaseDate: string
    releaseName?: string
  }) => void) => void
  onUpdateError: (callback: (error: { message: string; stack?: string }) => void) => void
  removeListeners: () => void
}

export interface ElectronAPI {
  platform: string
  getAppPath: () => Promise<string>
  getVersion: () => Promise<string>
  getModelsDirectory: () => Promise<string>
  getHardwareInfo: () => Promise<any>
  getRealTimeStats: () => Promise<any>
  fileExists: (path: string) => Promise<boolean>
  deleteModel: (path: string) => Promise<{ success: boolean; error?: string }>
  downloadModel: (options: any) => Promise<any>
  cancelDownload: (modelId: string) => Promise<{ success: boolean; error?: string }>
  pauseDownload: (modelId: string) => Promise<boolean>
  resumeDownload: (modelId: string) => Promise<boolean>
  onDownloadProgress: (callback: (progress: {
    modelId: string
    bytesDownloaded: number
    totalBytes: number
    speed: number
  }) => void) => void
  loadModel: (options: any) => Promise<boolean>
  unloadModel: () => Promise<boolean>
  generateCompletion: (options: any) => Promise<any>
  generateCompletionStream: (options: any, onToken: (token: string) => void, onComplete: (error?: string) => void) => string
  cancelGeneration: (requestId: string) => Promise<boolean>

  terminal: TerminalAPI
  runtime: RuntimeAPI
  tasks: TasksAPI
  sessions: SessionsAPI
  update: UpdateAPI

  fs: any
  code: any
  git: any
  shell: any
  minimizeWindow: () => Promise<void>
  maximizeWindow: () => Promise<void>
  closeWindow: () => Promise<void>
  nukeProcesses: (level: any) => Promise<{ success: boolean; message?: string }>
  build: any
  debug: any
  safeStorage: any
  runtimeMgmt: any
  deps: {
    detect: (workspacePath: string) => Promise<{ success: boolean; manager?: any; error?: string }>
    getForLanguage: (languageId: string) => Promise<{ success: boolean; manager?: any; error?: string }>
    install: (packageName: string, options: { workspacePath: string; global?: boolean; dev?: boolean; version?: string }) => Promise<{ success: boolean; output?: string; error?: string }>
    installAll: (workspacePath: string) => Promise<{ success: boolean; output?: string; error?: string }>
    uninstall: (packageName: string, workspacePath: string) => Promise<{ success: boolean; error?: string }>
    update: (packageName: string | null, workspacePath: string) => Promise<{ success: boolean; error?: string }>
    list: (workspacePath: string) => Promise<{ success: boolean; packages?: any[]; error?: string }>
    init: (managerName: string, workspacePath: string) => Promise<{ success: boolean; error?: string }>
    getSupportedManagers: () => Promise<any[]>
    kill: (operationId: string) => Promise<boolean>
    onOutput: (callback: (data: { operationId: string; type: string; data: string }) => void) => void
    onComplete: (callback: (data: { operationId: string; success: boolean; exitCode?: number; error?: string }) => void) => void
    removeListeners: () => void
  }
  initDB?: (dbPath: string) => Promise<void>
  dbQuery?: (sql: string, params: unknown[]) => Promise<unknown[]>
  dbRun?: (sql: string, params: unknown[]) => Promise<void>
  on: (channel: string, callback: (...args: any[]) => void) => (() => void)

  // Extension System APIs
  extensions: {
    scan: () => Promise<any[]>
    activate: (id: string) => Promise<any>
    deactivate: (id: string) => Promise<void>
    install: (vsixPath: string) => Promise<any>
    uninstall: (id: string) => Promise<void>
    list: () => Promise<any[]>
    active: () => Promise<any[]>
    contributions: () => Promise<any>
    startHost: () => Promise<void>
    stopHost: () => Promise<void>
    download: (url: string, targetPath: string) => Promise<void>
    onExtensionActivated: (callback: (data: { id: string }) => void) => void
    onExtensionDeactivated: (callback: (data: { id: string }) => void) => void
    onShowMessage: (callback: (data: { type: string; message: string }) => void) => void
    removeListeners: () => void
  }

  // Dialog APIs
  dialog: {
    showOpenDialog: (options: any) => Promise<any>
  }

  // App APIs
  app: {
    getPath: (name: string) => Promise<string>
  }

  // Cloud AI requests (main process) and the agent's tools
  ai: {
    chat: (requestId: string, request: import('./types/aiProtocol').ChatRequest) => Promise<
      | { ok: true; result: import('./types/aiProtocol').ChatResult }
      | { ok: false; error: string; status?: number; aborted?: boolean }>
    cancel: (requestId: string) => Promise<{ ok: boolean }>
    models: (provider: string, refresh?: boolean) => Promise<{ models: import('./types/aiProtocol').ModelInfo[]; live: boolean; error?: string }>
    verify: (provider: string, key: string) => Promise<{ ok: boolean; error?: string; status?: number }>
    keyStatus: () => Promise<Partial<Record<import('./types/aiProtocol').ProviderId, boolean>>>
    onEvent: (callback: (data: import('./types/aiProtocol').AiEventEnvelope) => void) => () => void
  }
  agent: {
    exec: (options: { id: string; command: string; cwd?: string; timeoutMs?: number; background?: boolean }) => Promise<{ ok: boolean; output: string; exitCode: number | null; running: boolean; timedOut?: boolean; durationMs: number; error?: string }>
    execRead: (id: string) => Promise<{ ok: boolean; output: string; running: boolean; exitCode: number | null; error?: string }>
    execKill: (id: string) => Promise<{ ok: boolean }>
    onExecOutput: (callback: (data: { id: string; data: string }) => void) => () => void
    glob: (options: { pattern: string; path?: string; limit?: number }) => Promise<{ ok: boolean; files?: string[]; total?: number; truncated?: boolean; error?: string }>
    grep: (options: { pattern: string; path?: string; glob?: string; caseSensitive?: boolean; context?: number; maxResults?: number; filesOnly?: boolean }) => Promise<{ ok: boolean; matches?: Array<{ file: string; line: number; text: string; before?: string[]; after?: string[] }>; files?: string[]; truncated?: boolean; error?: string }>
    webSearch: (options: { query: string; count?: number }) => Promise<{ ok: boolean; results?: Array<{ title: string; url: string; snippet: string }>; error?: string }>
    webFetch: (options: { url: string; maxChars?: number; allowPrivate?: boolean }) => Promise<{ ok: boolean; url?: string; title?: string; content?: string; contentType?: string; truncated?: boolean; error?: string }>
    listSessions: (spaceId?: string) => Promise<Array<{ id: string; title: string; spaceId?: string; provider?: string; model?: string; updatedAt: number; createdAt: number }>>
    loadSession: (id: string) => Promise<unknown>
    saveSession: (session: unknown) => Promise<{ ok: boolean; error?: string }>
    deleteSession: (id: string) => Promise<{ ok: boolean }>
  }

  // IPC Renderer
  ipcRenderer: {
    invoke: (channel: string, ...args: any[]) => Promise<any>
    on: (channel: string, callback: (event: any, ...args: any[]) => void) => () => void
    removeAllListeners: (channel: string) => void
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
  var electronAPI: ElectronAPI
}

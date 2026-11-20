/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Web/browser fallback shim matching the Electron preload API 1:1.
 */
const noopAsync = (..._args: any[]) => Promise.resolve({ success: false, error: 'Not available in web mode' })
const noopVoidAsync = (..._args: any[]) => Promise.resolve()
const noop = (..._args: any[]) => {}
const noopReturn = (..._args: any[]) => () => {}

const createEventAPI = () => ({
    removeListeners: noop,
})

const terminalShim = {
    spawn: noopAsync,
    write: noopAsync,
    writeOutput: noopAsync,
    resize: noopAsync,
    kill: noopAsync,
    sendSignal: noopAsync,
    getInfo: noopAsync,
    getAll: () => Promise.resolve({ success: true, terminals: [] }),
    fork: noopAsync,
    sendSequence: noopAsync,
    clearHistory: noopAsync,
    saveState: noopAsync,
    restoreState: noopAsync,
    broadcast: noopAsync,
    getCommandHistory: () => Promise.resolve({ success: true, history: [] }),
    getCurrentCommand: () => Promise.resolve({ success: true, command: null }),
    getDefaultShell: () => Promise.resolve({ success: false, shell: '', error: 'Not available in web mode' }),
    onData: noopReturn,
    onExit: noopReturn,
    onSpawned: noopReturn,
    onRestored: noopReturn,
    onCommandFinished: noopReturn,
    onDecorationsAvailable: noopReturn,
    ...createEventAPI(),
}

const runtimeShim = {
    startLSP: noopAsync,
    stopLSP: noopAsync,
    sendLSPRequest: noopAsync,
    getLanguageServers: () => Promise.resolve({ success: true, servers: [] }),
    startDebug: noopAsync,
    stopDebug: noopAsync,
    sendDebugRequest: noopAsync,
    getDebugSessions: () => Promise.resolve({ success: true, sessions: [] }),
    onLanguageServerStarted: noopReturn,
    onLanguageServerStopped: noopReturn,
    onDebugSessionStarted: noopReturn,
    onDebugSessionStopped: noopReturn,
    onDebugSessionError: noopReturn,
    ...createEventAPI(),
}

const tasksShim = {
    detectTasks: () => Promise.resolve({ success: true, tasks: [] }),
    executeTask: noopAsync,
    killTask: noopAsync,
    getExecutions: () => Promise.resolve({ success: true, executions: [] }),
    getExecution: noopAsync,
    onTaskOutput: noopReturn,
    onTaskCompleted: noopReturn,
    onTaskError: noopReturn,
    onTaskCancelled: noopReturn,
    ...createEventAPI(),
}

const sessionsShim = {
    createSession: noopAsync,
    getSession: noopAsync,
    updateSession: noopAsync,
    deleteSession: noopAsync,
    getAllSessions: () => Promise.resolve({ success: true, sessions: [] }),
    getActiveSessions: () => Promise.resolve({ success: true, sessions: [] }),
    saveSession: noopAsync,
    loadSession: noopAsync,
    exportSession: noopAsync,
    importSession: noopAsync,
    getStats: noopAsync,
    clearOldSessions: () => Promise.resolve({ success: true, count: 0 }),
    onSessionCreated: noopReturn,
    onSessionUpdated: noopReturn,
    onSessionDeleted: noopReturn,
    ...createEventAPI(),
}

const fsShim = {
    openFolder: () => Promise.resolve({ success: false, canceled: true }),
    setWorkspace: noopAsync,
    readDir: noopAsync,
    stat: noopAsync,
    readFile: noopAsync,
    readBinaryFile: noopAsync,
    writeFile: noopAsync,
    createFile: noopAsync,
    createDir: noopAsync,
    delete: noopAsync,
    rename: noopAsync,
    watchDir: noopAsync,
    unwatchDir: noopAsync,
    onChange: noopReturn,
    removeListeners: noop,
    backupWorkspace: noopAsync,
    search: noopAsync,
}

const codeShim = {
    execute: noopAsync,
    kill: noopAsync,
    writeInput: noopAsync,
    runCommand: noopAsync,
    onOutput: noopReturn,
    onExit: noopReturn,
    removeListeners: noop,
    clearBinaryCache: noopAsync,
    clearCache: noopAsync,
}

const shellShim = {
    openExternal: noopAsync,
    showItemInFolder: noopAsync,
}

const runtimeMgmtShim = {
    check: noopAsync,
    installable: () => Promise.resolve({ success: true, runtimes: [] as string[] }),
    download: noopAsync,
    install: noopAsync,
    uninstall: noopAsync,
    downloadAndInstall: noopAsync,
    onDownloadProgress: noopReturn,
    onStatus: noopReturn,
    onLog: noopReturn,
    removeListeners: noop,
}

const safeStorageShim = {
    isAvailable: () => Promise.resolve(false),
    set: noopAsync,
    get: () => Promise.resolve({ success: false, value: null, error: 'Not available in web mode' }),
    hasKey: () => Promise.resolve({ success: true, hasKey: false }),
    delete: noopAsync,
    listKeys: () => Promise.resolve({ success: true, keys: [] as string[] }),
}

const updateShim = {
    configureToken: noopAsync,
    checkForUpdates: () => Promise.resolve({ success: true, updateAvailable: false }),
    downloadUpdate: noopAsync,
    installUpdate: noopAsync,
    getVersion: () => Promise.resolve({ success: true, version: '2.0.0-web' }),
    getStatus: () => Promise.resolve({ success: true, checking: false, downloading: false }),
    onUpdateChecking: noopReturn,
    onUpdateAvailable: noopReturn,
    onUpdateNotAvailable: noopReturn,
    onDownloadProgress: noopReturn,
    onUpdateDownloaded: noopReturn,
    onUpdateError: noopReturn,
    removeListeners: noop,
}

const gitShim = {
    status: noopAsync,
    log: noopAsync,
    diff: noopAsync,
    add: noopAsync,
    commit: noopAsync,
    amend: noopAsync,
    branch: noopAsync,
    checkout: noopAsync,
    reset: noopAsync,
    push: noopAsync,
    publish: noopAsync,
    pull: noopAsync,
    init: noopAsync,
    discard: noopAsync,
    createBranch: noopAsync,
    fetch: noopAsync,
    remote: noopAsync,
    clone: noopAsync,
    stash: noopAsync,
    stashPop: noopAsync,
    stashList: noopAsync,
    commitFiles: noopAsync,
    commitDiff: noopAsync,
}

const depsShim = {
    detect: noopAsync,
    getForLanguage: noopAsync,
    install: noopAsync,
    installAll: noopAsync,
    uninstall: noopAsync,
    update: noopAsync,
    list: () => Promise.resolve({ success: true, packages: [] }),
    init: noopAsync,
    getSupportedManagers: () => Promise.resolve([]),
    kill: () => Promise.resolve(false),
    onOutput: noopReturn,
    onComplete: noopReturn,
    removeListeners: noop,
}

const buildShim = {
    getTasks: () => Promise.resolve({ success: true, tasks: [] }),
    executeTask: noopAsync,
    killTask: noopAsync,
    onOutput: noopReturn,
    onEnd: noopReturn,
    onProblems: noopReturn,
    removeListeners: noop,
}

const debugShim = {
    getConfigurations: () => Promise.resolve({ success: true, configurations: [] }),
    start: noopAsync,
    stop: noopAsync,
    setBreakpoints: noopAsync,
    continue: noopAsync,
    stepOver: noopAsync,
    stepInto: noopAsync,
    stepOut: noopAsync,
    pause: noopAsync,
    getCallStack: () => Promise.resolve({ success: true, callStack: [] }),
    getVariables: () => Promise.resolve({ success: true, variables: [] }),
    evaluate: noopAsync,
    addWatch: noopAsync,
    removeWatch: noopAsync,
    getWatches: () => Promise.resolve({ success: true, watches: [] }),
    updateWatches: () => Promise.resolve({ success: true, watches: [] }),
    clearWatches: noopAsync,
    onStarted: noopReturn,
    onStopped: noopReturn,
    onContinued: noopReturn,
    onTerminated: noopReturn,
    onOutput: noopReturn,
    onBreakpoint: noopReturn,
    onEvent: noopReturn,
    onResponse: noopReturn,
    onError: noopReturn,
    onAdapterMissing: noopReturn,
    removeListeners: noop,
}

const extensionsShim = {
    scan: () => Promise.resolve([]),
    activate: noopAsync,
    deactivate: noopVoidAsync,
    install: noopAsync,
    uninstall: noopVoidAsync,
    list: () => Promise.resolve([]),
    active: () => Promise.resolve([]),
    contributions: () => Promise.resolve({}),
    startHost: noopVoidAsync,
    stopHost: noopVoidAsync,
    download: noopVoidAsync,
    onActivated: noopReturn,
    onDeactivated: noopReturn,
    onExtensionActivated: noopReturn,
    onExtensionDeactivated: noopReturn,
    onShowMessage: noopReturn,
    removeListeners: noop,
}

const performanceShim = {
    setMode: noopAsync,
    getStatus: () => Promise.resolve({
        memory: { mode: 'balanced' as const, rss: 0, totalPrivateBytes: 0 },
        platform: 'browser',
        arch: 'web'
    }),
    requestGc: noopAsync,
    scanWorkspace: () => Promise.resolve([] as string[]),
    prewarmCache: noopAsync,
    testDiskSpeed: () => Promise.resolve({ read: 0, write: 0 }),
    getBootTime: () => Promise.resolve(0),
    getInferenceConfig: () => Promise.resolve({
        flashAttention: true,
        batchSize: 256,
        threads: 0,
        useSpeculativeDecoding: false
    }),
    onRequestGc: noopReturn,
    onSuspendBackgroundTasks: noopReturn,
    onOptimizeMonaco: noopReturn,
    onDisposeWorkers: noopReturn,
}

const windowControlsShim = {
    minimize: noopVoidAsync,
    maximize: noopVoidAsync,
    close: noopVoidAsync,
    isMaximized: () => Promise.resolve(false),
    onMaximizedChange: noopReturn,
}

export const electronAPIShim = {
    platform: 'browser' as const,
    getAppPath: () => Promise.resolve('/'),
    getVersion: () => Promise.resolve('2.0.0-web'),
    getModelsDirectory: () => Promise.resolve('/models'),
    getHardwareInfo: () => Promise.resolve({
        cpuCores: typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4,
        cpuThreads: typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4,
        cpuModel: 'Web Browser',
        totalRAM: 0,
        availableRAM: 0,
        usedRAM: 0,
        hasGPU: false,
        totalDiskSpace: null,
        availableDiskSpace: null
    }),
    getPerformanceInferenceConfig: performanceShim.getInferenceConfig,
    getRealTimeStats: () => Promise.resolve({
        cpuUsage: 0,
        ramUsage: 0,
        ramTotal: 0,
        diskUsage: null,
        diskTotal: null,
        diskIOSpeed: null,
        networkConnected: typeof navigator !== 'undefined' ? navigator.onLine : false,
        networkLatency: null,
        gpuUsage: null,
        vramUsage: null,
        vramTotal: 0,
        ivramUsage: null,
        ivramTotal: 0
    }),
    fileExists: () => Promise.resolve(false),
    deleteModel: noopAsync,
    downloadModel: noopAsync,
    cancelDownload: noopAsync,
    pauseDownload: noopAsync,
    resumeDownload: noopAsync,
    onDownloadProgress: noopReturn,
    loadModel: noopAsync,
    unloadModel: noopAsync,
    generateCompletion: noopAsync,
    generateCompletionStream: (_options: any, _onToken: (token: string) => void, onComplete: (error?: string) => void): string => {
        const requestId = `web-${Math.random().toString(36).slice(2, 9)}`
        queueMicrotask(() => onComplete?.('Not available in web mode'))
        return requestId
    },
    cancelGeneration: noopAsync,
    loadDraftModel: noopAsync,
    unloadDraftModel: noopAsync,
    getDraftModelStatus: () => Promise.resolve({ success: true, loaded: false, modelId: null }),
    getModelStatus: () => Promise.resolve({ success: true, loaded: false, modelId: null, generating: false }),
    onLLMEvent: noopReturn,
    nukeProcesses: noopAsync,

    minimizeWindow: windowControlsShim.minimize,
    maximizeWindow: windowControlsShim.maximize,
    closeWindow: windowControlsShim.close,
    isMaximized: windowControlsShim.isMaximized,
    onMaximizedChange: windowControlsShim.onMaximizedChange,
    window: windowControlsShim,

    on: noopReturn,

    dialog: {
        showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] as string[] }),
    },
    app: {
        getPath: () => Promise.resolve('/tmp'),
    },
    extensions: extensionsShim,
    performance: performanceShim,
    terminal: terminalShim,
    runtime: runtimeShim,
    tasks: tasksShim,
    sessions: sessionsShim,
    fs: fsShim,
    code: codeShim,
    shell: shellShim,
    runtimeMgmt: runtimeMgmtShim,
    safeStorage: safeStorageShim,
    build: buildShim,
    debug: debugShim,
    ai: {
        keyStatus: async () => ({}),
        models: async () => ({ models: [], live: false, error: 'AI connections need the desktop app.' }),
        verify: async () => ({ ok: false, error: 'AI connections need the desktop app.' }),
        localServerStatus: async () => ({ configured: false, baseUrl: '', hasToken: false, contextWindow: 8192 }),
        connectLocalServer: async () => ({ ok: false, error: 'Connecting a local server needs the desktop app.' }),
        disconnectLocalServer: async () => ({ ok: false, error: 'Connecting a local server needs the desktop app.' }),
        onEvent: noopReturn,
        chat: async () => ({ ok: false, error: 'AI requests need the desktop app.' }),
        cancel: async () => ({ ok: true })
    },
    // Conversation APIs return arrays/null, unlike generic IPC result objects.
    // An object here used to crash the agent panel on its first workspace.
    agent: {
        exec: async () => ({ ok: false, output: '', exitCode: null, running: false, durationMs: 0, error: 'Running commands needs the desktop app.' }),
        execRead: async () => ({ ok: false, output: '', running: false, exitCode: null, error: 'Running commands needs the desktop app.' }),
        execKill: async () => ({ ok: false }),
        onExecOutput: noopReturn,
        glob: async () => ({ ok: false, error: 'Workspace search needs the desktop app.' }),
        grep: async () => ({ ok: false, error: 'Workspace search needs the desktop app.' }),
        webSearch: async () => ({ ok: false, error: 'Web search needs the desktop app.' }),
        webFetch: async () => ({ ok: false, error: 'Fetching web pages needs the desktop app.' }),
        listSessions: async () => [],
        loadSession: async () => null,
        saveSession: async () => ({ ok: false, error: 'Saving conversations needs the desktop app.' }),
        flushSession: () => ({ ok: false, error: 'Saving conversations needs the desktop app.' }),
        deleteSession: async () => ({ ok: false, error: 'Deleting conversations needs the desktop app.' })
    },
    editorState: {
        load: async (spaceId: string, folder: string) => {
            try { return JSON.parse(localStorage.getItem(`kalynt-editor-recovery:${JSON.stringify([spaceId, folder])}`) ?? 'null') } catch { return null }
        },
        save: async (state: any) => {
            try { localStorage.setItem(`kalynt-editor-recovery:${JSON.stringify([state.spaceId, state.folder])}`, JSON.stringify(state)); return { success: true } }
            catch { return { success: false, error: 'Browser recovery storage is full.' } }
        },
        flush: (state: any) => {
            try { localStorage.setItem(`kalynt-editor-recovery:${JSON.stringify([state.spaceId, state.folder])}`, JSON.stringify(state)); return { success: true } }
            catch { return { success: false, error: 'Browser recovery storage is full.' } }
        }
    },
    update: updateShim,
    git: gitShim,
    deps: depsShim,
}

// Any API the shim does not model explicitly resolves to a harmless "not available"
// result (or a no-op unsubscribe for `on*` listeners) instead of crashing the renderer.
const WEB_RESULT = { success: false, error: 'Not available in web mode' }
const isListener = (name: string) => name === 'on' || /^on[A-Z]/.test(name)

function fallback(path: string): any {
    const name = path.split('.').pop() || ''
    const fn = (..._args: any[]) => {
        if (isListener(name)) return () => {}
        if (/^remove/.test(name)) return undefined
        return Promise.resolve(WEB_RESULT)
    }
    return new Proxy(fn, {
        get: (_target, prop) => {
            if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined
            return fallback(`${path}.${prop}`)
        }
    })
}

function withFallback<T extends object>(target: T, path: string): T {
    return new Proxy(target, {
        get(obj, prop, receiver) {
            if (typeof prop === 'symbol') return Reflect.get(obj, prop, receiver)
            if (prop in obj) {
                const value = Reflect.get(obj, prop, receiver)
                return value && typeof value === 'object' && !Array.isArray(value)
                    ? withFallback(value, `${path}.${prop}`)
                    : value
            }
            if (prop === 'then' || prop === 'toJSON' || prop === 'ipcRenderer') return undefined
            return fallback(`${path}.${prop}`)
        }
    })
}

const webAPI = withFallback(electronAPIShim, 'electronAPI')

if (typeof window !== 'undefined' && !(window as any).electronAPI) {
    (window as any).electronAPI = webAPI
}
if (typeof globalThis !== 'undefined' && !(globalThis as any).electronAPI) {
    (globalThis as any).electronAPI = webAPI
}

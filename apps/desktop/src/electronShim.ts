const noopAsync = (..._args: any[]) => Promise.resolve({ success: false, error: 'Not available in web mode' })
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
    getAll: noopAsync,
    fork: noopAsync,
    sendSequence: noopAsync,
    clearHistory: noopAsync,
    saveState: noopAsync,
    restoreState: noopAsync,
    broadcast: noopAsync,
    getCommandHistory: noopAsync,
    getCurrentCommand: noopAsync,
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
    getLanguageServers: noopAsync,
    startDebug: noopAsync,
    stopDebug: noopAsync,
    sendDebugRequest: noopAsync,
    getDebugSessions: noopAsync,
    onLanguageServerStarted: noopReturn,
    onLanguageServerStopped: noopReturn,
    onDebugSessionStarted: noopReturn,
    onDebugSessionStopped: noopReturn,
    onDebugSessionError: noopReturn,
    ...createEventAPI(),
}

const tasksShim = {
    detectTasks: noopAsync,
    executeTask: noopAsync,
    killTask: noopAsync,
    getExecutions: noopAsync,
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
    getAllSessions: noopAsync,
    getActiveSessions: noopAsync,
    saveSession: noopAsync,
    loadSession: noopAsync,
    exportSession: noopAsync,
    importSession: noopAsync,
    getStats: noopAsync,
    clearOldSessions: noopAsync,
    onSessionCreated: noopReturn,
    onSessionUpdated: noopReturn,
    onSessionDeleted: noopReturn,
    ...createEventAPI(),
}

const fsShim = {
    openFolder: noopAsync,
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
    runCommand: noopAsync,
    onOutput: noopReturn,
    onExit: noopReturn,
    removeListeners: noop,
    clearCache: noopAsync,
}

const shellShim = {
    openExternal: noopAsync,
    showItemInFolder: noopAsync,
}

const runtimeMgmtShim = {
    check: noopAsync,
    downloadAndInstall: noopAsync,
    uninstall: noopAsync,
    onDownloadProgress: noopReturn,
    onStatus: noopReturn,
    onLog: noopReturn,
    removeListeners: noop,
}

const safeStorageShim = {
    get: noopAsync,
    set: noopAsync,
    delete: noopAsync,
}

const updateShim = {
    configureToken: noopAsync,
    checkForUpdates: () => Promise.resolve({ success: true, updateAvailable: false }),
    downloadUpdate: noopAsync,
    installUpdate: noopAsync,
    getVersion: () => Promise.resolve({ success: true, version: '2.0.0-web' }),
    onUpdateChecking: noopReturn,
    onUpdateAvailable: noopReturn,
    onUpdateNotAvailable: noopReturn,
    onUpdateDownloaded: noopReturn,
    onDownloadProgress: noopReturn,
    onUpdateError: noopReturn,
    onError: noopReturn,
    removeListeners: noop,
}

const gitShim = {
    clone: noopAsync,
    status: noopAsync,
    add: noopAsync,
    commit: noopAsync,
    push: noopAsync,
    pull: noopAsync,
    log: noopAsync,
    diff: noopAsync,
    branch: noopAsync,
    checkout: noopAsync,
    getRemotes: noopAsync,
    addRemote: noopAsync,
    init: noopAsync,
    stash: noopAsync,
    stashPop: noopAsync,
    onProgress: noopReturn,
    removeListeners: noop,
}

const depsShim = {
    detect: noopAsync,
    getForLanguage: noopAsync,
    install: noopAsync,
    installAll: noopAsync,
    uninstall: noopAsync,
    update: noopAsync,
    list: noopAsync,
    init: noopAsync,
    onOutput: noopReturn,
    onComplete: noopReturn,
    removeListeners: noop,
}

export const electronAPIShim = {
    platform: 'browser' as const,
    getAppPath: () => Promise.resolve('/'),
    getVersion: () => Promise.resolve('2.0.0-web'),
    getAppVersion: () => Promise.resolve({ success: true, version: '2.0.0-web' }),
    getModelsDirectory: () => Promise.resolve('/models'),
    getHardwareInfo: () => Promise.resolve({ cpu: 'Web Browser', ram: 0, gpu: 'N/A' }),
    getRealTimeStats: () => Promise.resolve({ cpuUsage: 0, memUsage: 0 }),
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
    generateCompletionStream: noopAsync,
    cancelGeneration: noopAsync,
    loadDraftModel: noopAsync,
    unloadDraftModel: noopAsync,
    getDraftModelStatus: noopAsync,
    nukeProcesses: noopAsync,

    minimizeWindow: noop,
    maximizeWindow: noop,
    closeWindow: noop,

    on: noopReturn,
    ipcRenderer: {
        invoke: noopAsync,
        on: noopReturn,
        removeAllListeners: noop,
    },

    app: {
        getPath: () => Promise.resolve('/tmp'),
    },
    extensions: {
        download: noopAsync,
    },
    terminal: terminalShim,
    runtime: runtimeShim,
    tasks: tasksShim,
    sessions: sessionsShim,
    fs: fsShim,
    code: codeShim,
    shell: shellShim,
    runtimeMgmt: runtimeMgmtShim,
    safeStorage: safeStorageShim,
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
            if (prop === 'then' || prop === 'toJSON') return undefined
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

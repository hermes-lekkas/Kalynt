/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
const APP_START_TIME = Date.now()
import { app, BrowserWindow, ipcMain, dialog } from 'electron'
// SECURITY FIX: Enable sandbox mode for all platforms
// This must be called before app.whenReady() for full effect
app.enableSandbox()
import type { BrowserWindow as BrowserWindowType } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

// Import services
import { RuntimeManager } from './services/runtime-manager'
import { performanceAcceleration } from './services/Performance_Acceleration'

// Import handlers
import { registerAppInfoHandlers } from './handlers/app-info'
import { registerRuntimeHandlers } from './handlers/runtime'
import { registerTerminalHandlers } from './handlers/terminal'
import { registerGitHandlers } from './handlers/git'
import { registerFileSystemHandlers } from './handlers/file-system'
import { registerCodeExecutionHandlers } from './handlers/code-execution'
import { registerModelDownloadHandlers } from './handlers/model-download'
import { registerLLMInferenceHandlers } from './handlers/llm-inference'
import { registerSafeStorageHandlers } from './handlers/safeStorage'
import { registerNukeHandlers } from './handlers/nuke-handler'
import { registerDependencyHandlers } from './handlers/dependency'
import { setupBuildHandlers } from './handlers/build'
import { setupDebugHandlers } from './handlers/debug'
import { registerUpdateHandlers, initializeAutoUpdater, isInstallingUpdate } from './handlers/update-handler'
import { extensionHostManager } from './extensions/extensionHostManager'
import { startSignalingServer } from './signalingServer'
import type { SignalingServerHandle } from './signalingServer'
import { startMobileBridge, generatePairingQR, getLocalIp } from './mobileBridge'
import type { MobileBridgeHandle } from './mobileBridge'
import { initializeAgentBridge, cleanupAgentBridge } from './mobileAgentBridge'
import { stopEverything } from './services/shutdown'
import { createAppWindow } from './appWindow'

// Window and workspace state
let mainWindow: BrowserWindowType | null = null
let currentWorkspacePath: string | null = null

// Built-in P2P signaling server handle
let signalingServer: SignalingServerHandle | null = null

// Mobile bridge server handle
let mobileBridge: MobileBridgeHandle | null = null

// SECURITY: Deep link validation to prevent URL-based attacks
// Only allow safe paths that match expected patterns
function validateDeepLink(link: string): string | null {
    try {
        const url = new URL(link)

        // Must be kalynt:// protocol
        if (url.protocol !== 'kalynt:') {
            console.warn('[Main] Invalid deep link protocol:', url.protocol)
            return null
        }

        // Validate pathname: only allow alphanumeric, hyphens, underscores, slashes
        // Prevent path traversal and special characters
        const pathPattern = /^\/[a-zA-Z0-9_\-/]*$/
        if (!pathPattern.test(url.pathname) || url.pathname.includes('..')) {
            console.warn('[Main] Invalid deep link path:', url.pathname)
            return null
        }

        // Validate query params: block dangerous patterns
        const dangerousPatterns = ['javascript:', 'data:', 'file:', '<script', 'onerror']
        const searchLower = url.search.toLowerCase()
        for (const pattern of dangerousPatterns) {
            if (searchLower.includes(pattern)) {
                console.warn('[Main] Dangerous pattern in deep link query:', pattern)
                return null
            }
        }

        return link
    } catch (e) {
        console.warn('[Main] Failed to parse deep link:', e)
        return null
    }
}

// Hardware Acceleration: Enable by default for better UI performance. 
// If Linux users experience GL errors, they can use --disable-gpu flag.
// if (process.platform === 'linux') {
//     app.disableHardwareAcceleration()
// }

// Performance Optimization: Increase heap size and allow V8 to optimize for speed.
app.commandLine.appendSwitch('js-flags', '--expose_gc --max-old-space-size=4096')

// GPU Optimization: Enable GPU compositing for smooth animations.
// app.commandLine.appendSwitch('disable-gpu-compositing')       // Reduces GPU process memory ~50MB
app.commandLine.appendSwitch('disable-software-rasterizer')   // Prevent fallback software renderer
// app.commandLine.appendSwitch('in-process-gpu')                // Merge GPU into main process (~80MB saved)
app.commandLine.appendSwitch('disable-background-networking') // No idle network threads
app.commandLine.appendSwitch('disable-breakpad')              // No crash reporter memory overhead
app.commandLine.appendSwitch('disable-component-update')      // No background component updates
app.commandLine.appendSwitch('disable-domain-reliability')    // No domain reliability monitoring
app.commandLine.appendSwitch('disable-features', 'TranslateUI,BlinkGenPropertyTrees,AudioServiceOutOfProcess')
app.commandLine.appendSwitch('enable-features', 'CalculateNativeWinOcclusion') // Trim RS when occluded
app.commandLine.appendSwitch('force-color-profile', 'srgb')   // Simpler color management
// app.commandLine.appendSwitch('renderer-process-limit', '1')   // Only one renderer process
app.commandLine.appendSwitch('disable-renderer-backgrounding')// Stop renderer from going to background priority

// Directory constants (initialized after app is ready)
let MODELS_DIR: string
let RUNTIMES_DIR: string

// Initialize services (will be set after app is ready)
let runtimeManager: RuntimeManager
let EXTENSIONS_DIR: string

// Ensure models directory exists
function ensureModelsDir() {
    try {
        fs.mkdirSync(MODELS_DIR, { recursive: true })
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            console.error('[Main] Failed to ensure models dir:', err)
        }
    }
}

// Ensure runtimes directory exists
function ensureRuntimesDir() {
    try {
        fs.mkdirSync(RUNTIMES_DIR, { recursive: true })
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            console.error('[Main] Failed to ensure runtimes dir:', err)
        }
    }
}

// Ensure extensions directory exists
function ensureExtensionsDir() {
    try {
        fs.mkdirSync(EXTENSIONS_DIR, { recursive: true })
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            console.error('[Main] Failed to ensure extensions dir:', err)
        }
    }
}

// Register all IPC handlers
function registerAllHandlers() {
    // App info and hardware
    registerAppInfoHandlers(ipcMain, app, MODELS_DIR)

    // Performance Boot Time
    ipcMain.handle('performance:get-boot-time', () => {
        return Date.now() - APP_START_TIME
    })

    // Runtime management
    registerRuntimeHandlers(ipcMain, runtimeManager)

    // Terminal operations
    registerTerminalHandlers(
        ipcMain,
        () => mainWindow,
        () => currentWorkspacePath
    )

    // Git operations
    registerGitHandlers(ipcMain, () => currentWorkspacePath, () => app.getPath('userData'))

    // File system operations
    registerFileSystemHandlers(
        ipcMain,
        dialog,
        () => mainWindow,
        () => currentWorkspacePath,
        (path) => currentWorkspacePath = path,
        () => MODELS_DIR
    )

    // Code execution
    registerCodeExecutionHandlers(
        ipcMain,
        app,
        () => mainWindow,
        () => currentWorkspacePath
    )

    // Model downloads
    registerModelDownloadHandlers(
        ipcMain,
        () => mainWindow,
        () => MODELS_DIR
    )

    // LLM inference
    registerLLMInferenceHandlers(ipcMain, () => MODELS_DIR, () => mainWindow)

    // Secure storage for API keys
    registerSafeStorageHandlers(ipcMain, () => app.getPath('userData'))

    // Nuke Button (Emergency Process Cleanup)
    registerNukeHandlers()

    // Dependency management (npm, pip, cargo, etc.)
    registerDependencyHandlers(() => mainWindow)

    // Build/Task system
    setupBuildHandlers(ipcMain, () => mainWindow, () => currentWorkspacePath)

    // Debug system
    setupDebugHandlers(ipcMain, () => mainWindow, () => currentWorkspacePath)

    // Auto-update system
    registerUpdateHandlers(ipcMain, () => mainWindow)

    // Extension system
    registerExtensionHandlers()

    // Mobile bridge handlers
    registerMobileBridgeHandlers()

    // Window controls
    ipcMain.handle('minimize-window', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.minimize()
        }
    })

    ipcMain.handle('maximize-window', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMaximized()) {
                mainWindow.unmaximize()
            } else {
                mainWindow.maximize()
            }
        }
    })

    ipcMain.handle('close-window', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.close()
        }
    })
}

// Extension handlers
function registerExtensionHandlers() {
    // Extension host is already set up in extensionHostManager
    // Additional handlers for file operations
    ipcMain.handle('dialog:showOpenDialog', async (_, options) => {
        if (!mainWindow) return { canceled: true }
        return dialog.showOpenDialog(mainWindow, options)
    })
}

// Mobile bridge handlers
function registerMobileBridgeHandlers() {
    // Generate QR code for mobile pairing
    ipcMain.handle('mobile:generate-qr', async () => {
        if (!mobileBridge) {
            mobileBridge = await startMobileBridge(8443)
            initializeAgentBridge()
            console.log(`[Main] Mobile bridge started for pairing at ${mobileBridge.url}`)
        }
        // Get local IP for the QR code
        const localIp = getLocalIp()
        const { qrData } = generatePairingQR(localIp)
        return { qrData, localIp, port: mobileBridge.port }
    })

    // Get connected mobile devices
    ipcMain.handle('mobile:get-connected-devices', async () => {
        if (!mobileBridge) return []
        return mobileBridge.getConnectedDevices()
    })

    // Set GitHub token for mobile proxy
    ipcMain.handle('mobile:set-github-token', async (_, token: string) => {
        if (!mobileBridge) throw new Error('Mobile bridge not started')
        mobileBridge.setGitHubToken(token)
    })
}

// App lifecycle
// Register protocol client
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('kalynt', process.execPath, [path.resolve(process.argv[1])])
    }
} else {
    app.setAsDefaultProtocolClient('kalynt')
}

// Force Single Instance Application
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
    app.quit()
} else {
    app.on('second-instance', (_event, commandLine, _workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.focus()

            // Handle deep link on Windows/Linux
            const deepLink = commandLine.find((arg) => arg.startsWith('kalynt://'))
            if (deepLink) {
                const validatedLink = validateDeepLink(deepLink)
                if (validatedLink) {
                    mainWindow.webContents.send('deep-link', validatedLink)
                }
            }
        }
    })

    app.whenReady().then(() => {
        console.log('[Main] App ready, initializing...');
        // Initialize directory paths
        MODELS_DIR = path.join(app.getPath('userData'), 'models')
        RUNTIMES_DIR = path.join(app.getPath('userData'), 'runtimes')
        EXTENSIONS_DIR = path.join(app.getPath('userData'), 'extensions')

        console.log('[Main] Ensuring directories...');
        // Initialize services
        runtimeManager = new RuntimeManager(RUNTIMES_DIR)
        performanceAcceleration.init()

        ensureModelsDir()
        ensureRuntimesDir()
        ensureExtensionsDir()

        console.log('[Main] Registering handlers...');
        // Register handlers BEFORE creating window to ensure they are available
        registerAllHandlers()

        // Start built-in P2P signaling server (used by y-webrtc in the renderer)
        console.log('[Main] Starting built-in signaling server...');
        startSignalingServer(4444)
            .then(handle => {
                signalingServer = handle
                console.log(`[Main] Signaling server ready at ${handle.url}`)
            })
            .catch(err => {
                console.error('[Main] Failed to start signaling server:', err)
            })

        // The mobile bridge listens on the network, so it starts only when
        // someone pairs a phone (mobile:generate-qr), not on every launch.

        console.log('[Main] Creating window...');
        mainWindow = createAppWindow()
        mainWindow.on('closed', () => {
            mainWindow = null
        })

        // Initialize extension host
        console.log('[Main] Starting extension host...');
        extensionHostManager.start().catch(err => {
            console.error('[Main] Failed to start extension host:', err)
        })

        // Initialize auto-updater (after window is created)
        if (mainWindow) {
            console.log('[Main] Initializing auto-updater...');
            initializeAutoUpdater(mainWindow).catch(err => {
                console.error('[Main] Failed to initialize auto-updater:', err)
            })
        }
    })
}

// Handle deep link on macOS
app.on('open-url', (event, url) => {
    event.preventDefault()
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
        const validatedLink = validateDeepLink(url)
        if (validatedLink) {
            mainWindow.webContents.send('deep-link', validatedLink)
        }
    }
})

// Stop everything Kalynt started before quitting, so no shell, program or
// debugger is left running. Waits at most a few seconds.
let cleanedUp = false
app.on('before-quit', event => {
    if (signalingServer) {
        signalingServer.close()
        signalingServer = null
    }
    if (mobileBridge) {
        cleanupAgentBridge()
        mobileBridge.close()
        mobileBridge = null
    }
    if (cleanedUp) return
    cleanedUp = true
    // Installing an update must quit right away; stop processes without waiting.
    if (isInstallingUpdate()) {
        void stopEverything()
        return
    }
    event.preventDefault()
    const timeout = new Promise(resolve => setTimeout(resolve, 3000))
    Promise.race([
        Promise.all([stopEverything(), extensionHostManager.stop().catch(() => undefined)]),
        timeout
    ]).finally(() => app.quit())
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createAppWindow()
        mainWindow.on('closed', () => {
            mainWindow = null
        })
    }
})

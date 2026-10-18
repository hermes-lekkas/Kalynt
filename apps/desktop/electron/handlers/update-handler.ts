/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { autoUpdater } from 'electron-updater'
import { app } from 'electron'
import type { IpcMain, BrowserWindow } from 'electron'
import { sendToWindow } from '../utils/window'

/**
 * Secure Auto-Update Handler for Kalynt
 */

// Simple logger for electron-updater
const updateLogger = {
    info: (message: string) => console.log('[Update]', message),
    warn: (message: string) => console.warn('[Update]', message),
    error: (message: string) => console.error('[Update]', message),
    debug: (message: string) => console.log('[Update][Debug]', message)
}

interface UpdateInfo {
    version: string
    releaseNotes?: string
    releaseDate: string
    releaseName?: string
}

interface UpdateProgress {
    bytesPerSecond: number
    percent: number
    transferred: number
    total: number
}

let updateCheckInProgress = false
let downloadInProgress = false
let installing = false
/** Kept so every later check uses it; configuring without a token would drop it. */
let configuredToken: string | undefined

/** True once "Install and restart" was chosen; quitting must not be delayed then. */
export const isInstallingUpdate = () => installing

/** Release notes come as HTML text or as a list of per-version notes. */
function notesText(notes: unknown): string | undefined {
    if (typeof notes === 'string') return notes
    if (Array.isArray(notes)) {
        return notes.map(n => (n && typeof n === 'object' ? `${(n as { version?: string }).version ?? ''}\n${(n as { note?: string }).note ?? ''}` : String(n))).join('\n\n').trim() || undefined
    }
    return undefined
}

const describe = (info: { version: string; releaseNotes?: unknown; releaseDate?: string; releaseName?: string | null }) => ({
    version: info.version,
    releaseNotes: notesText(info.releaseNotes),
    releaseDate: info.releaseDate,
    releaseName: info.releaseName ?? undefined
})

/**
 * Configure auto-updater with security settings
 */
function configureAutoUpdater(githubToken: string | undefined = configuredToken) {
    configuredToken = githubToken
    // Enable logging
    autoUpdater.logger = updateLogger as any

    // Security: Only allow HTTPS
    // Allow update checks in development mode for testing
    // Unpackaged (development) builds check too, using the feed set below.
    autoUpdater.forceDevUpdateConfig = !app.isPackaged

    // Auto-download is disabled - user must explicitly approve
    autoUpdater.autoDownload = false

    // Auto-install is disabled - user must explicitly approve
    autoUpdater.autoInstallOnAppQuit = false

    // Get current version string
    const version = autoUpdater.currentVersion.version
    const isPrerelease = version.includes('-alpha') || version.includes('-beta') || version.includes('-rc')
    
    // Set update channel (latest, beta, alpha, etc.)
    const channel = process.env.UPDATE_CHANNEL || (isPrerelease ? 'beta' : 'latest')
    autoUpdater.channel = channel

    // Allow prerelease if channel is not 'latest' OR if current version is a prerelease
    autoUpdater.allowPrerelease = channel !== 'latest' || isPrerelease

    // Configure GitHub repository
    const owner = process.env.GITHUB_REPO_OWNER || 'Hermes-Lekkas'
    const repo = process.env.GITHUB_REPO_NAME || 'Kalynt'

    autoUpdater.setFeedURL({
        provider: 'github',
        owner,
        repo,
        private: false,
        token: githubToken || undefined
    })
    
    // Explicitly set the channel again on the updater instance
    autoUpdater.channel = channel
    // Setting a channel turns on allowDowngrade, which would offer older
    // releases (e.g. 1.0.5-beta to a 2.0.0 install) as "updates".
    autoUpdater.allowDowngrade = false

    console.log(`[Update] Configured for ${owner}/${repo}`)
    console.log(`[Update] Channel: ${autoUpdater.channel}, AllowPrerelease: ${autoUpdater.allowPrerelease}, Current Version: ${version}`)
}

/**
 * Register all update-related IPC handlers
 */
export function registerUpdateHandlers(
    ipcMain: IpcMain,
    getMainWindow: () => BrowserWindow | null
) {
    console.log('[Update] Registering update handlers...')

    // Configure auto-updater with default settings
    configureAutoUpdater()

    // Set up event listeners to forward to renderer
    setupAutoUpdaterEvents(getMainWindow)

    /**
     * Configure GitHub token for updates
     */
    ipcMain.handle('update:configure-token', async (_event, token: string) => {
        try {
            if (!token || token.trim() === '') {
                console.log('[Update] No token provided, using public access only')
                configureAutoUpdater(undefined)
                return { success: true, message: 'Using public access for updates' }
            }

            const trimmedToken = token.trim()
            const validTokenPatterns = [
                /^ghp_[a-zA-Z0-9]{36}$/,
                /^github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}$/,
                /^gho_[a-zA-Z0-9]{36}$/,
                /^ghu_[a-zA-Z0-9]{36}$/,
                /^ghs_[a-zA-Z0-9]{36}$/,
                /^[a-f0-9]{40}$/,
            ]

            const isValidFormat = validTokenPatterns.some(pattern => pattern.test(trimmedToken))
            if (!isValidFormat) {
                console.warn('[Update] Invalid token format provided')
                return {
                    success: false,
                    error: 'Invalid GitHub token format'
                }
            }

            configureAutoUpdater(trimmedToken)
            return { success: true, message: 'GitHub token configured successfully' }
        } catch (err) {
            const errorType = err instanceof Error ? err.name : 'Unknown'
            console.error('[Update] Token configuration failed:', errorType)
            return {
                success: false,
                error: 'Failed to configure GitHub token'
            }
        }
    })

    /**
     * Check for updates manually
     */
    ipcMain.handle('update:check', async () => {
        try {
            if (updateCheckInProgress) {
                return {
                    success: false,
                    error: 'Update check already in progress'
                }
            }

            updateCheckInProgress = true
            console.log('[Update] Checking for updates...')
            
            // Re-configure right before check to ensure settings are fresh
            configureAutoUpdater()

            const result = await autoUpdater.checkForUpdates()
            updateCheckInProgress = false

            if (!result) {
                return {
                    success: true,
                    updateAvailable: false,
                    currentVersion: autoUpdater.currentVersion.version,
                    message: 'No updates available or repository not found'
                }
            }

            const updateInfo: UpdateInfo = describe(result.updateInfo) as UpdateInfo

            console.log('[Update] Update check completed:', updateInfo.version, 'available:', result.isUpdateAvailable)

            return {
                success: true,
                // electron-updater compares versions properly (an older release is not an update).
                updateAvailable: result.isUpdateAvailable,
                updateInfo,
                currentVersion: autoUpdater.currentVersion.version
            }
        } catch (error) {
            updateCheckInProgress = false
            const errorMessage = error instanceof Error ? error.message : String(error)
            console.error('[Update] Check error:', errorMessage)
            console.error('[Update] Current state:', {
                channel: autoUpdater.channel,
                allowPrerelease: autoUpdater.allowPrerelease,
                currentVersion: autoUpdater.currentVersion.version
            })

            // Provide helpful error messages for common issues
            let userFriendlyError = errorMessage
            if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
                userFriendlyError = 'Update information not found on GitHub. This usually means the release is still being processed or the YAML configuration is missing.'
            } else if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
                userFriendlyError = 'GitHub token is invalid or expired.'
            } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('network')) {
                userFriendlyError = 'Network error. Please check your internet connection.'
            }

            return {
                success: false,
                error: userFriendlyError,
                currentVersion: autoUpdater.currentVersion?.version || 'unknown'
            }
        }
    })

    /**
     * Download update
     */
    ipcMain.handle('update:download', async () => {
        try {
            if (downloadInProgress) {
                return {
                    success: false,
                    error: 'Download already in progress'
                }
            }

            downloadInProgress = true
            console.log('[Update] Starting update download...')

            await autoUpdater.downloadUpdate()

            return { success: true }
        } catch (error) {
            downloadInProgress = false
            console.error('[Update] Download error:', error)
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            }
        }
    })

    /**
     * Install update and restart app
     */
    ipcMain.handle('update:install', async () => {
        try {
            console.log('[Update] Installing update and restarting...')

            installing = true
            setImmediate(() => {
                autoUpdater.quitAndInstall(false, true)
            })

            return { success: true }
        } catch (error) {
            console.error('[Update] Install error:', error)
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            }
        }
    })

    /**
     * Get current version
     */
    ipcMain.handle('update:get-version', () => {
        return {
            success: true,
            version: autoUpdater.currentVersion.version
        }
    })

    /**
     * Get update status
     */
    ipcMain.handle('update:get-status', () => {
        return {
            success: true,
            checking: updateCheckInProgress,
            downloading: downloadInProgress
        }
    })

    console.log('[Update] Update handlers registered successfully')
}

/**
 * Set up auto-updater event listeners and forward to renderer
 */
function setupAutoUpdaterEvents(getMainWindow: () => BrowserWindow | null) {
    const send = (channel: string, payload?: unknown) => sendToWindow(getMainWindow(), channel, payload)

    autoUpdater.on('checking-for-update', () => send('update:checking'))
    autoUpdater.on('update-available', info => {
        console.log('[Update] Update available:', info.version)
        send('update:available', describe(info))
    })
    autoUpdater.on('update-not-available', info => {
        updateCheckInProgress = false
        send('update:not-available', { version: info.version })
    })
    autoUpdater.on('download-progress', p => {
        const progress: UpdateProgress = { bytesPerSecond: p.bytesPerSecond, percent: p.percent, transferred: p.transferred, total: p.total }
        send('update:download-progress', progress)
    })
    autoUpdater.on('update-downloaded', info => {
        console.log('[Update] Update downloaded:', info.version)
        downloadInProgress = false
        send('update:downloaded', describe(info))
    })
    autoUpdater.on('error', error => {
        console.error('[Update] Error:', error)
        updateCheckInProgress = false
        downloadInProgress = false
        installing = false
        send('update:error', { message: error.message })
    })
}

/**
 * Initialize auto-update on app startup
 */
export async function initializeAutoUpdater(_mainWindow: BrowserWindow) {
    try {
        setTimeout(async () => {
            try {
                console.log('[Update] Performing automatic update check...')
                // Re-configure before automatic check
                configureAutoUpdater()
                await autoUpdater.checkForUpdates()
            } catch (error) {
                console.error('[Update] Automatic check failed:', error)
            }
        }, 5000)

        const checkInterval = Number.parseInt(process.env.UPDATE_CHECK_INTERVAL_MS || '3600000', 10)
        setInterval(async () => {
            try {
                if (!updateCheckInProgress && !downloadInProgress) {
                    console.log('[Update] Performing periodic update check...')
                    configureAutoUpdater()
                    await autoUpdater.checkForUpdates()
                }
            } catch (error) {
                console.error('[Update] Periodic check failed:', error)
            }
        }, checkInterval)

    } catch (error) {
        console.error('[Update] Initialization error:', error)
    }
}

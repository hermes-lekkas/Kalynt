/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Creating and configuring the main BrowserWindow: platform quirks, the
 * Content-Security-Policy applied to every response, and RAM-saving
 * lifecycle hooks.
 */
import { app, BrowserWindow, session } from 'electron'
import type { BrowserWindow as BrowserWindowType } from 'electron'
import path from 'node:path'

// VITE_DEV_SERVER_URL
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

// Window management
export function createAppWindow(): BrowserWindowType {
    const isLinux = process.platform === 'linux'

    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        frame: isLinux, // Enable frame on Linux for better compatibility
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        ...(process.platform === 'darwin' && { trafficLightPosition: { x: 16, y: 16 } }),
        icon: path.join(__dirname, VITE_DEV_SERVER_URL
            ? (isLinux ? '../public/Kalynt.png' : '../public/Kalynt_256x256.ico')
            : (isLinux ? '../dist/Kalynt.png' : '../dist/Kalynt_256x256.ico')),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,  // SECURITY FIX: Enable sandbox on all platforms for production security
            spellcheck: false,  // RAM: Saves ~20-30MB (no dictionary loaded)
            v8CacheOptions: 'bypassHeatCheck',  // RAM: Faster V8 code caching, less heap growth
            backgroundThrottling: true,  // RAM: Throttle timers/requestAnimationFrame when hidden
        },
        transparent: !isLinux, // Disable transparency on Linux to prevent crashes
        backgroundColor: isLinux ? '#1e1e1e' : '#00000000', // Use solid background on Linux
        show: false
    })

    // SECURITY FIX: Add Content Security Policy headers
    // HIGH-003: Strengthened CSP with additional directives
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [
                    "default-src 'self';" +
                    // Monaco and the bundler need eval; React DevTools runs on 8097 in development.
                    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:" + (VITE_DEV_SERVER_URL ? ' http://localhost:8097' : '') + ';' +
                    "style-src 'self' 'unsafe-inline';" +
                    "img-src 'self' data: blob: https:;" +
                    "font-src 'self' data:;" +
                    // Built-in signaling server, public signaling (wss) and cloud AI / GitHub / model APIs (https).
                    "connect-src 'self' ws://localhost:4444 wss: https:" + (VITE_DEV_SERVER_URL ? ' ws://localhost:* http://localhost:*' : '') + ';' +
                    "media-src 'self' blob:;" +
                    "worker-src 'self' blob:;" +
                    "object-src 'none';" +
                    "base-uri 'self';" +
                    "form-action 'self';" +
                    "frame-ancestors 'none';"
                ]
            }
        })
    })

    win.once('ready-to-show', () => {
        win.show()

        // RAM Optimization: Clear old Chromium session data on startup
        session.defaultSession.clearStorageData({
            storages: ['cachestorage', 'shadercache', 'serviceworkers'],
        }).catch(() => { /* ignore */ })
    })

    // RAM Optimization: Working set trimming on minimize/restore
    // When minimized, trigger aggressive GC + clear renderer back/forward cache
    win.on('minimize', () => {
        // Trigger GC in each renderer
        if (!win.isDestroyed()) {
            win.webContents.send('performance:request-gc')
        }
        // Trigger main process GC
        if (typeof globalThis.gc === 'function') {
            try { globalThis.gc() } catch { /* ignore */ }
        }
        // Clear Chromium back-forward cache to free page snapshots
        session.defaultSession.clearCache().catch(() => { /* ignore */ })
    })

    if (VITE_DEV_SERVER_URL) {
        void win.loadURL(VITE_DEV_SERVER_URL)
        // RAM: Only open DevTools if explicitly requested (saves ~50MB)
        if (process.argv.includes('--devtools')) {
            win.webContents.openDevTools()
        }
    } else {
        void win.loadFile(path.join(__dirname, '../dist/index.html'))
    }

    win.on('closed', () => {
        // The caller drops its reference to the window here.
    })

    return win
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Creating and configuring the main BrowserWindow: platform quirks, the
 * Content-Security-Policy applied to every response, and RAM-saving
 * lifecycle hooks.
 */
import { BrowserWindow, session } from 'electron'
import type { BrowserWindow as BrowserWindowType } from 'electron'
import path from 'node:path'
import { sendToWindow } from './utils/window'

// VITE_DEV_SERVER_URL
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

// Register the CSP header hook once on the default session (not per window).
let cspRegistered = false

function ensureCspHeaders() {
    if (cspRegistered) return
    cspRegistered = true

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
}

// Window management
export function createAppWindow(): BrowserWindowType {
    const isLinux = process.platform === 'linux'

    ensureCspHeaders()

    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        frame: isLinux, // Enable frame on Linux for better compatibility
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        ...(process.platform === 'darwin' && { trafficLightPosition: { x: 16, y: 14 } }),
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
        transparent: false,
        backgroundColor: '#17161d',
        show: false
    })

    const emitMaximized = () => {
        if (!win.isDestroyed()) {
            sendToWindow(win, 'window:maximized-changed', win.isMaximized())
        }
    }
    win.on('maximize', emitMaximized)
    win.on('unmaximize', emitMaximized)
    win.on('enter-full-screen', emitMaximized)
    win.on('leave-full-screen', emitMaximized)

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
        sendToWindow(win, 'performance:request-gc', undefined)
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

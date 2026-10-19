/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Choosing the default shell and assembling the environment (notably PATH)
 * that Kalynt terminals and tasks are spawned with.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { managedEnv, withManagedPath } from '../services/runtimes/manifest'

/** Picks a shell for a new terminal: the one Windows/Unix users expect, with fallbacks. */
export function getDefaultShell(): string {
    const platform = process.platform

    // Windows shell detection
    if (platform === 'win32') {
        const windowsShells = [
            process.env.COMSPEC, // Usually C:\Windows\System32\cmd.exe
            'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            'C:\\Windows\\System32\\cmd.exe',
            'C:\\Program Files\\PowerShell\\7\\pwsh.exe', // PowerShell 7
            'pwsh.exe', // PowerShell Core (if in PATH)
            'powershell.exe', // Windows PowerShell (if in PATH)
            'cmd.exe' // Fallback
        ]

        for (const shell of windowsShells) {
            if (!shell) continue

            // Check if it's a full path that exists
            if (shell.includes('\\') && fs.existsSync(shell)) {
                return shell
            }

            // If it's just a name (like 'powershell.exe'), return it
            // node-pty will search in PATH
            if (!shell.includes('\\')) {
                return shell
            }
        }

        return 'cmd.exe' // Ultimate fallback for Windows
    }

    // Unix/Linux/macOS shell detection
    const shells = [
        process.env.SHELL,
        '/bin/zsh',
        '/bin/bash',
        '/usr/bin/zsh',
        '/usr/bin/bash',
        '/usr/local/bin/zsh',
        '/usr/local/bin/bash',
        '/bin/sh'
    ]

    for (const shell of shells) {
        if (shell && fs.existsSync(shell)) {
            return shell
        }
    }

    return '/bin/sh'
}

/**
 * Builds the PATH terminals see. On Windows, Electron may not inherit the
 * user PATH fully when launched from shortcuts, so common install paths are
 * added explicitly; macOS gets Homebrew and the usual dev locations.
 */
export function buildEnhancedPath(): string {
    let enhancedPath = process.env.PATH || ''

    // PRIORITY: Add bundled bin directory
    const bundledBinPath = app.isPackaged
        ? path.join(process.resourcesPath, 'bin')
        : path.join(app.getAppPath(), 'bin')

    const pathSeparator = process.platform === 'win32' ? ';' : ':'
    if (fs.existsSync(bundledBinPath)) {
        enhancedPath = `${bundledBinPath}${pathSeparator}${enhancedPath}`
    }

    if (process.platform === 'win32') {
        const userProfile = process.env.USERPROFILE || 'C:\\Users\\Default'
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
        const localAppData = process.env.LOCALAPPDATA || `${userProfile}\\AppData\\Local`
        const appData = process.env.APPDATA || `${userProfile}\\AppData\\Roaming`

        // Common paths for user-installed development tools
        const additionalPaths = [
            // Python
            `${localAppData}\\Programs\\Python\\Python312`,
            `${localAppData}\\Programs\\Python\\Python312\\Scripts`,
            `${localAppData}\\Programs\\Python\\Python311`,
            `${localAppData}\\Programs\\Python\\Python311\\Scripts`,
            `${localAppData}\\Programs\\Python\\Python310`,
            `${localAppData}\\Programs\\Python\\Python310\\Scripts`,
            `${appData}\\Python\\Python312\\Scripts`,
            `${programFiles}\\Python312`,
            `${programFiles}\\Python311`,
            `${programFiles}\\Python310`,

            // Rust / Cargo
            `${userProfile}\\.cargo\\bin`,

            // Node.js / npm
            `${programFiles}\\nodejs`,
            `${appData}\\npm`,
            `${localAppData}\\fnm_multishells`,

            // Java
            `${programFiles}\\Java\\jdk-21\\bin`,
            `${programFiles}\\Eclipse Adoptium\\jdk-21\\bin`,
            `${programFiles}\\Microsoft\\jdk-17\\bin`,

            // Go
            `${userProfile}\\go\\bin`,
            `${programFiles}\\Go\\bin`,

            // Ruby
            `${programFiles}\\Ruby32-x64\\bin`,
            `${programFiles}\\Ruby31-x64\\bin`,

            // .NET
            `${programFiles}\\dotnet`,
            `${userProfile}\\.dotnet\\tools`,

            // Scoop
            `${userProfile}\\scoop\\shims`,

            // Chocolatey
            `${programFiles}\\chocolatey\\bin`,

            // Git
            `${programFiles}\\Git\\cmd`,
            `${programFiles}\\Git\\bin`,

            // Visual Studio Code
            `${localAppData}\\Programs\\Microsoft VS Code\\bin`,

            // Common local bin directories
            `${userProfile}\\.local\\bin`,
            `${userProfile}\\bin`
        ]

        for (const p of additionalPaths) {
            if (fs.existsSync(p) && !enhancedPath.toLowerCase().includes(p.toLowerCase())) {
                enhancedPath = `${p};${enhancedPath}`
            }
        }
    } else if (process.platform === 'darwin') {
        // macOS: Ensure Homebrew and common dev paths are included
        const homeDir = process.env.HOME || `/Users/${process.env.USER}`
        const macPaths = [
            '/opt/homebrew/bin',
            '/opt/homebrew/sbin',
            '/usr/local/bin',
            '/usr/local/sbin',
            `${homeDir}/.cargo/bin`,
            `${homeDir}/.local/bin`,
            `${homeDir}/go/bin`,
            '/Library/Apple/usr/bin'
        ]

        for (const p of macPaths) {
            if (fs.existsSync(p) && !enhancedPath.includes(p)) {
                enhancedPath = `${p}:${enhancedPath}`
            }
        }
    }

    return enhancedPath
}

/**
 * Resolves the shell, working directory and environment for a new terminal.
 * Falls back to the home directory when the requested cwd no longer exists.
 */
export function resolveSpawnTarget(options: {
    shell?: string
    cwd?: string
    workspacePath: string | null
    env?: { [key: string]: string }
    id: string
}): { shell: string; cwd: string; env: { [key: string]: string } } {
    let shell = options.shell?.trim() || ''
    if (!shell) {
        shell = getDefaultShell()
    }

    // Final validation - ensure we have a shell
    if (!shell) {
        shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    }

    console.log(`[Terminal] Using shell: ${shell}`)

    // Determine working directory
    const home = process.env.HOME || process.env.USERPROFILE || process.cwd()
    const wanted = options.cwd || options.workspacePath || home
    // A folder that was moved or deleted would make the shell fail to start.
    const cwd = fs.existsSync(wanted) && fs.statSync(wanted).isDirectory() ? wanted : home

    console.log(`[Terminal] Working directory: ${cwd}`)

    const env = {
        ...process.env,
        ...managedEnv(),
        ...options.env,
        PATH: withManagedPath(buildEnhancedPath()),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        KALYNT_TERMINAL: '1',
        KALYNT_TERMINAL_ID: options.id,
        LANG: process.platform === 'win32' ? 'en_US.UTF-8' : process.env.LANG || 'en_US.UTF-8'
    }

    return { shell, cwd, env }
}

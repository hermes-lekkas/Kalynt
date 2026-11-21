/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Default language-server and debug-adapter launch configurations.
 * Language servers and DAP adapters are expected to be installed on PATH
 * or registered explicitly via `configureLanguageServer` / `configureDebugAdapter`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { managedBinDirs } from '../services/runtimes/manifest'

const isWindows = process.platform === 'win32'
const isWindowsStoreStub = (p: string) => isWindows && /\\WindowsApps\\/i.test(p)

/**
 * Resolves a Python executable consistently across LSP, DAP, and code execution.
 * Checks: explicit preferred path -> workspace virtualenvs (.venv/venv) ->
 * active VIRTUAL_ENV -> Kalynt-managed runtimes -> PATH -> common install dirs.
 */
export async function resolvePythonExecutable(
    workspacePath?: string | null,
    preferred?: string | null
): Promise<string | null> {
    const isExecutable = async (p: string): Promise<boolean> => {
        if (!p || isWindowsStoreStub(p)) return false
        try {
            const stat = await fs.promises.stat(p)
            if (!stat.isFile()) return false
            if (!isWindows) {
                await fs.promises.access(p, fs.constants.X_OK)
            }
            return true
        } catch {
            return false
        }
    }

    const findOnPath = (name: string): string | null => {
        try {
            const out = execFileSync(isWindows ? 'where' : 'which', [name], {
                encoding: 'utf8',
                timeout: 2000,
                stdio: ['ignore', 'pipe', 'ignore']
            })
            const matches = out
                .split(/\r?\n/)
                .map(l => l.trim())
                .filter(p => p && !isWindowsStoreStub(p))
            return isWindows ? (matches.find(p => /\.(exe|cmd|bat|com)$/i.test(p)) ?? null) : (matches[0] ?? null)
        } catch {
            return null
        }
    }

    if (preferred && typeof preferred === 'string' && preferred.trim()) {
        const trimmed = preferred.trim()
        if (path.isAbsolute(trimmed) || trimmed.includes(path.sep) || trimmed.includes('/')) {
            const resolved = workspacePath && !path.isAbsolute(trimmed)
                ? path.resolve(workspacePath, trimmed)
                : trimmed
            if (await isExecutable(resolved)) return resolved
        } else {
            const found = findOnPath(trimmed)
            if (found) return found
        }
    }

    const venvCandidates = (rootDir: string): string[] => (
        isWindows
            ? [path.join(rootDir, 'Scripts', 'python.exe'), path.join(rootDir, 'python.exe')]
            : [path.join(rootDir, 'bin', 'python3'), path.join(rootDir, 'bin', 'python')]
    )

    if (workspacePath) {
        for (const venvDir of ['.venv', 'venv', '.virtualenv', 'env']) {
            for (const candidate of venvCandidates(path.join(workspacePath, venvDir))) {
                if (await isExecutable(candidate)) return candidate
            }
        }
    }

    if (process.env.VIRTUAL_ENV) {
        for (const candidate of venvCandidates(process.env.VIRTUAL_ENV)) {
            if (await isExecutable(candidate)) return candidate
        }
    }

    const names = isWindows ? ['python', 'python3', 'py'] : ['python3', 'python']

    // Check Kalynt-managed runtime bin directories first
    for (const dir of managedBinDirs()) {
        for (const name of names) {
            const candidates = isWindows ? [`${name}.exe`, `${name}.cmd`] : [name]
            for (const file of candidates) {
                const full = path.join(dir, file)
                if (await isExecutable(full)) return full
            }
        }
    }

    // Check PATH
    for (const name of names) {
        const found = findOnPath(name)
        if (found) return found
    }

    // Check common install directories
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const commonDirs = isWindows
        ? ['Python313', 'Python312', 'Python311'].map(v => path.join(home, 'AppData', 'Local', 'Programs', 'Python', v))
        : ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', path.join(home, '.local', 'bin'), path.join(home, '.pyenv', 'shims')]

    for (const dir of commonDirs) {
        for (const name of names) {
            const full = path.join(dir, isWindows ? `${name}.exe` : name)
            if (await isExecutable(full)) return full
        }
    }

    return null
}

export interface LanguageServerConfig {
    command: string
    args?: string[]
    runtime?: string
    env?: { [key: string]: string }
    initializationOptions?: object
}

export interface DebugAdapterConfig {
    type: string
    command: string
    args?: string[]
    runtime?: string
    env?: { [key: string]: string }
    configuration?: object
    transport: 'stdio' | 'socket'
}

const DEFAULT_PYTHON_COMMAND = process.platform === 'win32' ? 'python' : 'python3'

export const languageServerConfigurations: Record<string, LanguageServerConfig> = {
    python: {
        command: DEFAULT_PYTHON_COMMAND,
        args: ['-m', 'pylsp']
        // NOTE: Keep PYTHONPATH intact so virtualenvs resolve properly
    },
    javascript: {
        command: 'typescript-language-server',
        args: ['--stdio']
    },
    typescript: {
        command: 'typescript-language-server',
        args: ['--stdio']
    },
    rust: {
        command: 'rust-analyzer',
        args: []
    },
    go: {
        command: 'gopls',
        args: ['serve']
    },
    java: {
        command: 'jdtls',
        args: []
    },
    cpp: {
        command: 'clangd',
        args: ['--background-index']
    },
    csharp: {
        command: 'OmniSharp',
        args: ['--languageserver']
    },
    php: {
        command: 'intelephense',
        args: ['--stdio']
    },
    ruby: {
        command: 'solargraph',
        args: ['stdio']
    },
    kotlin: {
        command: 'kotlin-language-server',
        args: []
    },
    swift: {
        command: 'sourcekit-lsp',
        args: []
    },
    haskell: {
        command: 'haskell-language-server-wrapper',
        args: ['--lsp']
    },
    scala: {
        command: 'metals',
        args: []
    },
    dart: {
        command: 'dart',
        args: ['language-server']
    },
    elixir: {
        command: 'elixir-ls',
        args: []
    },
    clojure: {
        command: 'clojure-lsp',
        args: []
    },
    lua: {
        command: 'lua-language-server',
        args: []
    }
}

/**
 * Only real DAP-speaking adapters are registered by default.
 * Languages without a standard globally-installed DAP binary (e.g. Node, Java, PHP)
 * are handled by the IDE's dedicated debugger (`handlers/debug/**`) or can be
 * registered at runtime via `configureDebugAdapter()`.
 */
export const debugAdapterConfigurations: Record<string, DebugAdapterConfig> = {
    python: {
        type: 'python',
        command: DEFAULT_PYTHON_COMMAND,
        args: ['-m', 'debugpy', '--listen', '127.0.0.1:${port}', '--wait-for-client', '${program}'],
        transport: 'socket'
    },
    go: {
        type: 'go',
        command: 'dlv',
        args: ['dap', '--listen', '127.0.0.1:${port}'],
        transport: 'socket'
    },
    cpp: {
        type: 'cppdbg',
        command: 'lldb-dap',
        args: [],
        transport: 'stdio'
    },
    rust: {
        type: 'lldb',
        command: 'lldb-dap',
        args: [],
        transport: 'stdio'
    }
}

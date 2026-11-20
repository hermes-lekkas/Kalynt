/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Default language-server and debug-adapter launch configurations.
 * Language servers and DAP adapters are expected to be installed on PATH
 * or registered explicitly via `configureLanguageServer` / `configureDebugAdapter`.
 */

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

export const languageServerConfigurations: Record<string, LanguageServerConfig> = {
    python: {
        command: 'python',
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
        command: 'python',
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

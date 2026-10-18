/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Default language-server and debug-adapter launch configurations.
 * Language servers are expected to be installed globally / on PATH.
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
        // NOTE: Removed PYTHONPATH clearing - it breaks virtualenvs
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
        // NOTE: jdtls may require --data and --configuration args
        // User should configure via configureLanguageServer() if needed
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

export const debugAdapterConfigurations: Record<string, DebugAdapterConfig> = {
    // NOTE: Node.js debug config needs a proper DAP adapter
    // 'node' with --inspect-brk uses Chrome Inspector Protocol, NOT DAP
    // Use 'js-debug' or similar DAP adapter binary instead
    node: {
        type: 'node',
        command: 'js-debug',  // Placeholder - needs actual DAP adapter
        args: ['${program}'],
        transport: 'stdio'
    },
    python: {
        type: 'python',
        command: 'python',
        args: ['-m', 'debugpy', '--listen', '${port}', '--wait-for-client', '${program}'],
        transport: 'socket'
    },
    go: {
        type: 'go',
        command: 'dlv',
        args: ['dap', '--listen', '127.0.0.1:${port}'],
        transport: 'socket'
    },
    // NOTE: Java debug config needs a proper DAP adapter
    // 'java' with -agentlib:jdwp uses JDWP protocol, NOT DAP
    // Use 'java-debug-adapter' or similar DAP adapter binary instead
    java: {
        type: 'java',
        command: 'java-debug',  // Placeholder - needs actual DAP adapter
        args: ['--server', '--port', '${port}'],
        transport: 'socket'
    },
    cpp: {
        type: 'cppdbg',
        command: 'lldb-vscode',
        args: [],
        transport: 'stdio'
    },
    rust: {
        type: 'lldb',
        command: 'lldb-vscode',
        args: [],
        transport: 'stdio'
    },
    php: {
        type: 'php',
        command: 'php',
        args: ['-dxdebug.start_with_request=yes', '-S', 'localhost:0'],
        transport: 'socket'
    }
}

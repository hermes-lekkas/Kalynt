/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export interface DebugConfig {
    type: string
    request: 'launch' | 'attach'
    name: string
    program?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    mode?: string
    console?: string
    stopOnEntry?: boolean
    [key: string]: unknown
}

/** A launch configuration inferred from the file type, used when the folder has none. */
export function autoDebugConfig(filePath: string): DebugConfig {
    const ext = filePath.split('.').pop()?.toLowerCase()
    switch (ext) {
        case 'py':
            return { type: 'debugpy', request: 'launch', name: 'Python: current file', program: filePath, console: 'internalConsole' }
        case 'go':
            return { type: 'delve', request: 'launch', name: 'Go: debug package', mode: 'debug', program: '${workspaceFolder}' }
        case 'rs':
            return { type: 'lldb', request: 'launch', name: 'Rust: debug', program: filePath }
        case 'c':
        case 'cc':
        case 'cpp':
        case 'cxx':
            // The backend builds the source with debug information first.
            return { type: 'cppdbg', request: 'launch', name: 'C/C++: debug', program: filePath }
        case 'java':
            return { type: 'java', request: 'launch', name: 'Java: debug', mainClass: filePath }
        case 'ts':
        case 'tsx':
        case 'mts':
        case 'cts':
            return {
                type: 'node', request: 'launch', name: 'TypeScript: current file', program: filePath,
                runtimeArgs: ['-r', 'ts-node/register'], skipFiles: ['<node_internals>/**']
            }
        default:
            return { type: 'node', request: 'launch', name: 'Node.js: current file', program: filePath, skipFiles: ['<node_internals>/**'] }
    }
}

/** Groups adapter types by the language they debug, to match launch.json entries to a file. */
export function debugFamily(type: string): string {
    switch (type) {
        case 'debugpy':
        case 'python':
            return 'python'
        case 'node':
        case 'pwa-node':
        case 'node-terminal':
            return 'node'
        case 'delve':
        case 'go':
            return 'go'
        case 'lldb':
        case 'rust-lldb':
        case 'codelldb':
        case 'cppdbg':
        case 'gdb':
            return 'native'
        default:
            return type
    }
}

/** Short label for displaying a debug configuration in pickers. */
export function describeDebugConfig(config: DebugConfig): string {
    return `${config.name} (${config.type})`
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export interface DebugConfig {
    type: string
    request: 'launch'
    name: string
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
            // The backend builds the source with debug information first.
            return { type: 'cppdbg', request: 'launch', name: 'C/C++: debug', program: filePath }
        case 'java':
            return { type: 'java', request: 'launch', name: 'Java: debug', mainClass: filePath }
        case 'ts':
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
    const families: Record<string, string> = {
        debugpy: 'python', python: 'python',
        node: 'node', 'pwa-node': 'node', 'node-terminal': 'node',
        delve: 'go', go: 'go',
        lldb: 'native', 'rust-lldb': 'native', codelldb: 'native', cppdbg: 'native', gdb: 'native'
    }
    return families[type] ?? type
}

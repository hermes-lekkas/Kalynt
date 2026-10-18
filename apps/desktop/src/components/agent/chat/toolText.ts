/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Plain-language names for the agent's tools.
 */

const TOOL_TEXT: Record<string, string> = {
    readFile: 'Read a file',
    writeFile: 'Write a file',
    createFile: 'Create a file',
    delete: 'Delete a file',
    deleteFile: 'Delete a file',
    listDirectory: 'List a folder',
    searchFiles: 'Search files',
    searchInFiles: 'Search in files',
    replaceInFile: 'Edit a file',
    insertAtLine: 'Insert into a file',
    runCommand: 'Run a command',
    executeCode: 'Run code',
    gitStatus: 'Check git status',
    fileStats: 'Inspect a file',
    createFolder: 'Create a folder',
    renameFile: 'Rename a file'
}

export function describeTool(name: string): string {
    return TOOL_TEXT[name] ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase())
}

/** The most telling parameter of a tool call, for one-line summaries. */
export function toolTarget(params?: Record<string, unknown>): string | null {
    if (!params) return null
    for (const key of ['path', 'filePath', 'file', 'command', 'cmd', 'query', 'pattern', 'directory', 'dir']) {
        const value = params[key]
        if (typeof value === 'string' && value.trim()) return value.length > 80 ? `${value.slice(0, 77)}…` : value
    }
    return null
}

const RISKY = new Set(['delete', 'deleteFile', 'writeFile', 'runCommand', 'executeCode', 'replaceInFile', 'insertAtLine'])

export function isRiskyTool(name: string): boolean {
    return RISKY.has(name)
}

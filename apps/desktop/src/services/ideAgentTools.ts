/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * IDE Agent Tools - File system and code execution tools for AI agents
 * These tools allow AI agents to interact with the IDE's file system,
 * execute code, and perform other IDE operations.
 */

import { logger } from '../utils/logger'
import { validatePath } from '../utils/path-validator'
import { aimeService } from './aimeService'

export interface ToolResult {
    success: boolean
    data?: unknown
    error?: string
}

export interface ToolContext {
    workspacePath: string
}

export interface ToolCallRequest {
    id: string
    toolName: string
    params: Record<string, unknown>
    timestamp: number
}

// Tool Permission Middleware
class ToolPermissionManager {
    private readonly alwaysAllowedTools: Set<string> = new Set()
    private readOnlyAutoAllow: boolean = false
    private trustedMode: boolean = false
    private confirmationHandler: ((request: ToolCallRequest) => Promise<{ approved: boolean; alwaysAllow: boolean }>) | null = null

    setConfirmationHandler(handler: (request: ToolCallRequest) => Promise<{ approved: boolean; alwaysAllow: boolean }>) {
        this.confirmationHandler = handler
    }

    setReadOnlyAutoAllow(enabled: boolean) {
        this.readOnlyAutoAllow = enabled
    }

    /**
     * Enable trusted mode - automatically approve all tool calls
     * This gives the agent full IDE access like Cursor's agent
     */
    setTrustedMode(enabled: boolean) {
        this.trustedMode = enabled
        logger.agent.info(`Trusted mode ${enabled ? 'enabled' : 'disabled'}`)
    }

    isTrustedMode(): boolean {
        return this.trustedMode
    }

    isReadOnlyTool(toolName: string): boolean {
        return ['readFile', 'listDirectory', 'gitStatus', 'searchFiles', 'fileStats'].includes(toolName)
    }

    isDestructiveTool(toolName: string): boolean {
        return ['delete', 'writeFile', 'runCommand', 'executeCode', 'replaceInFile', 'insertAtLine'].includes(toolName)
    }

    async requestPermission(toolName: string, params: Record<string, unknown>): Promise<boolean> {
        // Trusted mode: auto-approve everything
        if (this.trustedMode) {
            logger.agent.debug('Auto-approved in trusted mode', { toolName })
            return true
        }

        // Check if always allowed
        if (this.alwaysAllowedTools.has(toolName)) {
            return true
        }

        // Auto-allow read-only tools if configured
        if (this.readOnlyAutoAllow && this.isReadOnlyTool(toolName)) {
            return true
        }

        // Request confirmation
        if (!this.confirmationHandler) {
            // No handler set, deny by default for safety
            logger.agent.warn('No confirmation handler set, denying tool call', { toolName })
            return false
        }

        const request: ToolCallRequest = {
            id: crypto.randomUUID(),
            toolName,
            params,
            timestamp: Date.now()
        }

        try {
            const result = await this.confirmationHandler(request)
            if (result.approved && result.alwaysAllow) {
                this.alwaysAllowedTools.add(toolName)
            }
            return result.approved
        } catch (err) {
            logger.agent.error('Confirmation error', { toolName, error: err })
            return false
        }
    }

    clearSession() {
        this.alwaysAllowedTools.clear()
    }

    getAlwaysAllowedTools(): string[] {
        return Array.from(this.alwaysAllowedTools)
    }
}

export const toolPermissionManager = new ToolPermissionManager()

// Track active tool execution for cancellation
let activeExecId: string | null = null

/**
 * Stop the currently running tool if it supports cancellation (e.g., code execution)
 */
export async function stopActiveTool(): Promise<boolean> {
    if (!activeExecId) return false

    try {
        ensureElectron()
        const result = await globalThis.window.electronAPI?.code.kill(activeExecId)
        if (result?.success) {
            logger.agent.info('Active tool execution stopped', { activeExecId })
            activeExecId = null
            return true
        }
        return false
    } catch (err) {
        logger.agent.error('Failed to stop active tool', { activeExecId, error: err })
        return false
    }
}

export interface Tool {
    name: string
    description: string
    parameters: {
        name: string
        type: 'string' | 'number' | 'boolean' | 'array'
        description: string
        required: boolean
    }[]
    execute: (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

// Helper to check environment
const ensureElectron = () => {
    if (!globalThis.window.electronAPI) {
        throw new Error('This tool is only available in the desktop application')
    }
}

// Read file tool
const readFileTool: Tool = {
    name: 'readFile',
    description: 'Read the contents of a file at the given path',
    parameters: [
        {
            name: 'path',
            type: 'string',
            description: 'Path to the file to read (relative if workspace is set, or absolute)',
            required: true
        }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const path = params.path as string
            if (!path) return { success: false, error: 'Path is required' }

            // SECURITY FIX: Validate path to prevent traversal attacks
            const validation = validatePath(path, context.workspacePath)
            if (!validation.valid) {
                logger.agent.warn('Path validation failed in readFile', { path, error: validation.error })
                return { success: false, error: validation.error || 'Invalid file path' }
            }

            const validatedPath = validation.normalizedPath!

            // BUG-046: Check file size before reading to prevent memory exhaustion
            const stats = await globalThis.window.electronAPI?.fs.stat(validatedPath)
            if (stats?.success) {
                // 50MB limit
                if (stats.size > 50 * 1024 * 1024) {
                    return { success: false, error: `File is too large to read (Size: ${(stats.size / 1024 / 1024).toFixed(2)}MB, Limit: 50MB)` }
                }
            }

            const result = await globalThis.window.electronAPI?.fs.readFile(validatedPath)
            if (result?.success) {
                // UI SIDE EFFECT: Open the file in the editor so user can see it
                window.dispatchEvent(new CustomEvent('kalynt-open-file', { detail: { path: validatedPath } }))
                return { success: true, data: result.content }
            }
            return { success: false, error: result?.error || 'Failed to read file' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// Write file tool
const writeFileTool: Tool = {
    name: 'writeFile',
    description: 'Write content to a file, creating it if it does not exist',
    parameters: [
        {
            name: 'path',
            type: 'string',
            description: 'Path to the file to write',
            required: true
        },
        {
            name: 'content',
            type: 'string',
            description: 'Content to write to the file',
            required: true
        }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const path = params.path as string
            const content = params.content as string
            if (!path) return { success: false, error: 'Path is required' }

            // SECURITY FIX: Validate path to prevent traversal attacks
            const validation = validatePath(path, context.workspacePath)
            if (!validation.valid) {
                logger.agent.warn('Path validation failed in writeFile', { path, error: validation.error })
                return { success: false, error: validation.error || 'Invalid file path' }
            }

            const validatedPath = validation.normalizedPath!

            const result = await globalThis.window.electronAPI?.fs.writeFile({ path: validatedPath, content: content || '' })
            if (result?.success) {
                // UI SIDE EFFECT: Focus the modified file
                window.dispatchEvent(new CustomEvent('kalynt-open-file', { detail: { path: validatedPath } }))
                return { success: true, data: { path: validatedPath, bytesWritten: content?.length || 0 } }
            }
            return { success: false, error: result?.error || 'Failed to write file' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// List directory tool
const listDirectoryTool: Tool = {
    name: 'listDirectory',
    description: 'List files and folders in a directory',
    parameters: [
        {
            name: 'path',
            type: 'string',
            description: 'Path to the directory',
            required: true
        },
        // BUG-047: Add pagination support
        {
            name: 'limit',
            type: 'number',
            description: 'Maximum number of items to return (default: 100)',
            required: false
        },
        {
            name: 'offset',
            type: 'number',
            description: 'Number of items to skip (default: 0)',
            required: false
        }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            let path = params.path as string
            if (!path) path = context.workspacePath || ''
            if (!path) return { success: false, error: 'Path is required' }

            // SECURITY FIX: Validate path to prevent traversal attacks
            const validation = validatePath(path, context.workspacePath)
            if (!validation.valid) {
                logger.agent.warn('Path validation failed in listDirectory', { path, error: validation.error })
                return { success: false, error: validation.error || 'Invalid directory path' }
            }

            const validatedPath = validation.normalizedPath!

            const limit = typeof params.limit === 'number' ? params.limit : 100
            const offset = typeof params.offset === 'number' ? params.offset : 0

            const result = await globalThis.window.electronAPI?.fs.readDir(validatedPath)
            if (result?.success && result.items) {
                const total = result.items.length
                const paginatedItems = result.items.slice(offset, offset + limit)

                // Capacity warning for very large directories
                if (total > 10000) {
                    logger.agent.warn('Very large directory detected', {
                        path: validatedPath,
                        total,
                        message: 'Consider refining your search or using more specific paths'
                    })
                }

                return {
                    success: true,
                    data: {
                        path: validatedPath,
                        items: paginatedItems,
                        total,
                        offset,
                        limit,
                        hasMore: offset + limit < total
                    }
                }
            }
            return { success: false, error: result?.error || 'Failed to read directory' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// Create file tool
const createFileTool: Tool = {
    name: 'createFile',
    description: 'Create a new empty file',
    parameters: [
        {
            name: 'path',
            type: 'string',
            description: 'Path for the new file',
            required: true
        }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const path = params.path as string
            if (!path) return { success: false, error: 'Path is required' }

            // SECURITY FIX: Validate path to prevent traversal attacks
            const validation = validatePath(path, context.workspacePath)
            if (!validation.valid) {
                logger.agent.warn('Path validation failed in createFile', { path, error: validation.error })
                return { success: false, error: validation.error || 'Invalid file path' }
            }

            const validatedPath = validation.normalizedPath!

            const result = await globalThis.window.electronAPI?.fs.createFile(validatedPath)
            if (result?.success) {
                return { success: true, data: { path: validatedPath } }
            }
            return { success: false, error: result?.error || 'Failed to create file' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// Create directory tool
const createDirectoryTool: Tool = {
    name: 'createDirectory',
    description: 'Create a new directory',
    parameters: [
        {
            name: 'path',
            type: 'string',
            description: 'Path for the new directory',
            required: true
        }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const path = params.path as string
            if (!path) return { success: false, error: 'Path is required' }

            // SECURITY FIX: Validate path to prevent traversal attacks
            const validation = validatePath(path, context.workspacePath)
            if (!validation.valid) {
                logger.agent.warn('Path validation failed in createDirectory', { path, error: validation.error })
                return { success: false, error: validation.error || 'Invalid directory path' }
            }

            const validatedPath = validation.normalizedPath!

            const result = await globalThis.window.electronAPI?.fs.createDir(validatedPath)
            if (result?.success) {
                return { success: true, data: { path: validatedPath } }
            }
            return { success: false, error: result?.error || 'Failed to create directory' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// Delete file/directory tool
const deleteTool: Tool = {
    name: 'delete',
    description: 'Delete a file or empty directory',
    parameters: [
        {
            name: 'path',
            type: 'string',
            description: 'Path to delete',
            required: true
        }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const path = params.path as string
            if (!path) return { success: false, error: 'Path is required' }

            // SECURITY FIX: Validate path to prevent traversal attacks
            const validation = validatePath(path, context.workspacePath)
            if (!validation.valid) {
                logger.agent.warn('Path validation failed in delete', { path, error: validation.error })
                return { success: false, error: validation.error || 'Invalid path' }
            }

            const validatedPath = validation.normalizedPath!

            const result = await globalThis.window.electronAPI?.fs.delete(validatedPath)
            if (result?.success) {
                return { success: true, data: { deleted: validatedPath } }
            }
            return { success: false, error: result?.error || 'Failed to delete' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// Execute code tool
const executeCodeTool: Tool = {
    name: 'executeCode',
    description: 'Execute an arbitrary code snippet (e.g., a script or test). To run an EXISTING file in the workspace, use "runFile" instead.',
    parameters: [
        {
            name: 'code',
            type: 'string',
            description: 'The code to execute',
            required: true
        },
        {
            name: 'language',
            type: 'string',
            description: 'Programming language: javascript, typescript, python, node, deno, bun, rust, go, java, dotnet, csharp, fsharp, ruby, php, gcc, cpp, c, kotlin, swift, scala, perl, lua, haskell, elixir, r, julia, dart, zig, clojure, groovy, ocaml, erlang, v, nim, html',
            required: true
        },
        {
            name: 'cwd',
            type: 'string',
            description: 'Working directory for execution',
            required: false
        }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const code = params.code as string
            const language = params.language as string
            let cwd = params.cwd as string | undefined

            if (!cwd && context.workspacePath) cwd = context.workspacePath
            if (!code) return { success: false, error: 'Code is required' }

            const supportedLanguages = [
                'javascript', 'typescript', 'python', 'node', 'deno', 'bun',
                'rust', 'go', 'java', 'dotnet', 'csharp', 'fsharp', 'ruby', 'php',
                'gcc', 'cpp', 'c', 'kotlin', 'swift', 'scala', 'perl', 'lua',
                'haskell', 'elixir', 'r', 'julia', 'dart', 'zig', 'clojure',
                'groovy', 'ocaml', 'erlang', 'v', 'nim', 'html'
            ]

            if (!supportedLanguages.includes(language.toLowerCase())) {
                return {
                    success: false,
                    error: `Unsupported language: ${language}. Supported languages: ${supportedLanguages.join(', ')}`
                }
            }

            const execId = `agent-exec-${Date.now()}`
            activeExecId = execId

            const result = await globalThis.window.electronAPI?.code.execute({ id: execId, code, language, cwd })

            if (activeExecId === execId) activeExecId = null

            if (result?.success) {
                return {
                    success: true,
                    data: {
                        stdout: result.stdout,
                        stderr: result.stderr,
                        exitCode: result.exitCode
                    }
                }
            }
            return { success: false, error: result?.error || 'Execution failed' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// Run existing file tool
const runFileTool: Tool = {
    name: 'runFile',
    description: 'Run an existing file in the workspace. Automatically detects language and executes it.',
    parameters: [
        {
            name: 'path',
            type: 'string',
            description: 'Path into the file to run',
            required: true
        }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const path = params.path as string
            if (!path) return { success: false, error: 'Path is required' }

            // SECURITY FIX: Validate path to prevent traversal attacks
            const validation = validatePath(path, context.workspacePath)
            if (!validation.valid) {
                logger.agent.warn('Path validation failed in runFile', { path, error: validation.error })
                return { success: false, error: validation.error || 'Invalid file path' }
            }

            const validatedPath = validation.normalizedPath!

            // Read file content
            const readResult = await globalThis.window.electronAPI?.fs.readFile(validatedPath)
            if (!readResult?.success) {
                return { success: false, error: readResult?.error || 'Failed to read file' }
            }

            const content = readResult.content as string
            if (!content) return { success: false, error: 'File is empty' }

            // Detect language
            const ext = validatedPath.split('.').pop()?.toLowerCase() || ''
            const langMap: Record<string, string> = {
                'js': 'javascript', 'jsx': 'javascript', 'ts': 'typescript', 'tsx': 'typescript',
                'py': 'python', 'pyw': 'python',
                'rs': 'rust',
                'go': 'go',
                'java': 'java',
                'c': 'c', 'h': 'c',
                'cpp': 'cpp', 'hpp': 'cpp', 'cc': 'cpp',
                'cs': 'csharp',
                'php': 'php',
                'rb': 'ruby',
                'sh': 'bash', 'bash': 'bash',
                'ps1': 'powershell'
            }

            const language = langMap[ext]
            if (!language) {
                return { success: false, error: `Unsupported file extension: .${ext}` }
            }

            const execId = `agent-run-file-${Date.now()}`
            const cwd = context.workspacePath
            activeExecId = execId

            // Run the file in place so its imports resolve.
            const result = await globalThis.window.electronAPI?.code.execute({ id: execId, filePath: validatedPath, code: content, language, cwd })

            if (activeExecId === execId) activeExecId = null

            if (result?.success) {
                // UI SIDE EFFECT: Ensure the bottom terminal/output tab is visible
                window.dispatchEvent(new CustomEvent('kalynt-show-output', { detail: { id: execId } }))
                
                return {
                    success: true,
                    data: {
                        stdout: result.stdout,
                        stderr: result.stderr,
                        exitCode: result.exitCode
                    }
                }
            }
            return { success: false, error: result?.error || 'Execution failed' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// Run generic command tool
const runCommandTool: Tool = {
    name: 'runCommand',
    description: 'Run a shell command (ALLOWED: npm, git, node, python, ls, dir, echo, cat, type)',
    parameters: [
        {
            name: 'command',
            type: 'string',
            description: 'The full command to run (e.g., "npm install")',
            required: true
        },
        {
            name: 'cwd',
            type: 'string',
            description: 'Working directory',
            required: false
        }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const command = params.command as string
            let cwd = params.cwd as string | undefined
            if (!cwd && context.workspacePath) cwd = context.workspacePath
            if (!cwd) return { success: false, error: 'Working directory is required' }
            if (!command) return { success: false, error: 'Command is required' }

            const execId = `agent-cmd-${Date.now()}`
            activeExecId = execId

            const result = await globalThis.window.electronAPI?.code.runCommand(cwd, command, execId)

            if (activeExecId === execId) activeExecId = null
            if (result?.success) {
                return { success: true, data: result.output }
            }
            return { success: false, error: result?.error || 'Command failed' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// Git status tool
const gitStatusTool: Tool = {
    name: 'gitStatus',
    description: 'Get the Git status of a repository',
    parameters: [
        {
            name: 'repoPath',
            type: 'string',
            description: 'Path to the Git repository',
            required: false
        }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            let repoPath = params.repoPath as string
            if (!repoPath) repoPath = context.workspacePath
            if (!repoPath) return { success: false, error: 'Repository path is required' }

            const result = await globalThis.window.electronAPI?.git.status(repoPath)
            if (result?.success) {
                return { success: true, data: result.status }
            }
            return { success: false, error: result?.error || 'Failed to get status' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// Search files tool (grep-like) - CROSS-PLATFORM using Node.js fs
const searchFilesTool: Tool = {
    name: 'searchFiles',
    description: 'Search for a pattern in files within a directory (like grep). Returns matching lines with file paths and line numbers. Works on Windows, macOS, and Linux.',
    parameters: [
        {
            name: 'pattern',
            type: 'string',
            description: 'Text pattern to search for (case-insensitive)',
            required: true
        },
        {
            name: 'path',
            type: 'string',
            description: 'Directory to search in (defaults to workspace)',
            required: false
        },
        {
            name: 'filePattern',
            type: 'string',
            description: 'Glob pattern to filter files (e.g., "*.ts", "*.py")',
            required: false
        }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const pattern = params.pattern as string
            const searchPath = params.path as string || context.workspacePath
            const filePattern = params.filePattern as string

            if (!pattern) return { success: false, error: 'Search pattern is required' }
            if (!searchPath) return { success: false, error: 'Search path is required' }

            // Use the cross-platform search IPC handler
            const result = await globalThis.window.electronAPI?.fs.search({
                searchPath: searchPath,
                pattern: pattern,
                filePattern: filePattern,
                maxResults: 100
            })

            if (result?.success) {
                return {
                    success: true,
                    data: {
                        matches: result.results || [],
                        truncated: result.truncated || false,
                        total: result.results?.length || 0
                    }
                }
            }
            
            return { success: false, error: result?.error || 'Search failed' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// Search Relevant Context tool (RAG)
const searchRelevantContextTool: Tool = {
    name: 'searchRelevantContext',
    description: 'Search the entire codebase for semantic context related to a query. Uses local indexing to find relevant files, functions, and classes.',
    parameters: [
        {
            name: 'query',
            type: 'string',
            description: 'The semantic query or symbol name to search for',
            required: true
        }
    ],
    execute: async (params, _context) => {
        try {
            const query = params.query as string
            if (!query) return { success: false, error: 'Query is required' }

            const context = await aimeService.retrieveContext(query)
            return { success: true, data: context }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// Get File Tree tool
const getFileTreeTool: Tool = {
    name: 'getFileTree',
    description: 'Get a recursive list of all files in the workspace (excluding node_modules, etc.). Use this for high-level structure exploration.',
    parameters: [
        {
            name: 'path',
            type: 'string',
            description: 'Starting directory (defaults to workspace root)',
            required: false
        },
        {
            name: 'depth',
            type: 'number',
            description: 'Maximum recursion depth (default: 3)',
            required: false,
        }
    ],
    execute: async (params, context) => {
        try {
            const startPath = params.path as string || context.workspacePath
            const maxDepth = (params.depth as number) || 3

            if (!globalThis.window.electronAPI) {
                throw new Error('This tool is only available in the desktop application')
            }

            const buildTree = async (currentPath: string, currentDepth: number): Promise<any> => {
                if (currentDepth > maxDepth) return null

                const res = await globalThis.window.electronAPI?.fs.readDir(currentPath)
                if (!res?.success || !res.items) return null

                const items = []
                const EXCLUDE = new Set(['node_modules', '.git', 'dist', 'build', '.next'])

                for (const item of res.items) {
                    if (EXCLUDE.has(item.name)) continue

                    const itemData: any = { name: item.name, isDirectory: item.isDirectory }
                    if (item.isDirectory && currentDepth < maxDepth) {
                        itemData.children = await buildTree(`${currentPath}/${item.name}`, currentDepth + 1)
                    }
                    items.push(itemData)
                }
                return items
            }

            const tree = await buildTree(startPath, 1)
            return { success: true, data: tree }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// Replace in file tool (find and replace)
const replaceInFileTool: Tool = {
    name: 'replaceInFile',
    description: 'Find and replace text in a file. Use this for precise edits instead of rewriting the whole file.',
    parameters: [
        {
            name: 'path',
            type: 'string',
            description: 'Path to the file to edit',
            required: true
        },
        {
            name: 'find',
            type: 'string',
            description: 'The exact text to find (will replace first occurrence)',
            required: true
        },
        {
            name: 'replace',
            type: 'string',
            description: 'The text to replace it with',
            required: true
        },
        {
            name: 'replaceAll',
            type: 'boolean',
            description: 'If true, replace all occurrences (default: false)',
            required: false
        }
    ],
    execute: async (params, _context) => {
        try {
            ensureElectron()
            const path = params.path as string
            const find = params.find as string
            const replace = params.replace as string
            const replaceAll = params.replaceAll as boolean || false

            if (!path) return { success: false, error: 'Path is required' }
            if (!find) return { success: false, error: 'Find text is required' }

            // Read the file first
            const readResult = await globalThis.window.electronAPI?.fs.readFile(path)
            if (!readResult?.success) {
                return { success: false, error: readResult?.error || 'Failed to read file' }
            }

            const content = readResult.content as string
            if (!content.includes(find)) {
                return { success: false, error: `Text "${find.substring(0, 50)}..." not found in file` }
            }

            // Perform replacement
            const newContent = replaceAll
                ? content.split(find).join(replace)
                : content.replace(find, replace)

            const replacements = replaceAll
                ? content.split(find).length - 1
                : 1

            // Write back
            const writeResult = await globalThis.window.electronAPI?.fs.writeFile({ path, content: newContent })
            if (writeResult?.success) {
                // UI SIDE EFFECT: Focus the modified file
                window.dispatchEvent(new CustomEvent('kalynt-open-file', { detail: { path } }))
                return {
                    success: true,
                    data: {
                        path,
                        replacements,
                        message: `Replaced ${replacements} occurrence(s)`
                    }
                }
            }
            return { success: false, error: writeResult?.error || 'Failed to write file' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// Insert at line tool
const insertAtLineTool: Tool = {
    name: 'insertAtLine',
    description: 'Insert content at a specific line number in a file',
    parameters: [
        {
            name: 'path',
            type: 'string',
            description: 'Path to the file',
            required: true
        },
        {
            name: 'line',
            type: 'number',
            description: 'Line number to insert at (1-indexed). Content is inserted BEFORE this line.',
            required: true
        },
        {
            name: 'content',
            type: 'string',
            description: 'Content to insert',
            required: true
        }
    ],
    execute: async (params, _context) => {
        try {
            ensureElectron()
            const path = params.path as string
            const line = params.line as number
            const insertContent = params.content as string

            if (!path) return { success: false, error: 'Path is required' }
            if (!line || line < 1) return { success: false, error: 'Valid line number is required (1-indexed)' }
            if (insertContent === undefined) return { success: false, error: 'Content is required' }

            // Read file
            const readResult = await globalThis.window.electronAPI?.fs.readFile(path)
            if (!readResult?.success) {
                return { success: false, error: readResult?.error || 'Failed to read file' }
            }

            const lines = (readResult.content as string).split('\n')
            const insertIndex = Math.min(line - 1, lines.length)

            // Insert the new content
            lines.splice(insertIndex, 0, insertContent)

            // Write back
            const writeResult = await globalThis.window.electronAPI?.fs.writeFile({ path, content: lines.join('\n') })
            if (writeResult?.success) {
                return {
                    success: true,
                    data: {
                        path,
                        insertedAtLine: insertIndex + 1,
                        newTotalLines: lines.length
                    }
                }
            }
            return { success: false, error: writeResult?.error || 'Failed to write file' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// File stats tool
const fileStatsTool: Tool = {
    name: 'fileStats',
    description: 'Get metadata about a file or directory (size, modified date, type)',
    parameters: [
        {
            name: 'path',
            type: 'string',
            description: 'Path to the file or directory',
            required: true
        }
    ],
    execute: async (params, _context) => {
        try {
            ensureElectron()
            const path = params.path as string
            if (!path) return { success: false, error: 'Path is required' }

            const result = await globalThis.window.electronAPI?.fs.stat(path)
            if (result?.success) {
                return {
                    success: true,
                    data: {
                        path,
                        size: result.size,
                        sizeHuman: result.size > 1024 * 1024
                            ? `${(result.size / 1024 / 1024).toFixed(2)} MB`
                            : result.size > 1024
                                ? `${(result.size / 1024).toFixed(2)} KB`
                                : `${result.size} bytes`,
                        isDirectory: result.isDirectory,
                        isFile: result.isFile,
                        modified: result.mtime,
                        created: result.birthtime
                    }
                }
            }
            return { success: false, error: result?.error || 'Failed to get file stats' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// ============================================================
// Fuzzy Search/Replace Tool (per research report Section 6)
// Uses content matching with whitespace normalization and
// Levenshtein distance for resilient code editing.
// ============================================================

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = []
    for (let i = 0; i <= b.length; i++) matrix[i] = [i]
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1]
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                )
            }
        }
    }
    return matrix[b.length][a.length]
}

/**
 * Find the best fuzzy match for a search block within file content.
 * Strategy order: exact → whitespace-normalized → sliding window Levenshtein.
 */
function fuzzyFind(
    fileContent: string,
    searchBlock: string,
    maxDistance: number = 0.15
): { start: number; end: number; distance: number } | null {
    const searchLines = searchBlock.split('\n')
    const fileLines = fileContent.split('\n')
    const searchLen = searchLines.length

    if (searchLen === 0 || fileLines.length === 0) return null

    // Strategy 1: Exact match
    const exactIdx = fileContent.indexOf(searchBlock)
    if (exactIdx !== -1) {
        return { start: exactIdx, end: exactIdx + searchBlock.length, distance: 0 }
    }

    // Strategy 2: Whitespace-normalized match
    const normalizeWS = (s: string) => s.split('\n').map(l => l.trim()).join('\n')
    const normFile = normalizeWS(fileContent)
    const normSearch = normalizeWS(searchBlock)
    const normIdx = normFile.indexOf(normSearch)

    if (normIdx !== -1) {
        // Map normalized position back to original using line counting
        const normLines = normFile.substring(0, normIdx).split('\n').length - 1
        const origLineStart = fileLines.slice(0, normLines).join('\n').length + (normLines > 0 ? 1 : 0)
        const origLineEnd = fileLines.slice(0, normLines + searchLen).join('\n').length
        return { start: origLineStart, end: origLineEnd, distance: 0 }
    }

    // Strategy 3: Sliding window with Levenshtein distance
    let bestMatch: { start: number; end: number; distance: number } | null = null
    let bestDist = Infinity

    for (let i = 0; i <= fileLines.length - searchLen; i++) {
        const window = fileLines.slice(i, i + searchLen).join('\n')
        const dist = levenshteinDistance(normalizeWS(window), normalizeWS(searchBlock))
        const relDist = dist / Math.max(searchBlock.length, 1)

        if (relDist < maxDistance && dist < bestDist) {
            bestDist = dist
            const startIdx = fileLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0)
            const endIdx = fileLines.slice(0, i + searchLen).join('\n').length
            bestMatch = { start: startIdx, end: endIdx, distance: relDist }
        }
    }

    return bestMatch
}

const fuzzyReplaceTool: Tool = {
    name: 'fuzzyReplace',
    description: 'Find and replace code using fuzzy matching. More resilient than replaceInFile - handles whitespace differences and minor typos. Provide the SEARCH block (code to find) and REPLACE block (new code).',
    parameters: [
        { name: 'path', type: 'string', description: 'Path to the file to edit', required: true },
        { name: 'search', type: 'string', description: 'The code block to find (fuzzy matched)', required: true },
        { name: 'replace', type: 'string', description: 'The code to replace it with', required: true }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const path = params.path as string
            const search = params.search as string
            const replace = params.replace as string

            if (!path) return { success: false, error: 'Path is required' }
            if (!search) return { success: false, error: 'Search block is required' }

            const validation = validatePath(path, context.workspacePath)
            if (!validation.valid) return { success: false, error: validation.error || 'Invalid path' }
            const validatedPath = validation.normalizedPath!

            const readResult = await globalThis.window.electronAPI?.fs.readFile(validatedPath)
            if (!readResult?.success) return { success: false, error: readResult?.error || 'Failed to read file' }

            const content = readResult.content as string
            const match = fuzzyFind(content, search)

            if (!match) {
                return {
                    success: false,
                    error: 'Could not find a matching code block. Try reading the file first with readFile to see exact content.'
                }
            }

            const newContent = content.substring(0, match.start) + replace + content.substring(match.end)
            const writeResult = await globalThis.window.electronAPI?.fs.writeFile({ path: validatedPath, content: newContent })

            if (writeResult?.success) {
                // UI SIDE EFFECT: Focus the modified file
                window.dispatchEvent(new CustomEvent('kalynt-open-file', { detail: { path: validatedPath } }))
                return {
                    success: true,
                    data: {
                        path: validatedPath,
                        matchDistance: match.distance,
                        matchType: match.distance === 0 ? 'exact' : 'fuzzy',
                        message: match.distance === 0
                            ? 'Exact match found and replaced'
                            : `Fuzzy match (${(match.distance * 100).toFixed(1)}% edit distance) replaced`
                    }
                }
            }
            return { success: false, error: writeResult?.error || 'Failed to write file' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// ============================================================
// Git Tools (diff, log, commit, add)
// ============================================================

const gitDiffTool: Tool = {
    name: 'gitDiff',
    description: 'Show git diff for the workspace (staged and unstaged changes)',
    parameters: [
        { name: 'staged', type: 'boolean', description: 'If true, show only staged changes (default: false)', required: false },
        { name: 'path', type: 'string', description: 'Specific file to diff (optional)', required: false }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const repoPath = context.workspacePath
            if (!repoPath) return { success: false, error: 'Workspace path required' }

            const staged = params.staged as boolean || false
            const filePath = params.path as string || ''
            const result = await globalThis.window.electronAPI?.git.diff({ repoPath, staged, file: filePath || undefined })
            if (result?.success) return { success: true, data: result.diff || '(no changes)' }
            return { success: false, error: result?.error || 'Git diff failed' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

const gitLogTool: Tool = {
    name: 'gitLog',
    description: 'Show recent git commit history',
    parameters: [
        { name: 'count', type: 'number', description: 'Number of commits to show (default: 10)', required: false }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const repoPath = context.workspacePath
            if (!repoPath) return { success: false, error: 'Workspace path required' }

            const count = (params.count as number) || 10
            const result = await globalThis.window.electronAPI?.git.log({ repoPath, maxCount: count })
            if (result?.success) return { success: true, data: result.log }
            return { success: false, error: result?.error || 'Git log failed' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

const gitAddTool: Tool = {
    name: 'gitAdd',
    description: 'Stage files for git commit',
    parameters: [
        { name: 'files', type: 'string', description: 'File paths to stage (comma-separated), or "." for all', required: true }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const repoPath = context.workspacePath
            if (!repoPath) return { success: false, error: 'Workspace path required' }

            const files = (params.files as string).split(',').map(f => f.trim())
            const result = await globalThis.window.electronAPI?.git.add({ repoPath, files })
            if (result?.success) return { success: true, data: { staged: files } }
            return { success: false, error: result?.error || 'Git add failed' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

const gitCommitTool: Tool = {
    name: 'gitCommit',
    description: 'Create a git commit with staged changes',
    parameters: [
        { name: 'message', type: 'string', description: 'Commit message', required: true }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const repoPath = context.workspacePath
            if (!repoPath) return { success: false, error: 'Workspace path required' }

            const message = params.message as string
            if (!message) return { success: false, error: 'Commit message required' }

            const result = await globalThis.window.electronAPI?.git.commit({ repoPath, message })
            if (result?.success) return { success: true, data: { message, hash: result.hash } }
            return { success: false, error: result?.error || 'Git commit failed' }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// ============================================================
// Diagnostics Tool
// ============================================================

const getDiagnosticsTool: Tool = {
    name: 'getDiagnostics',
    description: 'Check a file for syntax/type errors by running a quick lint. Useful for verifying code after modifications.',
    parameters: [
        { name: 'path', type: 'string', description: 'Path to the file to check', required: true }
    ],
    execute: async (params, context) => {
        try {
            ensureElectron()
            const path = params.path as string
            if (!path) return { success: false, error: 'Path is required' }

            const validation = validatePath(path, context.workspacePath)
            if (!validation.valid) return { success: false, error: validation.error || 'Invalid path' }

            const ext = path.split('.').pop()?.toLowerCase() || ''
            const cwd = context.workspacePath

            let command = ''
            if (['ts', 'tsx'].includes(ext)) {
                command = `npx tsc --noEmit --pretty "${validation.normalizedPath}" 2>&1`
            } else if (['js', 'jsx'].includes(ext)) {
                command = `node --check "${validation.normalizedPath}" 2>&1`
            } else if (ext === 'py') {
                command = `python -m py_compile "${validation.normalizedPath}" 2>&1`
            } else {
                return { success: true, data: { message: 'No diagnostic tool for this file type', errors: [] } }
            }

            const result = await globalThis.window.electronAPI?.code.runCommand(cwd, command)
            const output = result?.output || result?.error || ''
            const hasErrors = output.includes('error') || output.includes('Error') || (result?.exitCode && result.exitCode !== 0)

            return {
                success: true,
                data: {
                    hasErrors,
                    output: output.slice(0, 2000),
                    message: hasErrors ? 'Errors found' : 'No errors detected'
                }
            }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }
}

// All available tools
export const ideTools: Tool[] = [
    readFileTool,
    writeFileTool,
    listDirectoryTool,
    createFileTool,
    createDirectoryTool,
    deleteTool,
    executeCodeTool,
    runCommandTool,
    runFileTool,
    gitStatusTool,
    searchFilesTool,
    searchRelevantContextTool,
    getFileTreeTool,
    replaceInFileTool,
    fuzzyReplaceTool,
    insertAtLineTool,
    fileStatsTool,
    gitDiffTool,
    gitLogTool,
    gitAddTool,
    gitCommitTool,
    getDiagnosticsTool
]

// Get tool by name
export function getTool(name: string): Tool | undefined {
    return ideTools.find(t => t.name === name)
}

/**
 * Normalize tool parameters to handle common LLM naming mistakes.
 * LLMs often use synonyms for parameter names - this maps them to the correct ones.
 */
function normalizeParams(toolName: string, params: Record<string, unknown>): Record<string, unknown> {
    const normalized = { ...params }

    // Common parameter name mappings (LLM mistake → correct name)
    const paramMappings: Record<string, Record<string, string>> = {
        replaceInFile: {
            'search': 'find',
            'pattern': 'find',
            'searchText': 'find',
            'findText': 'find',
            'oldText': 'find',
            'old': 'find',
            'newText': 'replace',
            'new': 'replace',
            'replacement': 'replace',
            'text': 'replace',
            'all': 'replaceAll',
            'global': 'replaceAll',
            'replaceAllOccurrences': 'replaceAll',
        },
        readFile: {
            'filePath': 'path',
            'file': 'path',
            'filename': 'path',
        },
        writeFile: {
            'filePath': 'path',
            'file': 'path',
            'filename': 'path',
            'text': 'content',
            'data': 'content',
        },
        listDirectory: {
            'directory': 'path',
            'dir': 'path',
            'folder': 'path',
        },
        createFile: {
            'filePath': 'path',
            'file': 'path',
            'filename': 'path',
            'name': 'path',
        },
        createDirectory: {
            'directory': 'path',
            'dir': 'path',
            'folder': 'path',
            'name': 'path',
        },
        delete: {
            'filePath': 'path',
            'file': 'path',
            'target': 'path',
        },
        executeCode: {
            'lang': 'language',
            'runtime': 'language',
            'script': 'code',
            'source': 'code',
            'workingDirectory': 'cwd',
            'workDir': 'cwd',
        },
        runFile: {
            'file': 'path',
            'filename': 'path',
            'filePath': 'path',
        },
        runCommand: {
            'cmd': 'command',
            'shell': 'command',
            'workingDirectory': 'cwd',
            'workDir': 'cwd',
        },
        gitStatus: {
            'path': 'repoPath',
            'repository': 'repoPath',
            'repo': 'repoPath',
        },
        searchFiles: {
            'query': 'pattern',
            'search': 'pattern',
            'text': 'pattern',
            'regex': 'pattern',
            'glob': 'filePattern',
            'filter': 'filePattern',
        },
        insertAtLine: {
            'lineNumber': 'line',
            'at': 'line',
            'text': 'content',
            'insert': 'content',
            'filePath': 'path',
        },
        fileStats: {
            'filePath': 'path',
            'file': 'path',
        },
        fuzzyReplace: {
            'find': 'search',
            'searchBlock': 'search',
            'searchText': 'search',
            'old': 'search',
            'oldText': 'search',
            'replaceBlock': 'replace',
            'replaceText': 'replace',
            'new': 'replace',
            'newText': 'replace',
            'filePath': 'path',
            'file': 'path',
        },
        gitDiff: {
            'onlyStaged': 'staged',
            'cachedOnly': 'staged',
            'filePath': 'path',
            'file': 'path',
        },
        gitLog: {
            'limit': 'count',
            'max': 'count',
            'n': 'count',
        },
        gitAdd: {
            'paths': 'files',
            'filePaths': 'files',
            'file': 'files',
        },
        gitCommit: {
            'msg': 'message',
            'commitMessage': 'message',
        },
        getDiagnostics: {
            'filePath': 'path',
            'file': 'path',
        },
    }

    const mappings = paramMappings[toolName]
    if (mappings) {
        for (const [wrongName, correctName] of Object.entries(mappings)) {
            if (wrongName in normalized && !(correctName in normalized)) {
                normalized[correctName] = normalized[wrongName]
                delete normalized[wrongName]
                logger.agent.debug(`Normalized param: ${wrongName} → ${correctName}`, { toolName })
            }
        }
    }

    return normalized
}

// Execute a tool by name (with permission check and parameter normalization)
export async function executeTool(name: string, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = getTool(name)
    if (!tool) {
        // Try to find similar tool name (common typos)
        const similarTool = ideTools.find(t =>
            t.name.toLowerCase() === name.toLowerCase() ||
            t.name.toLowerCase().includes(name.toLowerCase()) ||
            name.toLowerCase().includes(t.name.toLowerCase())
        )
        if (similarTool) {
            return { success: false, error: `Tool not found: "${name}". Did you mean "${similarTool.name}"?` }
        }
        return { success: false, error: `Tool not found: ${name}. Available tools: ${ideTools.map(t => t.name).join(', ')}` }
    }

    // Normalize parameters to handle common LLM mistakes
    const normalizedParams = normalizeParams(name, params)

    // Validate required parameters
    const missingParams = tool.parameters
        .filter(p => p.required && !(p.name in normalizedParams))
        .map(p => p.name)

    if (missingParams.length > 0) {
        return {
            success: false,
            error: `Missing required parameters for "${name}": ${missingParams.join(', ')}. Expected: ${tool.parameters.filter(p => p.required).map(p => p.name).join(', ')}`
        }
    }

    // Check permission before executing
    const permitted = await toolPermissionManager.requestPermission(name, normalizedParams)
    if (!permitted) {
        return { success: false, error: `Permission denied: User rejected tool "${name}"` }
    }

    return tool.execute(normalizedParams, context)
}

// Format tools for AI prompt (OpenAI function calling format)
export function getToolsForPrompt(): object[] {
    return ideTools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: {
                type: 'object',
                properties: Object.fromEntries(
                    tool.parameters.map(p => [
                        p.name,
                        { type: p.type, description: p.description }
                    ])
                ),
                required: tool.parameters.filter(p => p.required).map(p => p.name)
            }
        }
    }))
}

// Format tools description for system prompt
export function getToolsDescription(): string {
    return ideTools.map(tool => {
        const params = tool.parameters.map(p =>
            `  - ${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`
        ).join('\n')
        return `${tool.name}: ${tool.description}\nParameters:\n${params}`
    }).join('\n\n')
}

/**
 * Generate JSON Schema for grammar-based sampling
 * This enforces 100% valid tool call JSON at the token level
 * Used with LlamaJsonSchemaGrammar for Cursor-like reliability
 */
export function getToolCallJsonSchema(): object {
    // Build properties for each tool's parameters
    const toolDefinitions: Record<string, any> = {}

    for (const tool of ideTools) {
        const properties: Record<string, any> = {}
        const required: string[] = []

        for (const param of tool.parameters) {
            // Map our parameter types to JSON Schema types
            let jsonType: string
            switch (param.type) {
                case 'string':
                    jsonType = 'string'
                    break
                case 'number':
                    jsonType = 'number'
                    break
                case 'boolean':
                    jsonType = 'boolean'
                    break
                case 'array':
                    jsonType = 'array'
                    break
                default:
                    jsonType = 'string'
            }

            properties[param.name] = {
                type: jsonType,
                description: param.description
            }

            if (param.required) {
                required.push(param.name)
            }
        }

        toolDefinitions[tool.name] = {
            type: 'object',
            description: tool.description,
            properties,
            required,
            additionalProperties: false
        }
    }

    // Main schema: union of all possible tool calls
    return {
        type: 'object',
        properties: {
            thought: {
                type: 'string',
                description: 'Brief reasoning about why this tool is needed (optional)'
            },
            name: {
                type: 'string',
                enum: ideTools.map(t => t.name),
                description: 'The name of the tool to call'
            },
            params: {
                type: 'object',
                description: 'Parameters for the tool call'
            }
        },
        required: ['name', 'params'],  // thought is optional
        additionalProperties: false,
        // Add tool definitions as definitions for reference
        definitions: toolDefinitions
    }
}

/**
 * Generate a system prompt that TEACHES the LLM how to call tools.
 * This is critical - small models need explicit format instructions.
 * 
 * @param workspacePath - Current workspace directory
 * @param compact - If true, use minimal prompt for very limited context models
 */
export function getToolSystemPrompt(workspacePath: string, compact: boolean = false): string {
    const toolNames = ideTools.map(t => t.name).join(', ')

    if (compact) {
        // Ultra-compact version for small models (highly aggressive on JSON-only format)
        return `You are Kalynt.

IF ACTION (files, code, terminal):
- Respond ONLY with JSON: {"name": "TOOL_NAME", "params": {...}}
- NO text, NO explanation, NO chat.

IF CHAT:
- Respond normally.

CRITICAL RULES:
- NEVER truncate code. Execute EXACTLY as requested.
- Python: Only use "import unittest" for unit tests. NEVER for normal scripts.
- Python unit test: End with "if __name__ == '__main__': unittest.main()". Do NOT wrap in a function.
- Multiline code: Use \\n for newlines.
- RUNNING FILES: If the user asks to run an existing file (e.g., "run main.py"), use "runFile", NOT "executeCode".

Tools: ${toolNames}

Examples:
User: "read file.txt" → {"name": "readFile", "params": {"path": "file.txt"}}
User: "run code" → {"name": "executeCode", "params": {"language": "python", "code": "print('ok')"}}`
    }

    // Full version with detailed tool descriptions for larger models
    return `You are Kalynt, an AI coding assistant with file system access.

WORKSPACE: ${workspacePath || 'Not set'}

## IMPORTANT RULES (READ CAREFULLY)
1. NEVER truncate, simplify, or summarize code for execution. Execute EXACTLY what is provided.
2. ALWAYS include all necessary imports (e.g., "import unittest", "import os") at the top of any script you generate.
3. Python unittest: IF AND ONLY IF writing a unit test, include "import unittest" and end with "if __name__ == '__main__': unittest.main()". NEVER wrap unit tests in a custom function like "test_main()".
4. For regular Python scripts (NOT tests), do NOT include the unittest boilerplate.
5. When an action is requested, respond with ONLY the JSON tool call - no other text.
6. After a tool executes, I'll give you the result - then summarize what happened.
7. Use relative paths when inside the workspace.
8. To modify a file, first use readFile to get contents, then writeFile with changes.
9. For multi-line code, use \\n for newlines (e.g., "line1\\nline2\\nline3").
10. RUNNING FILES: If the user asks to run a file that already exists in the workspace (e.g., "run test.py"), ALWAYS use the "runFile" tool. Do NOT use "executeCode" to re-write the file content.

## TOOL CALLING FORMAT
When you need to perform an action (read files, list directories, run commands, etc.), respond with ONLY a JSON object:

{"name": "TOOL_NAME", "params": {"param1": "value1", "param2": "value2"}}

## AVAILABLE TOOLS
${ideTools.map(tool => {
        const params = tool.parameters.map(p => `  - ${p.name} (${p.type}${p.required ? ', REQUIRED' : ''}): ${p.description}`).join('\n')
        return `### ${tool.name}
${tool.description}
Parameters:
${params}`
    }).join('\n\n')}

## EXAMPLES

User: "What files are in the src folder?"
Assistant: {"name": "listDirectory", "params": {"path": "src"}}

User: "Show me the contents of README.md"
Assistant: {"name": "readFile", "params": {"path": "README.md"}}

User: "Run npm install"
Assistant: {"name": "runCommand", "params": {"command": "npm install"}}

User: "Create a new file called utils.ts"
Assistant: {"name": "createFile", "params": {"path": "utils.ts"}}

User: "Run this Python code to print numbers"
Assistant: {"name": "executeCode", "params": {"language": "python", "code": "for i in range(5):\\n    print(i)"}}

User: "Run main.py"
Assistant: {"name": "runFile", "params": {"path": "main.py"}}

User: "Execute this Rust code"
Assistant: {"name": "executeCode", "params": {"language": "rust", "code": "fn main() {\\n    println!(\\"Hello from Rust!\\");\\n}"}}`
}

/**
 * Simplified JSON schema for small models (under 7B parameters).
 * Removes complex nesting and uses simpler structure.
 */
export function getSimplifiedToolSchema(): object {
    return {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                enum: ideTools.map(t => t.name)
            },
            params: {
                type: 'object'
            }
        },
        required: ['name', 'params']
    }
}

/**
 * Detect model size category based on model ID.
 * Used to choose appropriate prompt/schema complexity.
 */
export function getModelSizeCategory(modelId: string): 'small' | 'medium' | 'large' {
    const lower = modelId.toLowerCase()

    // Check for size indicators in model name
    if (/1\.5b|1b|0\.5b|500m|tiny|mini/.test(lower)) return 'small'
    if (/3b|4b|7b|8b/.test(lower)) return 'medium'
    if (/13b|14b|32b|70b|72b|large|xl/.test(lower)) return 'large'

    // Default to medium if unknown
    return 'medium'
}

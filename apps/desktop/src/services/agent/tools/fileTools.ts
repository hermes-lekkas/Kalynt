/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Read-only file tools: read, list, find by name, search contents.
 */
import { cleanError, fail, type AgentTool } from './types'
import { relativePath, resolvePath } from './paths'

const MAX_READ_LINES = 2000
const MAX_LINE_CHARS = 2000

const api = () => {
    const electron = window.electronAPI
    if (!electron?.fs) throw new Error('File tools need the desktop app.')
    return electron
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
const int = (v: unknown, fallback: number) => {
    const n = typeof v === 'number' ? v : parseInt(str(v), 10)
    return Number.isFinite(n) ? Math.trunc(n) : fallback
}

export const readFileTool: AgentTool = {
    name: 'read_file',
    kind: 'read',
    description: 'Read a text file. Returns numbered lines (up to 2000 per call). For large files, pass offset (1-based line to start from) and limit to read a section. Always read a file before editing it.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'File path, relative to the workspace or absolute.' },
            offset: { type: 'integer', description: 'First line to read (1-based). Default 1.' },
            limit: { type: 'integer', description: 'Number of lines to read. Default 2000.' }
        },
        required: ['path']
    },
    title: (args, ws) => `Read ${relativePath(ws, resolvePath(ws, args.path))}`,
    async execute(args, ctx) {
        const path = resolvePath(ctx.workspace, args.path)
        const result = await api().fs.readFile(path)
        if (!result?.success) return fail(cleanError(result?.error ?? 'Could not read the file.'))
        const content = String(result.content ?? '')
        if (content.includes('\u0000')) return fail('This looks like a binary file, which can\'t be read as text.')
        ctx.knownFiles.add(path)
        const lines = content.split(/\r?\n/)
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
        const start = Math.max(1, int(args.offset, 1))
        const count = Math.min(Math.max(1, int(args.limit, MAX_READ_LINES)), MAX_READ_LINES)
        const end = Math.min(lines.length, start + count - 1)
        if (lines.length === 0) {
            return { content: '(empty file)', display: { type: 'file', path: relativePath(ctx.workspace, path), startLine: 0, endLine: 0, totalLines: 0 } }
        }
        if (start > lines.length) return fail(`The file has only ${lines.length} lines.`)
        const width = String(end).length
        const body = lines.slice(start - 1, end)
            .map((line, i) => `${String(start + i).padStart(width)}\t${line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '… (line truncated)' : line}`)
            .join('\n')
        const more = end < lines.length ? `\n\n(${lines.length - end} more lines; read again with offset ${end + 1} to continue.)` : ''
        return {
            content: body + more,
            display: { type: 'file', path: relativePath(ctx.workspace, path), startLine: start, endLine: end, totalLines: lines.length }
        }
    }
}

export const listDirectoryTool: AgentTool = {
    name: 'list_directory',
    kind: 'read',
    description: 'List the files and folders in a folder (not recursive). Folders end with "/". Use find_files to search by name across the whole project.',
    parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Folder path. Default: the workspace root.' } }
    },
    title: (args, ws) => {
        const rel = relativePath(ws, resolvePath(ws, args.path || '.'))
        return rel === '.' ? 'List the project folder' : `List ${rel}`
    },
    async execute(args, ctx) {
        const path = resolvePath(ctx.workspace, args.path || '.')
        const result = await api().fs.readDir(path)
        if (!result?.success) return fail(cleanError(result?.error ?? 'Could not list the folder.'))
        const items = (result.items ?? []) as Array<{ name: string; isDirectory: boolean; size?: number }>
        items.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
        const lines = items.map(i => i.isDirectory ? `${i.name}/` : `${i.name}${i.size !== undefined ? `  (${formatSize(i.size)})` : ''}`)
        return {
            content: lines.length ? lines.join('\n') : '(empty folder)',
            display: { type: 'files', items: items.map(i => i.isDirectory ? `${i.name}/` : i.name), total: items.length, truncated: false }
        }
    }
}

export const findFilesTool: AgentTool = {
    name: 'find_files',
    kind: 'search',
    description: 'Find files by glob pattern, e.g. "**/*.ts", "src/**/test_*.py" or "*.{json,yml}". Respects .gitignore in git repositories. Results are sorted by most recently modified.',
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'Glob pattern.' },
            path: { type: 'string', description: 'Folder to search in. Default: the workspace root.' }
        },
        required: ['pattern']
    },
    title: args => `Find ${str(args.pattern)}`,
    async execute(args, ctx) {
        if (!ctx.workspace) return fail('Open a folder first.')
        const result = await api().agent.glob({ pattern: str(args.pattern), path: args.path ? resolvePath(ctx.workspace, args.path) : undefined, limit: 200 })
        if (!result?.ok) return fail(cleanError(result?.error ?? 'Search failed.'))
        const files = result.files ?? []
        const note = result.truncated ? `\n\n(showing ${files.length} of ${result.total}; narrow the pattern to see more)` : ''
        return {
            content: files.length ? files.join('\n') + note : 'No files match.',
            display: { type: 'files', items: files, total: result.total ?? files.length, truncated: !!result.truncated }
        }
    }
}

export const searchCodeTool: AgentTool = {
    name: 'search_code',
    kind: 'search',
    description: 'Search file contents with a regular expression (JavaScript syntax), like grep. Returns matching lines with file and line number. Use glob to limit file types, context for surrounding lines, files_only to list only matching files.',
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'Regular expression, e.g. "function\\\\s+parse" or "TODO".' },
            path: { type: 'string', description: 'Folder or file to search. Default: the workspace root.' },
            glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.py".' },
            case_sensitive: { type: 'boolean', description: 'Default false.' },
            context: { type: 'integer', description: 'Lines of context before and after each match (0-5).' },
            files_only: { type: 'boolean', description: 'Return only the names of matching files.' }
        },
        required: ['pattern']
    },
    title: args => `Search for ${str(args.pattern)}${args.glob ? ` in ${str(args.glob)}` : ''}`,
    async execute(args, ctx) {
        if (!ctx.workspace) return fail('Open a folder first.')
        const result = await api().agent.grep({
            pattern: str(args.pattern),
            path: args.path ? resolvePath(ctx.workspace, args.path) : undefined,
            glob: args.glob ? str(args.glob) : undefined,
            caseSensitive: args.case_sensitive === true,
            context: int(args.context, 0),
            filesOnly: args.files_only === true,
            maxResults: 100
        })
        if (!result?.ok) return fail(cleanError(result?.error ?? 'Search failed.'))
        const more = result.truncated ? '\n\n(more matches exist; refine the pattern or path)' : ''
        if (args.files_only === true) {
            const files = result.files ?? []
            return {
                content: files.length ? files.join('\n') + more : 'No matches.',
                display: { type: 'matches', query: str(args.pattern), items: files.map(file => ({ file })), total: files.length, truncated: !!result.truncated }
            }
        }
        const matches = result.matches ?? []
        const text = matches.map(m => {
            const ctxLines = [
                ...(m.before ?? []).map((l, i, arr) => `${m.file}-${m.line - arr.length + i}-${l}`),
                `${m.file}:${m.line}:${m.text}`,
                ...(m.after ?? []).map((l, i) => `${m.file}-${m.line + i + 1}-${l}`)
            ]
            return ctxLines.join('\n')
        }).join(int(args.context, 0) ? '\n--\n' : '\n')
        return {
            content: matches.length ? text + more : 'No matches.',
            display: { type: 'matches', query: str(args.pattern), items: matches.map(m => ({ file: m.file, line: m.line, text: m.text })), total: matches.length, truncated: !!result.truncated }
        }
    }
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

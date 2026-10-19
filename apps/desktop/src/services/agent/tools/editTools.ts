/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Tools that change files. Every change is snapshotted first (so the user can
 * undo the run) and reported as a diff for the chat.
 */
import { cleanError, fail, type AgentTool, type ToolContext, type ToolOutcome } from './types'
import { relativePath, resolvePath } from './paths'
import { diffLines } from './lineDiff'
import { quickCheck } from '../diagnostics'

const fsApi = () => {
    const fs = window.electronAPI?.fs
    if (!fs) throw new Error('File tools need the desktop app.')
    return fs
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

async function readIfExists(path: string): Promise<string | null> {
    const stat = await fsApi().stat(path)
    if (!stat?.success) return null
    if (stat.isDirectory) throw new Error('That path is a folder, not a file.')
    const result = await fsApi().readFile(path)
    if (!result?.success) throw new Error(cleanError(result?.error))
    return String(result.content ?? '')
}

async function write(path: string, content: string, before: string | null, ctx: ToolContext, summary: string): Promise<ToolOutcome> {
    await ctx.checkpoint(path)
    const result = await fsApi().writeFile({ path, content })
    if (!result?.success) return fail(cleanError(result?.error ?? 'Could not write the file.'))
    ctx.knownFiles.add(path)
    const display = diffDisplay(ctx, path, before, content)
    const message = `${summary} ${display.path} (+${display.added} −${display.removed}).`
    // A syntax error is cheapest to fix right after the edit that caused it.
    const check = await quickCheck(path)
    if (check && !check.ok) {
        const problems = check.output.split(path).join(display.path)
        return { content: `${message}\n\nThe file now fails ${check.checker}:\n${problems}\nFix this before moving on.`, display: { ...display, problems } }
    }
    return { content: message, display }
}

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0
    let count = 0
    for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) count++
    return count
}

/** Where the first line of a near-miss appears, to help the model retry. */
function nearMiss(content: string, oldString: string): string {
    const first = oldString.split('\n').map(l => l.trim()).find(Boolean)
    if (!first) return ''
    const lines = content.split('\n')
    const at = lines.findIndex(l => l.trim() === first)
    return at >= 0 ? ` A line matching its first line is at line ${at + 1}; check indentation and the following lines.` : ''
}

export const editFileTool: AgentTool = {
    name: 'edit_file',
    kind: 'edit',
    description: 'Replace exact text in a file. old_string must match the file exactly (including indentation and line breaks) and be unique unless replace_all is true; include enough surrounding lines to make it unique. Read the file first. Prefer this over write_file for changes to existing files.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'File to edit.' },
            old_string: { type: 'string', description: 'Exact text to replace.' },
            new_string: { type: 'string', description: 'Replacement text.' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' }
        },
        required: ['path', 'old_string', 'new_string']
    },
    title: (args, ws) => `Edit ${relativePath(ws, resolvePath(ws, args.path))}`,
    async preview(args, ctx) {
        const planned = await planEdit(args, ctx)
        return 'error' in planned ? null : diffDisplay(ctx, planned.path, planned.before, planned.after)
    },
    async execute(args, ctx) {
        const planned = await planEdit(args, ctx)
        if ('error' in planned) return fail(planned.error)
        return write(planned.path, planned.after, planned.before, ctx, planned.count > 1 ? `Replaced ${planned.count} occurrences in` : 'Edited')
    }
}

type Planned = { path: string; before: string | null; after: string; count: number } | { error: string }

function diffDisplay(ctx: ToolContext, path: string, before: string | null, after: string) {
    const { lines, added, removed } = diffLines(before, after)
    return { type: 'diff' as const, path: relativePath(ctx.workspace, path), created: before === null, added, removed, lines }
}

async function planEdit(args: Record<string, unknown>, ctx: ToolContext): Promise<Planned> {
    const path = resolvePath(ctx.workspace, args.path)
    let oldString = str(args.old_string)
    let newString = str(args.new_string)
    if (!oldString) return { error: 'old_string is empty. To create a file, use write_file.' }
    if (oldString === newString) return { error: 'old_string and new_string are the same; nothing to change.' }
    let before: string | null
    try { before = await readIfExists(path) } catch (e) { return { error: cleanError(e) } }
    if (before === null) return { error: `${relativePath(ctx.workspace, path)} doesn't exist. Use write_file to create it.` }
    if (!ctx.knownFiles.has(path)) return { error: 'Read the file with read_file before editing it, so the edit is based on its current content.' }

    // Files with Windows line endings: match the model's \n text against \r\n.
    if (before.includes('\r\n') && !oldString.includes('\r\n')) {
        const crlfOld = oldString.replace(/\n/g, '\r\n')
        if (countOccurrences(before, crlfOld) > 0) {
            oldString = crlfOld
            newString = newString.replace(/\r?\n/g, '\r\n')
        }
    }
    const count = countOccurrences(before, oldString)
    if (count === 0) return { error: `old_string was not found in ${relativePath(ctx.workspace, path)}.${nearMiss(before, oldString)} Read the file again and copy the text exactly.` }
    if (count > 1 && args.replace_all !== true) {
        return { error: `old_string appears ${count} times. Include more surrounding lines to make it unique, or set replace_all to true.` }
    }
    const after = args.replace_all === true ? before.split(oldString).join(newString) : before.replace(oldString, () => newString)
    return { path, before, after, count }
}

export const writeFileTool: AgentTool = {
    name: 'write_file',
    kind: 'edit',
    description: 'Create a file, or replace a whole file\'s content. Parent folders are created as needed. To change part of an existing file, use edit_file instead; to overwrite an existing file, read it first.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'File to write.' },
            content: { type: 'string', description: 'The complete file content.' }
        },
        required: ['path', 'content']
    },
    title: (args, ws) => `Write ${relativePath(ws, resolvePath(ws, args.path))}`,
    async preview(args, ctx) {
        if (typeof args.content !== 'string') return null
        const path = resolvePath(ctx.workspace, args.path)
        try { return diffDisplay(ctx, path, await readIfExists(path), args.content) } catch { return null }
    },
    async execute(args, ctx) {
        const path = resolvePath(ctx.workspace, args.path)
        if (typeof args.content !== 'string') return fail('content must be a string with the whole file.')
        let before: string | null
        try { before = await readIfExists(path) } catch (e) { return fail(cleanError(e)) }
        if (before !== null && !ctx.knownFiles.has(path)) {
            return fail(`${relativePath(ctx.workspace, path)} already exists. Read it first, then use edit_file for changes or write_file to replace it.`)
        }
        return write(path, args.content, before, ctx, before === null ? 'Created' : 'Rewrote')
    }
}

export const deletePathTool: AgentTool = {
    name: 'delete_path',
    kind: 'delete',
    description: 'Delete a file, or a folder with everything in it. Only do this when the task requires it.',
    parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File or folder to delete.' } },
        required: ['path']
    },
    title: (args, ws) => `Delete ${relativePath(ws, resolvePath(ws, args.path))}`,
    async execute(args, ctx) {
        const path = resolvePath(ctx.workspace, args.path)
        if (ctx.workspace && path.replace(/[\\/]+$/, '') === ctx.workspace.replace(/[\\/]+$/, '')) return fail('Refusing to delete the whole workspace.')
        const stat = await fsApi().stat(path)
        if (!stat?.success) return fail(`${relativePath(ctx.workspace, path)} doesn't exist.`)
        if (!stat.isDirectory) await ctx.checkpoint(path)
        const result = await fsApi().delete(path)
        if (!result?.success) return fail(cleanError(result?.error ?? 'Could not delete it.'))
        ctx.knownFiles.delete(path)
        const rel = relativePath(ctx.workspace, path)
        return { content: `Deleted ${rel}.`, display: { type: 'deleted', path: rel } }
    }
}

export const movePathTool: AgentTool = {
    name: 'move_path',
    kind: 'edit',
    description: 'Move or rename a file or folder. Fails if the destination already exists.',
    parameters: {
        type: 'object',
        properties: {
            from: { type: 'string', description: 'Current path.' },
            to: { type: 'string', description: 'New path.' }
        },
        required: ['from', 'to']
    },
    title: (args, ws) => `Move ${relativePath(ws, resolvePath(ws, args.from))} to ${relativePath(ws, resolvePath(ws, args.to))}`,
    async execute(args, ctx) {
        const from = resolvePath(ctx.workspace, args.from)
        const to = resolvePath(ctx.workspace, args.to)
        const stat = await fsApi().stat(from)
        if (!stat?.success) return fail(`${relativePath(ctx.workspace, from)} doesn't exist.`)
        if (!stat.isDirectory) {
            await ctx.checkpoint(from)
            await ctx.checkpoint(to)
        }
        const result = await fsApi().rename({ oldPath: from, newPath: to })
        if (!result?.success) return fail(cleanError(result?.error ?? 'Could not move it.'))
        if (ctx.knownFiles.delete(from)) ctx.knownFiles.add(to)
        const display = { type: 'moved' as const, from: relativePath(ctx.workspace, from), to: relativePath(ctx.workspace, to) }
        return { content: `Moved ${display.from} to ${display.to}.`, display }
    }
}

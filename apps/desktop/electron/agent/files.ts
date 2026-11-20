/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * File discovery for the AI agent, confined to the open workspace:
 *   agent:glob  { pattern, path? }                 -> { ok, files, truncated }
 *   agent:grep  { pattern, path?, glob?, ... }     -> { ok, matches | files, truncated }
 * In a git repository the file list comes from `git ls-files`, so ignored
 * files (build output, dependencies) stay out of results; otherwise a walk
 * skips the usual dependency and build folders.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { IpcMain } from 'electron'
import { validatePath } from '../utils/pathValidator'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', '__pycache__', '.next', '.nuxt', '.venv', 'venv', 'coverage', '.cache', '.turbo', '.gradle', 'Pods', 'vendor'])
const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|tar|gz|tgz|rar|7z|mp3|mp4|avi|mov|wav|woff2?|ttf|otf|eot|gguf|bin|exe|dll|so|dylib|o|a|class|jar|wasm|pyc|lock|sqlite|db)$/i
const MAX_FILES = 50_000
const MAX_FILE_BYTES = 2_000_000

/** Glob ("src/**\/*.ts", "*.{js,ts}") to a matcher on POSIX-style relative paths. */
export function globToRegExp(glob: string): RegExp {
    let re = ''
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i]
        if (c === '*') {
            if (glob[i + 1] === '*') {
                const slash = glob[i + 2] === '/'
                re += slash ? '(?:.*/)?' : '.*'
                i += slash ? 2 : 1
            } else re += '[^/]*'
        } else if (c === '?') re += '[^/]'
        else if (c === '{') {
            const end = glob.indexOf('}', i)
            if (end < 0) { re += '\\{'; continue }
            re += `(?:${glob.slice(i + 1, end).split(',').map(part => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`
            i = end
        } else re += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c
    }
    // A bare pattern without a slash matches at any depth, like most tools.
    return new RegExp(glob.includes('/') ? `^${re}$` : `(?:^|/)${re}$`, 'i')
}

function gitFiles(root: string): Promise<string[] | null> {
    return new Promise(resolve => {
        execFile('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
            if (error) return resolve(null)
            resolve(stdout.split('\0').filter(Boolean))
        })
    })
}

async function walkFiles(root: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string, rel: string): Promise<void> => {
        if (out.length >= MAX_FILES) return
        let entries: fs.Dirent[]
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), childRel)
            } else if (entry.isFile()) out.push(childRel)
            if (out.length >= MAX_FILES) return
        }
    }
    await walk(root, '')
    return out
}

const MAX_PATTERN_LENGTH = 500
const STAT_BATCH_SIZE = 64

function isInsideReal(realRoot: string, realTarget: string): boolean {
    const rel = path.relative(realRoot, realTarget)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** Rejects regexes with nested quantifiers or catastrophic backtracking shapes. */
function isUnsafeRegex(pattern: string): boolean {
    if (pattern.length > MAX_PATTERN_LENGTH) return true
    const stack: Array<{ hasQuantifier: boolean; hasAlternation: boolean }> = []
    let inClass = false
    let quantifiers = 0
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i]
        if (ch === '\\') {
            const next = pattern[i + 1]
            if (next && next >= '1' && next <= '9') {
                // Backreference inside/followed by repetition can backtrack exponentially.
                if (stack.length > 0 || /[+*?{]/.test(pattern[i + 2] ?? '')) return true
            }
            i++
            continue
        }
        if (inClass) {
            if (ch === ']') inClass = false
            continue
        }
        if (ch === '[') { inClass = true; continue }
        if (ch === '(') {
            stack.push({ hasQuantifier: false, hasAlternation: false })
            continue
        }
        if (ch === '|') {
            if (stack.length) stack[stack.length - 1].hasAlternation = true
            continue
        }
        if (ch === ')') {
            const frame = stack.pop()
            if (!frame) continue
            const after = pattern[i + 1]
            const groupQuantified = after === '+' || after === '*' || after === '{'
            if (groupQuantified && (frame.hasQuantifier || frame.hasAlternation)) return true
            if (stack.length && (frame.hasQuantifier || groupQuantified)) {
                stack[stack.length - 1].hasQuantifier = true
            }
            continue
        }
        if (ch === '+' || ch === '*' || ch === '{') {
            quantifiers++
            if (quantifiers > 24) return true
            if (stack.length) stack[stack.length - 1].hasQuantifier = true
        }
    }
    return false
}

async function filterExistingFiles(root: string, files: string[]): Promise<string[]> {
    const capped = files.slice(0, MAX_FILES)
    const existing: string[] = []
    for (let i = 0; i < capped.length; i += STAT_BATCH_SIZE) {
        const batch = capped.slice(i, i + STAT_BATCH_SIZE)
        const results = await Promise.all(batch.map(async f => {
            try {
                await fs.promises.access(path.join(root, f))
                return f
            } catch {
                return null
            }
        }))
        for (const f of results) if (f !== null) existing.push(f)
    }
    return existing
}

/** Files under `base` (relative to the workspace root), most recently changed first. */
async function listFiles(root: string, base: string): Promise<string[]> {
    const relBase = path.relative(root, base).split(path.sep).join('/')
    let files = await gitFiles(root)
    const fromGit = files !== null
    if (!files) files = await walkFiles(root)
    if (relBase) files = files.filter(f => f === relBase || f.startsWith(`${relBase}/`))
    return fromGit ? filterExistingFiles(root, files) : files
}

function resolveBase(workspace: string | null, target?: string): { root: string; base: string } {
    if (!workspace) throw new Error('Open a folder first.')
    const base = validatePath(workspace, target || '.')
    return { root: path.resolve(workspace), base }
}

async function byRecency(root: string, files: string[]): Promise<string[]> {
    const stats = await Promise.all(files.map(async f => {
        try { return [f, (await fs.promises.stat(path.join(root, f))).mtimeMs] as const } catch { return [f, 0] as const }
    }))
    return stats.sort((a, b) => b[1] - a[1]).map(([f]) => f)
}

export function registerAgentFileHandlers(ipcMain: IpcMain, getWorkspace: () => string | null): void {
    ipcMain.handle('agent:glob', async (_event, options: { pattern: string; path?: string; limit?: number }) => {
        try {
            const { root, base } = resolveBase(getWorkspace(), options?.path)
            const pattern = String(options?.pattern ?? '').trim() || '**/*'
            const re = globToRegExp(pattern)
            const relBase = path.relative(root, base).split(path.sep).join('/')
            const matched = (await listFiles(root, base)).filter(f => re.test(relBase ? f.slice(relBase.length + 1) : f) || re.test(f))
            const limit = Math.min(options?.limit ?? 200, 1000)
            const sorted = await byRecency(root, matched.slice(0, 5000))
            return { ok: true, files: sorted.slice(0, limit), total: matched.length, truncated: matched.length > limit }
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    ipcMain.handle('agent:grep', async (_event, options: { pattern: string; path?: string; glob?: string; caseSensitive?: boolean; context?: number; maxResults?: number; filesOnly?: boolean }) => {
        try {
            const { root, base } = resolveBase(getWorkspace(), options?.path)
            const rawPattern = typeof options?.pattern === 'string' ? options.pattern : ''
            if (!rawPattern.trim()) {
                return { ok: false, error: 'Search pattern cannot be empty.' }
            }
            if (isUnsafeRegex(rawPattern)) {
                return { ok: false, error: 'Search pattern is too complex or unsafe. Simplify nested quantifiers and try again.' }
            }
            let regex: RegExp
            try { regex = new RegExp(rawPattern, options?.caseSensitive ? '' : 'i') } catch (e) {
                return { ok: false, error: `Invalid regular expression: ${e instanceof Error ? e.message : String(e)}` }
            }
            const realRoot = await fs.promises.realpath(root)
            const fileFilter = options?.glob ? globToRegExp(options.glob) : null
            const context = Math.min(Math.max(options?.context ?? 0, 0), 5)
            const maxResults = Math.min(options?.maxResults ?? 100, 500)
            const files = (await listFiles(root, base)).filter(f => !BINARY.test(f) && (!fileFilter || fileFilter.test(f)))
            const matches: Array<{ file: string; line: number; text: string; before?: string[]; after?: string[] }> = []
            const matchedFiles: string[] = []
            let truncated = false
            for (const file of files) {
                const full = path.join(root, file)
                let content: string
                try {
                    // Per-file symlink containment check so tracked symlinks cannot read outside the workspace.
                    const realFull = await fs.promises.realpath(full)
                    if (!isInsideReal(realRoot, realFull)) continue
                    const stat = await fs.promises.stat(realFull)
                    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
                    content = await fs.promises.readFile(realFull, 'utf8')
                } catch { continue }
                if (content.includes('\u0000')) continue
                const lines = content.split(/\r?\n/)
                let hit = false
                for (let i = 0; i < lines.length; i++) {
                    if (!regex.test(lines[i])) continue
                    hit = true
                    if (options?.filesOnly) break
                    matches.push({
                        file, line: i + 1, text: lines[i].slice(0, 400),
                        ...(context ? { before: lines.slice(Math.max(0, i - context), i), after: lines.slice(i + 1, i + 1 + context) } : {})
                    })
                    if (matches.length >= maxResults) { truncated = true; break }
                }
                if (hit) matchedFiles.push(file)
                if (truncated || (options?.filesOnly && matchedFiles.length >= maxResults)) { truncated = true; break }
            }
            return options?.filesOnly ? { ok: true, files: matchedFiles, truncated } : { ok: true, matches, truncated }
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
    })
}

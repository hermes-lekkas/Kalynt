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

/** Files under `base` (relative to the workspace root), most recently changed first. */
async function listFiles(root: string, base: string): Promise<string[]> {
    const relBase = path.relative(root, base).split(path.sep).join('/')
    let files = await gitFiles(root)
    if (!files) files = await walkFiles(root)
    files = files.filter(f => fs.existsSync(path.join(root, f)))
    return relBase ? files.filter(f => f === relBase || f.startsWith(`${relBase}/`)) : files
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
            let regex: RegExp
            try { regex = new RegExp(String(options?.pattern ?? ''), options?.caseSensitive ? '' : 'i') } catch (e) {
                return { ok: false, error: `Invalid regular expression: ${e instanceof Error ? e.message : String(e)}` }
            }
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
                    const stat = await fs.promises.stat(full)
                    if (stat.size > MAX_FILE_BYTES) continue
                    content = await fs.promises.readFile(full, 'utf8')
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

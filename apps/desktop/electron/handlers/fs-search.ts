/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Plain-text search across a folder: bundled ripgrep when present, otherwise
 * a JavaScript walk. Matching is case-insensitive and literal.
 */
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { binaryManager } from '../services/binary-manager'

export interface SearchMatch {
    file: string
    line: number
    content: string
}

export interface SearchResult {
    success: boolean
    results?: SearchMatch[]
    truncated?: boolean
    error?: string
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', '__pycache__'])
const BINARY_EXTS = new Set([
    '.exe', '.dll', '.so', '.dylib', '.bin', '.png', '.jpg', '.jpeg', '.gif', '.webp',
    '.bmp', '.ico', '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z', '.mp3', '.mp4',
    '.avi', '.mov', '.woff', '.woff2', '.ttf', '.otf', '.gguf', '.wasm', '.class', '.o'
])
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_LINE = 200

/** "*.ts" or "src/**\/*.py" to an anchored, case-insensitive matcher on the file name or relative path. */
function globMatcher(glob: string | undefined): (relative: string) => boolean {
    if (!glob) return () => true
    const source = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
    const re = new RegExp(`^${source}$`, 'i')
    return relative => {
        const normalized = relative.split(path.sep).join('/')
        return re.test(normalized) || re.test(path.posix.basename(normalized))
    }
}

async function searchWithJs(root: string, pattern: string, filePattern: string | undefined, maxResults: number): Promise<SearchResult> {
    const results: SearchMatch[] = []
    const needle = pattern.toLowerCase()
    const matches = globMatcher(filePattern)

    const walk = async (dir: string): Promise<void> => {
        if (results.length >= maxResults) return
        await new Promise(resolve => setImmediate(resolve))
        let entries: fs.Dirent[]
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            if (results.length >= maxResults) return
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) await walk(full)
                continue
            }
            if (!entry.isFile() || BINARY_EXTS.has(path.extname(entry.name).toLowerCase())) continue
            const relative = path.relative(root, full)
            if (!matches(relative)) continue
            try {
                if ((await fs.promises.stat(full)).size > MAX_FILE_BYTES) continue
                const lines = (await fs.promises.readFile(full, 'utf-8')).split('\n')
                for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                    if (lines[i].toLowerCase().includes(needle)) {
                        results.push({ file: relative, line: i + 1, content: lines[i].trim().slice(0, MAX_LINE) })
                    }
                }
            } catch {
                // Unreadable file: skip it.
            }
        }
    }

    await walk(root)
    return { success: true, results, truncated: results.length >= maxResults }
}

function searchWithRipgrep(rgPath: string, root: string, pattern: string, filePattern: string | undefined, maxResults: number): Promise<SearchResult | null> {
    return new Promise(resolve => {
        const args = ['--json', '--ignore-case', '--fixed-strings', '--max-filesize', '5M']
        if (filePattern) args.push('--glob', filePattern)
        args.push('--', pattern, root)

        const rg = spawn(rgPath, args)
        const results: SearchMatch[] = []
        let buffer = ''
        let settled = false
        const done = (value: SearchResult | null) => {
            if (settled) return
            settled = true
            resolve(value)
        }

        rg.stdout.on('data', (data: Buffer) => {
            buffer += data.toString()
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''
            for (const line of lines) {
                if (results.length >= maxResults) break
                try {
                    const entry = JSON.parse(line)
                    if (entry.type !== 'match' || !entry.data.path?.text) continue
                    results.push({
                        file: path.relative(root, entry.data.path.text),
                        line: entry.data.line_number,
                        content: String(entry.data.lines?.text ?? '').trim().slice(0, MAX_LINE)
                    })
                } catch {
                    // Partial or non-JSON line.
                }
            }
            if (results.length >= maxResults) {
                rg.kill()
                done({ success: true, results, truncated: true })
            }
        })

        // Exit code 1 means "no matches"; 2 is a real error unless some files matched.
        rg.on('close', code => {
            if (code === 2 && results.length === 0) done(null)
            else done({ success: true, results, truncated: false })
        })
        // Spawn failure: let the caller fall back to the JS search.
        rg.on('error', err => {
            console.warn('[FS] ripgrep failed, using the JS search:', err.message)
            done(null)
        })
    })
}

export async function searchFolder(root: string, pattern: string, filePattern: string | undefined, maxResults = 100): Promise<SearchResult> {
    if (!pattern) return { success: true, results: [], truncated: false }
    const rgPath = binaryManager.getRipgrepPath()
    if (rgPath) {
        const result = await searchWithRipgrep(rgPath, root, pattern, filePattern, maxResults)
        if (result) return result
    }
    return searchWithJs(root, pattern, filePattern, maxResults)
}

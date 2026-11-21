/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Pure helpers for Monaco editor reliability:
 * - QA-11: workspace-relative ignore filtering & TS/JS file discovery
 * - QA-18: cancellation error classification & window-level cancellation guard
 */

export const IGNORED_WORKSPACE_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'dist-electron',
    'build',
    'out',
    '.next',
    '.nuxt',
    '.svelte-kit',
    'coverage',
    '.turbo',
    '.cache',
    'release'
])

export const WORKSPACE_TYPE_FILE_GLOB = '**/*.{d.ts,ts,tsx,mts,cts,js,jsx,mjs,cjs}'
export const WORKSPACE_TYPE_FILE_RE = /\.(?:d\.ts|tsx?|jsx?|mts|cts|mjs|cjs)$/i

export interface WorkspaceDiscoveryApi {
    agent?: {
        glob?: (options: { pattern: string; path?: string; limit?: number }) => Promise<{
            ok?: boolean
            files?: string[]
        } | null | undefined>
    }
    fs?: {
        readDir?: (dirPath: string) => Promise<{
            success?: boolean
            items?: Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean }>
        } | null | undefined>
    }
}

export function normalizeFsPath(rawPath: string): string {
    return rawPath.replace(/\\/g, '/').replace(/\/+$/, '')
}

function isAbsoluteFsPath(normalizedPath: string): boolean {
    return normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath)
}

/**
 * Converts a discovered path (relative or absolute) into a clean
 * workspace-relative POSIX path, or returns null if it escapes the root.
 * Ancestor directory names above `workspaceRoot` are never inspected by
 * workspace ignore rules.
 */
export function toWorkspaceRelativePath(filePath: string, workspaceRoot: string): string | null {
    const root = normalizeFsPath(workspaceRoot)
    const raw = filePath.replace(/\\/g, '/')
    if (!raw) return null

    if (!isAbsoluteFsPath(raw)) {
        const cleaned = raw.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '')
        if (!cleaned || cleaned === '..' || cleaned.startsWith('../') || cleaned.includes('/../')) {
            return null
        }
        return cleaned
    }

    if (raw === root) return ''
    const rootPrefix = `${root}/`
    if (raw.startsWith(rootPrefix)) {
        return raw.slice(rootPrefix.length)
    }

    // Handle Windows drive letter casing differences (e.g. c:/ vs C:/).
    if (/^[A-Za-z]:\//.test(root) && /^[A-Za-z]:\//.test(raw)) {
        if (raw[0].toLowerCase() === root[0].toLowerCase() && raw.slice(1).startsWith(rootPrefix.slice(1))) {
            return raw.slice(rootPrefix.length)
        }
    }

    return null
}

/**
 * Applies ignored directory rules strictly to workspace-relative directory
 * segments, never to ancestor folders above the workspace root.
 */
export function isIgnoredWorkspaceRelativePath(relPath: string): boolean {
    const cleaned = relPath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '')
    if (!cleaned) return true
    const segments = cleaned.split('/').filter(Boolean)
    if (segments.length === 0) return true
    // Only directory segments (all segments before the filename) are checked against IGNORED_DIRS.
    const dirSegments = segments.slice(0, -1)
    return dirSegments.some(seg => seg === '..' || IGNORED_WORKSPACE_DIRS.has(seg))
}

export function joinWorkspacePath(workspaceRoot: string, relPath: string): string {
    const root = normalizeFsPath(workspaceRoot)
    const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    return `${root}/${rel}`
}

/**
 * Discovers workspace TS/JS files for Monaco IntelliSense.
 * Uses the fast main-process glob when available and falls back to bounded BFS
 * `fs.readDir`, applying ignore filters strictly to workspace-relative segments.
 */
export async function discoverWorkspaceTypeFilesFromApi(
    folder: string,
    api: WorkspaceDiscoveryApi | undefined,
    maxFiles: number = 280
): Promise<string[]> {
    const normalizedRoot = normalizeFsPath(folder)
    if (!normalizedRoot) return []

    // Fast path: main-process glob.
    if (api?.agent?.glob) {
        try {
            const res = await api.agent.glob({
                pattern: WORKSPACE_TYPE_FILE_GLOB,
                path: folder,
                limit: maxFiles
            })
            if (res?.ok && Array.isArray(res.files)) {
                const seen = new Set<string>()
                const found: string[] = []
                for (const file of res.files) {
                    if (typeof file !== 'string' || !file) continue
                    const rel = toWorkspaceRelativePath(file, normalizedRoot)
                    if (!rel || !WORKSPACE_TYPE_FILE_RE.test(rel)) continue
                    if (isIgnoredWorkspaceRelativePath(rel)) continue
                    const full = joinWorkspacePath(normalizedRoot, rel)
                    if (!seen.has(full)) {
                        seen.add(full)
                        found.push(full)
                    }
                    if (found.length >= maxFiles) break
                }
                return found
            }
        } catch {
            // Fall through to bounded directory scan.
        }
    }

    // Fallback: bounded BFS using fs.readDir (max depth 5).
    if (!api?.fs?.readDir) return []
    const found: string[] = []
    const seen = new Set<string>()
    const queue: Array<{ dir: string; relDir: string; depth: number }> = [
        { dir: normalizedRoot, relDir: '', depth: 0 }
    ]

    while (queue.length > 0 && found.length < maxFiles) {
        const current = queue.shift()!
        const res = await api.fs.readDir(current.dir).catch(() => null)
        if (!res?.success || !Array.isArray(res.items)) continue
        for (const item of res.items) {
            if (!item || typeof item.name !== 'string' || !item.name) continue
            const nextRel = current.relDir ? `${current.relDir}/${item.name}` : item.name
            if (item.isDirectory) {
                if (current.depth < 5 && !IGNORED_WORKSPACE_DIRS.has(item.name) && !item.name.startsWith('.')) {
                    const nextDir = item.path ? normalizeFsPath(item.path) : joinWorkspacePath(normalizedRoot, nextRel)
                    queue.push({ dir: nextDir, relDir: nextRel, depth: current.depth + 1 })
                }
            } else if (item.isFile && WORKSPACE_TYPE_FILE_RE.test(item.name)) {
                if (isIgnoredWorkspaceRelativePath(nextRel)) continue
                const full = item.path ? item.path.replace(/\\/g, '/') : joinWorkspacePath(normalizedRoot, nextRel)
                if (!seen.has(full)) {
                    seen.add(full)
                    found.push(full)
                }
                if (found.length >= maxFiles) break
            }
        }
    }

    return found
}

export function prioritizeWorkspaceTypeFiles(files: readonly string[], maxFiles: number): string[] {
    const rank = (filePath: string): number => {
        const lower = filePath.toLowerCase()
        if (lower.endsWith('.d.ts')) return 0
        if (/\.(?:tsx?|mts|cts)$/.test(lower)) return 1
        return 2
    }
    return [...files]
        .sort((a, b) => {
            const rankDiff = rank(a) - rank(b)
            if (rankDiff !== 0) return rankDiff
            return a.length - b.length
        })
        .slice(0, maxFiles)
}

export function stripJsonc(text: string): string {
    let out = ''
    let inString = false
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        const next = text[i + 1]
        if (inString) {
            out += ch
            if (ch === '\\') {
                out += next ?? ''
                i++
            } else if (ch === '"') {
                inString = false
            }
        } else if (ch === '"') {
            inString = true
            out += ch
        } else if (ch === '/' && next === '/') {
            while (i < text.length && text[i] !== '\n') i++
            out += '\n'
        } else if (ch === '/' && next === '*') {
            i += 2
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
            i++
        } else {
            out += ch
        }
    }
    return out.replace(/,(\s*[}\]])/g, '$1')
}

/**
 * Resolves `compilerOptions.baseUrl` to a file URI. When `paths` aliases are
 * present without an explicit `baseUrl` (valid since TS 4.1), defaults to the
 * workspace root so Monaco's TS worker can resolve path aliases reliably.
 */
export function resolveTsConfigBaseUrl(
    folder: string,
    rawBaseUrl: unknown,
    hasPaths: boolean,
    toFileUri: (fsPath: string) => string
): string | undefined {
    const normalizedFolder = normalizeFsPath(folder)
    if (typeof rawBaseUrl === 'string') {
        const cleanBase = rawBaseUrl.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
        return cleanBase === '.' || cleanBase === ''
            ? toFileUri(normalizedFolder)
            : toFileUri(`${normalizedFolder}/${cleanBase}`)
    }
    if (hasPaths) {
        return toFileUri(normalizedFolder)
    }
    return undefined
}

// ---------------------------------------------------------------------------
// QA-18: Cancellation classification & window-level Monaco lifecycle guard
// ---------------------------------------------------------------------------

/**
 * Returns true strictly for normal async/provider cancellation errors
 * (Monaco CancellationError, AbortError, @monaco-editor/loader cancelation).
 * Never matches real unexpected runtime errors.
 */
export function isCancellationError(error: unknown): boolean {
    if (!error) return false
    if (typeof error === 'string') {
        const trimmed = error.trim()
        return trimmed === 'Canceled' || trimmed === 'Uncaught Canceled' || trimmed === 'Uncaught Error: Canceled'
    }
    if (typeof error === 'object') {
        const record = error as {
            name?: unknown
            message?: unknown
            type?: unknown
            isCanceled?: unknown
            canceled?: unknown
        }
        if (record.type === 'cancelation') return true
        if (record.isCanceled === true || record.canceled === true) return true
        if (record.name === 'Canceled' || record.name === 'CancellationError' || record.name === 'AbortError') {
            return true
        }
        if (record.message === 'Canceled' && (!record.name || record.name === 'Error')) {
            return true
        }
    }
    return false
}

const installedTargets = new WeakSet<EventTarget>()

/**
 * Prevents normal Monaco provider/disposal `Canceled` errors from surfacing as
 * uncaught renderer `unhandledrejection` or `error` events during split-pane,
 * tab-close, and workspace-switch transitions. Real non-cancellation errors
 * continue to propagate untouched.
 */
export function installMonacoCancellationHandler(
    target: EventTarget | undefined = typeof window !== 'undefined' ? window : undefined
): () => void {
    if (!target || installedTargets.has(target)) {
        return () => undefined
    }
    installedTargets.add(target)

    const onUnhandledRejection = (event: Event) => {
        const rejection = event as Event & { reason?: unknown }
        if (isCancellationError(rejection.reason)) {
            event.preventDefault()
        }
    }

    const onWindowError = (event: Event) => {
        const errEvent = event as Event & { error?: unknown; message?: unknown }
        if (isCancellationError(errEvent.error)) {
            event.preventDefault()
            return
        }
        if (errEvent.error == null && typeof errEvent.message === 'string' && isCancellationError(errEvent.message)) {
            event.preventDefault()
        }
    }

    target.addEventListener('unhandledrejection', onUnhandledRejection)
    target.addEventListener('error', onWindowError)

    return () => {
        target.removeEventListener('unhandledrejection', onUnhandledRejection)
        target.removeEventListener('error', onWindowError)
        installedTargets.delete(target)
    }
}

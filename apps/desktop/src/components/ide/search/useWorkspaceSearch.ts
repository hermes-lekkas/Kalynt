/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Find and replace across the workspace. Uses main-process ripgrep (`fs.search`)
 * or `agent.grep` when available, merged with dirty open editor buffers matched
 * via `samePath()`, with a clean renderer directory-walk fallback.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OpenFilesApi } from '../hooks/useOpenFiles'
import { useNotificationStore } from '../../../stores/notificationStore'
import { confirmAction } from '../../ui'
import { baseName, samePath } from '../languages'
import {
    buildPattern, extractMatchesInText, isBinaryFile, matchesInclude, preserveCase, splitList,
    type SearchMatch, type SearchOptions
} from './searchUtils'

const MAX_RESULTS = 2000
const MAX_FILE_BYTES = 1_500_000
const READ_CONCURRENCY = 16
const HISTORY_KEY = 'kalynt-search-history'

function loadHistory(): string[] {
    try {
        const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
        return Array.isArray(raw) ? raw.map((h: string | { query: string }) => (typeof h === 'string' ? h : h.query)).slice(0, 20) : []
    } catch {
        return []
    }
}

function normSlash(p: string): string {
    return p.replace(/\\/g, '/')
}

function toRelative(filePath: string, root: string): string | null {
    const normRoot = normSlash(root).replace(/\/+$/, '')
    const normFile = normSlash(filePath)
    if (normFile.startsWith(normRoot + '/')) return normFile.slice(normRoot.length + 1)
    if (normFile.toLowerCase().startsWith(normRoot.toLowerCase() + '/')) return normFile.slice(normRoot.length + 1)
    return null
}

function joinUnder(root: string, relative: string): string {
    const cleanRoot = root.replace(/[\\/]+$/, '')
    const cleanRel = normSlash(relative).replace(/^\/+/, '')
    return `${cleanRoot}/${cleanRel}`
}

function isExcluded(relative: string, excludes: string[]): boolean {
    if (excludes.length === 0) return false
    const segments = normSlash(relative).split('/')
    for (const seg of segments) {
        if (excludes.includes(seg)) return true
    }
    return matchesInclude(relative, excludes)
}

export interface SearchProgress {
    filesSearched: number
    matches: number
    files: number
    truncated: boolean
    done: boolean
}

export interface SearchRunOptions {
    recordHistory?: boolean
}

export function useWorkspaceSearch(folder: string | null, buffers?: Pick<OpenFilesApi, 'files' | 'updateContent'>) {
    const buffersRef = useRef(buffers)
    buffersRef.current = buffers
    const addNotification = useNotificationStore(s => s.addNotification)
    const [query, setQuery] = useState('')
    const [replacement, setReplacement] = useState('')
    const [options, setOptions] = useState<SearchOptions>({ regex: false, caseSensitive: false, wholeWord: false })
    const [keepCase, setKeepCase] = useState(true)
    const [include, setInclude] = useState('')
    const [exclude, setExclude] = useState('node_modules, .git, dist, build, .next, target')
    const [results, setResults] = useState<SearchMatch[]>([])
    const [progress, setProgress] = useState<SearchProgress | null>(null)
    const [searching, setSearching] = useState(false)
    const [replacing, setReplacing] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [history, setHistory] = useState<string[]>(loadHistory)
    const runId = useRef(0)
    const lastSearch = useRef<string | null>(null)
    const signature = JSON.stringify([folder, query, options, include, exclude])
    const folderRef = useRef(folder)
    folderRef.current = folder

    useEffect(() => {
        runId.current++
        setResults([])
        setProgress(null)
        setSearching(false)
        setReplacing(false)
        lastSearch.current = null
        return () => { runId.current++ }
    }, [folder])

    const remember = useCallback((q: string) => {
        if (!q.trim()) return
        setHistory(prev => {
            const next = [q, ...prev.filter(h => h !== q)].slice(0, 20)
            try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
            return next
        })
    }, [])

    const stop = useCallback(() => {
        runId.current++
        setSearching(false)
        setProgress(p => (p ? { ...p, done: true } : p))
    }, [])

    const search = useCallback(async (overrideQuery?: string, runOpts?: SearchRunOptions) => {
        const run = ++runId.current
        setSearching(false)
        const q = overrideQuery ?? query
        if (!q || !folder) {
            if (!q) {
                setError(null)
                setResults([])
                setProgress(null)
                lastSearch.current = null
            }
            return
        }
        const pattern = buildPattern(q, options)
        if (typeof pattern === 'string') {
            setError(pattern)
            return
        }
        setError(null)
        setSearching(true)
        setResults([])
        lastSearch.current = JSON.stringify([folder, q, options, include, exclude])
        if (runOpts?.recordHistory !== false) remember(q)

        const includes = splitList(include)
        const excludes = splitList(exclude)
        const found: SearchMatch[] = []
        const matchedFiles = new Set<string>()
        let filesSearched = 0
        let truncated = false
        const api = window.electronAPI?.fs
        const agentApi = window.electronAPI?.agent

        const openFiles = buffersRef.current?.files ?? []
        const findOpenBuffer = (path: string) => openFiles.find(file => samePath(file.path, path))

        const searchContent = (path: string, name: string, content: string) => {
            if (content.length > MAX_FILE_BYTES) return
            const remaining = MAX_RESULTS - found.length
            const res = extractMatchesInText(path, name, content, pattern, remaining)
            if (res.matches.length > 0) {
                matchedFiles.add(normSlash(path))
                for (const m of res.matches) found.push(m)
            }
            if (res.truncated) truncated = true
        }

        const searchDiskFile = async (path: string, name: string) => {
            const open = findOpenBuffer(path)
            if (open) {
                searchContent(open.path, open.name || name, open.content)
                return
            }
            const res = await api?.readFile(path)
            if (!res?.success || typeof res.content !== 'string') return
            searchContent(path, name, res.content)
        }

        // Fast main-process search (ripgrep via fs.search for literal, agent.grep for regex).
        const runFastBackend = async (): Promise<boolean> => {
            let candidateRelPaths: string[] | null = null
            let backendTruncated = false

            if (!options.regex && typeof api?.search === 'function') {
                const filePattern = includes.length === 1 && !includes[0].includes('{') ? includes[0] : undefined
                const res = await api.search({
                    searchPath: folder,
                    pattern: q,
                    filePattern,
                    maxResults: MAX_RESULTS * 2
                })
                if (run !== runId.current) return true
                if (!res?.success || !Array.isArray(res.results)) return false
                const seen = new Set<string>()
                candidateRelPaths = []
                for (const item of res.results as Array<{ file?: string }>) {
                    if (!item?.file) continue
                    const rel = normSlash(item.file)
                    if (!seen.has(rel)) {
                        seen.add(rel)
                        candidateRelPaths.push(rel)
                    }
                }
                backendTruncated = !!res.truncated
            } else if (options.regex && typeof agentApi?.grep === 'function') {
                const glob = includes.length === 1 ? includes[0] : undefined
                const res = await agentApi.grep({
                    pattern: pattern.source,
                    path: folder,
                    glob,
                    caseSensitive: options.caseSensitive,
                    maxResults: 500,
                    filesOnly: true
                })
                if (run !== runId.current) return true
                if (!res?.ok || !Array.isArray(res.files)) return false
                // If grep hit its 500-file ceiling, fall back to full walk so matches aren't missed.
                if (res.truncated) return false
                candidateRelPaths = res.files.map(normSlash)
            } else {
                return false
            }

            // 1. Always search in-memory open buffers inside this folder first (handles dirty edits & unsaved matches).
            const searchedOpen = new Set<string>()
            for (const file of openFiles) {
                if (run !== runId.current || truncated) break
                const rel = toRelative(file.path, folder)
                if (!rel) continue
                if (isExcluded(rel, excludes) || isBinaryFile(file.name) || !matchesInclude(rel, includes)) continue
                searchedOpen.add(normSlash(file.path))
                searchContent(file.path, file.name, file.content)
                filesSearched++
            }

            // 2. Filter candidate disk files and read them in bounded concurrent batches for exact columns/context.
            const diskTargets: Array<{ path: string; name: string }> = []
            for (const rel of candidateRelPaths) {
                if (isExcluded(rel, excludes)) continue
                const name = baseName(rel)
                if (isBinaryFile(name) || !matchesInclude(rel, includes)) continue
                const fullPath = joinUnder(folder, rel)
                if (searchedOpen.has(normSlash(fullPath)) || findOpenBuffer(fullPath)) continue
                diskTargets.push({ path: fullPath, name })
            }

            for (let i = 0; i < diskTargets.length; i += READ_CONCURRENCY) {
                if (run !== runId.current || truncated) break
                const batch = diskTargets.slice(i, i + READ_CONCURRENCY)
                const contents = await Promise.all(batch.map(t => api?.readFile(t.path)))
                if (run !== runId.current) return true
                for (let j = 0; j < batch.length; j++) {
                    if (truncated) break
                    const res = contents[j]
                    filesSearched++
                    if (res?.success && typeof res.content === 'string') {
                        searchContent(batch[j].path, batch[j].name, res.content)
                    }
                }
                if (run === runId.current && diskTargets.length > READ_CONCURRENCY) {
                    setProgress({ filesSearched, matches: found.length, files: matchedFiles.size, truncated, done: false })
                    setResults([...found])
                }
            }

            if (backendTruncated && found.length >= MAX_RESULTS) truncated = true
            return true
        }

        // Clean fallback: recursive walk over fs.readDir when main-process backend is unavailable.
        const walk = async (dir: string): Promise<void> => {
            if (run !== runId.current || truncated) return
            const res = await api?.readDir(dir)
            if (!res?.success || !res.items) return
            for (const entry of res.items as Array<{ name: string; path: string; isDirectory: boolean }>) {
                if (run !== runId.current || truncated) return
                const path = entry.path || `${dir}/${entry.name}`
                const relative = toRelative(path, folder) ?? entry.name
                if (excludes.length && (excludes.includes(entry.name) || matchesInclude(relative, excludes))) continue
                if (entry.isDirectory) {
                    await walk(path)
                    continue
                }
                if (isBinaryFile(entry.name) || !matchesInclude(relative, includes)) continue
                await searchDiskFile(path, entry.name)
                filesSearched++
                if (filesSearched % 40 === 0 && run === runId.current) {
                    setProgress({ filesSearched, matches: found.length, files: matchedFiles.size, truncated, done: false })
                    setResults([...found])
                }
            }
        }

        try {
            const usedFast = await runFastBackend()
            if (!usedFast && run === runId.current) {
                await walk(folder)
            }
        } catch (e) {
            addNotification(`Search stopped: ${e instanceof Error ? e.message : String(e)}`, 'error')
        }
        if (run !== runId.current) return
        setResults(found)
        setProgress({ filesSearched, matches: found.length, files: matchedFiles.size, truncated, done: true })
        setSearching(false)
    }, [query, folder, options, include, exclude, addNotification, remember])

    const replaceText = useCallback((content: string, onlyAt?: SearchMatch): string | null => {
        const pattern = buildPattern(query, options)
        if (typeof pattern === 'string') return null
        const replaceWith = (m: string) => (keepCase && !options.regex ? preserveCase(m, replacement) : replacement)
        if (!onlyAt) {
            return options.regex ? content.replace(pattern, replacement) : content.replace(pattern, replaceWith)
        }
        const lines = content.split('\n')
        const rawLine = lines[onlyAt.line - 1]
        if (rawLine === undefined) return null
        const hasCr = rawLine.endsWith('\r')
        const line = hasCr ? rawLine.slice(0, -1) : rawLine
        const start = onlyAt.column - 1
        if (line.slice(start, start + onlyAt.matchText.length) !== onlyAt.matchText) return null
        let updated: string
        if (options.regex) {
            const exact = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'y')
            exact.lastIndex = start
            const matched = exact.exec(line)
            if (!matched || matched[0] !== onlyAt.matchText) return null
            exact.lastIndex = start
            updated = line.replace(exact, replacement)
        } else {
            updated = line.slice(0, start) + replaceWith(onlyAt.matchText) + line.slice(start + onlyAt.matchText.length)
        }
        lines[onlyAt.line - 1] = hasCr ? `${updated}\r` : updated
        return lines.join('\n')
    }, [query, options, replacement, keepCase])

    const isStale = lastSearch.current !== null && lastSearch.current !== signature

    const writeReplaced = useCallback(async (path: string, onlyAt?: SearchMatch): Promise<'replaced' | 'stale' | 'unchanged'> => {
        const api = window.electronAPI?.fs
        if (folderRef.current !== folder || lastSearch.current !== signature) return 'stale'
        const open = buffersRef.current?.files.find(file => samePath(file.path, path))
        const res = open ? { success: true, content: open.content } : await api?.readFile(path)
        if (folderRef.current !== folder) return 'stale'
        if (!res?.success || typeof res.content !== 'string') throw new Error(res?.error ?? `Could not read ${path}`)
        const next = replaceText(res.content, onlyAt)
        if (next === null || next === res.content) return 'unchanged'
        if (open) {
            buffersRef.current?.updateContent(open.path, next)
            return 'replaced'
        }
        const write = await api?.writeFile({ path, content: next, expectedContent: res.content })
        if (!write?.success && !write?.conflict) throw new Error(write?.error ?? `Could not save ${path}`)
        return write?.success ? 'replaced' : 'unchanged'
    }, [replaceText, folder, signature])

    const replaceOne = useCallback(async (match: SearchMatch) => {
        try {
            const outcome = await writeReplaced(match.filePath, match)
            if (outcome === 'replaced') {
                await search(undefined, { recordHistory: false })
            } else if (outcome === 'stale') {
                addNotification('Search criteria changed since the last search. Run search again before replacing.', 'warning')
            } else {
                addNotification('That match changed since the search. Search again to refresh.', 'warning')
            }
        } catch (error) {
            addNotification(`Replacement failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
        }
    }, [writeReplaced, search, addNotification])

    const replaceInFile = useCallback(async (path: string) => {
        if (lastSearch.current !== signature) {
            addNotification('Search criteria changed since the last search. Run search again before replacing.', 'warning')
            return
        }
        setReplacing(true)
        try {
            const outcome = await writeReplaced(path)
            if (outcome === 'replaced') {
                await search(undefined, { recordHistory: false })
            } else if (outcome === 'stale') {
                addNotification('Search criteria changed since the last search. Run search again before replacing.', 'warning')
            } else {
                addNotification('No matching text remained in that file. Search again to refresh.', 'warning')
            }
        } catch (error) {
            addNotification(`Replacement failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
        } finally {
            setReplacing(false)
        }
    }, [writeReplaced, search, signature, addNotification])

    const replaceAll = useCallback(async () => {
        if (lastSearch.current !== signature) {
            addNotification('Search criteria changed since the last search. Run search again before replacing.', 'warning')
            return
        }
        const files = Array.from(new Set(results.map(r => r.filePath)))
        if (files.length === 0) return
        const ok = await confirmAction({
            title: `Replace ${results.length} matches?`,
            message: `This changes ${files.length} file${files.length === 1 ? '' : 's'}. Open files are edited in the editor and remain unsaved. Closed files are updated on disk.`,
            confirmLabel: 'Replace all',
            danger: true
        })
        if (!ok) return
        setReplacing(true)
        let changed = 0
        try {
            for (const path of files) {
                if ((await writeReplaced(path)) === 'replaced') changed++
            }
            addNotification(
                `Replaced matches in ${changed} file${changed === 1 ? '' : 's'}.${changed < files.length ? ' Some files changed or could not be written; search again before retrying.' : ''}`,
                changed < files.length ? 'warning' : 'success'
            )
            await search(undefined, { recordHistory: false })
        } catch (error) {
            addNotification(`Replacement failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
        } finally {
            setReplacing(false)
        }
    }, [results, writeReplaced, search, signature, addNotification])

    const dismissMatch = useCallback((target: SearchMatch) => {
        setResults(prev => {
            const next = prev.filter(m => !(samePath(m.filePath, target.filePath) && m.line === target.line && m.column === target.column))
            const fileCount = new Set(next.map(m => normSlash(m.filePath))).size
            setProgress(p => (p ? { ...p, matches: next.length, files: fileCount } : p))
            return next
        })
    }, [])

    const dismissFile = useCallback((filePath: string) => {
        setResults(prev => {
            const next = prev.filter(m => !samePath(m.filePath, filePath))
            const fileCount = new Set(next.map(m => normSlash(m.filePath))).size
            setProgress(p => (p ? { ...p, matches: next.length, files: fileCount } : p))
            return next
        })
    }, [])

    return {
        query, setQuery, replacement, setReplacement, options, setOptions, keepCase, setKeepCase,
        include, setInclude, exclude, setExclude, results, progress, searching, replacing, error,
        history, isStale, search, stop, replaceOne, replaceInFile, replaceAll, dismissMatch, dismissFile,
        clear: () => { runId.current++; setResults([]); setProgress(null); setSearching(false); setError(null); lastSearch.current = null }
    }
}

export type WorkspaceSearchApi = ReturnType<typeof useWorkspaceSearch>

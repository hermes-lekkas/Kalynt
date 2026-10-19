/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Find and replace across the workspace, run in the renderer over the file
 * system API. Cancellable, capped, and remembers recent queries.
 */
import { useCallback, useRef, useState } from 'react'
import { useNotificationStore } from '../../../stores/notificationStore'
import { confirmAction } from '../../ui'
import {
    buildPattern, isBinaryFile, matchesInclude, preserveCase, splitList,
    type SearchMatch, type SearchOptions
} from './searchUtils'

const MAX_RESULTS = 2000
const MAX_FILE_BYTES = 1_500_000
const HISTORY_KEY = 'kalynt-search-history'

function loadHistory(): string[] {
    try {
        const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
        return Array.isArray(raw) ? raw.map((h: string | { query: string }) => (typeof h === 'string' ? h : h.query)).slice(0, 20) : []
    } catch {
        return []
    }
}

export interface SearchProgress {
    filesSearched: number
    matches: number
    files: number
    truncated: boolean
    done: boolean
}

export function useWorkspaceSearch(folder: string | null) {
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

    const remember = (q: string) => {
        setHistory(prev => {
            const next = [q, ...prev.filter(h => h !== q)].slice(0, 20)
            try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
            return next
        })
    }

    const stop = useCallback(() => {
        runId.current++
        setSearching(false)
        setProgress(p => (p ? { ...p, done: true } : p))
    }, [])

    const search = useCallback(async (overrideQuery?: string) => {
        const q = (overrideQuery ?? query).trim()
        if (!q || !folder) return
        const pattern = buildPattern(q, options)
        if (typeof pattern === 'string') {
            setError(pattern)
            return
        }
        const run = ++runId.current
        setError(null)
        setSearching(true)
        setResults([])
        remember(q)

        const includes = splitList(include)
        const excludes = new Set(splitList(exclude))
        const found: SearchMatch[] = []
        const matchedFiles = new Set<string>()
        let filesSearched = 0
        let truncated = false
        const api = window.electronAPI?.fs

        const searchFile = async (path: string, name: string) => {
            const res = await api?.readFile(path)
            if (!res?.success || typeof res.content !== 'string' || res.content.length > MAX_FILE_BYTES) return
            const lines: string[] = res.content.split('\n')
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i]
                pattern.lastIndex = 0
                let m: RegExpExecArray | null
                while ((m = pattern.exec(line)) !== null) {
                    if (m[0].length === 0) { pattern.lastIndex++; continue }
                    if (found.length >= MAX_RESULTS) { truncated = true; return }
                    matchedFiles.add(path)
                    found.push({
                        filePath: path, fileName: name, line: i + 1, column: m.index + 1, matchText: m[0],
                        // Short leading context keeps the match itself in view in a narrow side bar.
                        before: (m.index > 18 ? '…' : '') + line.slice(Math.max(0, m.index - 18), m.index).trimStart(),
                        after: line.slice(m.index + m[0].length, m.index + m[0].length + 80)
                    })
                }
            }
        }

        const walk = async (dir: string): Promise<void> => {
            if (run !== runId.current || truncated) return
            const res = await api?.readDir(dir)
            if (!res?.success || !res.items) return
            for (const entry of res.items as Array<{ name: string; path: string; isDirectory: boolean }>) {
                if (run !== runId.current || truncated) return
                const path = entry.path || `${dir}/${entry.name}`
                if (entry.isDirectory) {
                    if (!excludes.has(entry.name)) await walk(path)
                    continue
                }
                if (isBinaryFile(entry.name) || !matchesInclude(entry.name, includes)) continue
                await searchFile(path, entry.name)
                filesSearched++
                if (filesSearched % 40 === 0 && run === runId.current) {
                    setProgress({ filesSearched, matches: found.length, files: matchedFiles.size, truncated, done: false })
                    setResults([...found])
                }
            }
        }

        try {
            await walk(folder)
        } catch (e) {
            addNotification(`Search stopped: ${e instanceof Error ? e.message : String(e)}`, 'error')
        }
        if (run !== runId.current) return
        setResults(found)
        setProgress({ filesSearched, matches: found.length, files: matchedFiles.size, truncated, done: true })
        setSearching(false)
    }, [query, folder, options, include, exclude, addNotification])

    const replaceText = useCallback((content: string, onlyAt?: SearchMatch): string | null => {
        const pattern = buildPattern(query.trim(), options)
        if (typeof pattern === 'string') return null
        const replaceWith = (m: string) => (keepCase && !options.regex ? preserveCase(m, replacement) : replacement)
        if (!onlyAt) {
            return options.regex ? content.replace(pattern, replacement) : content.replace(pattern, replaceWith)
        }
        const lines = content.split('\n')
        const line = lines[onlyAt.line - 1]
        if (line === undefined) return null
        const start = onlyAt.column - 1
        if (line.slice(start, start + onlyAt.matchText.length) !== onlyAt.matchText) return null
        const single = options.regex ? onlyAt.matchText.replace(new RegExp(pattern.source, pattern.flags.replace('g', '')), replacement) : replaceWith(onlyAt.matchText)
        lines[onlyAt.line - 1] = line.slice(0, start) + single + line.slice(start + onlyAt.matchText.length)
        return lines.join('\n')
    }, [query, options, replacement, keepCase])

    const writeReplaced = useCallback(async (path: string, onlyAt?: SearchMatch): Promise<boolean> => {
        const api = window.electronAPI?.fs
        const res = await api?.readFile(path)
        if (!res?.success || typeof res.content !== 'string') return false
        const next = replaceText(res.content, onlyAt)
        if (next === null || next === res.content) return false
        const write = await api?.writeFile({ path, content: next })
        return !!write?.success
    }, [replaceText])

    const replaceOne = useCallback(async (match: SearchMatch) => {
        if (await writeReplaced(match.filePath, match)) await search()
        else addNotification('That match changed since the search. Search again to refresh.', 'warning')
    }, [writeReplaced, search, addNotification])

    const replaceInFile = useCallback(async (path: string) => {
        setReplacing(true)
        await writeReplaced(path)
        setReplacing(false)
        await search()
    }, [writeReplaced, search])

    const replaceAll = useCallback(async () => {
        const files = Array.from(new Set(results.map(r => r.filePath)))
        if (files.length === 0) return
        const ok = await confirmAction({
            title: `Replace ${results.length} matches?`,
            message: `This changes ${files.length} file${files.length === 1 ? '' : 's'} on disk. Open editors with unsaved changes keep their own text.`,
            confirmLabel: 'Replace all',
            danger: true
        })
        if (!ok) return
        setReplacing(true)
        let changed = 0
        for (const path of files) if (await writeReplaced(path)) changed++
        setReplacing(false)
        addNotification(`Replaced matches in ${changed} file${changed === 1 ? '' : 's'}.`, 'success')
        await search()
    }, [results, writeReplaced, search, addNotification])

    return {
        query, setQuery, replacement, setReplacement, options, setOptions, keepCase, setKeepCase,
        include, setInclude, exclude, setExclude, results, progress, searching, replacing, error,
        history, search, stop, replaceOne, replaceInFile, replaceAll,
        clear: () => { runId.current++; setResults([]); setProgress(null); setSearching(false) }
    }
}

export type WorkspaceSearchApi = ReturnType<typeof useWorkspaceSearch>

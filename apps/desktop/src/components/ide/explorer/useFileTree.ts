/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Lazily loaded folder tree. Children are cached per directory, so refreshing
 * keeps expanded folders open, generation guards prevent folder-switch races,
 * and deleted subtrees are pruned on `unlinkDir`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileSystemItem } from '../../../vite-env'
import { useFolderChanges } from '../hooks/folderWatcher'
import { dirName } from '../languages'

export interface TreeRow {
    item: FileSystemItem
    depth: number
    expanded: boolean
    loading: boolean
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

function sortItems(items: FileSystemItem[]): FileSystemItem[] {
    return [...items].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
}

export function useFileTree(folder: string | null) {
    const [children, setChildren] = useState<Map<string, FileSystemItem[]>>(new Map())
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const [loading, setLoading] = useState<Set<string>>(new Set())
    const [error, setError] = useState<string | null>(null)
    const childrenRef = useRef(children)
    childrenRef.current = children
    const expandedRef = useRef(expanded)
    expandedRef.current = expanded
    const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>())
    const generation = useRef(0)

    const root = folder ? norm(folder) : null

    const loadDir = useCallback(async (dir: string, gen = generation.current): Promise<FileSystemItem[]> => {
        const key = norm(dir)
        setLoading(prev => new Set(prev).add(key))
        try {
            const result = await window.electronAPI?.fs?.readDir(dir)
            if (gen !== generation.current) return []
            if (!result?.success) {
                if (key === root) setError(result?.error || 'This folder could not be read.')
                return []
            }
            const items = sortItems((result.items ?? []) as FileSystemItem[])
            setChildren(prev => new Map(prev).set(key, items))
            if (key === root) setError(null)
            return items
        } finally {
            if (gen === generation.current) {
                setLoading(prev => {
                    const next = new Set(prev)
                    next.delete(key)
                    return next
                })
            }
        }
    }, [root])

    useEffect(() => {
        const gen = ++generation.current
        pending.current.forEach(clearTimeout)
        pending.current.clear()
        setChildren(new Map())
        setExpanded(new Set())
        setLoading(new Set())
        setError(null)
        if (root) void loadDir(root, gen)
        return () => {
            generation.current++
            pending.current.forEach(clearTimeout)
            pending.current.clear()
        }
    }, [root, loadDir])

    const toggle = useCallback((dir: string) => {
        const key = norm(dir)
        if (expandedRef.current.has(key)) {
            setExpanded(prev => {
                const next = new Set(prev)
                next.delete(key)
                return next
            })
            return
        }
        setExpanded(prev => new Set(prev).add(key))
        if (!childrenRef.current.has(key)) void loadDir(key)
    }, [loadDir])

    const expand = useCallback(async (dir: string, gen = generation.current) => {
        const key = norm(dir)
        if (gen !== generation.current) return
        setExpanded(prev => new Set(prev).add(key))
        if (!childrenRef.current.has(key)) await loadDir(key, gen)
    }, [loadDir])

    const collapseAll = useCallback(() => setExpanded(new Set()), [])

    /** Reloads the root and every open folder without collapsing anything. */
    const refresh = useCallback(async () => {
        if (!root) return
        const gen = generation.current
        await Promise.all([root, ...Array.from(expandedRef.current)].map(dir => loadDir(dir, gen)))
    }, [root, loadDir])

    /** Opens every ancestor of `path` so it becomes visible. */
    const reveal = useCallback(async (path: string) => {
        if (!root) return
        const gen = generation.current
        const target = norm(path)
        if (!target.startsWith(root + '/') && target !== root) return
        const parts = target.slice(root.length).split('/').filter(Boolean)
        let current = root
        for (const part of parts.slice(0, -1)) {
            if (gen !== generation.current) return
            current = `${current}/${part}`
            await expand(current, gen)
        }
    }, [root, expand])

    // Reload only the parent folder of whatever changed, debounced per folder,
    // and prune deleted subtrees on `unlinkDir`.
    useFolderChanges(folder, change => {
        if (!['add', 'addDir', 'unlink', 'unlinkDir'].includes(change.event)) return
        const changedNorm = norm(change.path)

        if (change.event === 'unlinkDir') {
            const isUnder = (k: string) => k === changedNorm || k.startsWith(changedNorm + '/')
            pending.current.forEach((timer, key) => {
                if (isUnder(key)) {
                    clearTimeout(timer)
                    pending.current.delete(key)
                }
            })
            setChildren(prev => {
                let mutated = false
                const next = new Map(prev)
                for (const key of next.keys()) {
                    if (isUnder(key)) {
                        next.delete(key)
                        mutated = true
                    }
                }
                return mutated ? next : prev
            })
            setExpanded(prev => {
                let mutated = false
                const next = new Set(prev)
                for (const key of next) {
                    if (isUnder(key)) {
                        next.delete(key)
                        mutated = true
                    }
                }
                return mutated ? next : prev
            })
        }

        const parent = norm(dirName(changedNorm))
        if (!childrenRef.current.has(parent)) return
        const gen = generation.current
        const timers = pending.current
        const existing = timers.get(parent)
        if (existing) clearTimeout(existing)
        timers.set(parent, setTimeout(() => {
            timers.delete(parent)
            if (gen === generation.current) void loadDir(parent, gen)
        }, 250))
    })

    const rows = useMemo<TreeRow[]>(() => {
        if (!root) return []
        const out: TreeRow[] = []
        const walk = (dir: string, depth: number) => {
            for (const item of children.get(dir) ?? []) {
                const key = norm(item.path)
                const isOpen = item.isDirectory && expanded.has(key)
                out.push({ item, depth, expanded: isOpen, loading: loading.has(key) })
                if (isOpen) walk(key, depth + 1)
            }
        }
        walk(root, 0)
        return out
    }, [root, children, expanded, loading])

    return {
        rows, error, rootLoading: !!root && loading.has(root) && !children.has(root),
        toggle, expand, collapseAll, refresh, reveal, isExpanded: (p: string) => expanded.has(norm(p))
    }
}

export type FileTreeApi = ReturnType<typeof useFileTree>

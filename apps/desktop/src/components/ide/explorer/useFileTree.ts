/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Lazily loaded folder tree. Children are cached per directory, so refreshing
 * keeps expanded folders open, and file-system events reload only the folder
 * that changed.
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

    const root = folder ? norm(folder) : null

    const loadDir = useCallback(async (dir: string): Promise<FileSystemItem[]> => {
        const key = norm(dir)
        setLoading(prev => new Set(prev).add(key))
        try {
            const result = await window.electronAPI?.fs?.readDir(dir)
            if (!result?.success) {
                if (key === root) setError(result?.error || 'This folder could not be read.')
                return []
            }
            const items = sortItems((result.items ?? []) as FileSystemItem[])
            setChildren(prev => new Map(prev).set(key, items))
            if (key === root) setError(null)
            return items
        } finally {
            setLoading(prev => {
                const next = new Set(prev)
                next.delete(key)
                return next
            })
        }
    }, [root])

    useEffect(() => {
        setChildren(new Map())
        setExpanded(new Set())
        setError(null)
        if (root) loadDir(root)
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
        if (!childrenRef.current.has(key)) loadDir(key)
    }, [loadDir])

    const expand = useCallback(async (dir: string) => {
        const key = norm(dir)
        setExpanded(prev => new Set(prev).add(key))
        if (!childrenRef.current.has(key)) await loadDir(key)
    }, [loadDir])

    const collapseAll = useCallback(() => setExpanded(new Set()), [])

    /** Reloads the root and every open folder without collapsing anything. */
    const refresh = useCallback(async () => {
        if (!root) return
        await Promise.all([root, ...Array.from(expandedRef.current)].map(dir => loadDir(dir)))
    }, [root, loadDir])

    /** Opens every ancestor of `path` so it becomes visible. */
    const reveal = useCallback(async (path: string) => {
        if (!root) return
        const target = norm(path)
        if (!target.startsWith(root)) return
        const parts = target.slice(root.length).split('/').filter(Boolean)
        let current = root
        for (const part of parts.slice(0, -1)) {
            current = `${current}/${part}`
            await expand(current)
        }
    }, [root, expand])

    // Reload only the parent folder of whatever changed, debounced per folder.
    useFolderChanges(folder, change => {
        if (!['add', 'addDir', 'unlink', 'unlinkDir'].includes(change.event)) return
        const parent = norm(dirName(norm(change.path)))
        if (!childrenRef.current.has(parent)) return
        const timers = pending.current
        const existing = timers.get(parent)
        if (existing) clearTimeout(existing)
        timers.set(parent, setTimeout(() => {
            timers.delete(parent)
            loadDir(parent)
        }, 250))
    })

    useEffect(() => () => pending.current.forEach(clearTimeout), [])

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

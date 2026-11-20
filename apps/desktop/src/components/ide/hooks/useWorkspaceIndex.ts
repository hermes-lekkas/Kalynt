/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * A flat list of files in the workspace for "Go to file", Explorer filter, and
 * @-mentions. Prefers the fast main-process `agent.glob` scan (which respects
 * `.gitignore` via `git ls-files`), falling back safely to `fs.readDir`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileItem } from '../../../types/ide'
import type { FileSystemItem } from '../../../vite-env'
import { useCommandStore } from '../../../stores/commandStore'
import { baseName } from '../languages'
import { useFolderChanges } from './folderWatcher'

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'target', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.turbo'])
const MAX_FILES = 20000
const MAX_DEPTH = 14

function joinPath(root: string, rel: string): string {
    const cleanRoot = root.replace(/[\\/]+$/, '')
    const cleanRel = rel.replace(/\\/g, '/').replace(/^\/+/, '')
    return `${cleanRoot}/${cleanRel}`
}

async function collectViaGlob(root: string): Promise<FileItem[] | null> {
    const glob = window.electronAPI?.agent?.glob
    if (typeof glob !== 'function') return null
    try {
        const res = await glob({ pattern: '**/*', path: root, limit: 1000 })
        if (!res?.ok || !Array.isArray(res.files)) return null
        // If truncated on a huge repo, still return the fast 1000 most-recent files
        // rather than blocking the renderer with thousands of IPC readDir calls.
        const items: FileItem[] = []
        const seenDirs = new Set<string>()
        for (const rel of res.files) {
            const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '')
            if (!norm) continue
            const segments = norm.split('/')
            let dirAccum = ''
            for (let i = 0; i < segments.length - 1; i++) {
                dirAccum = dirAccum ? `${dirAccum}/${segments[i]}` : segments[i]
                if (!seenDirs.has(dirAccum)) {
                    seenDirs.add(dirAccum)
                    items.push({ path: joinPath(root, dirAccum), name: segments[i], type: 'directory' })
                }
            }
            items.push({ path: joinPath(root, norm), name: baseName(norm), type: 'file' })
        }
        return items
    } catch {
        return null
    }
}

async function collectViaReadDir(root: string): Promise<FileItem[]> {
    const items: FileItem[] = []
    const walk = async (dir: string, depth: number) => {
        if (items.length >= MAX_FILES || depth > MAX_DEPTH) return
        const result = await window.electronAPI?.fs?.readDir(dir)
        if (!result?.success || !result.items) return
        for (const entry of result.items as FileSystemItem[]) {
            if (items.length >= MAX_FILES) return
            if (IGNORED.has(entry.name)) continue
            const path = entry.path || `${dir}/${entry.name}`
            if (entry.isDirectory) {
                items.push({ path, name: entry.name, type: 'directory' })
                await walk(path, depth + 1)
            } else {
                items.push({ path, name: entry.name, type: 'file' })
            }
        }
    }
    await walk(root, 0)
    return items
}

async function collect(root: string): Promise<FileItem[]> {
    const fast = await collectViaGlob(root)
    if (fast !== null) return fast
    return collectViaReadDir(root)
}

export function useWorkspaceIndex(folder: string | null, openFile: (path: string) => void) {
    const [files, setFiles] = useState<FileItem[]>([])
    const setPaletteFiles = useCommandStore(s => s.setFiles)
    const clearPaletteFiles = useCommandStore(s => s.clearFiles)
    const generation = useRef(0)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

    const reindex = useCallback(async () => {
        const run = ++generation.current
        if (!folder) {
            setFiles([])
            return
        }
        const next = await collect(folder)
        if (run === generation.current) setFiles(next)
    }, [folder])

    useEffect(() => {
        if (timer.current) {
            clearTimeout(timer.current)
            timer.current = null
        }
        void reindex()
        return () => {
            generation.current++
            if (timer.current) {
                clearTimeout(timer.current)
                timer.current = null
            }
        }
    }, [reindex])

    // Structural changes only; content edits don't change the list.
    useFolderChanges(folder, change => {
        if (!['add', 'addDir', 'unlink', 'unlinkDir'].includes(change.event)) return
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
            timer.current = null
            void reindex()
        }, 600)
    })

    const openRef = useRef(openFile)
    openRef.current = openFile
    useEffect(() => {
        setPaletteFiles(files, folder, path => openRef.current(path))
    }, [files, folder, setPaletteFiles])

    useEffect(() => () => clearPaletteFiles(), [clearPaletteFiles])

    return { files, reindex }
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * A flat list of files in the workspace for "Go to file" and @-mentions.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileItem } from '../../../types/ide'
import type { FileSystemItem } from '../../../vite-env'
import { useCommandStore } from '../../../stores/commandStore'
import { useFolderChanges } from './folderWatcher'

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'target', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.turbo'])
const MAX_FILES = 20000
const MAX_DEPTH = 14

async function collect(root: string): Promise<FileItem[]> {
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
        reindex()
    }, [reindex])

    // Structural changes only; content edits don't change the list.
    useFolderChanges(folder, change => {
        if (!['add', 'addDir', 'unlink', 'unlinkDir'].includes(change.event)) return
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(reindex, 600)
    })

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

    const openRef = useRef(openFile)
    openRef.current = openFile
    useEffect(() => {
        setPaletteFiles(files, folder, path => openRef.current(path))
    }, [files, folder, setPaletteFiles])

    useEffect(() => () => clearPaletteFiles(), [clearPaletteFiles])

    return { files, reindex }
}

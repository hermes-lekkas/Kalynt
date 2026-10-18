/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * One file-system watcher per workspace folder, shared by every region that
 * needs change events (explorer, source control, file index).
 */
import { useEffect, useRef } from 'react'

export interface FsChange {
    event: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir' | string
    path: string
}

type Listener = (change: FsChange) => void

interface Watch {
    folder: string
    id: string
    refs: number
    listeners: Set<Listener>
    off?: () => void
}

let active: Watch | null = null

function start(folder: string): Watch {
    if (active && active.folder === folder) return active
    if (active) stop(active)
    const watch: Watch = { folder, id: `kalynt-watch-${Date.now()}`, refs: 0, listeners: new Set() }
    const api = window.electronAPI
    api?.fs?.watchDir?.({ id: watch.id, dirPath: folder })
    const off = api?.fs?.onChange?.((data: { id: string; event: string; path: string }) => {
        if (data.id !== watch.id) return
        watch.listeners.forEach(listener => listener({ event: data.event, path: data.path }))
    })
    if (typeof off === 'function') watch.off = off
    active = watch
    return watch
}

function stop(watch: Watch) {
    watch.off?.()
    window.electronAPI?.fs?.unwatchDir?.(watch.id)
    if (active === watch) active = null
}

/** Subscribes to changes inside `folder` for as long as the component is mounted. */
export function useFolderChanges(folder: string | null, listener: Listener) {
    const listenerRef = useRef(listener)
    listenerRef.current = listener

    useEffect(() => {
        if (!folder) return
        const watch = start(folder)
        const relay: Listener = change => listenerRef.current(change)
        watch.listeners.add(relay)
        watch.refs += 1
        return () => {
            watch.listeners.delete(relay)
            watch.refs -= 1
            // Defer so a remount in the same tick doesn't restart the watcher.
            setTimeout(() => { if (watch.refs <= 0) stop(watch) }, 0)
        }
    }, [folder])
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Detects installed language runtimes and installs or removes the ones
 * Kalynt manages, with live progress and logs.
 */
import { useCallback, useEffect, useState } from 'react'
import { useNotificationStore } from '../../stores/notificationStore'
import { confirmAction } from '../ui'
import { RUNTIME_CATALOG, type RuntimeEntry } from './runtimeCatalog'

export interface RuntimeState {
    installed: boolean
    version?: string
    managed?: boolean
}

export interface InstallProgress {
    phase: 'downloading' | 'installing' | 'completed' | 'failed'
    fraction?: number
    speed?: number
    message?: string
}

const mgmt = () => window.electronAPI?.runtimeMgmt

export function useRuntimes() {
    const addNotification = useNotificationStore(s => s.addNotification)
    const [states, setStates] = useState<Record<string, RuntimeState>>({})
    const [checking, setChecking] = useState(false)
    const [progress, setProgress] = useState<Record<string, InstallProgress>>({})
    const [logs, setLogs] = useState<Record<string, string[]>>({})
    // What this machine's Kalynt can install by itself; everything else links to its download page.
    const [installable, setInstallable] = useState<Set<string>>(new Set())
    const canInstall = useCallback((rt: RuntimeEntry) => installable.has(rt.id), [installable])

    useEffect(() => {
        mgmt()?.installable?.().then((r: { success?: boolean; runtimes?: string[] }) => {
            if (r?.success && Array.isArray(r.runtimes)) setInstallable(new Set(r.runtimes))
        }).catch(() => undefined)
    }, [])

    const check = useCallback(async () => {
        setChecking(true)
        const entries = await Promise.all(RUNTIME_CATALOG.map(async (rt): Promise<[string, RuntimeState]> => {
            if (rt.builtIn) return [rt.id, { installed: true }]
            try {
                const r = await mgmt()?.check?.(rt.id)
                if (r?.success && (r.isInstalled || r.installed)) return [rt.id, { installed: true, version: r.version, managed: r.managedByKalynt }]
            } catch { /* treat as missing */ }
            return [rt.id, { installed: false }]
        }))
        setStates(Object.fromEntries(entries))
        setChecking(false)
    }, [])

    useEffect(() => {
        check()
        const offs: Array<unknown> = [
            mgmt()?.onDownloadProgress?.((p: { runtimeId: string; bytesDownloaded?: number; totalBytes?: number; progress?: number; speed: number }) => {
                const fraction = p.totalBytes ? (p.bytesDownloaded ?? 0) / p.totalBytes : p.progress !== undefined ? p.progress / 100 : undefined
                setProgress(prev => ({ ...prev, [p.runtimeId]: { phase: 'downloading', fraction, speed: p.speed } }))
            }),
            mgmt()?.onStatus?.((s: { runtimeId: string; status: InstallProgress['phase']; message?: string; error?: string }) => {
                setProgress(prev => ({ ...prev, [s.runtimeId]: { ...prev[s.runtimeId], phase: s.status, message: s.error || s.message } }))
                if (s.status === 'completed') setTimeout(check, 800)
            }),
            mgmt()?.onLog?.((l: { runtimeId: string; message: string }) => {
                setLogs(prev => ({ ...prev, [l.runtimeId]: [...(prev[l.runtimeId] ?? []), l.message].slice(-200) }))
            })
        ]
        return () => {
            offs.forEach(off => { if (typeof off === 'function') off() })
            mgmt()?.removeListeners?.()
        }
    }, [check])

    const install = useCallback(async (rt: RuntimeEntry) => {
        setLogs(prev => ({ ...prev, [rt.id]: [] }))
        setProgress(prev => ({ ...prev, [rt.id]: { phase: 'downloading' } }))
        if (!installable.has(rt.id) || !mgmt()?.downloadAndInstall) {
            window.electronAPI?.shell?.openExternal?.(rt.downloadUrl)
            setProgress(prev => { const next = { ...prev }; delete next[rt.id]; return next })
            return
        }
        try {
            const r = await mgmt().downloadAndInstall(rt.id)
            if (!r?.success) {
                setProgress(prev => ({ ...prev, [rt.id]: { phase: 'failed', message: r?.error } }))
                addNotification(`Couldn't install ${rt.name}: ${r?.error || 'unknown error'}`, 'error')
            }
        } catch (e) {
            setProgress(prev => ({ ...prev, [rt.id]: { phase: 'failed', message: e instanceof Error ? e.message : String(e) } }))
        }
    }, [addNotification, installable])

    const uninstall = useCallback(async (rt: RuntimeEntry) => {
        const ok = await confirmAction({
            title: `Uninstall ${rt.name}?`,
            message: 'Kalynt removes the copy it installed. Other installs on this machine are not touched.',
            confirmLabel: 'Uninstall',
            danger: true
        })
        if (!ok) return
        const r = await mgmt()?.uninstall?.(rt.id)
        if (r?.success) {
            addNotification(`Uninstalled ${rt.name}`, 'info')
            check()
        } else {
            addNotification(`Couldn't uninstall ${rt.name}: ${r?.error || 'unknown error'}`, 'error')
        }
    }, [addNotification, check])

    return { states, checking, progress, logs, check, install, uninstall, canInstall }
}

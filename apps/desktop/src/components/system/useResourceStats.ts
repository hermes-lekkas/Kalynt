/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useState } from 'react'
import { hardwareService, type RealTimeStats } from '../../services/hardwareService'

export interface ResourceSnapshot {
    cpu: number | null
    ramUsedMB: number | null
    ramTotalMB: number | null
    gpu: number | null
    vramUsedMB: number | null
    vramTotalMB: number | null
    diskUsedMB: number | null
    diskTotalMB: number | null
    appMemoryMB: number | null
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function toSnapshot(stats: Partial<RealTimeStats> | null | undefined, appMemoryMB: number | null): ResourceSnapshot {
    return {
        cpu: num(stats?.cpuUsage),
        ramUsedMB: num(stats?.ramUsage),
        ramTotalMB: num(stats?.ramTotal),
        gpu: num(stats?.gpuUsage),
        vramUsedMB: num(stats?.vramUsage),
        vramTotalMB: num(stats?.vramTotal),
        diskUsedMB: num(stats?.diskUsage),
        diskTotalMB: num(stats?.diskTotal),
        appMemoryMB
    }
}

/** Polls machine stats while the window is visible. Missing values stay null. */
export function useResourceStats(intervalMs = 3000): ResourceSnapshot | null {
    const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null)

    useEffect(() => {
        if (window.electronAPI?.platform === 'browser') return
        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | null = null

        const tick = async () => {
            if (document.hidden) {
                timer = setTimeout(tick, intervalMs)
                return
            }
            try {
                const [stats, status] = await Promise.all([
                    hardwareService.getRealTimeStats(),
                    window.electronAPI?.ipcRenderer?.invoke('performance:get-status').catch(() => null)
                ])
                const rss = num(status?.memory?.rss)
                if (!cancelled) setSnapshot(toSnapshot(stats, rss))
            } catch {
                if (!cancelled) setSnapshot(toSnapshot(null, null))
            }
            if (!cancelled) timer = setTimeout(tick, intervalMs)
        }

        tick()
        return () => {
            cancelled = true
            if (timer) clearTimeout(timer)
        }
    }, [intervalMs])

    return snapshot
}

export function formatMB(mb: number | null): string {
    if (mb === null) return '–'
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

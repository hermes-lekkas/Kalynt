/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { Popover, ProgressBar } from '../ui'
import { formatMB, useResourceStats } from './useResourceStats'
import './system.css'

function ratio(used: number | null, total: number | null): number | undefined {
    if (used === null || total === null || total <= 0) return undefined
    return used / total
}

/** Status-bar readout of CPU and memory with a details popover. */
export function ResourceMeter() {
    const stats = useResourceStats()
    const triggerRef = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const setShowSettings = useAppStore(s => s.setShowSettings)
    const setSettingsTab = useAppStore(s => s.setSettingsTab)

    if (!stats) return null
    const ram = ratio(stats.ramUsedMB, stats.ramTotalMB)
    const high = (stats.cpu ?? 0) > 90 || (ram ?? 0) > 0.9

    const rows: Array<{ label: string; value: string; fraction?: number }> = [
        { label: 'Processor', value: stats.cpu === null ? '–' : `${Math.round(stats.cpu)}%`, fraction: stats.cpu === null ? undefined : stats.cpu / 100 },
        { label: 'Memory', value: `${formatMB(stats.ramUsedMB)} of ${formatMB(stats.ramTotalMB)}`, fraction: ram },
        ...(stats.vramTotalMB ? [{ label: 'Graphics memory', value: `${formatMB(stats.vramUsedMB)} of ${formatMB(stats.vramTotalMB)}`, fraction: ratio(stats.vramUsedMB, stats.vramTotalMB) }] : []),
        ...(stats.gpu !== null && stats.vramTotalMB ? [{ label: 'Graphics', value: `${Math.round(stats.gpu)}%`, fraction: stats.gpu / 100 }] : []),
        ...(stats.diskTotalMB ? [{ label: 'Disk', value: `${formatMB(stats.diskUsedMB)} of ${formatMB(stats.diskTotalMB)}`, fraction: ratio(stats.diskUsedMB, stats.diskTotalMB) }] : [])
    ]

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                className={`statusbar__item ${high ? 'is-warning' : ''}`}
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                title="System resources"
            >
                <Activity size={12} aria-hidden />
                <span>CPU {stats.cpu === null ? '–' : `${Math.round(stats.cpu)}%`}</span>
                <span>RAM {ram === undefined ? '–' : `${Math.round(ram * 100)}%`}</span>
            </button>
            <Popover open={open} onClose={() => setOpen(false)} anchor={triggerRef.current} placement="top-end" width={300} ariaLabel="System resources">
                <div className="resource-pop">
                    {rows.map(row => (
                        <div key={row.label} className="resource-pop__row">
                            <div className="resource-pop__line">
                                <span>{row.label}</span>
                                <span className="resource-pop__value">{row.value}</span>
                            </div>
                            {row.fraction !== undefined && (
                                <ProgressBar value={row.fraction} tone={row.fraction > 0.9 ? 'danger' : 'neutral'} label={row.label} />
                            )}
                        </div>
                    ))}
                    {stats.appMemoryMB !== null && (
                        <p className="resource-pop__note">Kalynt is using {formatMB(stats.appMemoryMB)}.</p>
                    )}
                    <button
                        type="button"
                        className="resource-pop__link"
                        onClick={() => { setOpen(false); setSettingsTab('performance'); setShowSettings(true) }}
                    >
                        Performance settings
                    </button>
                </div>
            </Popover>
        </>
    )
}

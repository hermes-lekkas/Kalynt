/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useState } from 'react'
import { performanceDiagnosticService, type DiagnosticResult } from '../../services/performanceDiagnosticService'
import { Button, ProgressBar, Select } from '../ui'
import { AimeSettings } from './AimeSettings'
import { SettingRow, SettingsPage, SettingsSection } from './parts'

type Mode = 'balanced' | 'high_performance' | 'power_saver'
const POINTS = 40

function Sparkline({ values }: { values: number[] }) {
    if (values.length < 2) return <p className="set-note">Collecting memory readings…</p>
    const max = Math.max(...values)
    const min = Math.min(...values)
    const range = Math.max(max - min, 1)
    const points = values.map((v, i) => `${(i / (values.length - 1)) * 300},${54 - ((v - min) / range) * 46}`).join(' ')
    return (
        <svg className="sparkline" viewBox="0 0 300 60" preserveAspectRatio="none" role="img" aria-label={`Kalynt memory use, between ${min} and ${max} MB recently`}>
            <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
    )
}

export default function PerformanceSettings() {
    const [history, setHistory] = useState<number[]>([])
    const [rss, setRss] = useState<number | null>(null)
    const [mode, setMode] = useState<Mode | null>(null)
    const [running, setRunning] = useState(false)
    const [progress, setProgress] = useState(0)
    const [result, setResult] = useState<DiagnosticResult | null>(null)
    const invoke = window.electronAPI?.ipcRenderer?.invoke

    useEffect(() => {
        let active = true
        const poll = async () => {
            try {
                const status = await invoke?.('performance:get-status')
                if (!active || !status?.memory) return
                setRss(status.memory.rss)
                if (status.memory.mode) setMode(status.memory.mode)
                setHistory(prev => [...prev, status.memory.rss].slice(-POINTS))
            } catch { /* not available in this build */ }
        }
        poll()
        const timer = setInterval(poll, 3000)
        return () => { active = false; clearInterval(timer) }
    }, [invoke])

    const changeMode = async (next: Mode) => {
        setMode(next)
        await invoke?.('performance:set-mode', next)
    }

    const diagnose = async () => {
        setRunning(true)
        setProgress(0.1)
        try {
            const cpu = await performanceDiagnosticService.runCPUBenchmark()
            setProgress(0.45)
            const ipc = await performanceDiagnosticService.measureIPCLatency()
            setProgress(0.7)
            const disk = await performanceDiagnosticService.measureDiskSpeed()
            setProgress(0.9)
            const bootTime = await invoke?.('performance:get-boot-time')
            setResult({
                bootTime: bootTime || 0,
                ipcLatency: Math.round(ipc * 100) / 100,
                diskReadSpeed: Math.round(disk.read * 10) / 10,
                diskWriteSpeed: Math.round(disk.write * 10) / 10,
                cpuScore: cpu,
                timestamp: Date.now()
            })
            setProgress(1)
        } finally {
            setTimeout(() => { setRunning(false); setProgress(0) }, 300)
        }
    }

    return (
        <SettingsPage title="Performance">
            <SettingsSection title="Memory" description={rss !== null ? `Kalynt is using ${rss >= 1024 ? `${(rss / 1024).toFixed(1)} GB` : `${rss} MB`} across all of its processes.` : 'Memory use appears here in the desktop app.'}>
                <Sparkline values={history} />
                <SettingRow
                    label="Power mode"
                    description="Power saver frees memory more aggressively; high performance keeps more cached."
                    htmlFor="perf-mode"
                    control={
                        <Select id="perf-mode" size="sm" value={mode ?? 'balanced'} onChange={e => changeMode(e.target.value as Mode)} disabled={!invoke}>
                            <option value="balanced">Balanced</option>
                            <option value="high_performance">High performance</option>
                            <option value="power_saver">Power saver</option>
                        </Select>
                    }
                />
            </SettingsSection>

            <SettingsSection
                title="Speed check"
                description="Measures processor speed, how quickly the interface talks to the background process, and disk speed."
                actions={<Button size="sm" loading={running} onClick={diagnose}>{result ? 'Run again' : 'Run check'}</Button>}
            >
                {running && <ProgressBar value={progress} tone="agent" label="Speed check progress" />}
                {result && !running && (
                    <dl className="perf-results">
                        <div><dt>Start-up time</dt><dd>{result.bootTime ? `${(result.bootTime / 1000).toFixed(1)} s` : '–'}</dd></div>
                        <div><dt>Interface response</dt><dd>{result.ipcLatency} ms</dd></div>
                        <div><dt>Processor score</dt><dd>{result.cpuScore}</dd></div>
                        <div><dt>Disk read</dt><dd>{result.diskReadSpeed} MB/s</dd></div>
                        <div><dt>Disk write</dt><dd>{result.diskWriteSpeed} MB/s</dd></div>
                    </dl>
                )}
            </SettingsSection>

            <AimeSettings />
        </SettingsPage>
    )
}

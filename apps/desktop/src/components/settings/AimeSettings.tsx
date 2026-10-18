/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * How local models use memory and hardware (AIME). Every setting here reaches
 * the engine on the next model load; the MemoryGuard ones keep the machine
 * from swapping while a model is resident. Saved settings apply the next time
 * a model is loaded.
 */
import { useEffect, useState } from 'react'
import { hardwareService } from '../../services/hardwareService'
import type { AIMEConfig, HardwareInfo, OffloadingStrategy } from '../../types/aime'
import { AIME_PRESETS, DEFAULT_AIME_CONFIG, calculateAIMERAMUsage, recommendAIMESettings } from '../../types/aime'
import { Button, Select, Spinner, Switch, confirmAction } from '../ui'
import { SavedNote, SettingRow, SettingsSection } from './parts'

const KEY = 'aime-config'
const IDLE_OPTIONS = [
    { value: 0, label: 'Never' },
    { value: 5, label: 'After 5 minutes' },
    { value: 10, label: 'After 10 minutes' },
    { value: 15, label: 'After 15 minutes' },
    { value: 30, label: 'After 30 minutes' }
]

function loadConfig(): AIMEConfig | null {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null') } catch { return null }
}

export function AimeSettings() {
    const [hardware, setHardware] = useState<HardwareInfo | null>(null)
    const [config, setConfig] = useState<AIMEConfig>(() => loadConfig() ?? DEFAULT_AIME_CONFIG)
    const [loading, setLoading] = useState(true)
    const [saved, setSaved] = useState(false)

    useEffect(() => {
        let cancelled = false
        Promise.race([
            hardwareService.getHardwareInfo(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ]).then(hw => {
            if (cancelled) return
            setHardware(hw)
            if (!loadConfig()) setConfig(recommendAIMESettings(hw))
        }).catch(() => undefined).finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [])

    const set = (patch: Partial<AIMEConfig>) => setConfig(c => ({ ...c, ...patch }))

    const applyPreset = async (name: string) => {
        if (name === 'auto') {
            if (hardware) setConfig(recommendAIMESettings(hardware))
            return
        }
        const preset = AIME_PRESETS.find(p => p.name === name)
        if (!preset) return
        if (preset.name.includes('Maximum') && hardware && hardware.totalRAM < 12288) {
            const ok = await confirmAction({
                title: 'Use the maximum quality preset?',
                message: `It is meant for machines with 16 GB of memory or more; this one has about ${Math.round(hardware.totalRAM / 1024)} GB. Models may load slowly or fail.`,
                confirmLabel: 'Use it anyway'
            })
            if (!ok) return
        }
        setConfig(preset.config)
    }

    const save = () => {
        localStorage.setItem(KEY, JSON.stringify(config))
        setSaved(true)
        setTimeout(() => setSaved(false), 1800)
    }

    if (loading) return <SettingsSection title="Local model memory"><Spinner label="Detecting hardware" /></SettingsSection>

    const estimate = calculateAIMERAMUsage(7700, config.maxContextTokens, config.flashAttention)

    return (
        <SettingsSection
            title="Local model memory"
            description={hardware
                ? `${hardware.cpuModel}, ${hardware.cpuCores} cores, ${Math.round(hardware.totalRAM / 1024)} GB memory${hardware.hasGPU ? `, ${hardware.gpuName ?? 'GPU'}` : ', no GPU detected'}.`
                : 'Controls how local models use memory and hardware.'}
            actions={<><SavedNote show={saved} /><Button size="sm" variant="primary" onClick={save}>Save</Button></>}
        >
            <SettingRow
                label="Preset"
                description="A starting point you can adjust below."
                control={
                    <Select size="sm" aria-label="Preset" defaultValue="" onChange={e => { applyPreset(e.target.value); e.target.value = '' }}>
                        <option value="" disabled>Choose…</option>
                        <option value="auto">Recommended for this machine</option>
                        {AIME_PRESETS.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                    </Select>
                }
            />
            <SettingRow
                label="Fast attention kernel"
                description="Flash attention: slightly faster generation and a slightly smaller memory footprint. Turn it off if a model misbehaves."
                control={<Switch label="Fast attention kernel" checked={config.flashAttention} onChange={v => set({ flashAttention: v })} />}
            />
            <SettingRow
                label="Graphics card"
                htmlFor="aime-offload"
                control={
                    <Select id="aime-offload" size="sm" value={config.offloadingStrategy} onChange={e => set({ offloadingStrategy: e.target.value as OffloadingStrategy })}>
                        <option value="auto">Decide automatically</option>
                        <option value="gpu-only" disabled={!hardware?.hasGPU}>Graphics card only</option>
                        <option value="balanced" disabled={!hardware?.hasGPU}>Split with processor</option>
                        <option value="cpu-only">Processor only</option>
                        <option value="custom">Custom layers</option>
                    </Select>
                }
            />
            {config.offloadingStrategy === 'custom' && (
                <SettingRow
                    label={`Layers on the graphics card: ${config.gpuLayers}`}
                    htmlFor="aime-layers"
                    control={<input id="aime-layers" className="set-range" type="range" min={0} max={64} value={config.gpuLayers} onChange={e => set({ gpuLayers: Number(e.target.value) })} />}
                />
            )}
            <SettingRow
                label={`Context window: ${config.maxContextTokens.toLocaleString()} tokens`}
                description={`Estimated memory for a 7B model at Q8: ${estimate.toLocaleString()} MB.`}
                htmlFor="aime-context"
                control={<input id="aime-context" className="set-range" type="range" min={1024} max={32768} step={1024} value={config.maxContextTokens} onChange={e => set({ maxContextTokens: Number(e.target.value) })} />}
            />
            <SettingRow
                label="Shrink the context to fit free memory"
                description="When loading, the context is reduced to what the machine can actually hold — before anything slows down or crashes."
                control={<Switch label="Shrink the context to fit free memory" checked={config.autoContextCap} onChange={v => set({ autoContextCap: v })} />}
            />
            <SettingRow
                label={`Processor threads: ${config.threads === 0 ? 'Automatic' : config.threads}`}
                description="Automatic uses every performance core, which is fastest on most machines."
                htmlFor="aime-threads"
                control={<input id="aime-threads" className="set-range" type="range" min={0} max={hardware?.cpuCores || 8} value={config.threads} onChange={e => set({ threads: Number(e.target.value) })} />}
            />
            <SettingRow
                label={`Batch size: ${config.batchSize}`}
                htmlFor="aime-batch"
                control={<input id="aime-batch" className="set-range" type="range" min={128} max={2048} step={128} value={config.batchSize} onChange={e => set({ batchSize: Number(e.target.value) })} />}
            />
            <SettingRow
                label={`Keep this much memory free: ${config.reservedRAM} MB`}
                description="The MemoryGuard frees the model when free memory falls below this, so the system never starts swapping."
                htmlFor="aime-reserved"
                control={<input id="aime-reserved" className="set-range" type="range" min={256} max={4096} step={128} value={config.reservedRAM} onChange={e => set({ reservedRAM: Number(e.target.value) })} />}
            />
            <SettingRow
                label="Unload when memory runs low"
                description={`Enabled: the model is freed (and any generation stopped) when free memory drops under ${config.reservedRAM} MB.`}
                control={<Switch label="Unload when memory runs low" checked={config.emergencyUnload} onChange={v => set({ emergencyUnload: v })} />}
            />
            <SettingRow
                label="Unload the model when idle"
                description="Frees memory while you are not using local AI; the model reloads the next time you need it."
                control={
                    <Select size="sm" aria-label="Idle unload" value={config.idleUnloadMinutes} onChange={e => set({ idleUnloadMinutes: Number(e.target.value) })}>
                        {IDLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </Select>
                }
            />
        </SettingsSection>
    )
}

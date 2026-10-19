/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Model and reasoning effort for the agent, plus how much it may do without
 * asking (agent mode).
 */
import { useRef, useState } from 'react'
import { Check, ChevronDown, Cloud, Cpu, Loader2, ShieldCheck } from 'lucide-react'
import { useAppStore } from '../../../stores/appStore'
import type { Effort } from '../../../types/aiProtocol'
import { providerInfo } from '../../../types/aiProviders'
import { AGENT_MODES, type AgentMode } from '../../../services/agent/approvals'
import { Popover } from '../../ui'
import { localModelName } from './modelNames'
import type { ModelChoiceApi } from './useModelChoice'

const EFFORTS: Array<{ id: Effort; label: string }> = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'max', label: 'Max' }
]

export function ModelPicker({ model }: { model: ModelChoiceApi }) {
    const triggerRef = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const setShowSettings = useAppStore(s => s.setShowSettings)
    const setSettingsTab = useAppStore(s => s.setSettingsTab)
    const { choice } = model

    const openSettings = () => {
        setOpen(false)
        setSettingsTab('models')
        setShowSettings(true)
    }

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                className={`model-trigger ${model.ready ? '' : 'is-missing'}`}
                onClick={() => setOpen(o => !o)}
                aria-haspopup="dialog"
                aria-expanded={open}
                title="Choose the model the agent uses"
            >
                {choice.mode === 'cloud' ? <Cloud size={12} aria-hidden /> : <Cpu size={12} aria-hidden />}
                <span className="truncate">{model.label}</span>
                {choice.mode === 'cloud' && model.ready && <span className="model-trigger__effort">{model.effort}</span>}
                <ChevronDown size={12} aria-hidden />
            </button>
            <Popover open={open} onClose={() => setOpen(false)} anchor={triggerRef.current} placement="top-start" width={300} ariaLabel="Models">
                <div className="model-menu">
                    {choice.mode === 'cloud' && model.ready && (
                        <section className="model-menu__group">
                            <p className="model-menu__heading">Reasoning effort</p>
                            <div className="model-menu__effort" role="radiogroup" aria-label="Reasoning effort">
                                {EFFORTS.map(e => (
                                    <button key={e.id} type="button" role="radio" aria-checked={model.effort === e.id}
                                        className={`model-menu__effort-btn ${model.effort === e.id ? 'is-selected' : ''}`}
                                        onClick={() => model.setEffort(e.id)}>
                                        {e.label}
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}
                    {model.providers.map(provider => (
                        <section key={provider} className="model-menu__group">
                            <p className="model-menu__heading">{providerInfo(provider).label} <span className="model-menu__vendor">{providerInfo(provider).vendor}</span></p>
                            {model.modelsFor(provider).map(m => {
                                const selected = choice.mode === 'cloud' && choice.provider === provider && choice.cloudModel === m.id
                                return (
                                    <button key={m.id} type="button" className={`model-menu__item ${selected ? 'is-selected' : ''}`} onClick={() => { model.chooseCloud(provider, m.id); setOpen(false) }}>
                                        <span className="truncate">{m.label}</span>
                                        {selected && <Check size={13} aria-hidden />}
                                    </button>
                                )
                            })}
                        </section>
                    ))}
                    {model.downloaded.length > 0 && (
                        <section className="model-menu__group">
                            <p className="model-menu__heading">On this machine</p>
                            {model.downloaded.map(id => {
                                const loaded = model.loadedModelId === id
                                const selected = choice.mode === 'offline' && loaded
                                return (
                                    <button key={id} type="button" className={`model-menu__item ${selected ? 'is-selected' : ''}`} onClick={() => { void model.chooseLocal(id); setOpen(false) }}>
                                        <span>{localModelName(id)}</span>
                                        {model.isLoading && choice.mode === 'offline' && !loaded ? <Loader2 size={13} className="spin" aria-hidden />
                                            : selected ? <Check size={13} aria-hidden />
                                                : !loaded ? <span className="model-menu__hint">Load</span> : null}
                                    </button>
                                )
                            })}
                        </section>
                    )}
                    {model.providers.length === 0 && model.downloaded.length === 0 && (
                        <p className="model-menu__empty">No models yet. Add an API key or download a model that runs on this machine.</p>
                    )}
                    <button type="button" className="model-menu__manage" onClick={openSettings}>Manage models and keys</button>
                </div>
            </Popover>
        </>
    )
}

export function ModeMenu({ mode, onChange }: { mode: AgentMode; onChange: (mode: AgentMode) => void }) {
    const triggerRef = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const current = AGENT_MODES.find(m => m.id === mode) ?? AGENT_MODES[0]
    return (
        <>
            <button ref={triggerRef} type="button" className={`model-trigger mode-trigger is-${mode}`} onClick={() => setOpen(o => !o)} aria-haspopup="dialog" aria-expanded={open} title="How much the agent may do without asking">
                <ShieldCheck size={12} aria-hidden />
                <span>{current.label}</span>
                <ChevronDown size={12} aria-hidden />
            </button>
            <Popover open={open} onClose={() => setOpen(false)} anchor={triggerRef.current} placement="top-start" width={280} ariaLabel="Agent permissions">
                <div className="model-menu" role="radiogroup" aria-label="Agent permissions">
                    {AGENT_MODES.map(m => (
                        <button key={m.id} type="button" role="radio" aria-checked={m.id === mode} className={`model-menu__item model-menu__item--tall ${m.id === mode ? 'is-selected' : ''}`} onClick={() => { onChange(m.id); setOpen(false) }}>
                            <span className="model-menu__stack">
                                <span>{m.label}</span>
                                <span className="model-menu__hint">{m.hint}</span>
                            </span>
                            {m.id === mode && <Check size={13} aria-hidden />}
                        </button>
                    ))}
                </div>
            </Popover>
        </>
    )
}

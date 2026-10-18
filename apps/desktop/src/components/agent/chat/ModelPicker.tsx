/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useRef, useState } from 'react'
import { Check, ChevronDown, Cloud, Cpu, Loader2 } from 'lucide-react'
import { useAppStore } from '../../../stores/appStore'
import { PROVIDER_MODELS } from '../../../services/aiService'
import { Popover } from '../../ui'
import { cloudModelName, localModelName, PROVIDER_LABEL } from './modelNames'
import type { ModelChoiceApi } from './useModelChoice'

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
                <ChevronDown size={12} aria-hidden />
            </button>
            <Popover open={open} onClose={() => setOpen(false)} anchor={triggerRef.current} placement="top-start" width={280} ariaLabel="Models">
                <div className="model-menu">
                    {model.providers.map(provider => (
                        <section key={provider} className="model-menu__group">
                            <p className="model-menu__heading">{PROVIDER_LABEL[provider]}</p>
                            {(PROVIDER_MODELS[provider] ?? []).map(id => {
                                const selected = choice.mode === 'cloud' && choice.provider === provider && choice.cloudModel === id
                                return (
                                    <button key={id} type="button" className={`model-menu__item ${selected ? 'is-selected' : ''}`} onClick={() => { model.chooseCloud(provider, id); setOpen(false) }}>
                                        <span>{cloudModelName(id)}</span>
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
                                    <button key={id} type="button" className={`model-menu__item ${selected ? 'is-selected' : ''}`} onClick={() => { model.chooseLocal(id); setOpen(false) }}>
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

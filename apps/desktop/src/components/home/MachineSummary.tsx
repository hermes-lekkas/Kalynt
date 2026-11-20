/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Cloud, Cpu, KeyRound, Puzzle, Server } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useModelStore } from '../../stores/modelStore'
import { useUiStore } from '../../stores/uiStore'
import { getModelById } from '../../types/offlineModels'
import { CLOUD_PROVIDERS } from '../../types/aiProviders'
import { RUNTIME_CATALOG } from '../extensions/runtimeCatalog'
import { StatusDot } from '../ui'

/** What this machine can run right now, stated plainly, with direct links to configure it. */
export function MachineSummary() {
    const apiKeys = useAppStore(s => s.apiKeys)
    const setShowSettings = useAppStore(s => s.setShowSettings)
    const setSettingsTab = useAppStore(s => s.setSettingsTab)
    const openExtensions = useUiStore(s => s.openExtensions)
    const loadedModelId = useModelStore(s => s.loadedModelId)
    const downloadedModels = useModelStore(s => s.downloadedModels)

    const providers = CLOUD_PROVIDERS.filter(p => apiKeys[p.id]).map(p => p.label)
    const downloaded = Object.keys(downloadedModels).length
    const loadedName = loadedModelId ? getModelById(loadedModelId)?.name ?? loadedModelId : null
    const serverConnected = !!apiKeys['local-server']

    const openSettings = (tab: string) => {
        setSettingsTab(tab)
        setShowSettings(true)
    }

    return (
        <ul className="machine">
            <li className="machine__row">
                <Cpu size={15} className="machine__icon" aria-hidden />
                <div className="machine__text">
                    <span className="machine__label">
                        <StatusDot tone={loadedName ? 'success' : 'neutral'} />
                        Local model
                    </span>
                    <span className="machine__value tabular-nums">
                        {loadedName ? `${loadedName} loaded` : downloaded > 0 ? `${downloaded} downloaded, none loaded` : 'None downloaded'}
                    </span>
                </div>
                <button type="button" className="machine__link" onClick={() => openSettings('models')}>
                    {downloaded > 0 ? 'Manage' : 'Browse'}
                </button>
            </li>
            <li className="machine__row">
                <Server size={15} className="machine__icon" aria-hidden />
                <div className="machine__text">
                    <span className="machine__label">
                        <StatusDot tone={serverConnected ? 'success' : 'neutral'} />
                        Local server
                    </span>
                    <span className="machine__value">
                        {serverConnected ? 'Connected (Ollama / LM Studio)' : 'Connect Ollama or LM Studio'}
                    </span>
                </div>
                <button type="button" className="machine__link" onClick={() => openSettings('models-server')}>
                    {serverConnected ? 'Manage' : 'Connect'}
                </button>
            </li>
            <li className="machine__row">
                {providers.length > 0 ? <Cloud size={15} className="machine__icon" aria-hidden /> : <KeyRound size={15} className="machine__icon" aria-hidden />}
                <div className="machine__text">
                    <span className="machine__label">
                        <StatusDot tone={providers.length > 0 ? 'success' : 'neutral'} />
                        Cloud providers
                    </span>
                    <span className="machine__value">
                        {providers.length > 0 ? providers.join(', ') : 'No API keys saved (stored in OS keychain)'}
                    </span>
                </div>
                <button type="button" className="machine__link" onClick={() => openSettings('models-cloud')}>
                    {providers.length > 0 ? 'Edit keys' : 'Add key'}
                </button>
            </li>
            <li className="machine__row">
                <Puzzle size={15} className="machine__icon" aria-hidden />
                <div className="machine__text">
                    <span className="machine__label">Language runtimes</span>
                    <span className="machine__value tabular-nums">
                        Node.js, Python, Rust, Go and {RUNTIME_CATALOG.length - 4} more
                    </span>
                </div>
                <button type="button" className="machine__link" onClick={() => openExtensions('runtimes')}>
                    Runtimes
                </button>
            </li>
        </ul>
    )
}

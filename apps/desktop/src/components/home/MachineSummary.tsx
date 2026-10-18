/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Cloud, Cpu, KeyRound, Puzzle } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useModelStore } from '../../stores/modelStore'
import { useUiStore } from '../../stores/uiStore'
import { getModelById } from '../../types/offlineModels'
import { RUNTIME_CATALOG } from '../extensions/runtimeCatalog'

const PROVIDER_NAMES: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google' }

/** What this machine can run right now, stated plainly, with a way to change it. */
export function MachineSummary() {
    const apiKeys = useAppStore(s => s.apiKeys)
    const setShowSettings = useAppStore(s => s.setShowSettings)
    const setSettingsTab = useAppStore(s => s.setSettingsTab)
    const openExtensions = useUiStore(s => s.openExtensions)
    const { loadedModelId, downloadedModels } = useModelStore()

    const providers = Object.entries(apiKeys).filter(([, key]) => !!key).map(([id]) => PROVIDER_NAMES[id] ?? id)
    const downloaded = Object.keys(downloadedModels).length
    const loadedName = loadedModelId ? getModelById(loadedModelId)?.name ?? loadedModelId : null

    const openSettings = (tab: string) => {
        setSettingsTab(tab)
        setShowSettings(true)
    }

    return (
        <ul className="machine">
            <li className="machine__row">
                <Cpu size={16} className="machine__icon" aria-hidden />
                <div className="machine__text">
                    <span className="machine__label">Local model</span>
                    <span className="machine__value">
                        {loadedName ? `${loadedName} is loaded` : downloaded > 0 ? `${downloaded} downloaded, none loaded` : 'None downloaded yet'}
                    </span>
                </div>
                <button type="button" className="machine__link" onClick={() => openSettings('models')}>
                    {downloaded > 0 ? 'Manage models' : 'Browse models'}
                </button>
            </li>
            <li className="machine__row">
                {providers.length > 0 ? <Cloud size={16} className="machine__icon" aria-hidden /> : <KeyRound size={16} className="machine__icon" aria-hidden />}
                <div className="machine__text">
                    <span className="machine__label">Cloud providers</span>
                    <span className="machine__value">
                        {providers.length > 0 ? providers.join(', ') : 'No API keys added. Keys stay in your system keychain.'}
                    </span>
                </div>
                <button type="button" className="machine__link" onClick={() => openSettings('models')}>
                    {providers.length > 0 ? 'Edit keys' : 'Add a key'}
                </button>
            </li>
            <li className="machine__row">
                <Puzzle size={16} className="machine__icon" aria-hidden />
                <div className="machine__text">
                    <span className="machine__label">Language runtimes</span>
                    <span className="machine__value">Run Node.js, Python, Rust, Go and {RUNTIME_CATALOG.length - 4} more languages from the editor</span>
                </div>
                <button type="button" className="machine__link" onClick={() => openExtensions('runtimes')}>
                    Manage runtimes
                </button>
            </li>
        </ul>
    )
}

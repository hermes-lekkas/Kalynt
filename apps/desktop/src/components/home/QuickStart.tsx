/* SPDX-License-Identifier: AGPL-3.0-only */
import { useState } from 'react'
import { ArrowRight, Check, FolderOpen, SlidersHorizontal, Sparkles, X } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useModelStore } from '../../stores/modelStore'
import { useWorkspaceFolderStore } from '../../stores/workspaceFolderStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useUiStore } from '../../stores/uiStore'
import { Button, IconButton } from '../ui'
import { openFolderAsWorkspace, openWorkspace } from './workspaceActions'

const STARTER = "Explain how this project starts. Point me to the entry file and the command to run it. Don't change any files."
const DISMISSED_KEY = 'kalynt-quick-start-dismissed'
const LEGACY_HIDDEN_KEY = 'kalynt-quick-start-hidden'

function readDismissed(): boolean {
    try {
        return localStorage.getItem(DISMISSED_KEY) === 'true' || localStorage.getItem(LEGACY_HIDDEN_KEY) === 'true'
    } catch {
        return false
    }
}

export function QuickStart() {
    const spaces = useAppStore(s => s.spaces)
    const keys = useAppStore(s => s.apiKeys)
    const records = useWorkspaceFolderStore(s => s.records)
    const loaded = useModelStore(s => s.loadedModelId)
    const [dismissed, setDismissed] = useState(readDismissed)

    const workspace = spaces.find(s => !!records[s.id]?.folder)
    const configured = !!loaded || Object.values(keys).some(Boolean)

    // Auto-hide completely (zero dead vertical space) once workspace + model are ready, or when dismissed.
    if (dismissed || (workspace && configured)) return null

    const doneCount = (workspace ? 1 : 0) + (configured ? 1 : 0)

    const dismiss = () => {
        setDismissed(true)
        try {
            localStorage.setItem(DISMISSED_KEY, 'true')
            localStorage.setItem(LEGACY_HIDDEN_KEY, 'true')
        } catch {
            // Storage unavailable
        }
    }

    const setup = () => {
        const state = useAppStore.getState()
        state.setSettingsTab('models')
        state.setShowSettings(true)
    }

    const tryPrompt = () => {
        if (!workspace) return
        useUiStore.getState().setAgentDraft(STARTER)
        useLayoutStore.getState().showRightTab('agent')
        openWorkspace(workspace)
    }

    return (
        <section className="quick-start" aria-labelledby="quick-start-title">
            <div className="quick-start__head">
                <div>
                    <span className="quick-start__eyebrow tabular-nums">GETTING STARTED · {doneCount} OF 2 READY</span>
                    <h2 id="quick-start-title">Set up your first session</h2>
                </div>
                <IconButton size="sm" label="Dismiss getting started guide" icon={<X size={14} />} onClick={dismiss} />
            </div>

            <ol className="quick-start__steps">
                <li className={workspace ? 'is-complete' : ''}>
                    <span className={`quick-start__number ${workspace ? 'is-done' : ''}`}>
                        {workspace ? <Check size={13} aria-label="Folder ready" /> : '1'}
                    </span>
                    <div>
                        <h3>Open a project folder</h3>
                        <p>Your existing files and Git repository work as they are.</p>
                    </div>
                    {!workspace && (
                        <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void openFolderAsWorkspace()}>
                            Open folder
                        </Button>
                    )}
                </li>
                <li className={configured ? 'is-complete' : ''}>
                    <span className={`quick-start__number ${configured ? 'is-done' : ''}`}>
                        {configured ? <Check size={13} aria-label="Model configured" /> : '2'}
                    </span>
                    <div>
                        <h3>Connect a model</h3>
                        <p>Download locally, connect Ollama / LM Studio, or add a cloud key.</p>
                    </div>
                    {!configured && (
                        <Button size="sm" variant={workspace ? 'primary' : 'secondary'} icon={<SlidersHorizontal size={13} />} onClick={setup}>
                            Set up AI
                        </Button>
                    )}
                </li>
                {workspace && (
                    <li>
                        <span className="quick-start__number">3</span>
                        <div>
                            <h3>Try a read-only walkthrough</h3>
                            <p>Ask the agent to explain how your project starts without editing files.</p>
                        </div>
                        <Button size="sm" icon={<Sparkles size={13} />} iconRight={<ArrowRight size={12} />} onClick={tryPrompt}>
                            Try prompt
                        </Button>
                    </li>
                )}
            </ol>
        </section>
    )
}

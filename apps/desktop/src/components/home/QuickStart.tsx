/* SPDX-License-Identifier: AGPL-3.0-only */
import { useState } from 'react'
import { ArrowRight, Check, FolderOpen, SlidersHorizontal, Sparkles } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useModelStore } from '../../stores/modelStore'
import { useWorkspaceFolderStore } from '../../stores/workspaceFolderStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useUiStore } from '../../stores/uiStore'
import { Button } from '../ui'
import { openFolderAsWorkspace, openWorkspace } from './workspaceActions'

const STARTER = "Explain how this project starts. Point me to the entry file and the command to run it. Don't change any files."

export function QuickStart() {
    const spaces = useAppStore(s => s.spaces)
    const keys = useAppStore(s => s.apiKeys)
    const records = useWorkspaceFolderStore(s => s.records)
    const loaded = useModelStore(s => s.loadedModelId)
    const [hidden, setHidden] = useState(() => { try { return localStorage.getItem('kalynt-quick-start-hidden') === 'true' } catch { return false } })
    const workspace = spaces.find(s => !!records[s.id]?.folder)
    const configured = !!loaded || Object.values(keys).some(Boolean)
    const toggle = () => setHidden(value => { try { localStorage.setItem('kalynt-quick-start-hidden', String(!value)) } catch { /* storage unavailable */ } return !value })
    const setup = () => { const state = useAppStore.getState(); state.setSettingsTab('models'); state.setShowSettings(true) }
    const tryPrompt = () => {
        if (!workspace) return
        useUiStore.getState().setAgentDraft(STARTER)
        useLayoutStore.getState().showRightTab('agent')
        openWorkspace(workspace)
    }

    return (
        <section className="quick-start" aria-labelledby="quick-start-title">
            <div className="quick-start__head"><div><span className="quick-start__eyebrow">GET COMFORTABLE</span><h2 id="quick-start-title">Your first useful session</h2></div><button type="button" className="machine__link" onClick={toggle} aria-expanded={!hidden}>{hidden ? 'Show guide' : 'Hide guide'}</button></div>
            {!hidden && <>
                <p className="quick-start__lede">Keep your current tools. Try one small task here, and check the result.</p>
                <ol className="quick-start__steps">
                    <li><span className={`quick-start__number ${workspace ? 'is-done' : ''}`}>{workspace ? <Check size={13} aria-label="Folder ready" /> : '1'}</span><div><h3>Open a project folder</h3><p>Your existing files and Git repository work as they are.</p></div><Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void openFolderAsWorkspace()}>Open folder</Button></li>
                    <li><span className={`quick-start__number ${configured ? 'is-done' : ''}`}>{configured ? <Check size={13} aria-label="Model configured" /> : '2'}</span><div><h3>Connect a model</h3><p>Download locally, reuse Ollama / LM Studio, or add a cloud key.</p></div><Button size="sm" icon={<SlidersHorizontal size={13} />} onClick={setup}>{configured ? 'Manage AI' : 'Set up AI'}</Button></li>
                    <li><span className="quick-start__number">3</span><div><h3>Understand the project</h3><p>Start with an explanation. This prompt asks for no file changes.</p></div><Button size="sm" icon={<Sparkles size={13} />} disabled={!workspace} onClick={tryPrompt}>Try a first prompt <ArrowRight size={12} /></Button></li>
                </ol>
                <p className="quick-start__foot">When you're ready for edits, use <strong>Ask before changes</strong>, review the diff, and run your project's tests.</p>
            </>}
        </section>
    )
}

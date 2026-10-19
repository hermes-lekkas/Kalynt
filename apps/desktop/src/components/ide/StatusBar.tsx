/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { AlertTriangle, ArrowDown, ArrowUp, GitBranch, Lock, Sparkles, Users } from 'lucide-react'
import { useEditorStatusStore } from '../../stores/editorStatusStore'
import { useAgentStatusStore } from '../../stores/agentStatusStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useUiStore } from '../../stores/uiStore'
import { useYDoc } from '../../hooks/useYjs'
import { RegionBoundary, StatusDot } from '../ui'
import { ResourceMeter } from '../system/ResourceMeter'
import type { GitApi } from './git/useGit'
import type { RunnerApi } from './hooks/useRunner'
import { languageLabel } from './languages'

interface StatusBarProps {
    spaceId: string
    git: GitApi
    runner: RunnerApi
    hasFile: boolean
    dirtyCount: number
    onGoToLine: () => void
}

const AGENT_TEXT = {
    idle: 'Agent ready',
    thinking: 'Agent is thinking',
    working: 'Agent is working',
    'waiting-approval': 'Agent needs your approval',
    scanning: 'Agent is reviewing files'
} as const

export function StatusBar({ spaceId, git, runner, hasFile, dirtyCount, onGoToLine }: StatusBarProps) {
    const { line, column, selectionLength, language } = useEditorStatusStore()
    const { activity, model, step } = useAgentStatusStore()
    const showSidePanel = useLayoutStore(s => s.showSidePanel)
    const showRightTab = useLayoutStore(s => s.showRightTab)
    const showBottomTab = useLayoutStore(s => s.showBottomTab)
    const openCollaboration = useUiStore(s => s.openCollaboration)
    const { peerCount, encrypted, synced } = useYDoc(spaceId)

    const agentText = activity === 'idle' && !model ? 'No model connected' : AGENT_TEXT[activity]

    const runState = runner.isDebugging ? { label: 'Debugging', tone: 'danger' as const, tab: 'debug' as const }
        : runner.isBuilding ? { label: 'Building', tone: 'warning' as const, tab: 'build' as const }
            : runner.isRunning ? { label: 'Running', tone: 'success' as const, tab: 'output' as const }
                : null

    return (
        <footer className="statusbar" aria-label="Status">
            <div className="statusbar__group">
                {git.isRepo && (
                    <button type="button" className="statusbar__item" onClick={() => showSidePanel('git')} title="Source control">
                        <GitBranch size={12} aria-hidden />
                        <span className="mono">{git.branch}</span>
                        {git.changes.length > 0 && <span className="statusbar__muted">{git.changes.length} changed</span>}
                        {git.ahead > 0 && <span className="statusbar__sync"><ArrowUp size={11} aria-hidden />{git.ahead}</span>}
                        {git.behind > 0 && <span className="statusbar__sync"><ArrowDown size={11} aria-hidden />{git.behind}</span>}
                    </button>
                )}
                <button type="button" className="statusbar__item" onClick={() => openCollaboration(peerCount ? 'members' : 'invite')} title={encrypted ? 'Peer-to-peer sync, end-to-end encrypted' : 'Peer-to-peer sync'}>
                    {encrypted ? <Lock size={11} aria-hidden /> : <Users size={12} aria-hidden />}
                    <span>{peerCount > 0 ? `${peerCount} ${peerCount === 1 ? 'peer' : 'peers'}` : synced ? 'Only you' : 'Connecting'}</span>
                </button>
                {runState && (
                    <button type="button" className="statusbar__item" onClick={() => showBottomTab(runState.tab)}>
                        <StatusDot tone={runState.tone} pulse />
                        <span>{runState.label}</span>
                    </button>
                )}
                {dirtyCount > 0 && (
                    <span className="statusbar__item statusbar__static" title="Files with unsaved changes">
                        <AlertTriangle size={11} aria-hidden /> {dirtyCount} unsaved
                    </span>
                )}
            </div>

            <div className="statusbar__group">
                {hasFile && (
                    <>
                        <button type="button" className="statusbar__item" onClick={onGoToLine} title="Go to line">
                            Ln {line}, Col {column}{selectionLength > 0 ? ` (${selectionLength} selected)` : ''}
                        </button>
                        {language && <span className="statusbar__item statusbar__static">{languageLabel(language)}</span>}
                    </>
                )}
                <button
                    type="button"
                    className={`statusbar__item statusbar__agent ${activity !== 'idle' ? 'is-busy' : ''} ${activity === 'waiting-approval' ? 'is-waiting' : ''}`}
                    onClick={() => showRightTab('agent')}
                    title={model ? `${agentText} with ${model}` : agentText}
                >
                    <Sparkles size={12} aria-hidden />
                    <span>{agentText}{step ? ` (step ${step.current} of ${step.max})` : ''}</span>
                </button>
                <RegionBoundary name="Resources" compact>
                    <ResourceMeter />
                </RegionBoundary>
            </div>
        </footer>
    )
}

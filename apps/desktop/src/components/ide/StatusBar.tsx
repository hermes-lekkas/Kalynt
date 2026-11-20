/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, GitBranch, Lock, Sparkles, Users, XCircle } from 'lucide-react'
import { useEditorStatusStore, type LineEnding } from '../../stores/editorStatusStore'
import { useAgentStatusStore } from '../../stores/agentStatusStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useUiStore } from '../../stores/uiStore'
import { useYDoc } from '../../hooks/useYjs'
import { Menu, RegionBoundary, StatusDot, useMenuAnchor } from '../ui'
import { ResourceMeter } from '../system/ResourceMeter'
import type { GitApi } from './git/useGit'
import type { RunnerApi } from './hooks/useRunner'
import { OPEN_PROBLEMS_EVENT } from './hooks/useIdeCommands'
import { LANGUAGE_OPTIONS, languageLabel } from './languages'

interface StatusBarProps {
    spaceId: string
    git: GitApi
    runner: RunnerApi
    hasFile: boolean
    canEdit?: boolean
    dirtyCount: number
    onGoToLine: () => void
    onChangeLanguage?: (language: string) => void
    onChangeEol?: (eol: LineEnding) => void
}

interface DiagnosticsSummary {
    errors: number
    warnings: number
}

const AGENT_TEXT = {
    idle: 'Agent ready',
    thinking: 'Agent is thinking',
    working: 'Agent is working',
    'waiting-approval': 'Agent needs your approval',
    scanning: 'Agent is reviewing files'
} as const

export function StatusBar({
    spaceId, git, runner, hasFile, canEdit = true, dirtyCount, onGoToLine, onChangeLanguage, onChangeEol
}: StatusBarProps) {
    const line = useEditorStatusStore(s => s.line)
    const column = useEditorStatusStore(s => s.column)
    const selectionLength = useEditorStatusStore(s => s.selectionLength)
    const language = useEditorStatusStore(s => s.language)
    const eol = useEditorStatusStore(s => s.eol)

    const activity = useAgentStatusStore(s => s.activity)
    const model = useAgentStatusStore(s => s.model)
    const step = useAgentStatusStore(s => s.step)

    const showSidePanel = useLayoutStore(s => s.showSidePanel)
    const showRightTab = useLayoutStore(s => s.showRightTab)
    const showBottomTab = useLayoutStore(s => s.showBottomTab)
    const tabSize = useLayoutStore(s => s.tabSize)
    const insertSpaces = useLayoutStore(s => s.insertSpaces)
    const setEditorPref = useLayoutStore(s => s.setEditorPref)

    const openCollaboration = useUiStore(s => s.openCollaboration)
    const { peerCount, encrypted, synced } = useYDoc(spaceId)

    const [diagnostics, setDiagnostics] = useState<DiagnosticsSummary>({ errors: 0, warnings: 0 })
    const indentMenu = useMenuAnchor()
    const eolMenu = useMenuAnchor()
    const langMenu = useMenuAnchor()

    useEffect(() => {
        const onSummary = (e: Event) => {
            const detail = (e as CustomEvent<{ errors?: number; warnings?: number; errorCount?: number; warningCount?: number }>).detail
            if (!detail) return
            const errors = Math.max(0, Number(detail.errors ?? detail.errorCount ?? 0) || 0)
            const warnings = Math.max(0, Number(detail.warnings ?? detail.warningCount ?? 0) || 0)
            setDiagnostics({ errors, warnings })
        }
        window.addEventListener('kalynt-diagnostics-summary', onSummary)
        return () => window.removeEventListener('kalynt-diagnostics-summary', onSummary)
    }, [])

    const agentText = activity === 'idle' && !model ? 'No model connected' : AGENT_TEXT[activity]

    const runState = runner.isDebugging ? { label: 'Debugging', tone: 'danger' as const, tab: 'debug' as const }
        : runner.isBuilding ? { label: 'Building', tone: 'warning' as const, tab: 'build' as const }
            : runner.isRunning ? { label: 'Running', tone: 'success' as const, tab: 'output' as const }
                : null

    const openProblems = () => window.dispatchEvent(new Event(OPEN_PROBLEMS_EVENT))

    return (
        <footer className="statusbar" aria-label="Status">
            <div className="statusbar__group statusbar__group--left">
                {git.isRepo && (
                    <button type="button" className="statusbar__item statusbar__branch" onClick={() => showSidePanel('git')} title={`Source control (${git.branch})`}>
                        <GitBranch size={12} aria-hidden />
                        <span className="mono truncate">{git.branch}</span>
                        {git.changes.length > 0 && <span className="statusbar__muted statusbar__hide-sm tabular-nums">{git.changes.length}</span>}
                        {git.ahead > 0 && <span className="statusbar__sync tabular-nums"><ArrowUp size={11} aria-hidden />{git.ahead}</span>}
                        {git.behind > 0 && <span className="statusbar__sync tabular-nums"><ArrowDown size={11} aria-hidden />{git.behind}</span>}
                    </button>
                )}
                <button
                    type="button"
                    className={`statusbar__item statusbar__diag tabular-nums ${diagnostics.errors > 0 ? 'is-danger' : diagnostics.warnings > 0 ? 'is-warning' : ''}`}
                    onClick={openProblems}
                    title={`${diagnostics.errors} error${diagnostics.errors === 1 ? '' : 's'}, ${diagnostics.warnings} warning${diagnostics.warnings === 1 ? '' : 's'} — Click to open Problems`}
                >
                    <span className="statusbar__diag-count"><XCircle size={11} aria-hidden />{diagnostics.errors}</span>
                    <span className="statusbar__diag-count"><AlertTriangle size={11} aria-hidden />{diagnostics.warnings}</span>
                </button>
                <button
                    type="button"
                    className="statusbar__item statusbar__hide-md"
                    onClick={() => openCollaboration(peerCount ? 'members' : 'invite')}
                    title={encrypted ? 'Peer-to-peer sync, end-to-end encrypted' : 'Peer-to-peer sync'}
                >
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
                    <span className="statusbar__item statusbar__static statusbar__hide-sm tabular-nums" title="Files with unsaved changes">
                        <AlertTriangle size={11} aria-hidden /> {dirtyCount} unsaved
                    </span>
                )}
            </div>

            <div className="statusbar__group statusbar__group--right">
                {hasFile && (
                    <>
                        <button type="button" className="statusbar__item tabular-nums" onClick={onGoToLine} title="Go to line">
                            Ln {line}, Col {column}{selectionLength > 0 ? ` (${selectionLength} sel)` : ''}
                        </button>
                        <button
                            type="button"
                            className="statusbar__item statusbar__hide-sm tabular-nums"
                            onClick={indentMenu.toggle}
                            aria-haspopup="menu"
                            aria-expanded={indentMenu.open}
                            title="Select indentation"
                        >
                            {insertSpaces ? `Spaces: ${tabSize}` : `Tab Size: ${tabSize}`}
                        </button>
                        <Menu
                            open={indentMenu.open}
                            anchor={indentMenu.anchor}
                            onClose={indentMenu.close}
                            placement="top-end"
                            width={180}
                            ariaLabel="Indentation"
                            items={[
                                { heading: 'Indent using' },
                                { label: 'Spaces', checked: insertSpaces, onSelect: () => setEditorPref({ insertSpaces: true }) },
                                { label: 'Tabs', checked: !insertSpaces, onSelect: () => setEditorPref({ insertSpaces: false }) },
                                'separator',
                                { heading: 'Tab size' },
                                { label: '2 spaces', checked: tabSize === 2, onSelect: () => setEditorPref({ tabSize: 2 }) },
                                { label: '4 spaces', checked: tabSize === 4, onSelect: () => setEditorPref({ tabSize: 4 }) },
                                { label: '8 spaces', checked: tabSize === 8, onSelect: () => setEditorPref({ tabSize: 8 }) }
                            ]}
                        />
                        <button
                            type="button"
                            className="statusbar__item statusbar__hide-md"
                            onClick={eolMenu.toggle}
                            disabled={!canEdit}
                            aria-haspopup="menu"
                            aria-expanded={eolMenu.open}
                            title="Select end of line sequence"
                        >
                            {eol}
                        </button>
                        <Menu
                            open={eolMenu.open}
                            anchor={eolMenu.anchor}
                            onClose={eolMenu.close}
                            placement="top-end"
                            width={160}
                            ariaLabel="End of line sequence"
                            items={[
                                { label: 'LF', hint: 'Unix / macOS', checked: eol === 'LF', onSelect: () => onChangeEol?.('LF') },
                                { label: 'CRLF', hint: 'Windows', checked: eol === 'CRLF', onSelect: () => onChangeEol?.('CRLF') }
                            ]}
                        />
                        {language && (
                            <>
                                <button
                                    type="button"
                                    className="statusbar__item"
                                    onClick={langMenu.toggle}
                                    aria-haspopup="menu"
                                    aria-expanded={langMenu.open}
                                    title="Select language mode"
                                >
                                    {languageLabel(language)}
                                </button>
                                <Menu
                                    open={langMenu.open}
                                    anchor={langMenu.anchor}
                                    onClose={langMenu.close}
                                    placement="top-end"
                                    width={200}
                                    ariaLabel="Language mode"
                                    items={LANGUAGE_OPTIONS.map(opt => ({
                                        label: opt.label,
                                        checked: opt.id === language,
                                        onSelect: () => onChangeLanguage?.(opt.id)
                                    }))}
                                />
                            </>
                        )}
                    </>
                )}
                <button
                    type="button"
                    className={`statusbar__item statusbar__agent ${activity !== 'idle' ? 'is-busy' : ''} ${activity === 'waiting-approval' ? 'is-waiting' : ''}`}
                    onClick={() => showRightTab('agent')}
                    title={model ? `${agentText} with ${model}` : agentText}
                >
                    <Sparkles size={12} aria-hidden />
                    <span className="truncate">{agentText}{step ? ` (${step.current}/${step.max})` : ''}</span>
                </button>
                <RegionBoundary name="Resources" compact>
                    <ResourceMeter />
                </RegionBoundary>
            </div>
        </footer>
    )
}

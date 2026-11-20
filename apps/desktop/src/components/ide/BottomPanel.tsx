/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ChevronDown, Eraser, Play, Plus, Search, Square, X } from 'lucide-react'
import { useLayoutStore, LAYOUT_LIMITS, type BottomTab } from '../../stores/layoutStore'
import { formatShortcut } from '../../stores/commandStore'
import { useDiagnosticsStore } from '../../stores/diagnosticsStore'
import { Badge, IconButton, Menu, RegionBoundary, Resizer, StatusDot, Tabs, useMenuAnchor, type MenuEntry } from '../ui'
import { useTerminals } from './terminal/useTerminals'
import { TerminalPane } from './terminal/TerminalPane'
import { OutputView } from './terminal/OutputView'
import { RecentCommands } from './terminal/RecentCommands'
import { ProblemsPanel } from './problems/ProblemsPanel'
import type { RunnerApi } from './hooks/useRunner'

type PanelTabId = BottomTab | 'problems'

interface BottomPanelProps {
    folder: string | null
    runner: RunnerApi
    active: boolean
}

export function BottomPanel({ folder, runner, active }: BottomPanelProps) {
    const { bottomOpen, bottomHeight, bottomTab, setBottomOpen, setBottomHeight, setBottomTab } = useLayoutStore()
    const diagCounts = useDiagnosticsStore(s => s.counts)

    const [problemsActive, setProblemsActive] = useState(false)
    const [searchOpen, setSearchOpen] = useState(false)
    const [debugReplInput, setDebugReplInput] = useState('')
    const panelRef = useRef<HTMLElement>(null)
    const taskMenu = useMenuAnchor()

    const effectiveTab: PanelTabId = problemsActive ? 'problems' : bottomTab
    const terminalVisible = active && bottomOpen && effectiveTab === 'terminal'
    const terminals = useTerminals(folder, terminalVisible, { onSearch: () => setSearchOpen(true) })

    // Keep Monaco workspace TS/JS types & LSP workspace synced lazily without loading Monaco eagerly on boot.
    useEffect(() => {
        let cancelled = false
        let cleanup: (() => void) | undefined
        void import('./editor/monacoSetup')
            .then(m => {
                if (!cancelled) cleanup = m.syncWorkspaceTypes(folder)
            })
            .catch(() => undefined)
        return () => {
            cancelled = true
            cleanup?.()
        }
    }, [folder])

    // Sync local Problems tab override when layoutStore switches bottom tabs or custom events fire.
    useEffect(() => {
        setProblemsActive(false)
    }, [bottomTab])

    useEffect(() => {
        const onOpenProblems = () => {
            setBottomOpen(true)
            setProblemsActive(true)
        }
        const onBottomTab = () => {
            setProblemsActive(false)
        }
        window.addEventListener('kalynt-open-problems', onOpenProblems)
        window.addEventListener('kalynt-bottom-tab', onBottomTab)
        return () => {
            window.removeEventListener('kalynt-open-problems', onOpenProblems)
            window.removeEventListener('kalynt-bottom-tab', onBottomTab)
        }
    }, [setBottomOpen])

    // Handle Ctrl+F / Cmd+F inside the terminal without colliding with Ctrl+Shift+F Workspace Search.
    useEffect(() => {
        if (!terminalVisible) return
        const el = panelRef.current
        if (!el) return
        const onKeyDown = (e: KeyboardEvent) => {
            const mod = e.ctrlKey || e.metaKey
            if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
                if (e.target instanceof Element && e.target.closest('.terminal-pane')) {
                    e.preventDefault()
                    setSearchOpen(true)
                }
            }
        }
        el.addEventListener('keydown', onKeyDown, true)
        return () => el.removeEventListener('keydown', onKeyDown, true)
    }, [terminalVisible])

    const handleTabChange = (id: PanelTabId) => {
        if (id === 'problems') {
            setProblemsActive(true)
        } else {
            setProblemsActive(false)
            setBottomTab(id)
        }
    }

    const problemBadge = useMemo(() => {
        if (diagCounts.errors > 0) {
            return (
                <Badge tone="danger" title={`${diagCounts.errors} errors, ${diagCounts.warnings} warnings`}>
                    {diagCounts.errors + diagCounts.warnings}
                </Badge>
            )
        }
        if (diagCounts.warnings > 0) {
            return (
                <Badge tone="warning" title={`${diagCounts.warnings} warnings`}>
                    {diagCounts.warnings}
                </Badge>
            )
        }
        return undefined
    }, [diagCounts.errors, diagCounts.warnings])

    const tabs = [
        { id: 'problems' as const, label: 'Problems', badge: problemBadge },
        { id: 'terminal' as const, label: 'Terminal' },
        { id: 'output' as const, label: 'Output', badge: runner.isRunning ? <StatusDot tone="success" pulse /> : undefined },
        { id: 'build' as const, label: 'Build', badge: runner.isBuilding ? <StatusDot tone="warning" pulse /> : undefined },
        { id: 'debug' as const, label: 'Debug', badge: runner.isDebugging ? <StatusDot tone="danger" pulse /> : undefined }
    ]

    const outputFor = (tab: Exclude<BottomTab, 'terminal'>) => ({
        output: { content: runner.runOutput, running: runner.isRunning, empty: 'Run a file with F5 to see its output here.' },
        build: { content: runner.buildOutput, running: runner.isBuilding, empty: 'Build the project with Ctrl+Shift+B to see build output here.' },
        debug: { content: runner.debugOutput, running: runner.isDebugging, empty: 'Start debugging to inspect output and evaluate expressions here.' }
    }[tab])

    const taskMenuItems = useMemo<MenuEntry[]>(() => {
        if (runner.buildTasks.length === 0) {
            return [{ id: 'none', label: 'No tasks detected', disabled: true, onSelect: () => undefined }]
        }
        return runner.buildTasks.map((task, idx) => ({
            id: `${task.label}-${idx}`,
            label: task.label,
            icon: <Play size={12} />,
            onSelect: () => { void runner.runTask(task) }
        }))
    }, [runner])

    const submitDebugRepl = (e: FormEvent) => {
        e.preventDefault()
        const expr = debugReplInput.trim()
        if (!expr) return
        setDebugReplInput('')
        void runner.evaluateExpression(expr)
    }

    return (
        <section ref={panelRef} className="bottom-panel" style={{ height: bottomHeight, display: bottomOpen ? 'flex' : 'none' }} aria-label="Panel">
            <Resizer
                axis="y"
                direction={-1}
                label="Resize panel"
                value={bottomHeight}
                min={LAYOUT_LIMITS.bottom.min}
                max={LAYOUT_LIMITS.bottom.max}
                defaultValue={LAYOUT_LIMITS.bottom.default}
                onChange={setBottomHeight}
                panelRef={panelRef}
            />
            <header className="bottom-panel__head">
                <Tabs size="sm" ariaLabel="Panel views" value={effectiveTab} onChange={handleTabChange} items={tabs} idPrefix="bottom" />
                <div className="bottom-panel__actions">
                    {effectiveTab === 'terminal' ? (
                        <>
                            {terminals.tabs.length > 1 && (
                                <div className="term-switch" role="tablist" aria-label="Terminals">
                                    {terminals.tabs.map(t => (
                                        <div key={t.id} className={`term-switch__item ${t.id === terminals.activeId ? 'is-active' : ''}`}>
                                            <button type="button" role="tab" aria-selected={t.id === terminals.activeId} onClick={() => terminals.setActiveId(t.id)}>
                                                {t.title}{t.exited ? ' (exited)' : ''}
                                            </button>
                                            <IconButton size="sm" label={`Kill ${t.title}`} icon={<X size={12} />} onClick={() => terminals.close(t.id)} />
                                        </div>
                                    ))}
                                </div>
                            )}
                            <RecentCommands terminalId={terminals.activeId} onRun={terminals.sendCommand} />
                            <IconButton
                                size="sm"
                                label="Find in terminal"
                                shortcut={formatShortcut('Ctrl+F')}
                                icon={<Search size={14} />}
                                onClick={() => setSearchOpen(o => !o)}
                                active={searchOpen}
                                disabled={!terminals.activeId}
                            />
                            <IconButton size="sm" label="Clear terminal" icon={<Eraser size={14} />} onClick={terminals.clear} disabled={!terminals.activeId} />
                            <IconButton size="sm" label="New terminal" icon={<Plus size={15} />} onClick={() => terminals.add()} />
                        </>
                    ) : effectiveTab === 'problems' ? null : (
                        <>
                            {effectiveTab === 'build' && (
                                <>
                                    <IconButton
                                        size="sm"
                                        label="Run task…"
                                        icon={<Play size={13} />}
                                        onClick={taskMenu.toggle}
                                        active={taskMenu.open}
                                        disabled={!folder}
                                    />
                                    <Menu
                                        open={taskMenu.open}
                                        anchor={taskMenu.anchor}
                                        onClose={taskMenu.close}
                                        items={taskMenuItems}
                                        placement="top-end"
                                    />
                                    {runner.isBuilding && (
                                        <IconButton
                                            size="sm"
                                            tone="danger"
                                            label="Stop build"
                                            icon={<Square size={12} />}
                                            onClick={() => { void runner.stopBuild() }}
                                        />
                                    )}
                                </>
                            )}
                            <IconButton size="sm" label="Clear output" icon={<Eraser size={14} />} onClick={() => runner.clearOutput(effectiveTab)} />
                        </>
                    )}
                    <IconButton size="sm" label="Hide panel" shortcut={formatShortcut('Ctrl+`')} icon={<ChevronDown size={15} />} onClick={() => setBottomOpen(false)} />
                </div>
            </header>

            <div className="bottom-panel__body">
                <div className="bottom-panel__view" hidden={effectiveTab !== 'problems'} id="bottom-panel-problems" role="tabpanel" aria-labelledby="bottom-tab-problems">
                    <RegionBoundary name="Problems">
                        <ProblemsPanel folder={folder} />
                    </RegionBoundary>
                </div>
                <div className="bottom-panel__view" hidden={effectiveTab !== 'terminal'} id="bottom-panel-terminal" role="tabpanel" aria-labelledby="bottom-tab-terminal">
                    <RegionBoundary name="Terminal">
                        <TerminalPane terminals={terminals} searchOpen={searchOpen} onCloseSearch={() => setSearchOpen(false)} />
                    </RegionBoundary>
                </div>
                {(['output', 'build', 'debug'] as const).map(tab => {
                    const view = outputFor(tab)
                    return (
                        <div key={tab} className="bottom-panel__view" hidden={effectiveTab !== tab} id={`bottom-panel-${tab}`} role="tabpanel" aria-labelledby={`bottom-tab-${tab}`}>
                            <OutputView
                                content={view.content}
                                running={view.running}
                                visible={active && bottomOpen && effectiveTab === tab}
                                emptyText={view.empty}
                                onInput={tab === 'output' ? runner.sendInput : undefined}
                            />
                            {tab === 'debug' && runner.isDebugging && (
                                <form className="debug-repl__form" style={{ padding: '4px 12px 6px', borderTop: '1px solid var(--line)' }} onSubmit={submitDebugRepl}>
                                    <span className="debug-repl__prompt" aria-hidden>&gt;</span>
                                    <input
                                        type="text"
                                        className="debug-repl__input"
                                        value={debugReplInput}
                                        onChange={e => setDebugReplInput(e.target.value)}
                                        placeholder="Evaluate expression in debug console…"
                                        aria-label="Debug console expression"
                                    />
                                </form>
                            )}
                        </div>
                    )
                })}
            </div>
        </section>
    )
}

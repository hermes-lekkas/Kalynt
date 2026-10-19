/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useRef, useState } from 'react'
import { ChevronDown, Eraser, Plus, Search, X } from 'lucide-react'
import { useLayoutStore, LAYOUT_LIMITS, type BottomTab } from '../../stores/layoutStore'
import { IconButton, RegionBoundary, Resizer, StatusDot, Tabs } from '../ui'
import { useTerminals } from './terminal/useTerminals'
import { TerminalPane } from './terminal/TerminalPane'
import { OutputView } from './terminal/OutputView'
import { RecentCommands } from './terminal/RecentCommands'
import type { RunnerApi } from './hooks/useRunner'

interface BottomPanelProps {
    folder: string | null
    runner: RunnerApi
    active: boolean
}

export function BottomPanel({ folder, runner, active }: BottomPanelProps) {
    const { bottomOpen, bottomHeight, bottomTab, setBottomOpen, setBottomHeight, setBottomTab } = useLayoutStore()
    const [searchOpen, setSearchOpen] = useState(false)
    const panelRef = useRef<HTMLElement>(null)
    const terminalVisible = active && bottomOpen && bottomTab === 'terminal'
    const terminals = useTerminals(folder, terminalVisible, { onSearch: () => setSearchOpen(true) })

    const tabs = [
        { id: 'terminal' as const, label: 'Terminal' },
        { id: 'output' as const, label: 'Output', badge: runner.isRunning ? <StatusDot tone="success" pulse /> : undefined },
        { id: 'build' as const, label: 'Build', badge: runner.isBuilding ? <StatusDot tone="warning" pulse /> : undefined },
        { id: 'debug' as const, label: 'Debug', badge: runner.isDebugging ? <StatusDot tone="danger" pulse /> : undefined }
    ]

    const outputFor = (tab: Exclude<BottomTab, 'terminal'>) => ({
        output: { content: runner.runOutput, running: runner.isRunning, empty: 'Run a file with F5 to see its output here.' },
        build: { content: runner.buildOutput, running: runner.isBuilding, empty: 'Build the project with Ctrl+Shift+B to see build output here.' },
        debug: { content: runner.debugOutput, running: runner.isDebugging, empty: 'Start debugging with F9. Debugger messages appear here.' }
    }[tab])

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
                <Tabs size="sm" ariaLabel="Panel views" value={bottomTab} onChange={setBottomTab} items={tabs} idPrefix="bottom" />
                <div className="bottom-panel__actions">
                    {bottomTab === 'terminal' ? (
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
                            <IconButton size="sm" label="Find in terminal" shortcut="Ctrl+Shift+F" icon={<Search size={14} />} onClick={() => setSearchOpen(o => !o)} active={searchOpen} disabled={!terminals.activeId} />
                            <IconButton size="sm" label="Clear terminal" icon={<Eraser size={14} />} onClick={terminals.clear} disabled={!terminals.activeId} />
                            <IconButton size="sm" label="New terminal" icon={<Plus size={15} />} onClick={() => terminals.add()} />
                        </>
                    ) : (
                        <IconButton size="sm" label="Clear output" icon={<Eraser size={14} />} onClick={() => runner.clearOutput(bottomTab)} />
                    )}
                    <IconButton size="sm" label="Hide panel" shortcut="Ctrl+`" icon={<ChevronDown size={15} />} onClick={() => setBottomOpen(false)} />
                </div>
            </header>

            <div className="bottom-panel__body">
                <div className="bottom-panel__view" hidden={bottomTab !== 'terminal'} id="bottom-panel-terminal" role="tabpanel" aria-labelledby="bottom-tab-terminal">
                    <RegionBoundary name="Terminal">
                        <TerminalPane terminals={terminals} searchOpen={searchOpen} onCloseSearch={() => setSearchOpen(false)} />
                    </RegionBoundary>
                </div>
                {(['output', 'build', 'debug'] as const).map(tab => {
                    const view = outputFor(tab)
                    return (
                        <div key={tab} className="bottom-panel__view" hidden={bottomTab !== tab} id={`bottom-panel-${tab}`} role="tabpanel" aria-labelledby={`bottom-tab-${tab}`}>
                            <OutputView
                                content={view.content}
                                running={view.running}
                                visible={active && bottomOpen && bottomTab === tab}
                                emptyText={view.empty}
                                onInput={tab === 'output' ? runner.sendInput : undefined}
                            />
                        </div>
                    )
                })}
            </div>
        </section>
    )
}

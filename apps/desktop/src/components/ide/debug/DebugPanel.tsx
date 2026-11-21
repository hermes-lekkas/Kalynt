/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Run & Debug sidebar view: launch config & task picker, DAP transport
 * controls, Call Stack, Scopes & Variables tree, Watch expressions,
 * Breakpoints list, and Debug Console REPL.
 */
import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    ChevronDown,
    ChevronRight,
    Eraser,
    Pause,
    Play,
    Plus,
    RefreshCw,
    RotateCw,
    Square,
    StepForward,
    Trash2,
    X
} from 'lucide-react'
import type { Variable } from '../../../types/debug'
import { IconButton, StatusDot } from '../../ui'
import { baseName, dirName, relativePath } from '../languages'
import { autoDebugConfig, describeDebugConfig, type DebugConfig } from '../hooks/debugConfig'
import { useActiveRunnerStore, type RunnerApi } from '../hooks/useRunner'
import './debug.css'

interface DebugPanelProps {
    folder: string | null
    activePath: string | null
    runner?: RunnerApi
    onOpenFile: (path: string, line?: number) => void
}

function valueToneClass(variable: Variable): string {
    const t = (variable.type ?? '').toLowerCase()
    const v = variable.value ?? ''
    if (t.includes('string') || /^['"`]/.test(v)) return 'debug-var__val--string'
    if (t.includes('number') || t.includes('int') || t.includes('float') || /^-?\d+(?:\.\d+)?$/.test(v)) {
        return 'debug-var__val--number'
    }
    return ''
}

function VariableNode({
    variable,
    depth,
    expanded,
    childrenMap,
    onToggle
}: {
    variable: Variable
    depth: number
    expanded: Set<number>
    childrenMap: Record<number, Variable[]>
    onToggle: (ref: number) => void
}) {
    const ref = variable.variablesReference ?? 0
    const expandable = ref > 0
    const isOpen = expandable && expanded.has(ref)
    const nested = expandable ? childrenMap[ref] ?? [] : []

    return (
        <li>
            <div className="debug-var" style={{ paddingLeft: 14 + depth * 12 }} title={`${variable.name}: ${variable.value}${variable.type ? ` (${variable.type})` : ''}`}>
                {expandable ? (
                    <button
                        type="button"
                        className="debug-var__toggle"
                        onClick={() => onToggle(ref)}
                        aria-label={isOpen ? `Collapse ${variable.name}` : `Expand ${variable.name}`}
                        aria-expanded={isOpen}
                    >
                        {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    </button>
                ) : (
                    <span className="debug-var__toggle" aria-hidden />
                )}
                <span className="debug-var__name">{variable.name}</span>
                <span className="debug-var__sep">=</span>
                <span className={`debug-var__val ${valueToneClass(variable)}`}>{variable.value}</span>
            </div>
            {isOpen && nested.length > 0 && (
                <ul className="debug-list">
                    {nested.map((child, idx) => (
                        <VariableNode
                            key={`${ref}-${child.name}-${idx}`}
                            variable={child}
                            depth={depth + 1}
                            expanded={expanded}
                            childrenMap={childrenMap}
                            onToggle={onToggle}
                        />
                    ))}
                </ul>
            )}
        </li>
    )
}

export function DebugPanel({ folder, activePath, runner: runnerProp, onOpenFile }: DebugPanelProps) {
    const liveRunner = useActiveRunnerStore(s => s.runner)
    const runner = runnerProp ?? liveRunner

    const [openSections, setOpenSections] = useState({
        callStack: true,
        variables: true,
        watch: true,
        breakpoints: true,
        console: true,
        tasks: false
    })
    const [collapsedScopes, setCollapsedScopes] = useState<Set<string>>(new Set())
    const [expandedVars, setExpandedVars] = useState<Set<number>>(new Set())
    const [watchInput, setWatchInput] = useState('')
    const [addingWatch, setAddingWatch] = useState(false)
    const [replInput, setReplInput] = useState('')
    const [replHistory, setReplHistory] = useState<string[]>([])
    const [historyIndex, setHistoryIndex] = useState(-1)

    const toggleSection = (key: keyof typeof openSections) => {
        setOpenSections(prev => ({ ...prev, [key]: !prev[key] }))
    }

    const launchOptions = useMemo(() => {
        const list: Array<{ key: string; label: string; config?: DebugConfig }> = []
        if (activePath) {
            const auto = autoDebugConfig(activePath)
            list.push({ key: '__auto__', label: `Auto: ${auto.name}` })
        }
        const configs = runner?.debugConfigurations ?? []
        for (const cfg of configs) {
            list.push({ key: cfg.name, label: describeDebugConfig(cfg), config: cfg })
        }
        return list
    }, [activePath, runner?.debugConfigurations])

    const flatBreakpoints = useMemo(() => {
        if (!runner) return [] as Array<{ file: string; line: number; enabled: boolean }>
        const rows: Array<{ file: string; line: number; enabled: boolean }> = []
        runner.breakpoints.forEach((lines, file) => {
            for (const line of lines) {
                const key = `${file.replace(/\\/g, '/')}:${line}`
                rows.push({ file, line, enabled: !runner.disabledBreakpoints.has(key) })
            }
        })
        rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
        return rows
    }, [runner])

    const handleToggleVar = (ref: number) => {
        setExpandedVars(prev => {
            const next = new Set(prev)
            if (next.has(ref)) {
                next.delete(ref)
            } else {
                next.add(ref)
                if (runner && !runner.variableChildren[ref]) {
                    void runner.expandVariable(ref)
                }
            }
            return next
        })
    }

    const handleAddWatch = (e: FormEvent) => {
        e.preventDefault()
        if (!runner || !watchInput.trim()) return
        runner.addWatch(watchInput)
        setWatchInput('')
        setAddingWatch(false)
    }

    const handleReplSubmit = (e: FormEvent) => {
        e.preventDefault()
        if (!runner) return
        const expr = replInput.trim()
        if (!expr) return
        setReplHistory(prev => [expr, ...prev.slice(0, 49)])
        setHistoryIndex(-1)
        setReplInput('')
        void runner.evaluateExpression(expr)
    }

    const handleReplKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowUp' && replHistory.length > 0) {
            e.preventDefault()
            const nextIdx = Math.min(historyIndex + 1, replHistory.length - 1)
            setHistoryIndex(nextIdx)
            setReplInput(replHistory[nextIdx])
        } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            if (historyIndex <= 0) {
                setHistoryIndex(-1)
                setReplInput('')
            } else {
                const nextIdx = historyIndex - 1
                setHistoryIndex(nextIdx)
                setReplInput(replHistory[nextIdx])
            }
        }
    }

    const jumpToFile = (path: string, line: number, column?: number) => {
        onOpenFile(path, line)
        window.dispatchEvent(
            new CustomEvent('kalynt-open-file', { detail: { path, line, column: column || 1 } })
        )
    }

    const handleStartSelected = () => {
        if (!runner) return
        const chosen = runner.selectedDebugConfig
            ? runner.debugConfigurations.find(c => c.name === runner.selectedDebugConfig)
            : undefined
        void runner.startDebug(chosen)
    }

    const selectedLaunchValue = runner?.selectedDebugConfig ?? (activePath ? '__auto__' : runner?.debugConfigurations[0]?.name ?? '')

    return (
        <div className="debug-panel">
            <header className="side-head">
                <h2 className="side-head__title">Run &amp; Debug</h2>
                <div className="side-head__actions">
                    <IconButton
                        size="sm"
                        label="Refresh configurations & tasks"
                        icon={<RefreshCw size={13} />}
                        onClick={() => {
                            void runner?.refreshDebugConfigs()
                            void runner?.refreshTasks()
                        }}
                        disabled={!folder || !runner}
                    />
                </div>
            </header>

            <div className="debug-launch">
                <select
                    className="debug-launch__select"
                    aria-label="Debug launch configuration"
                    value={selectedLaunchValue}
                    onChange={e => {
                        const val = e.target.value
                        runner?.setSelectedDebugConfig(val === '__auto__' ? null : val)
                    }}
                    disabled={!runner || launchOptions.length === 0}
                >
                    {launchOptions.length === 0 ? (
                        <option value="">Open a file to debug</option>
                    ) : (
                        launchOptions.map(opt => (
                            <option key={opt.key} value={opt.key}>{opt.label}</option>
                        ))
                    )}
                </select>
                {runner?.isDebugging ? (
                    <IconButton
                        size="sm"
                        tone="danger"
                        label="Stop debugging"
                        shortcut="Shift+F5"
                        icon={<Square size={13} />}
                        onClick={() => { void runner.stopDebug() }}
                    />
                ) : (
                    <IconButton
                        size="sm"
                        label="Start debugging"
                        icon={<Play size={13} />}
                        onClick={handleStartSelected}
                        disabled={!runner || !folder || (!activePath && (runner?.debugConfigurations.length ?? 0) === 0)}
                    />
                )}
            </div>

            {runner?.isDebugging && (
                <div className="debug-toolbar" role="toolbar" aria-label="Debug controls">
                    <div className="debug-toolbar__controls">
                        {runner.isPaused ? (
                            <IconButton size="sm" label="Continue" shortcut="F5" icon={<Play size={13} />} onClick={() => { void runner.debugStep('continue') }} />
                        ) : (
                            <IconButton size="sm" label="Pause" shortcut="F6" icon={<Pause size={13} />} onClick={() => { void runner.debugStep('pause') }} />
                        )}
                        <IconButton size="sm" label="Step over" shortcut="F10" icon={<StepForward size={13} />} onClick={() => { void runner.debugStep('stepOver') }} disabled={!runner.isPaused} />
                        <IconButton size="sm" label="Step into" shortcut="F11" icon={<ArrowDownToLine size={13} />} onClick={() => { void runner.debugStep('stepInto') }} disabled={!runner.isPaused} />
                        <IconButton size="sm" label="Step out" shortcut="Shift+F11" icon={<ArrowUpFromLine size={13} />} onClick={() => { void runner.debugStep('stepOut') }} disabled={!runner.isPaused} />
                        <IconButton size="sm" label="Restart" icon={<RotateCw size={13} />} onClick={() => { void runner.restartDebug() }} />
                        <IconButton size="sm" tone="danger" label="Stop" shortcut="Shift+F5" icon={<Square size={12} />} onClick={() => { void runner.stopDebug() }} />
                    </div>
                    <span className="debug-toolbar__status" title={runner.pausedReason ?? undefined}>
                        <StatusDot tone={runner.isPaused ? 'warning' : 'success'} pulse={!runner.isPaused} />
                        <span>{runner.isPaused ? (runner.pausedReason || 'Paused') : 'Running'}</span>
                    </span>
                </div>
            )}

            <div className="debug-panel__scroll">
                {/* Call Stack */}
                <section className="debug-section">
                    <div className="debug-section__head">
                        <button type="button" className="debug-section__toggle" onClick={() => toggleSection('callStack')} aria-expanded={openSections.callStack}>
                            {openSections.callStack ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            <span>Call Stack</span>
                            {(runner?.callStack.length ?? 0) > 0 && (
                                <span className="debug-section__count">{runner?.callStack.length}</span>
                            )}
                        </button>
                    </div>
                    {openSections.callStack && (
                        <div className="debug-section__body">
                            {!runner?.isDebugging ? (
                                <p className="debug-empty">Not debugging.</p>
                            ) : !runner.isPaused ? (
                                <p className="debug-empty">Running… pause or hit a breakpoint to inspect frames.</p>
                            ) : runner.callStack.length === 0 ? (
                                <p className="debug-empty">No stack frames returned.</p>
                            ) : (
                                <ul className="debug-list">
                                    {runner.callStack.map(frame => (
                                        <li key={frame.id}>
                                            <button
                                                type="button"
                                                className={`debug-frame ${runner.selectedFrameId === frame.id ? 'is-selected' : ''}`}
                                                onClick={() => { void runner.selectFrame(frame.id) }}
                                                title={frame.source?.path ? `${frame.name} — ${frame.source.path}:${frame.line}` : frame.name}
                                            >
                                                <span className="debug-frame__name">{frame.name}</span>
                                                <span className="debug-frame__loc">
                                                    {frame.source?.name || (frame.source?.path ? baseName(frame.source.path) : '')}:{frame.line}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </section>

                {/* Scopes & Variables */}
                <section className="debug-section">
                    <div className="debug-section__head">
                        <button type="button" className="debug-section__toggle" onClick={() => toggleSection('variables')} aria-expanded={openSections.variables}>
                            {openSections.variables ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            <span>Variables</span>
                        </button>
                    </div>
                    {openSections.variables && (
                        <div className="debug-section__body">
                            {!runner?.isPaused ? (
                                <p className="debug-empty">{runner?.isDebugging ? 'Pause execution to inspect variables.' : 'No active frame.'}</p>
                            ) : runner.scopes.length === 0 ? (
                                <p className="debug-empty">No variables in this frame.</p>
                            ) : (
                                runner.scopes.map(scope => {
                                    const isOpen = !collapsedScopes.has(scope.name)
                                    return (
                                        <div key={scope.name}>
                                            <button
                                                type="button"
                                                className="debug-scope__title"
                                                onClick={() => {
                                                    setCollapsedScopes(prev => {
                                                        const next = new Set(prev)
                                                        if (next.has(scope.name)) next.delete(scope.name)
                                                        else next.add(scope.name)
                                                        return next
                                                    })
                                                }}
                                                aria-expanded={isOpen}
                                            >
                                                {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                                <span>{scope.name}</span>
                                            </button>
                                            {isOpen && (
                                                <ul className="debug-list">
                                                    {scope.variables.map((v, idx) => (
                                                        <VariableNode
                                                            key={`${scope.name}-${v.name}-${idx}`}
                                                            variable={v}
                                                            depth={0}
                                                            expanded={expandedVars}
                                                            childrenMap={runner.variableChildren}
                                                            onToggle={handleToggleVar}
                                                        />
                                                    ))}
                                                </ul>
                                            )}
                                        </div>
                                    )
                                })
                            )}
                        </div>
                    )}
                </section>

                {/* Watch Expressions */}
                <section className="debug-section">
                    <div className="debug-section__head">
                        <button type="button" className="debug-section__toggle" onClick={() => toggleSection('watch')} aria-expanded={openSections.watch}>
                            {openSections.watch ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            <span>Watch</span>
                            {(runner?.watches.length ?? 0) > 0 && (
                                <span className="debug-section__count">{runner?.watches.length}</span>
                            )}
                        </button>
                        <div className="debug-section__actions">
                            <IconButton
                                size="sm"
                                label="Add watch expression"
                                icon={<Plus size={12} />}
                                onClick={() => {
                                    setOpenSections(prev => ({ ...prev, watch: true }))
                                    setAddingWatch(v => !v)
                                }}
                            />
                            {runner?.isDebugging && (
                                <IconButton
                                    size="sm"
                                    label="Refresh watch expressions"
                                    icon={<RefreshCw size={12} />}
                                    onClick={() => runner.refreshWatches()}
                                />
                            )}
                        </div>
                    </div>
                    {openSections.watch && (
                        <div className="debug-section__body">
                            {addingWatch && (
                                <form className="debug-watch-form" onSubmit={handleAddWatch}>
                                    <input
                                        type="text"
                                        value={watchInput}
                                        onChange={e => setWatchInput(e.target.value)}
                                        placeholder="Expression to watch…"
                                        aria-label="Watch expression"
                                        autoFocus
                                    />
                                    <IconButton size="sm" type="submit" label="Save watch" icon={<Plus size={12} />} />
                                </form>
                            )}
                            {(runner?.watches.length ?? 0) === 0 ? (
                                <p className="debug-empty">No watch expressions. Click + to add one.</p>
                            ) : (
                                <ul className="debug-list">
                                    {runner!.watches.map(w => (
                                        <li key={w.id} className="debug-watch-row">
                                            <span className="debug-var__name">{w.expression}</span>
                                            <span className="debug-var__sep">=</span>
                                            <span className={`debug-var__val ${w.error ? 'debug-var__val--error' : ''}`}>
                                                {w.error ?? w.value ?? (runner?.isDebugging ? '…' : 'not available')}
                                            </span>
                                            <IconButton
                                                size="sm"
                                                className="debug-watch-row__remove"
                                                label={`Remove watch ${w.expression}`}
                                                icon={<X size={11} />}
                                                onClick={() => runner!.removeWatch(w.id)}
                                            />
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </section>

                {/* Breakpoints */}
                <section className="debug-section">
                    <div className="debug-section__head">
                        <button type="button" className="debug-section__toggle" onClick={() => toggleSection('breakpoints')} aria-expanded={openSections.breakpoints}>
                            {openSections.breakpoints ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            <span>Breakpoints</span>
                            {flatBreakpoints.length > 0 && (
                                <span className="debug-section__count">{flatBreakpoints.length}</span>
                            )}
                        </button>
                        {flatBreakpoints.length > 0 && runner && (
                            <div className="debug-section__actions">
                                <IconButton
                                    size="sm"
                                    label="Remove all breakpoints"
                                    icon={<Trash2 size={12} />}
                                    onClick={() => runner.clearBreakpoints()}
                                />
                            </div>
                        )}
                    </div>
                    {openSections.breakpoints && (
                        <div className="debug-section__body">
                            {flatBreakpoints.length === 0 ? (
                                <p className="debug-empty">Click in the editor gutter to add breakpoints.</p>
                            ) : (
                                <ul className="debug-list">
                                    {flatBreakpoints.map(bp => {
                                        const rel = relativePath(bp.file, folder)
                                        const relDir = dirName(rel)
                                        return (
                                            <li key={`${bp.file}:${bp.line}`} className={`debug-bp-row ${bp.enabled ? '' : 'is-disabled'}`}>
                                                <input
                                                    type="checkbox"
                                                    className="debug-bp-row__check"
                                                    checked={bp.enabled}
                                                    onChange={() => runner?.toggleBreakpointEnabled(bp.file, bp.line)}
                                                    aria-label={`${bp.enabled ? 'Disable' : 'Enable'} breakpoint at ${baseName(bp.file)}:${bp.line}`}
                                                />
                                                <button
                                                    type="button"
                                                    className="debug-bp-row__jump"
                                                    onClick={() => jumpToFile(bp.file, bp.line)}
                                                    title={`${bp.file}:${bp.line}`}
                                                >
                                                    <span className="debug-bp-row__file">{baseName(bp.file)}</span>
                                                    {relDir && relDir !== '.' && <span className="debug-bp-row__dir">{relDir}</span>}
                                                    <span className="debug-bp-row__line">{bp.line}</span>
                                                </button>
                                                <IconButton
                                                    size="sm"
                                                    className="debug-bp-row__remove"
                                                    label={`Remove breakpoint at ${baseName(bp.file)}:${bp.line}`}
                                                    icon={<X size={11} />}
                                                    onClick={() => runner?.removeBreakpoint(bp.file, bp.line)}
                                                />
                                            </li>
                                        )
                                    })}
                                </ul>
                            )}
                        </div>
                    )}
                </section>

                {/* Debug Console REPL */}
                <section className="debug-section">
                    <div className="debug-section__head">
                        <button type="button" className="debug-section__toggle" onClick={() => toggleSection('console')} aria-expanded={openSections.console}>
                            {openSections.console ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            <span>Debug Console</span>
                        </button>
                        {(runner?.debugConsole.length ?? 0) > 0 && runner && (
                            <div className="debug-section__actions">
                                <IconButton
                                    size="sm"
                                    label="Clear debug console"
                                    icon={<Eraser size={12} />}
                                    onClick={() => runner.clearDebugConsole()}
                                />
                            </div>
                        )}
                    </div>
                    {openSections.console && (
                        <div className="debug-repl">
                            {(runner?.debugConsole.length ?? 0) > 0 && (
                                <div className="debug-repl__log" role="log" aria-label="Debug console output">
                                    {runner!.debugConsole.map(entry => (
                                        <div key={entry.id} className={`debug-repl__entry debug-repl__entry--${entry.kind}`}>
                                            {entry.kind === 'input' ? `> ${entry.text}` : entry.text}
                                        </div>
                                    ))}
                                </div>
                            )}
                            <form className="debug-repl__form" onSubmit={handleReplSubmit}>
                                <span className="debug-repl__prompt" aria-hidden>&gt;</span>
                                <input
                                    type="text"
                                    className="debug-repl__input"
                                    value={replInput}
                                    onChange={e => setReplInput(e.target.value)}
                                    onKeyDown={handleReplKeyDown}
                                    placeholder={runner?.isDebugging ? 'Evaluate expression…' : 'Start debugging to evaluate'}
                                    aria-label="Evaluate debug expression"
                                    disabled={!runner?.isDebugging}
                                />
                            </form>
                        </div>
                    )}
                </section>

                {/* Workspace Tasks Picker */}
                <section className="debug-section">
                    <div className="debug-section__head">
                        <button type="button" className="debug-section__toggle" onClick={() => toggleSection('tasks')} aria-expanded={openSections.tasks}>
                            {openSections.tasks ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            <span>Tasks</span>
                            {(runner?.buildTasks.length ?? 0) > 0 && (
                                <span className="debug-section__count">{runner?.buildTasks.length}</span>
                            )}
                        </button>
                        {runner?.isBuilding && (
                            <div className="debug-section__actions">
                                <IconButton
                                    size="sm"
                                    tone="danger"
                                    label="Stop running task"
                                    icon={<Square size={11} />}
                                    onClick={() => { void runner.stopBuild() }}
                                />
                            </div>
                        )}
                    </div>
                    {openSections.tasks && (
                        <div className="debug-section__body">
                            {(runner?.buildTasks.length ?? 0) === 0 ? (
                                <p className="debug-empty">No tasks detected in this folder.</p>
                            ) : (
                                <ul className="debug-list">
                                    {runner!.buildTasks.map((task, idx) => {
                                        const groupKind = typeof task.group === 'string' ? task.group : task.group?.kind
                                        return (
                                            <li key={`${task.label}-${idx}`}>
                                                <button
                                                    type="button"
                                                    className="debug-task-row"
                                                    onClick={() => { void runner!.runTask(task) }}
                                                    title={task.detail || task.command}
                                                >
                                                    <Play size={11} aria-hidden />
                                                    <span className="debug-task-row__label">{task.label}</span>
                                                    {groupKind && <span className="debug-task-row__tag">{groupKind}</span>}
                                                </button>
                                            </li>
                                        )
                                    })}
                                </ul>
                            )}
                        </div>
                    )}
                </section>
            </div>
        </div>
    )
}

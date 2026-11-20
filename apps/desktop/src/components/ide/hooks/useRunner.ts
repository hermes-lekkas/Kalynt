/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Running the current file, building the project (with task picker support)
 * and full DAP debugging (call stack, scopes/variables, watch expressions,
 * breakpoints, console REPL, and editor active-line highlighting).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import type { OpenFile } from '../../../types/ide'
import type { Scope, StackFrame, Variable } from '../../../types/debug'
import type { Task } from '../../../types/tasks'
import { useNotificationStore } from '../../../stores/notificationStore'
import { useLayoutStore } from '../../../stores/layoutStore'
import { useDiagnosticsStore, type RawBuildProblem } from '../../../stores/diagnosticsStore'
import { RUNNABLE_LANGUAGES, languageLabel } from '../languages'
import { autoDebugConfig, debugFamily, type DebugConfig } from './debugConfig'

const api = () => window.electronAPI
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface DebugScopeView {
    name: string
    variablesReference: number
    expensive?: boolean
    variables: Variable[]
}

export interface WatchEntry {
    id: string
    expression: string
    value?: string
    type?: string
    error?: string
    variablesReference?: number
}

export interface DebugConsoleEntry {
    id: string
    kind: 'input' | 'result' | 'error' | 'output'
    text: string
    type?: string
}

interface Options {
    folder: string | null
    activeFile: OpenFile | null
    saveFile: (path?: string | null) => Promise<boolean>
}

const bpKey = (file: string, line: number) => `${file.replace(/\\/g, '/')}:${line}`

function dispatchDebugLocation(detail: { path: string; line: number; column?: number } | null) {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('kalynt-debug-location', { detail }))
}

function dispatchOpenFile(path: string, line: number, column?: number) {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('kalynt-open-file', { detail: { path, line, column } }))
}

function dispatchBottomTabSwitch(tab: 'output' | 'build' | 'debug') {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('kalynt-bottom-tab', { detail: tab }))
}

export function useRunner({ folder, activeFile, saveFile }: Options) {
    const addNotification = useNotificationStore(s => s.addNotification)
    const showBottomTab = useLayoutStore(s => s.showBottomTab)

    const [runOutput, setRunOutput] = useState('')
    const [buildOutput, setBuildOutput] = useState('')
    const [debugOutput, setDebugOutput] = useState('')
    const [isRunning, setIsRunning] = useState(false)
    const [isBuilding, setIsBuilding] = useState(false)
    const [isDebugging, setIsDebugging] = useState(false)
    const [isPaused, setIsPaused] = useState(false)
    const [pausedReason, setPausedReason] = useState<string | null>(null)

    const [breakpoints, setBreakpoints] = useState<Map<string, number[]>>(new Map())
    const [disabledBreakpoints, setDisabledBreakpoints] = useState<Set<string>>(new Set())

    const [callStack, setCallStack] = useState<StackFrame[]>([])
    const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null)
    const [scopes, setScopes] = useState<DebugScopeView[]>([])
    const [variableChildren, setVariableChildren] = useState<Record<number, Variable[]>>({})
    const [watches, setWatches] = useState<WatchEntry[]>([])
    const [debugConsole, setDebugConsole] = useState<DebugConsoleEntry[]>([])

    const [debugConfigurations, setDebugConfigurations] = useState<DebugConfig[]>([])
    const [selectedDebugConfig, setSelectedDebugConfig] = useState<string | null>(null)
    const [buildTasks, setBuildTasks] = useState<Task[]>([])
    const [activeBuildTaskLabel, setActiveBuildTaskLabel] = useState<string | null>(null)

    const executionId = useRef<string | null>(null)
    const buildTaskId = useRef<string | null>(null)
    const debugSessionId = useRef<string | null>(null)
    const debugStarting = useRef(false)
    const activeThreadId = useRef<number | undefined>(undefined)
    const lastDebugConfig = useRef<DebugConfig | null>(null)
    const adapterMissing = useRef(false)
    const runListeners = useRef<Array<() => void>>([])
    const folderRef = useRef(folder)
    folderRef.current = folder
    const watchesRef = useRef(watches)
    watchesRef.current = watches
    const selectedFrameIdRef = useRef(selectedFrameId)
    selectedFrameIdRef.current = selectedFrameId
    const prevFolderRef = useRef<string | null>(folder)
    const loadGenRef = useRef(0)

    const clearRunListeners = useCallback(() => {
        runListeners.current.forEach(off => off())
        runListeners.current = []
    }, [])

    const focusBottom = useCallback((tab: 'output' | 'build' | 'debug') => {
        showBottomTab(tab)
        dispatchBottomTabSwitch(tab)
    }, [showBottomTab])

    const clearPausedState = useCallback(() => {
        setIsPaused(false)
        setPausedReason(null)
        setCallStack([])
        setSelectedFrameId(null)
        setScopes([])
        setVariableChildren({})
        dispatchDebugLocation(null)
    }, [])

    const refreshTasks = useCallback(async (targetFolder?: string | null) => {
        const dir = targetFolder ?? folderRef.current
        if (!dir) {
            setBuildTasks([])
            return [] as Task[]
        }
        try {
            const res = await api()?.build.getTasks(dir)
            const list: Task[] = res?.success && Array.isArray(res.tasks) ? res.tasks : []
            if (dir === folderRef.current) setBuildTasks(list)
            return list
        } catch {
            if (dir === folderRef.current) setBuildTasks([])
            return [] as Task[]
        }
    }, [])

    const refreshDebugConfigs = useCallback(async (targetFolder?: string | null) => {
        const dir = targetFolder ?? folderRef.current
        if (!dir) {
            setDebugConfigurations([])
            return [] as DebugConfig[]
        }
        try {
            const res = await api()?.debug.getConfigurations(dir)
            const list: DebugConfig[] = res?.success && Array.isArray(res.configurations) ? res.configurations : []
            if (dir === folderRef.current) setDebugConfigurations(list)
            return list
        } catch {
            if (dir === folderRef.current) setDebugConfigurations([])
            return [] as DebugConfig[]
        }
    }, [])

    const evaluateWatchList = useCallback(async (session: string, frameId?: number) => {
        const current = watchesRef.current
        if (current.length === 0) return
        const d = api()?.debug
        if (!d?.evaluate) return
        const updated = await Promise.all(
            current.map(async entry => {
                try {
                    const res = await d.evaluate(session, entry.expression, frameId)
                    if (res?.success && res.result) {
                        return {
                            ...entry,
                            value: String(res.result.result ?? ''),
                            type: res.result.type ? String(res.result.type) : undefined,
                            variablesReference: Number(res.result.variablesReference) || 0,
                            error: undefined
                        }
                    }
                    return { ...entry, value: undefined, error: res?.error || 'Unavailable' }
                } catch (e) {
                    return { ...entry, value: undefined, error: errorText(e) }
                }
            })
        )
        if (debugSessionId.current === session) {
            setWatches(updated)
        }
    }, [])

    const loadFrameInspection = useCallback(async (session: string, frame: StackFrame) => {
        const d = api()?.debug
        if (!d) return
        setSelectedFrameId(frame.id)
        setVariableChildren({})

        if (frame.source?.path) {
            dispatchOpenFile(frame.source.path, frame.line, frame.column || 1)
            dispatchDebugLocation({ path: frame.source.path, line: frame.line, column: frame.column || 1 })
        }

        const nextScopes: DebugScopeView[] = []
        try {
            if (typeof d.getScopes === 'function') {
                const scopesRes = await d.getScopes(session, frame.id)
                const rawScopes: Scope[] = scopesRes?.success && Array.isArray(scopesRes.scopes) ? scopesRes.scopes : []
                for (const sc of rawScopes) {
                    if (debugSessionId.current !== session) return
                    const varsRes = sc.variablesReference > 0
                        ? await d.getVariables(session, sc.variablesReference).catch(() => null)
                        : null
                    nextScopes.push({
                        name: sc.name,
                        variablesReference: sc.variablesReference,
                        expensive: sc.expensive,
                        variables: varsRes?.success && Array.isArray(varsRes.variables) ? varsRes.variables : []
                    })
                }
            } else if (typeof d.getVariables === 'function') {
                const varsRes = await d.getVariables(session, frame.id).catch(() => null)
                if (varsRes?.success && Array.isArray(varsRes.variables) && varsRes.variables.length > 0) {
                    nextScopes.push({
                        name: 'Locals',
                        variablesReference: frame.id,
                        variables: varsRes.variables
                    })
                }
            }
        } catch {
            // Adapter may not expose variables for this frame
        }

        if (debugSessionId.current === session) {
            setScopes(nextScopes)
            void evaluateWatchList(session, frame.id)
        }
    }, [evaluateWatchList])

    const selectFrame = useCallback(async (frameId: number) => {
        const session = debugSessionId.current
        if (!session) return
        const frame = callStack.find(f => f.id === frameId)
        if (!frame) return
        await loadFrameInspection(session, frame)
    }, [callStack, loadFrameInspection])

    const expandVariable = useCallback(async (variablesReference: number) => {
        const session = debugSessionId.current
        if (!session || variablesReference <= 0) return [] as Variable[]
        try {
            const res = await api()?.debug.getVariables(session, variablesReference)
            const children: Variable[] = res?.success && Array.isArray(res.variables) ? res.variables : []
            if (debugSessionId.current === session) {
                setVariableChildren(prev => ({ ...prev, [variablesReference]: children }))
            }
            return children
        } catch {
            return [] as Variable[]
        }
    }, [])

    const addWatch = useCallback((expression: string) => {
        const trimmed = expression.trim()
        if (!trimmed) return
        const entry: WatchEntry = {
            id: `w-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            expression: trimmed
        }
        setWatches(prev => [...prev, entry])
        const session = debugSessionId.current
        if (session) {
            const frameId = selectedFrameIdRef.current ?? undefined
            void api()?.debug.evaluate(session, trimmed, frameId).then((res: { success?: boolean; result?: { result?: string; type?: string; variablesReference?: number }; error?: string }) => {
                setWatches(prev => prev.map(w => {
                    if (w.id !== entry.id) return w
                    if (res?.success && res.result) {
                        return {
                            ...w,
                            value: String(res.result.result ?? ''),
                            type: res.result.type ? String(res.result.type) : undefined,
                            variablesReference: Number(res.result.variablesReference) || 0,
                            error: undefined
                        }
                    }
                    return { ...w, value: undefined, error: res?.error || 'Unavailable' }
                }))
            }).catch((e: unknown) => {
                setWatches(prev => prev.map(w => (w.id === entry.id ? { ...w, error: errorText(e) } : w)))
            })
        }
    }, [])

    const removeWatch = useCallback((id: string) => {
        setWatches(prev => prev.filter(w => w.id !== id))
    }, [])

    const refreshWatches = useCallback(() => {
        const session = debugSessionId.current
        if (session) void evaluateWatchList(session, selectedFrameIdRef.current ?? undefined)
    }, [evaluateWatchList])

    const evaluateExpression = useCallback(async (expression: string) => {
        const trimmed = expression.trim()
        if (!trimmed) return
        const inputEntry: DebugConsoleEntry = {
            id: `c-in-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            kind: 'input',
            text: trimmed
        }
        setDebugConsole(prev => [...prev.slice(-198), inputEntry])
        setDebugOutput(prev => `${prev}> ${trimmed}\n`)

        const session = debugSessionId.current
        if (!session) {
            const errEntry: DebugConsoleEntry = {
                id: `c-err-${Date.now()}`,
                kind: 'error',
                text: 'No active debug session.'
            }
            setDebugConsole(prev => [...prev.slice(-198), errEntry])
            return
        }

        try {
            const res = await api()?.debug.evaluate(session, trimmed, selectedFrameIdRef.current ?? undefined)
            if (res?.success && res.result) {
                const value = String(res.result.result ?? '')
                const outEntry: DebugConsoleEntry = {
                    id: `c-res-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    kind: 'result',
                    text: value,
                    type: res.result.type ? String(res.result.type) : undefined
                }
                setDebugConsole(prev => [...prev.slice(-198), outEntry])
                setDebugOutput(prev => `${prev}${value}\n`)
            } else {
                const msg = res?.error || 'Evaluation failed'
                setDebugConsole(prev => [...prev.slice(-198), { id: `c-err-${Date.now()}`, kind: 'error', text: msg }])
                setDebugOutput(prev => `${prev}✗ ${msg}\n`)
            }
        } catch (e) {
            const msg = errorText(e)
            setDebugConsole(prev => [...prev.slice(-198), { id: `c-err-${Date.now()}`, kind: 'error', text: msg }])
            setDebugOutput(prev => `${prev}✗ ${msg}\n`)
        }
    }, [])

    const clearDebugConsole = useCallback(() => {
        setDebugConsole([])
    }, [])

    const canRun = !!activeFile && RUNNABLE_LANGUAGES.has(activeFile.language)

    const run = useCallback(async () => {
        if (!activeFile) return
        if (!RUNNABLE_LANGUAGES.has(activeFile.language)) {
            addNotification(`Kalynt can't run ${languageLabel(activeFile.language)} files yet.`, 'warning')
            return
        }
        const saved = await saveFile(activeFile.path)
        if (!saved) return

        // Kill any previous execution cleanly before starting a new one.
        if (executionId.current) {
            api()?.code.kill(executionId.current)
            clearRunListeners()
        }

        const id = `exec-${Date.now()}`
        executionId.current = id
        setIsRunning(true)
        setRunOutput(`▶ Running ${activeFile.name}\n`)
        focusBottom('output')

        clearRunListeners()
        const offOutput = api()?.code.onOutput((data: { id: string; data: string }) => {
            if (data.id === id && data.data) setRunOutput(prev => prev + data.data)
        })
        const offExit = api()?.code.onExit((data: { id: string; exitCode: number | null; signal?: string | null; phase?: string }) => {
            if (data.id !== id) return
            const stopped = executionId.current !== id
            setIsRunning(false)
            executionId.current = null
            clearRunListeners()
            if (stopped) return // stopRun already wrote "Stopped"
            const line = data.phase === 'compile' && data.exitCode !== 0
                ? '✗ Compilation failed'
                : data.exitCode === 0 ? '✓ Exited with code 0'
                    : data.exitCode !== null ? `✗ Exited with code ${data.exitCode}`
                        : data.signal ? `✗ Ended by ${data.signal}` : '✗ Didn’t start'
            setRunOutput(prev => `${prev}${prev.endsWith('\n') ? '' : '\n'}${line}\n`)
        })
        if (typeof offOutput === 'function') runListeners.current.push(offOutput)
        if (typeof offExit === 'function') runListeners.current.push(offExit)

        // The file was just saved, so it runs in place and its imports resolve. No time limit: Stop ends it.
        const result = await api()?.code.execute({ id, filePath: activeFile.path, code: activeFile.content, language: activeFile.language, cwd: folder || undefined, timeoutMs: 0 })
        // Failures that produced an exit event were already reported above.
        if (!result?.success && executionId.current === id) {
            setRunOutput(prev => `${prev}\n✗ Couldn't start: ${result?.error || 'unknown error'}\n`)
            setIsRunning(false)
            executionId.current = null
            clearRunListeners()
        }
    }, [activeFile, folder, saveFile, addNotification, focusBottom, clearRunListeners])

    const stopRun = useCallback(() => {
        if (!executionId.current) return
        const id = executionId.current
        executionId.current = null
        clearRunListeners()
        api()?.code.kill(id)
        setRunOutput(prev => `${prev}\n■ Stopped\n`)
        setIsRunning(false)
    }, [clearRunListeners])

    const sendInput = useCallback((data: string) => {
        if (executionId.current) api()?.code?.writeInput?.(executionId.current, data)
    }, [])

    const runTask = useCallback(async (task: Task) => {
        if (!folder) return
        if (buildTaskId.current) {
            await api()?.build.killTask(buildTaskId.current).catch(() => undefined)
            buildTaskId.current = null
        }
        useDiagnosticsStore.getState().clearOrigin('build')
        const label = task.label || task.command || 'Build'
        setBuildOutput(`▶ ${label}\n`)
        setActiveBuildTaskLabel(label)
        focusBottom('build')
        try {
            const result = await api()?.build.executeTask(task, folder)
            if (result?.success && result.taskId) {
                buildTaskId.current = result.taskId
                setIsBuilding(true)
            } else {
                setActiveBuildTaskLabel(null)
                addNotification(result?.error || "The task didn't start.", 'error')
            }
        } catch (e) {
            setActiveBuildTaskLabel(null)
            addNotification(`Build error: ${errorText(e)}`, 'error')
        }
    }, [folder, addNotification, focusBottom])

    const build = useCallback(async (explicitTask?: Task) => {
        if (!folder) return
        if (explicitTask) {
            await runTask(explicitTask)
            return
        }
        setBuildOutput('')
        focusBottom('build')
        try {
            const list = await refreshTasks(folder)
            const kindOf = (t: { group?: unknown }) => {
                const group = t.group as { kind?: string; isDefault?: boolean } | string | undefined
                return typeof group === 'object' ? { kind: group?.kind, isDefault: !!group?.isDefault } : { kind: group, isDefault: false }
            }
            const task = list.find(t => kindOf(t).kind === 'build' && kindOf(t).isDefault) ?? list.find(t => kindOf(t).kind === 'build')
            if (!task) {
                setBuildOutput('No build task found. Add a "build" script to package.json or a build task to .vscode/tasks.json.\n')
                addNotification('No build task found in this folder.', 'warning')
                return
            }
            await runTask(task)
        } catch (e) {
            addNotification(`Build error: ${errorText(e)}`, 'error')
        }
    }, [folder, refreshTasks, runTask, addNotification, focusBottom])

    const stopBuild = useCallback(async () => {
        if (!buildTaskId.current) return
        const id = buildTaskId.current
        buildTaskId.current = null
        try {
            await api()?.build.killTask(id)
            setBuildOutput(prev => `${prev}\n■ Build stopped\n`)
        } catch (e) {
            addNotification(`Couldn't stop the build: ${errorText(e)}`, 'error')
        }
        setIsBuilding(false)
        setActiveBuildTaskLabel(null)
    }, [addNotification])

    const enabledBreakpointsPayload = useCallback(() => {
        const result: Array<{ file: string; lines: number[] }> = []
        breakpoints.forEach((lines, file) => {
            const activeLines = lines.filter(line => !disabledBreakpoints.has(bpKey(file, line)))
            if (activeLines.length > 0) result.push({ file, lines: activeLines })
        })
        return result
    }, [breakpoints, disabledBreakpoints])

    const startDebug = useCallback(async (overrideConfig?: DebugConfig) => {
        if (!folder) return
        if (!activeFile && !overrideConfig) return
        if (activeFile) {
            const saved = await saveFile(activeFile.path)
            if (!saved) return
        }

        if (debugSessionId.current) {
            await api()?.debug.stop(debugSessionId.current).catch(() => undefined)
            debugSessionId.current = null
        }

        clearPausedState()
        setDebugOutput('')
        setDebugConsole([])
        focusBottom('debug')

        try {
            const fallback = activeFile ? autoDebugConfig(activeFile.path) : null
            const configs = await refreshDebugConfigs(folder)
            let config: DebugConfig | null = overrideConfig ?? null
            if (!config && selectedDebugConfig) {
                config = configs.find(c => c.name === selectedDebugConfig) ?? null
            }
            if (!config && fallback) {
                config = configs.find(c => debugFamily(c.type) === debugFamily(fallback.type)) ?? fallback
            }
            if (!config) {
                config = configs[0] ?? null
            }
            if (!config) {
                addNotification('No debug configuration available. Open a file or add .vscode/launch.json.', 'warning')
                return
            }

            lastDebugConfig.current = config
            const initial = enabledBreakpointsPayload()
            setDebugOutput(`▶ Starting ${config.name}\n`)
            adapterMissing.current = false
            debugStarting.current = true
            const result = await api()?.debug.start(config, folder, activeFile?.path, initial)
            debugStarting.current = false
            if (result?.success && result.sessionId) {
                debugSessionId.current = result.sessionId
                setIsDebugging(true)
            } else {
                const message = result?.error || "The debugger didn't start."
                setDebugOutput(prev => `${prev}✗ ${message}\n`)
                if (!adapterMissing.current) addNotification(message, 'error')
            }
        } catch (e) {
            debugStarting.current = false
            addNotification(`Debug error: ${errorText(e)}`, 'error')
        }
    }, [activeFile, folder, saveFile, clearPausedState, focusBottom, refreshDebugConfigs, selectedDebugConfig, enabledBreakpointsPayload, addNotification])

    const stopDebug = useCallback(async () => {
        const session = debugSessionId.current
        if (!session) return
        debugSessionId.current = null
        activeThreadId.current = undefined
        clearPausedState()
        try {
            await api()?.debug.stop(session)
            setDebugOutput(prev => `${prev}\n■ Debug session stopped\n`)
        } catch (e) {
            addNotification(`Couldn't stop debugging: ${errorText(e)}`, 'error')
        }
        setIsDebugging(false)
    }, [addNotification, clearPausedState])

    const restartDebug = useCallback(async () => {
        const config = lastDebugConfig.current ?? undefined
        if (debugSessionId.current) {
            await stopDebug()
        }
        await startDebug(config)
    }, [stopDebug, startDebug])

    const debugStep = useCallback(async (action: 'continue' | 'stepOver' | 'stepInto' | 'stepOut' | 'pause') => {
        const session = debugSessionId.current
        if (!session) return
        if (action !== 'pause') {
            clearPausedState()
        }
        try {
            await api()?.debug[action](session, activeThreadId.current)
        } catch (e) {
            addNotification(`Debugger ${action} failed: ${errorText(e)}`, 'error')
        }
    }, [addNotification, clearPausedState])

    const toggleBreakpoint = useCallback((path: string, line: number) => {
        setBreakpoints(prev => {
            const next = new Map(prev)
            const lines = next.get(path) ?? []
            if (lines.includes(line)) {
                const remaining = lines.filter(l => l !== line)
                if (remaining.length > 0) next.set(path, remaining)
                else next.delete(path)
                setDisabledBreakpoints(d => {
                    const key = bpKey(path, line)
                    if (!d.has(key)) return d
                    const copy = new Set(d)
                    copy.delete(key)
                    return copy
                })
            } else {
                next.set(path, [...lines, line].sort((a, b) => a - b))
            }
            return next
        })
    }, [])

    const toggleBreakpointEnabled = useCallback((path: string, line: number) => {
        const key = bpKey(path, line)
        setDisabledBreakpoints(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }, [])

    const removeBreakpoint = useCallback((path: string, line: number) => {
        setBreakpoints(prev => {
            const lines = prev.get(path)
            if (!lines || !lines.includes(line)) return prev
            const next = new Map(prev)
            const remaining = lines.filter(l => l !== line)
            if (remaining.length > 0) next.set(path, remaining)
            else next.delete(path)
            return next
        })
        setDisabledBreakpoints(prev => {
            const key = bpKey(path, line)
            if (!prev.has(key)) return prev
            const next = new Set(prev)
            next.delete(key)
            return next
        })
    }, [])

    const clearBreakpoints = useCallback(() => {
        const prevFiles = Array.from(breakpoints.keys())
        setBreakpoints(new Map())
        setDisabledBreakpoints(new Set())
        const session = debugSessionId.current
        if (session) {
            prevFiles.forEach(file => {
                api()?.debug.setBreakpoints(session, file, [])?.catch?.(() => undefined)
            })
        }
    }, [breakpoints])

    // Keep the debug adapter's breakpoints in step with the gutter & DebugPanel toggles.
    useEffect(() => {
        if (!isDebugging || !debugSessionId.current) return
        const session = debugSessionId.current
        breakpoints.forEach((lines, file) => {
            const activeLines = lines.filter(line => !disabledBreakpoints.has(bpKey(file, line)))
            api()?.debug.setBreakpoints(
                session,
                file,
                activeLines.map((line, i) => ({
                    id: `bp-${file}-${line}-${i}`, file, line, enabled: true, verified: false
                }))
            )?.catch?.((e: unknown) => console.error('Failed to sync breakpoints', file, e))
        })
    }, [isDebugging, breakpoints, disabledBreakpoints])

    // Reset runner/debug state & breakpoints on folder change, and load tasks/configs for the new folder.
    useEffect(() => {
        const gen = ++loadGenRef.current
        if (prevFolderRef.current !== folder) {
            prevFolderRef.current = folder

            if (executionId.current) {
                api()?.code.kill(executionId.current)
                executionId.current = null
            }
            clearRunListeners()
            if (buildTaskId.current) {
                api()?.build.killTask(buildTaskId.current)?.catch?.(() => undefined)
                buildTaskId.current = null
            }
            if (debugSessionId.current) {
                api()?.debug.stop(debugSessionId.current)?.catch?.(() => undefined)
                debugSessionId.current = null
            }
            activeThreadId.current = undefined
            lastDebugConfig.current = null

            setRunOutput('')
            setBuildOutput('')
            setDebugOutput('')
            setIsRunning(false)
            setIsBuilding(false)
            setActiveBuildTaskLabel(null)
            setIsDebugging(false)
            clearPausedState()
            setBreakpoints(new Map())
            setDisabledBreakpoints(new Set())
            setDebugConsole([])
            setSelectedDebugConfig(null)
            useDiagnosticsStore.getState().clearOrigin('build')
        }

        if (folder) {
            void refreshTasks(folder).then(() => {
                if (gen !== loadGenRef.current) return
            })
            void refreshDebugConfigs(folder).then(() => {
                if (gen !== loadGenRef.current) return
            })
        } else {
            setBuildTasks([])
            setDebugConfigurations([])
        }
    }, [folder, clearRunListeners, clearPausedState, refreshTasks, refreshDebugConfigs])

    // Build and debug events from the main process (strictly filtered by active ID).
    useEffect(() => {
        const offs: Array<(() => void) | undefined> = []
        const b = api()?.build
        const d = api()?.debug

        offs.push(b?.onOutput((data: { taskId?: string; data?: string; output?: string; type?: string } | string) => {
            if (typeof data !== 'string' && data?.taskId) {
                if (!buildTaskId.current || data.taskId !== buildTaskId.current) return
            }
            const text = typeof data === 'string' ? data : data?.data ?? data?.output ?? ''
            if (text) setBuildOutput(prev => prev + text)
        }))

        offs.push(b?.onProblems?.((data: { taskId?: string; problems?: RawBuildProblem[] }) => {
            if (data?.taskId && buildTaskId.current && data.taskId !== buildTaskId.current) return
            if (Array.isArray(data?.problems)) {
                useDiagnosticsStore.getState().setBuildProblems(data.problems, folderRef.current)
            }
        }))

        offs.push(b?.onEnd((data: { taskId?: string; problems?: RawBuildProblem[]; exitCode: number }) => {
            if (data?.taskId && buildTaskId.current && data.taskId !== buildTaskId.current) return
            setIsBuilding(false)
            setActiveBuildTaskLabel(null)
            buildTaskId.current = null
            const problems = Array.isArray(data.problems) ? data.problems : []
            useDiagnosticsStore.getState().setBuildProblems(problems, folderRef.current)
            if (problems.length) {
                addNotification(`Build finished with ${problems.length} problem${problems.length === 1 ? '' : 's'}.`, 'warning')
            } else if (data.exitCode === 0) {
                addNotification('Build succeeded.', 'success')
            } else {
                addNotification(`Build failed with exit code ${data.exitCode}.`, 'error')
            }
        }))

        offs.push(d?.onStopped(async (data: { sessionId?: string; reason?: string; threadId?: number }) => {
            if (data?.sessionId && debugSessionId.current && data.sessionId !== debugSessionId.current) return
            const session = data?.sessionId ?? debugSessionId.current
            if (!session) return
            activeThreadId.current = data?.threadId
            setIsPaused(true)
            setPausedReason(data?.reason ?? 'paused')

            let where = ''
            const stack = await d?.getCallStack(session, data?.threadId).catch(() => null)
            if (debugSessionId.current && debugSessionId.current !== session) return
            const frames: StackFrame[] = stack?.success && Array.isArray(stack.callStack) ? stack.callStack : []
            setCallStack(frames)
            const top = frames[0] ?? null
            if (top?.source?.path) {
                where = ` at ${top.source.path.split(/[\\/]/).pop()}:${top.line}`
            }
            setDebugOutput(prev => `${prev}\n⏸ Paused${where}${data?.reason ? ` (${data.reason})` : ''}\n`)
            if (top) {
                await loadFrameInspection(session, top)
            } else {
                void evaluateWatchList(session)
            }
        }))

        offs.push(d?.onContinued?.((data: { sessionId?: string }) => {
            if (data?.sessionId && debugSessionId.current && data.sessionId !== debugSessionId.current) return
            clearPausedState()
        }))

        offs.push(d?.onTerminated((data: { sessionId?: string }) => {
            // stopDebug clears the id first and writes its own line.
            if (!debugSessionId.current || (data?.sessionId && data.sessionId !== debugSessionId.current)) return
            setIsDebugging(false)
            debugSessionId.current = null
            activeThreadId.current = undefined
            clearPausedState()
            setDebugOutput(prev => `${prev}\n✓ Debug session ended\n`)
        }))

        offs.push(d?.onOutput((data: { sessionId?: string; output?: string; data?: string; category?: string } | string) => {
            if (typeof data !== 'string' && data?.sessionId) {
                if (debugSessionId.current && data.sessionId !== debugSessionId.current) return
                if (!debugSessionId.current && !debugStarting.current) return
            }
            const text = typeof data === 'string' ? data : data?.output ?? data?.data ?? ''
            if (text) {
                setDebugOutput(prev => prev + text)
                const trimmed = text.replace(/\r?\n$/, '')
                if (trimmed) {
                    setDebugConsole(prev => [
                        ...prev.slice(-198),
                        {
                            id: `c-out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                            kind: typeof data !== 'string' && data?.category === 'stderr' ? 'error' : 'output',
                            text: trimmed
                        }
                    ])
                }
            }
        }))

        offs.push(d?.onError((data: { sessionId?: string; error: unknown }) => {
            if (data?.sessionId && debugSessionId.current && data.sessionId !== debugSessionId.current) return
            const text = typeof data.error === 'string' ? data.error : JSON.stringify(data.error)
            addNotification(`Debugger error: ${text}`, 'error')
            setDebugOutput(prev => `${prev}\nError: ${text}\n`)
            setIsDebugging(false)
            debugSessionId.current = null
            activeThreadId.current = undefined
            clearPausedState()
        }))

        offs.push(d?.onAdapterMissing((data: { requiredBinary: string; installInstructions: string }) => {
            adapterMissing.current = true
            addNotification(`Install ${data.requiredBinary} to debug this file. See the Debug panel for steps.`, 'warning')
            setDebugOutput(prev => `${prev}\n${data.requiredBinary} is not installed.\n${data.installInstructions}\n`)
        }))

        return () => offs.forEach(off => typeof off === 'function' && off())
    }, [addNotification, clearPausedState, loadFrameInspection, evaluateWatchList])

    useEffect(() => () => {
        clearRunListeners()
        dispatchDebugLocation(null)
    }, [clearRunListeners])

    const clearOutput = useCallback((which: 'output' | 'build' | 'debug') => {
        if (which === 'output') setRunOutput('')
        else if (which === 'build') setBuildOutput('')
        else {
            setDebugOutput('')
            setDebugConsole([])
        }
    }, [])

    const runnerApi = useMemo(() => ({
        canRun, run, stopRun, sendInput, runOutput, isRunning,
        build, stopBuild, buildOutput, isBuilding, buildTasks, activeBuildTaskLabel, runTask, refreshTasks,
        startDebug, stopDebug, restartDebug, debugStep, debugOutput, isDebugging, isPaused, pausedReason,
        breakpoints, disabledBreakpoints, toggleBreakpoint, toggleBreakpointEnabled, removeBreakpoint, clearBreakpoints,
        callStack, selectedFrameId, selectFrame, scopes, variableChildren, expandVariable,
        watches, addWatch, removeWatch, refreshWatches,
        debugConsole, evaluateExpression, clearDebugConsole,
        debugConfigurations, selectedDebugConfig, setSelectedDebugConfig, refreshDebugConfigs,
        clearOutput
    }), [
        canRun, run, stopRun, sendInput, runOutput, isRunning,
        build, stopBuild, buildOutput, isBuilding, buildTasks, activeBuildTaskLabel, runTask, refreshTasks,
        startDebug, stopDebug, restartDebug, debugStep, debugOutput, isDebugging, isPaused, pausedReason,
        breakpoints, disabledBreakpoints, toggleBreakpoint, toggleBreakpointEnabled, removeBreakpoint, clearBreakpoints,
        callStack, selectedFrameId, selectFrame, scopes, variableChildren, expandVariable,
        watches, addWatch, removeWatch, refreshWatches,
        debugConsole, evaluateExpression, clearDebugConsole,
        debugConfigurations, selectedDebugConfig, refreshDebugConfigs,
        clearOutput
    ])

    // Publish live runner handle for sidebar DebugPanel & ActivityBar without requiring prop drilling through IDEWorkspace.
    useEffect(() => {
        useActiveRunnerStore.getState().setRunner(runnerApi)
    }, [runnerApi])

    useEffect(() => () => {
        useActiveRunnerStore.getState().setRunner(null)
    }, [])

    return runnerApi
}

export type RunnerApi = ReturnType<typeof useRunner>

interface ActiveRunnerStoreState {
    runner: RunnerApi | null
    setRunner: (runner: RunnerApi | null) => void
}

export const useActiveRunnerStore = create<ActiveRunnerStoreState>(set => ({
    runner: null,
    setRunner: runner => set({ runner })
}))

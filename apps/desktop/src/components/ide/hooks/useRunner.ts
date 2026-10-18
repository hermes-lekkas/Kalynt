/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Running the current file, building the project and debugging, with their
 * output streams and breakpoints.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OpenFile } from '../../../types/ide'
import { useNotificationStore } from '../../../stores/notificationStore'
import { useLayoutStore } from '../../../stores/layoutStore'
import { RUNNABLE_LANGUAGES, languageLabel } from '../languages'
import { autoDebugConfig, debugFamily } from './debugConfig'

const api = () => window.electronAPI
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface Options {
    folder: string | null
    activeFile: OpenFile | null
    saveFile: (path?: string | null) => Promise<boolean>
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
    const [breakpoints, setBreakpoints] = useState<Map<string, number[]>>(new Map())

    const executionId = useRef<string | null>(null)
    const buildTaskId = useRef<string | null>(null)
    const debugSessionId = useRef<string | null>(null)
    const adapterMissing = useRef(false)
    const runListeners = useRef<Array<() => void>>([])

    const clearRunListeners = () => {
        runListeners.current.forEach(off => off())
        runListeners.current = []
    }

    const canRun = !!activeFile && RUNNABLE_LANGUAGES.has(activeFile.language)

    const run = useCallback(async () => {
        if (!activeFile) return
        if (!RUNNABLE_LANGUAGES.has(activeFile.language)) {
            addNotification(`Kalynt can't run ${languageLabel(activeFile.language)} files yet.`, 'warning')
            return
        }
        await saveFile(activeFile.path)
        const id = `exec-${Date.now()}`
        executionId.current = id
        setIsRunning(true)
        setRunOutput(`▶ Running ${activeFile.name}\n`)
        showBottomTab('output')

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
    }, [activeFile, folder, saveFile, addNotification, showBottomTab])

    const stopRun = useCallback(() => {
        if (!executionId.current) return
        api()?.code.kill(executionId.current)
        setRunOutput(prev => `${prev}\n■ Stopped\n`)
        setIsRunning(false)
        executionId.current = null
    }, [])

    const sendInput = useCallback((data: string) => {
        if (executionId.current) api()?.ipcRenderer.invoke('code:write-input', executionId.current, data)
    }, [])

    const build = useCallback(async () => {
        if (!folder) return
        setBuildOutput('')
        showBottomTab('build')
        try {
            const tasks = await api()?.build.getTasks(folder)
            // The default build task, else any build task. Never an arbitrary script such as a dev server.
            const kindOf = (t: { group?: unknown }) => {
                const group = t.group as { kind?: string; isDefault?: boolean } | string | undefined
                return typeof group === 'object' ? { kind: group?.kind, isDefault: !!group?.isDefault } : { kind: group, isDefault: false }
            }
            const list: { group?: unknown; label?: string; name?: string }[] = tasks?.success ? tasks.tasks ?? [] : []
            const task = list.find(t => kindOf(t).kind === 'build' && kindOf(t).isDefault) ?? list.find(t => kindOf(t).kind === 'build')
            if (!task) {
                setBuildOutput('No build task found. Add a "build" script to package.json or a build task to .vscode/tasks.json.\n')
                addNotification('No build task found in this folder.', 'warning')
                return
            }
            setBuildOutput(`▶ ${task.label ?? task.name ?? 'Build'}\n`)
            const result = await api()?.build.executeTask(task, folder)
            if (result?.success && result.taskId) {
                buildTaskId.current = result.taskId
                setIsBuilding(true)
            } else {
                addNotification(result?.error || "The build didn't start.", 'error')
            }
        } catch (e) {
            addNotification(`Build error: ${errorText(e)}`, 'error')
        }
    }, [folder, addNotification, showBottomTab])

    const stopBuild = useCallback(async () => {
        if (!buildTaskId.current) return
        try {
            await api()?.build.killTask(buildTaskId.current)
            setBuildOutput(prev => `${prev}\n■ Build stopped\n`)
        } catch (e) {
            addNotification(`Couldn't stop the build: ${errorText(e)}`, 'error')
        }
        setIsBuilding(false)
        buildTaskId.current = null
    }, [addNotification])

    const startDebug = useCallback(async () => {
        if (!activeFile || !folder) return
        await saveFile(activeFile.path)
        setDebugOutput('')
        showBottomTab('debug')
        try {
            // A configuration for this file's language, else one inferred from the file.
            const fallback = autoDebugConfig(activeFile.path)
            const configs = await api()?.debug.getConfigurations(folder)
            const config = (configs?.success ? configs.configurations ?? [] : [])
                .find((c: { type: string }) => debugFamily(c.type) === debugFamily(fallback.type)) ?? fallback
            const initial = Array.from(breakpoints, ([file, lines]) => ({ file, lines })).filter(b => b.lines.length > 0)
            setDebugOutput(`▶ Starting ${config.name}\n`)
            adapterMissing.current = false
            const result = await api()?.debug.start(config, folder, activeFile.path, initial)
            if (result?.success && result.sessionId) {
                debugSessionId.current = result.sessionId
                setIsDebugging(true)
            } else {
                const message = result?.error || "The debugger didn't start."
                setDebugOutput(prev => `${prev}✗ ${message}\n`)
                if (!adapterMissing.current) addNotification(message, 'error')
            }
        } catch (e) {
            addNotification(`Debug error: ${errorText(e)}`, 'error')
        }
    }, [activeFile, folder, saveFile, addNotification, showBottomTab, breakpoints])

    const stopDebug = useCallback(async () => {
        const session = debugSessionId.current
        if (!session) return
        debugSessionId.current = null
        try {
            await api()?.debug.stop(session)
            setDebugOutput(prev => `${prev}\n■ Debug session stopped\n`)
        } catch (e) {
            addNotification(`Couldn't stop debugging: ${errorText(e)}`, 'error')
        }
        setIsDebugging(false)
        debugSessionId.current = null
    }, [addNotification])

    const debugStep = useCallback(async (action: 'continue' | 'stepOver' | 'stepInto' | 'stepOut' | 'pause') => {
        if (!debugSessionId.current) return
        try {
            await api()?.debug[action](debugSessionId.current)
        } catch (e) {
            addNotification(`Debugger ${action} failed: ${errorText(e)}`, 'error')
        }
    }, [addNotification])

    const toggleBreakpoint = useCallback((path: string, line: number) => {
        setBreakpoints(prev => {
            const next = new Map(prev)
            const lines = next.get(path) ?? []
            next.set(path, lines.includes(line) ? lines.filter(l => l !== line) : [...lines, line].sort((a, b) => a - b))
            return next
        })
    }, [])

    // Keep the debug adapter's breakpoints in step with the gutter.
    useEffect(() => {
        if (!isDebugging || !debugSessionId.current) return
        const session = debugSessionId.current
        breakpoints.forEach((lines, file) => {
            api()?.debug.setBreakpoints(session, file, lines.map((line, i) => ({
                id: `bp-${file}-${line}-${i}`, file, line, enabled: true, verified: false
            })))?.catch?.((e: unknown) => console.error('Failed to sync breakpoints', file, e))
        })
    }, [isDebugging, breakpoints])

    // Build and debug events from the main process.
    useEffect(() => {
        const offs: Array<(() => void) | undefined> = []
        const b = api()?.build
        const d = api()?.debug
        offs.push(b?.onOutput((data: { data?: string; output?: string; type?: string } | string) => {
            const text = typeof data === 'string' ? data : data?.data ?? data?.output ?? ''
            if (text) setBuildOutput(prev => prev + text)
        }))
        offs.push(b?.onEnd((data: { problems?: unknown[]; exitCode: number }) => {
            setIsBuilding(false)
            buildTaskId.current = null
            if (data.problems?.length) addNotification(`Build finished with ${data.problems.length} problem${data.problems.length === 1 ? '' : 's'}.`, 'warning')
            else if (data.exitCode === 0) addNotification('Build succeeded.', 'success')
            else addNotification(`Build failed with exit code ${data.exitCode}.`, 'error')
        }))
        offs.push(d?.onStopped(async (data: { sessionId?: string; reason?: string; threadId?: number }) => {
            const session = data?.sessionId ?? debugSessionId.current
            let where = ''
            if (session) {
                const stack = await d?.getCallStack(session, data?.threadId).catch(() => null)
                const top = stack?.success ? stack.callStack?.[0] : null
                if (top?.source?.path) where = ` at ${top.source.path.split(/[\\/]/).pop()}:${top.line}`
            }
            setDebugOutput(prev => `${prev}\n⏸ Paused${where}${data?.reason ? ` (${data.reason})` : ''}\n`)
        }))
        offs.push(d?.onTerminated((data: { sessionId?: string }) => {
            // stopDebug clears the id first and writes its own line.
            if (!debugSessionId.current || (data?.sessionId && data.sessionId !== debugSessionId.current)) return
            setIsDebugging(false)
            debugSessionId.current = null
            setDebugOutput(prev => `${prev}\n✓ Debug session ended\n`)
        }))
        offs.push(d?.onOutput((data: { output?: string; data?: string } | string) => {
            const text = typeof data === 'string' ? data : data?.output ?? data?.data ?? ''
            if (text) setDebugOutput(prev => prev + text)
        }))
        offs.push(d?.onError((data: { error: unknown }) => {
            const text = typeof data.error === 'string' ? data.error : JSON.stringify(data.error)
            addNotification(`Debugger error: ${text}`, 'error')
            setDebugOutput(prev => `${prev}\nError: ${text}\n`)
            setIsDebugging(false)
            debugSessionId.current = null
        }))
        offs.push(d?.onAdapterMissing((data: { requiredBinary: string; installInstructions: string }) => {
            adapterMissing.current = true
            addNotification(`Install ${data.requiredBinary} to debug this file. See the Debug panel for steps.`, 'warning')
            setDebugOutput(prev => `${prev}\n${data.requiredBinary} is not installed.\n${data.installInstructions}\n`)
        }))
        return () => offs.forEach(off => typeof off === 'function' && off())
    }, [addNotification])

    useEffect(() => () => clearRunListeners(), [])

    return {
        canRun, run, stopRun, sendInput, runOutput, isRunning,
        build, stopBuild, buildOutput, isBuilding,
        startDebug, stopDebug, debugStep, debugOutput, isDebugging,
        breakpoints, toggleBreakpoint,
        clearOutput: (which: 'output' | 'build' | 'debug') => {
            if (which === 'output') setRunOutput('')
            else if (which === 'build') setBuildOutput('')
            else setDebugOutput('')
        }
    }
}

export type RunnerApi = ReturnType<typeof useRunner>

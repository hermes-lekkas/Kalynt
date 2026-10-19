/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Runs build tasks and streams their output and problems to the Build panel.
 */
import { ipcMain, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import * as path from 'path'
import type { Task, TaskExecution } from '../../src/types/tasks'
import { getAllTasks, parseProblems, resolveMatcher, substituteVariables } from './build-tasks'
import { killProcessTree, wrapWindowsCommand } from './code-exec/binaries'
import { sendToWindow } from '../utils/window'

interface RunningTask {
    process: ChildProcess
    execution: TaskExecution
}

const runningTasks = new Map<string, RunningTask>()
let taskCounter = 0

/** Stops every running build task. */
export async function stopAllBuilds(): Promise<number> {
    const tasks = [...runningTasks.values()]
    runningTasks.clear()
    await Promise.all(tasks.map(t => killProcessTree(t.process)))
    return tasks.length
}

// Quotes an argument for the shell that runs 'shell' tasks, as VS Code does.
function shellQuote(arg: string): string {
    if (/^[\w@%+=:,./-]+$/.test(arg)) return arg
    return process.platform === 'win32' ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`
}

function executeTask(task: Task, workspacePath: string, getWindow: () => BrowserWindow | null): string {
    const taskId = `task-${++taskCounter}`
    const execution: TaskExecution = { taskId, taskLabel: task.label, startTime: Date.now(), problems: [] }
    const send = (channel: string, payload: unknown) => sendToWindow(getWindow(), channel, payload)
    const sub = (value: string) => substituteVariables(value, workspacePath)

    let command = sub(task.command)
    let args = (task.args ?? []).map(sub)
    // 'process' tasks run the program directly; 'shell' tasks go through the shell.
    let useShell = task.type !== 'process'
    let windowsVerbatimArguments: boolean | undefined
    if (task.type === 'npm') {
        ;({ command, args, windowsVerbatimArguments } = wrapWindowsCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', task.command, ...args]))
        useShell = false
    }

    const cwd = task.options?.cwd ? path.resolve(workspacePath, sub(task.options.cwd)) : workspacePath
    const env = { ...process.env, ...task.options?.env, FORCE_COLOR: '1' }

    send('build:output', { taskId, type: 'start', data: `\x1b[1m> ${task.label}\x1b[0m\n` })

    // A shell task is one command line: the command as written plus quoted arguments.
    const child = useShell
        ? spawn([command, ...args.map(shellQuote)].join(' '), { cwd, env, shell: true, windowsHide: true })
        : spawn(command, args, { cwd, env, shell: false, windowsHide: true, windowsVerbatimArguments })
    execution.processId = child.pid
    runningTasks.set(taskId, { process: child, execution })

    const matcher = resolveMatcher(task.problemMatcher)
    let pending = ''
    const onData = (type: 'stdout' | 'stderr') => (data: Buffer) => {
        const text = data.toString()
        send('build:output', { taskId, type, data: text })
        if (!matcher) return
        // Only parse whole lines; keep the trailing partial line for the next chunk.
        const lines = (pending + text).split(/\r?\n/)
        pending = lines.pop() ?? ''
        const found = parseProblems(lines.join('\n'), matcher, workspacePath)
        if (found.length) {
            execution.problems.push(...found)
            send('build:problems', { taskId, problems: execution.problems })
        }
    }
    child.stdout?.on('data', onData('stdout'))
    child.stderr?.on('data', onData('stderr'))

    let finished = false
    const finish = (code: number | null, error?: string) => {
        if (finished) return
        finished = true
        runningTasks.delete(taskId)
        execution.endTime = Date.now()
        execution.exitCode = code ?? undefined
        const seconds = ((execution.endTime - execution.startTime) / 1000).toFixed(1)
        const summary = error
            ? `\x1b[31m✗ ${error}\x1b[0m`
            : code === 0 ? `\x1b[32m✓ ${task.label} finished\x1b[0m` : `\x1b[31m✗ ${task.label} failed${code === null ? ' (stopped)' : ` with exit code ${code}`}\x1b[0m`
        send('build:output', { taskId, type: error ? 'error' : 'end', data: `\n${summary} in ${seconds}s\n` })
        send('build:end', { taskId, exitCode: code ?? 1, problems: execution.problems })
    }
    child.on('error', err => finish(1, (err as NodeJS.ErrnoException).code === 'ENOENT' ? `${command} isn't installed or isn't on PATH` : err.message))
    child.on('close', code => finish(code))

    return taskId
}

export function setupBuildHandlers(
    ipc: typeof ipcMain,
    getMainWindow: () => BrowserWindow | null,
    _getWorkspacePath: () => string | null
) {
    ipc.handle('build:getTasks', async (_, workspacePath: string) => {
        try {
            return { success: true, tasks: getAllTasks(workspacePath) }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    })

    ipc.handle('build:executeTask', async (_, task: Task, workspacePath: string) => {
        try {
            if (!task?.command) return { success: false, error: 'This task has no command to run' }
            return { success: true, taskId: executeTask(task, workspacePath, getMainWindow) }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    })

    ipc.handle('build:killTask', async (_, taskId: string) => {
        const running = runningTasks.get(taskId)
        if (!running) return { success: false, error: 'The task is not running' }
        await killProcessTree(running.process)
        return { success: true }
    })
}

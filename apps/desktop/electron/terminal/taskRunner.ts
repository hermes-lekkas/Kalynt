/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// main-process/taskRunner.ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import treeKill from 'tree-kill'
import { createDefaultTaskProviders } from './taskProviders'
import type { TaskDefinition, TaskExecution, TaskProvider } from './taskTypes'

export type { TaskDefinition, TaskExecution, TaskProvider } from './taskTypes'

function killProcessTree(proc: import('node:child_process').ChildProcess): Promise<void> {
    if (!proc || !proc.pid || proc.exitCode !== null) return Promise.resolve()
    const pid = proc.pid
    return new Promise((resolve) => {
        treeKill(pid, 'SIGKILL', (err) => {
            if (err) {
                try {
                    if (process.platform === 'win32') {
                        spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore' })
                    } else {
                        try {
                            process.kill(-pid, 'SIGKILL')
                        } catch {
                            proc.kill('SIGKILL')
                        }
                    }
                } catch {
                    // Already exited
                }
            }
            resolve()
        })
    })
}

export class TaskRunnerService extends EventEmitter {
    private readonly executions = new Map<string, TaskExecution>()
    private taskProviders = new Map<string, TaskProvider>()
    private readonly detectedTasks = new Map<string, TaskDefinition[]>()

    constructor() {
        super()
        this.registerDefaultTaskProviders()
    }

    private registerDefaultTaskProviders(): void {
        this.taskProviders = createDefaultTaskProviders()
    }

    registerTaskProvider(type: string, provider: TaskProvider): void {
        this.taskProviders.set(type, provider)
    }

    async detectTasks(workspacePath: string): Promise<TaskDefinition[]> {
        const allTasks: TaskDefinition[] = []

        for (const [type, provider] of Array.from(this.taskProviders)) {
            try {
                const tasks = await provider.provideTasks(workspacePath)
                allTasks.push(...tasks)
            } catch (error) {
                console.error(`[TaskRunner] Error detecting ${type} tasks:`, error)
            }
        }

        this.detectedTasks.set(workspacePath, allTasks)
        return allTasks
    }

    async executeTask(options: {
        id: string
        task: TaskDefinition
        terminalService?: any
        getMainWindow?: () => any
    }): Promise<{ success: boolean; executionId?: string; error?: string }> {
        try {
            const executionId = `exec_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`

            const resolvedTask = await this.resolveTask(options.task)

            const execution: TaskExecution = {
                id: executionId,
                task: resolvedTask,
                process: null as any,
                startTime: Date.now(),
                output: '',
                status: 'running'
            }

            let command = resolvedTask.command
            const args = resolvedTask.args || []
            let shell = true
            const currentPlatform = process.platform
            const taskCwd = resolvedTask.cwd || process.cwd()

            // Enhance PATH with bundled binaries when running inside Electron
            let enhancedPath = process.env.PATH || ''
            if (app && typeof app.getAppPath === 'function') {
                const bundledBinPath = app.isPackaged
                    ? path.join(process.resourcesPath, 'bin')
                    : path.join(app.getAppPath(), 'bin')
                const pathSeparator = currentPlatform === 'win32' ? ';' : ':'
                if (fs.existsSync(bundledBinPath)) {
                    enhancedPath = `${bundledBinPath}${pathSeparator}${enhancedPath}`
                }
            }

            // Normalize default tool names per platform WITHOUT clobbering explicit commands
            // (e.g., preserve `pip`, `pytest`, etc. for python tasks).
            switch (resolvedTask.type) {
                case 'shell':
                    break
                case 'process':
                    shell = false
                    break
                case 'npm':
                    if (!command || command === 'npm') {
                        command = currentPlatform === 'win32' ? 'npm.cmd' : 'npm'
                    }
                    break
                case 'maven':
                    if (!command || command === 'mvn') {
                        command = currentPlatform === 'win32' ? 'mvn.cmd' : 'mvn'
                    }
                    break
                case 'gradle':
                    if (!command || command === './gradlew' || command === 'gradlew') {
                        const wrapper = currentPlatform === 'win32' ? 'gradlew.bat' : 'gradlew'
                        if (fs.existsSync(path.join(taskCwd, wrapper))) {
                            command = currentPlatform === 'win32' ? 'gradlew.bat' : './gradlew'
                        } else {
                            command = currentPlatform === 'win32' ? 'gradle.bat' : 'gradle'
                        }
                    }
                    break
                case 'python':
                    if (!command) {
                        command = currentPlatform === 'win32' ? 'python.exe' : 'python3'
                    } else if (currentPlatform === 'win32' && command === 'python') {
                        command = 'python.exe'
                    }
                    break
                case 'dotnet':
                    if (!command || command === 'dotnet') {
                        command = currentPlatform === 'win32' ? 'dotnet.exe' : 'dotnet'
                    }
                    break
            }

            const childProcess: ChildProcessWithoutNullStreams = spawn(command, args, {
                cwd: taskCwd,
                env: {
                    ...process.env,
                    ...resolvedTask.env,
                    PATH: enhancedPath
                },
                shell,
                detached: currentPlatform !== 'win32',
                stdio: ['pipe', 'pipe', 'pipe']
            })

            execution.process = childProcess
            this.executions.set(executionId, execution)

            let output = ''

            const collectOutput = (data: Buffer, type: 'stdout' | 'stderr') => {
                const text = data.toString()
                output += text
                execution.output += text

                // Single source of truth: handlers/terminal.ts forwards tasks:* to the renderer.
                this.emit('task_output', {
                    executionId,
                    type,
                    data: text
                })
            }

            childProcess.stdout?.on('data', (data: Buffer) => collectOutput(data, 'stdout'))
            childProcess.stderr?.on('data', (data: Buffer) => collectOutput(data, 'stderr'))

            childProcess.on('exit', (code: number | null) => {
                if (execution.status === 'cancelled') {
                    return
                }
                execution.endTime = Date.now()
                execution.exitCode = code ?? undefined
                execution.status = code === 0 ? 'succeeded' : 'failed'

                this.emit('task_completed', {
                    executionId,
                    exitCode: code ?? -1,
                    status: execution.status,
                    output,
                    duration: execution.endTime - execution.startTime
                })
            })

            childProcess.on('error', (error: Error) => {
                if (execution.status === 'cancelled') {
                    return
                }
                execution.endTime = Date.now()
                execution.status = 'failed'

                this.emit('task_error', {
                    executionId,
                    error: error.message
                })
            })

            return { success: true, executionId }
        } catch (error) {
            console.error('[TaskRunner] Error executing task:', error)
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    }

    async killTaskExecution(executionId: string): Promise<boolean> {
        const execution = this.executions.get(executionId)
        if (!execution) return false

        try {
            execution.status = 'cancelled'
            execution.endTime = Date.now()
            await killProcessTree(execution.process)

            this.emit('task_cancelled', { executionId })
            return true
        } catch (error) {
            console.error(`[TaskRunner] Error killing execution ${executionId}:`, error)
            return false
        }
    }

    async getTaskExecutions(): Promise<TaskExecution[]> {
        return Array.from(this.executions.values())
    }

    async getTaskExecution(executionId: string): Promise<TaskExecution | undefined> {
        return this.executions.get(executionId)
    }

    private async resolveTask(task: TaskDefinition): Promise<TaskDefinition> {
        const provider = this.taskProviders.get(task.type)
        if (provider) {
            return await provider.resolveTask(task)
        }
        return task
    }

    dispose(): void {
        for (const [executionId, execution] of Array.from(this.executions)) {
            if (execution.status === 'running') {
                execution.status = 'cancelled'
                void killProcessTree(execution.process).catch((error) => {
                    console.error(`[TaskRunner] Error disposing execution ${executionId}:`, error)
                })
            }
        }

        this.executions.clear()
        this.detectedTasks.clear()
        this.taskProviders.clear()
        this.removeAllListeners()
    }
}

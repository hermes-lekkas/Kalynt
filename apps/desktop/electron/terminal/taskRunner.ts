/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// main-process/taskRunner.ts
import { spawn, ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { createDefaultTaskProviders } from './taskProviders'
import type { TaskDefinition, TaskExecution, TaskProvider } from './taskTypes'

export type { TaskDefinition, TaskExecution, TaskProvider } from './taskTypes'

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

        // Cache detected tasks
        this.detectedTasks.set(workspacePath, allTasks)

        return allTasks
    }

    async executeTask(options: {
        id: string
        task: TaskDefinition
        terminalService: any
        getMainWindow: () => any
    }): Promise<{ success: boolean; executionId?: string; error?: string }> {
        try {
            const executionId = `exec_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`

            // Resolve task if needed
            const resolvedTask = await this.resolveTask(options.task)

            // Create execution record
            const execution: TaskExecution = {
                id: executionId,
                task: resolvedTask,
                process: null as any,
                startTime: Date.now(),
                output: '',
                status: 'running'
            }

            // Determine command and arguments
            let command = resolvedTask.command
            const args = resolvedTask.args || []
            let shell = true
            const currentPlatform = process.platform

            // ENHANCE PATH
            const bundledBinPath = app.isPackaged 
                ? path.join(process.resourcesPath, 'bin')
                : path.join(app.getAppPath(), 'bin')
            
            const pathSeparator = currentPlatform === 'win32' ? ';' : ':'
            let enhancedPath = process.env.PATH || ''
            if (fs.existsSync(bundledBinPath)) {
                enhancedPath = `${bundledBinPath}${pathSeparator}${enhancedPath}`
            }

            // Handle different task types
            switch (resolvedTask.type) {
                case 'shell':
                    // shell is already true
                    break
                case 'process':
                    shell = false
                    break
                case 'npm':
                    command = currentPlatform === 'win32' ? 'npm.cmd' : 'npm'
                    break
                case 'maven':
                    command = currentPlatform === 'win32' ? 'mvn.cmd' : 'mvn'
                    break
                case 'gradle':
                    command = currentPlatform === 'win32' ? 'gradlew.bat' : './gradlew'
                    break
                case 'python':
                    command = currentPlatform === 'win32' ? 'python.exe' : 'python'
                    break
                case 'dotnet':
                    command = currentPlatform === 'win32' ? 'dotnet.exe' : 'dotnet'
                    break
            }

            // Spawn child process
            const childProcess: ChildProcessWithoutNullStreams = spawn(command, args, {
                cwd: resolvedTask.cwd || process.cwd(),
                env: { 
                    ...process.env, 
                    ...resolvedTask.env,
                    PATH: enhancedPath
                },
                shell: shell,
                stdio: ['pipe', 'pipe', 'pipe']
            })

            execution.process = childProcess
            this.executions.set(executionId, execution)

            // Setup output handling
            let output = ''

            const collectOutput = (data: Buffer, type: 'stdout' | 'stderr') => {
                const text = data.toString()
                output += text
                execution.output += text

                // Emit output event
                this.emit('task_output', {
                    executionId,
                    type,
                    data: text
                })

                // Send to renderer
                const mainWindow = options.getMainWindow()
                if (mainWindow) {
                    mainWindow.webContents.send('task:output', {
                        executionId,
                        type,
                        data: text
                    })
                }
            }

            childProcess.stdout?.on('data', (data: Buffer) => collectOutput(data, 'stdout'))
            childProcess.stderr?.on('data', (data: Buffer) => collectOutput(data, 'stderr'))

            // Handle process completion
            childProcess.on('exit', (code: number | null) => {
                execution.endTime = Date.now()
                execution.exitCode = code ?? undefined
                execution.status = code === 0 ? 'succeeded' : 'failed'

                this.emit('task_completed', {
                    executionId,
                    exitCode: code,
                    output,
                    duration: execution.endTime - execution.startTime
                })

                // Send completion to renderer
                const mainWindow = options.getMainWindow()
                if (mainWindow) {
                    mainWindow.webContents.send('task:completed', {
                        executionId,
                        exitCode: code,
                        status: execution.status,
                        duration: execution.endTime - execution.startTime
                    })
                }
            })

            childProcess.on('error', (error: Error) => {
                execution.endTime = Date.now()
                execution.status = 'failed'

                this.emit('task_error', {
                    executionId,
                    error: error.message
                })

                // Send error to renderer
                const mainWindow = options.getMainWindow()
                if (mainWindow) {
                    mainWindow.webContents.send('task:error', {
                        executionId,
                        error: error.message
                    })
                }
            })

            return { success: true, executionId }
        } catch (error) {
            console.error('[TaskRunner] Error executing task:', error)
            return { success: false, error: String(error) }
        }
    }

    async killTaskExecution(executionId: string): Promise<boolean> {
        const execution = this.executions.get(executionId)
        if (!execution) return false

        try {
            execution.process.kill()
            execution.status = 'cancelled'
            execution.endTime = Date.now()

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
        // Kill all running executions
        for (const [executionId, execution] of Array.from(this.executions)) {
            if (execution.status === 'running') {
                try {
                    execution.process.kill()
                } catch (error) {
                    console.error(`[TaskRunner] Error disposing execution ${executionId}:`, error)
                }
            }
        }

        this.executions.clear()
        this.detectedTasks.clear()
        this.taskProviders.clear()
        this.removeAllListeners()
    }
}
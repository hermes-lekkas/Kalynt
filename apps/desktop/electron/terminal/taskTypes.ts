/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Task definitions exchanged between the task runner, its providers and the
 * renderer.
 */

export interface TaskDefinition {
    id: string
    label: string
    type: 'shell' | 'process' | 'npm' | 'maven' | 'gradle' | 'make' | 'python' | 'dotnet'
    command: string
    args?: string[]
    cwd?: string
    env?: { [key: string]: string }
    group?: 'build' | 'test' | 'run' | 'clean' | 'debug'
    problemMatcher?: string | string[]
    presentation?: {
        echo?: boolean
        reveal?: 'always' | 'silent' | 'never'
        focus?: boolean
        panel?: 'shared' | 'dedicated' | 'new'
        showReuseMessage?: boolean
        clear?: boolean
    }
    options?: {
        shell?: {
            executable?: string
            args?: string[]
        }
    }
}

export interface TaskExecution {
    id: string
    task: TaskDefinition
    process: import('node:child_process').ChildProcess
    startTime: number
    endTime?: number
    exitCode?: number
    output: string
    status: 'running' | 'succeeded' | 'failed' | 'cancelled'
    terminalId?: string
}

export interface TaskProvider {
    provideTasks(workspacePath: string): Promise<TaskDefinition[]>
    resolveTask(task: TaskDefinition): Promise<TaskDefinition>
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Stops every process Kalynt started: terminals, programs, builds, debug
 * sessions, downloads and package manager commands. Used by "Stop all processes"
 * and when the app quits, so nothing is left running in the background.
 */
import { disposeTerminalService, killAllTaskExecutions, killAllTerminals } from '../handlers/terminal'
import { cleanupHtmlPreviewFiles, stopAllCodeProcesses } from '../handlers/code-execution'
import { stopAllBuilds } from '../handlers/build'
import { stopAllDebugSessions } from '../handlers/debug'
import { abortAllModelDownloads } from '../handlers/model-download'
import { unloadLocalModel } from '../handlers/llm-inference'
import { disposeAutoUpdater } from '../handlers/update-handler'
import { getDependencyManager } from '../terminal/dependencyManager'
import { stopAllAgentProcesses } from '../agent/exec'
import { cancelAllAiRequests } from '../ai'
import { nativeHelperService } from './native-helper-service'
import { performanceAcceleration } from './Performance_Acceleration'

export interface StopReport {
    terminals: number
    tasks: number
    programs: number
    builds: number
    debugSessions: number
    packageCommands: number
    agentCommands: number
    downloads: number
}

export interface TaskStopResult {
    stopped: number
    failed: number
    errors: string[]
}

export interface StoppableTaskRunner {
    killAllTaskExecutions(): Promise<TaskStopResult>
}

export interface DetailedStopReport {
    status: 'complete' | 'partial' | 'failed'
    counts: StopReport
    totalStopped: number
    failedCount: number
    errors: Array<{ subsystem: string; error: string }>
}

const registeredTaskRunners = new Set<StoppableTaskRunner>()

/** Registers an additional TaskRunnerService instance to be stopped during shared shutdown. */
export function registerTaskRunnerForShutdown(runner: StoppableTaskRunner): () => void {
    registeredTaskRunners.add(runner)
    return () => {
        registeredTaskRunners.delete(runner)
    }
}

export function unregisterTaskRunnerForShutdown(runner: StoppableTaskRunner): void {
    registeredTaskRunners.delete(runner)
}

interface SubsystemOutcome {
    stopped: number
    failed: number
    errors: Array<{ subsystem: string; error: string }>
}

async function settleSubsystem(subsystem: string, work: Promise<number> | number): Promise<SubsystemOutcome> {
    try {
        const stopped = await work
        return { stopped, failed: 0, errors: [] }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[Shutdown] Could not stop ${subsystem}:`, err)
        return { stopped: 0, failed: 1, errors: [{ subsystem, error: message }] }
    }
}

async function stopAllTaskRunners(): Promise<SubsystemOutcome> {
    const runners: Array<() => Promise<TaskStopResult>> = [
        () => killAllTaskExecutions(),
        ...Array.from(registeredTaskRunners).map(runner => () => runner.killAllTaskExecutions())
    ]

    let stopped = 0
    let failed = 0
    const errors: Array<{ subsystem: string; error: string }> = []

    const results = await Promise.all(runners.map(async (fn) => {
        try {
            return await fn()
        } catch (err) {
            return {
                stopped: 0,
                failed: 1,
                errors: [err instanceof Error ? err.message : String(err)]
            }
        }
    }))

    for (const r of results) {
        stopped += r.stopped
        failed += r.failed
        for (const msg of r.errors) {
            errors.push({ subsystem: 'tasks', error: msg })
        }
    }

    return { stopped, failed, errors }
}

const settleVoid = (work: Promise<unknown> | void) => Promise.resolve(work).catch(err => {
    console.error('[Shutdown] Cleanup step failed:', err)
})

/**
 * Stops all user/background processes and returns complete/partial/failed status
 * along with per-subsystem counts and error details.
 */
export async function stopEverythingWithDetails(): Promise<DetailedStopReport> {
    cancelAllAiRequests()
    const downloads = abortAllModelDownloads()
    const [terminalsRes, tasksRes, programsRes, buildsRes, debugRes, pkgRes, agentRes] = await Promise.all([
        settleSubsystem('terminals', killAllTerminals()),
        stopAllTaskRunners(),
        settleSubsystem('programs', stopAllCodeProcesses()),
        settleSubsystem('builds', stopAllBuilds()),
        settleSubsystem('debugSessions', stopAllDebugSessions()),
        settleSubsystem('packageCommands', getDependencyManager().killAll()),
        settleSubsystem('agentCommands', stopAllAgentProcesses())
    ])

    const counts: StopReport = {
        terminals: terminalsRes.stopped,
        tasks: tasksRes.stopped,
        programs: programsRes.stopped,
        builds: buildsRes.stopped,
        debugSessions: debugRes.stopped,
        packageCommands: pkgRes.stopped,
        agentCommands: agentRes.stopped,
        downloads
    }

    const allOutcomes = [terminalsRes, tasksRes, programsRes, buildsRes, debugRes, pkgRes, agentRes]
    const totalStopped = Object.values(counts).reduce((sum, n) => sum + n, 0)
    const failedCount = allOutcomes.reduce((sum, r) => sum + r.failed, 0)
    const errors = allOutcomes.flatMap(r => r.errors)

    const status: DetailedStopReport['status'] =
        failedCount === 0 && errors.length === 0
            ? 'complete'
            : totalStopped > 0
                ? 'partial'
                : 'failed'

    return { status, counts, totalStopped, failedCount, errors }
}

/** Stops all user/background processes without tearing down app-wide services. */
export async function stopEverything(): Promise<StopReport> {
    const detailed = await stopEverythingWithDetails()
    return detailed.counts
}

/**
 * Full app-exit cleanup: stops all processes and disposes long-lived services
 * (terminalService gateways, task runner, native llama.cpp model, macOS helper,
 * performance timers, update timers, and temporary HTML previews).
 */
export async function shutdownApp(): Promise<StopReport> {
    disposeAutoUpdater()
    performanceAcceleration.dispose()
    const report = await stopEverything()
    await Promise.all([
        settleVoid(unloadLocalModel()),
        settleVoid(cleanupHtmlPreviewFiles()),
        settleVoid(disposeTerminalService()),
        settleVoid(nativeHelperService.dispose())
    ])
    return report
}

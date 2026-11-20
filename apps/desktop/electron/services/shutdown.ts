/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Stops every process Kalynt started: terminals, programs, builds, debug
 * sessions, downloads and package manager commands. Used by "Stop all processes"
 * and when the app quits, so nothing is left running in the background.
 */
import { disposeTerminalService, killAllTerminals } from '../handlers/terminal'
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
    programs: number
    builds: number
    debugSessions: number
    packageCommands: number
    agentCommands: number
    downloads: number
}

const settle = (work: Promise<number> | number) => Promise.resolve(work).catch(err => {
    console.error('[Shutdown] Could not stop some processes:', err)
    return 0
})

const settleVoid = (work: Promise<unknown> | void) => Promise.resolve(work).catch(err => {
    console.error('[Shutdown] Cleanup step failed:', err)
})

/** Stops all user/background processes without tearing down app-wide services. */
export async function stopEverything(): Promise<StopReport> {
    cancelAllAiRequests()
    const downloads = abortAllModelDownloads()
    const [terminals, programs, builds, debugSessions, packageCommands, agentCommands] = await Promise.all([
        settle(killAllTerminals()),
        settle(stopAllCodeProcesses()),
        settle(stopAllBuilds()),
        settle(stopAllDebugSessions()),
        settle(getDependencyManager().killAll()),
        settle(stopAllAgentProcesses())
    ])
    return { terminals, programs, builds, debugSessions, packageCommands, agentCommands, downloads }
}

/**
 * Full app-exit cleanup: stops all processes and disposes long-lived services
 * (terminalService gateways, native llama.cpp model, macOS helper, performance
 * timers, update timers, and temporary HTML previews).
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

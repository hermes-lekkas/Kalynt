/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Stops every process Kalynt started: terminals, programs, builds, debug
 * sessions and package manager commands. Used by "Stop all processes" and
 * when the app quits, so nothing is left running in the background.
 */
import { killAllTerminals } from '../handlers/terminal'
import { stopAllCodeProcesses } from '../handlers/code-execution'
import { stopAllBuilds } from '../handlers/build'
import { stopAllDebugSessions } from '../handlers/debug'
import { getDependencyManager } from '../terminal/dependencyManager'
import { stopAllAgentProcesses } from '../agent/exec'
import { cancelAllAiRequests } from '../ai'

export interface StopReport {
    terminals: number
    programs: number
    builds: number
    debugSessions: number
    packageCommands: number
    agentCommands: number
}

const settle = (work: Promise<number> | number) => Promise.resolve(work).catch(err => {
    console.error('[Shutdown] Could not stop some processes:', err)
    return 0
})

export async function stopEverything(): Promise<StopReport> {
    cancelAllAiRequests()
    const [terminals, programs, builds, debugSessions, packageCommands, agentCommands] = await Promise.all([
        settle(killAllTerminals()),
        settle(stopAllCodeProcesses()),
        settle(stopAllBuilds()),
        settle(stopAllDebugSessions()),
        settle(getDependencyManager().killAll()),
        settle(stopAllAgentProcesses())
    ])
    return { terminals, programs, builds, debugSessions, packageCommands, agentCommands }
}

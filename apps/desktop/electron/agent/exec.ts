/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Shell commands for the AI agent. This is deliberately a real shell: the
 * agent runs what a developer would type (pipes, &&, globs), and every
 * command is approved by the user in the renderer before it gets here
 * (unless they chose full auto mode). Commands run non-interactively, with
 * output captured and streamed, a timeout, and their whole process tree
 * stopped on cancel, "Stop all" or quit.
 *
 * IPC:
 *   agent:exec       { id, command, cwd, timeoutMs?, background? } -> ExecResult
 *   agent:exec-read  id -> { output, running, exitCode }   (new output since last read)
 *   agent:exec-kill  id -> { ok }
 * Live output is sent as `agent:exec-output` { id, data }.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IpcMain, WebContents } from 'electron'
import treeKill from 'tree-kill'
import { buildEnhancedPath, getDefaultShell } from '../terminal/terminalEnv'

const MAX_BUFFER = 2_000_000
const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 30 * 60_000
/** How long a background command runs before the agent gets its first output. */
const BACKGROUND_SETTLE_MS = 4000

interface Job {
    proc: ChildProcess
    output: string
    readFrom: number
    exitCode: number | null
    running: boolean
    startedAt: number
    done: Promise<void>
}

const jobs = new Map<string, Job>()

export interface ExecResult {
    ok: boolean
    output: string
    exitCode: number | null
    running: boolean
    timedOut?: boolean
    durationMs: number
    error?: string
}

/** The user's shell, invoked so it runs one command line and exits. */
function shellInvocation(command: string): { file: string; args: string[] } {
    if (process.platform === 'win32') {
        const shell = getDefaultShell()
        if (/pwsh|powershell/i.test(shell)) return { file: shell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] }
        return { file: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    }
    const shell = getDefaultShell()
    const name = path.basename(shell)
    const usable = ['bash', 'zsh', 'sh', 'dash', 'ksh', 'fish'].includes(name) ? shell : '/bin/sh'
    return { file: usable, args: ['-c', command] }
}

/** Non-interactive environment: no pagers, prompts or colour codes in captured output. */
function agentEnv(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        PATH: buildEnhancedPath(),
        CI: process.env.CI ?? '1',
        TERM: 'dumb',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        npm_config_yes: 'true',
        PYTHONUNBUFFERED: '1',
        ELECTRON_RUN_AS_NODE: undefined
    }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g

function kill(job: Job): Promise<void> {
    if (!job.running || !job.proc.pid) return Promise.resolve()
    return new Promise(resolve => treeKill(job.proc.pid!, 'SIGKILL', () => resolve()))
}

function start(id: string, command: string, cwd: string, sender: WebContents): Job {
    const { file, args } = shellInvocation(command)
    const proc = spawn(file, args, { cwd, env: agentEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    const job: Job = { proc, output: '', readFrom: 0, exitCode: null, running: true, startedAt: Date.now(), done: Promise.resolve() }
    const onData = (chunk: Buffer) => {
        const text = chunk.toString('utf8').replace(ANSI, '').replace(/\r(?!\n)/g, '\n')
        job.output += text
        if (job.output.length > MAX_BUFFER) {
            const cut = job.output.length - MAX_BUFFER
            job.output = job.output.slice(cut)
            job.readFrom = Math.max(0, job.readFrom - cut)
        }
        if (!sender.isDestroyed()) sender.send('agent:exec-output', { id, data: text })
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    job.done = new Promise(resolve => {
        proc.on('error', error => {
            job.output += `\n${error.message}\n`
            job.running = false
            job.exitCode = job.exitCode ?? 127
            resolve()
        })
        proc.on('close', code => {
            job.running = false
            job.exitCode = code ?? job.exitCode ?? 1
            resolve()
        })
    })
    jobs.set(id, job)
    return job
}

export function registerAgentExecHandlers(ipcMain: IpcMain, getWorkspace: () => string | null): void {
    ipcMain.handle('agent:exec', async (event, options: { id: string; command: string; cwd?: string; timeoutMs?: number; background?: boolean }) => {
        const started = Date.now()
        const command = typeof options?.command === 'string' ? options.command.trim() : ''
        if (!options?.id || !command) return { ok: false, output: '', exitCode: null, running: false, durationMs: 0, error: 'No command given.' } satisfies ExecResult
        if (jobs.get(options.id)?.running) return { ok: false, output: '', exitCode: null, running: true, durationMs: 0, error: 'A command with this id is already running.' } satisfies ExecResult

        const cwd = path.resolve(options.cwd || getWorkspace() || os.homedir())
        if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
            return { ok: false, output: '', exitCode: null, running: false, durationMs: 0, error: `Folder not found: ${cwd}` } satisfies ExecResult
        }

        const job = start(options.id, command, cwd, event.sender)
        const timeout = Math.min(Math.max(options.timeoutMs || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT)

        if (options.background) {
            // Let a server print its startup lines, then hand control back.
            await Promise.race([job.done, new Promise(r => setTimeout(r, BACKGROUND_SETTLE_MS))])
            job.readFrom = job.output.length
            return { ok: true, output: job.output, exitCode: job.exitCode, running: job.running, durationMs: Date.now() - started } satisfies ExecResult
        }

        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; void kill(job) }, timeout)
        await job.done
        clearTimeout(timer)
        jobs.delete(options.id)
        return {
            ok: true,
            output: job.output,
            exitCode: job.exitCode,
            running: false,
            ...(timedOut ? { timedOut: true } : {}),
            durationMs: Date.now() - started
        } satisfies ExecResult
    })

    ipcMain.handle('agent:exec-read', (_event, id: string) => {
        const job = jobs.get(id)
        if (!job) return { ok: false, output: '', running: false, exitCode: null, error: 'No such process. It may have been stopped already.' }
        const output = job.output.slice(job.readFrom)
        job.readFrom = job.output.length
        if (!job.running) jobs.delete(id)
        return { ok: true, output, running: job.running, exitCode: job.exitCode }
    })

    ipcMain.handle('agent:exec-kill', async (_event, id: string) => {
        const job = jobs.get(id)
        if (!job) return { ok: false }
        await kill(job)
        jobs.delete(id)
        return { ok: true }
    })
}

/** Stops every command the agent started. Returns how many were running. */
export async function stopAllAgentProcesses(): Promise<number> {
    const running = [...jobs.values()].filter(j => j.running)
    await Promise.all(running.map(kill))
    jobs.clear()
    return running.length
}

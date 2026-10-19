/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Runs programs for the Run button and the agent. A saved file is run in place
 * so its imports resolve; a code snippet is written to a temporary file first.
 */
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { shell } from 'electron'
import type { BrowserWindow as BrowserWindowType } from 'electron'
import { validatePath } from '../utils/pathValidator'
import { sendToWindow } from '../utils/window'
import { clearBinaryCache, findBinary, killProcessTree, safeEnv, wrapWindowsCommand } from './code-exec/binaries'
import { EXTENSIONS, planRun, type Step } from './code-exec/languages'

const runningProcesses = new Map<string, ChildProcess>()

const DEFAULT_RUN_LIMIT_MS = 5 * 60_000
const COMPILE_LIMIT_MS = 2 * 60_000
const COMMAND_LIMIT_MS = 30_000

interface ExecuteOptions {
    id: string
    language: string
    /** Source to run when there is no saved file. */
    code?: string
    /** A saved file inside the workspace; run in place when given. */
    filePath?: string
    cwd?: string
    /** 0 runs until the program exits or is stopped. Defaults to 5 minutes. */
    timeoutMs?: number
    /** Written to the program's stdin, which is then closed. */
    stdin?: string
}

interface StepResult {
    code: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
    error?: string
    timedOut: boolean
}

/** Stops every program started from the editor or by the agent. */
export async function stopAllCodeProcesses(): Promise<number> {
    const procs = [...runningProcesses.values()]
    runningProcesses.clear()
    await Promise.all(procs.map(killProcessTree))
    return procs.length
}

// Splits a command line the way a shell would: spaces separate words, quotes
// (anywhere in a word) group text and are removed. Nothing is expanded.
function splitCommand(command: string): string[] {
    const words: string[] = []
    let word = ''
    let quote: '"' | "'" | null = null
    let inWord = false
    for (const ch of command) {
        if (quote) {
            if (ch === quote) quote = null
            else word += ch
        } else if (ch === '"' || ch === "'") {
            quote = ch
            inWord = true
        } else if (/\s/.test(ch)) {
            if (inWord) words.push(word)
            word = ''
            inWord = false
        } else {
            word += ch
            inWord = true
        }
    }
    if (inWord) words.push(word)
    return words
}

export function registerCodeExecutionHandlers(
    ipcMain: Electron.IpcMain,
    app: Electron.App,
    getMainWindow: () => BrowserWindowType | null,
    getCurrentWorkspacePath: () => string | null
) {
    const emit = (channel: string, payload: unknown) => sendToWindow(getMainWindow(), channel, payload)

    const runStep = (id: string, s: Step, cwd: string, env: NodeJS.ProcessEnv, limitMs: number, stdin?: string) =>
        new Promise<StepResult>(resolve => {
            const result: StepResult = { code: null, signal: null, stdout: '', stderr: '', timedOut: false }
            let proc: ChildProcess
            try {
                proc = spawn(s.command, s.args, { cwd, env, shell: false, windowsHide: true, windowsVerbatimArguments: s.windowsVerbatimArguments })
            } catch (err) {
                resolve({ ...result, error: (err as Error).message })
                return
            }
            runningProcesses.set(id, proc)

            // Writing to a program that already exited must not crash the main process.
            proc.stdin?.on('error', () => undefined)
            if (stdin !== undefined) proc.stdin?.end(stdin)

            const forward = (type: 'stdout' | 'stderr') => (data: Buffer) => {
                const text = data.toString()
                result[type] += text
                emit('code:output', { id, type, data: text })
            }
            proc.stdout?.on('data', forward('stdout'))
            proc.stderr?.on('data', forward('stderr'))

            const timer = limitMs > 0 ? setTimeout(() => {
                result.timedOut = true
                emit('code:output', { id, type: 'stderr', data: `\nStopped after ${Math.round(limitMs / 1000)} seconds\n` })
                void killProcessTree(proc)
            }, limitMs) : null

            proc.on('error', err => {
                if (timer) clearTimeout(timer)
                if (runningProcesses.get(id) === proc) runningProcesses.delete(id)
                const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
                resolve({ ...result, error: missing ? `${path.basename(s.command)} isn't installed or isn't on PATH` : err.message })
            })
            proc.on('close', (code, signal) => {
                if (timer) clearTimeout(timer)
                if (runningProcesses.get(id) === proc) runningProcesses.delete(id)
                resolve({ ...result, code, signal })
            })
        })

    ipcMain.handle('code:execute', async (_event, options: ExecuteOptions) => {
        const id = String(options?.id ?? '')
        const language = String(options?.language ?? '').toLowerCase()
        if (!id || !language) return { success: false, error: 'A run id and a language are required' }
        if (runningProcesses.has(id)) return { success: false, error: 'A program with this id is already running' }

        const safeId = id.replace(/[^\w-]/g, '_')
        const workspace = getCurrentWorkspacePath()
        const buildDir = path.join(app.getPath('temp'), 'kalynt-run')
        const cleanup: string[] = []

        try {
            await fs.promises.mkdir(buildDir, { recursive: true })

            let script: string
            if (options.filePath) {
                if (!workspace) return { success: false, error: 'Open a folder to run its files' }
                script = validatePath(workspace, options.filePath)
                if (!fs.existsSync(script)) return { success: false, error: `${path.basename(script)} doesn't exist on disk` }
            } else {
                script = path.join(buildDir, `kalynt_${safeId}${EXTENSIONS[language] ?? '.txt'}`)
                await fs.promises.writeFile(script, options.code ?? '')
                cleanup.push(script)
            }

            if (language === 'html') {
                await shell.openExternal(pathToFileURL(script).href)
                return { success: true, stdout: `Opened ${path.basename(script)} in your browser`, stderr: '', exitCode: 0 }
            }

            const plan = await planRun(language, script, buildDir, workspace, safeId)
            if (!plan) return { success: false, error: `Kalynt can't run ${language} files` }
            cleanup.push(...plan.artifacts)

            let cwd = workspace || path.dirname(script)
            if (options.cwd) {
                try {
                    cwd = workspace ? validatePath(workspace, options.cwd) : options.cwd
                } catch {
                    console.warn('[CodeExec] Working folder outside the workspace; using the workspace instead')
                }
            }
            if (!fs.existsSync(cwd)) cwd = path.dirname(script)

            const env = safeEnv({ NODE_NO_WARNINGS: '1', NO_UPDATE_NOTIFIER: '1', ...plan.env })
            const finish = (r: StepResult, phase: 'compile' | 'run') => {
                if (r.error) emit('code:output', { id, type: 'stderr', data: `${r.error}\n` })
                emit('code:exit', { id, exitCode: r.code, signal: r.signal, phase })
                const output = { stdout: r.stdout, stderr: r.stderr, exitCode: r.code, signal: r.signal }
                if (r.error) return { success: false, error: r.error, ...output }
                if (r.timedOut) return { success: false, error: 'The program ran too long and was stopped', ...output }
                if (phase === 'compile') return { success: false, error: 'Compilation failed', ...output }
                return { success: true, ...output }
            }

            if (plan.compile) {
                const compiled = await runStep(id, plan.compile, cwd, env, COMPILE_LIMIT_MS)
                if (compiled.error || compiled.code !== 0) return finish(compiled, 'compile')
            }
            const limit = options.timeoutMs === 0 ? 0 : (options.timeoutMs ?? DEFAULT_RUN_LIMIT_MS)
            return finish(await runStep(id, plan.run, cwd, env, limit, options.stdin), 'run')
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        } finally {
            for (const file of cleanup) fs.promises.rm(file, { force: true }).catch(() => undefined)
        }
    })

    // Runs one allow-listed tool (no shell) and returns its combined output.
    ipcMain.handle('code:runCommand', async (_event, cwd: string, commandString: string, id?: string) => {
        const ALLOWED = ['npm', 'git', 'node', 'python', 'ls', 'dir', 'echo', 'cat', 'type', 'pip', 'python3', 'yarn', 'pnpm', 'npx', 'tsc', 'vite', 'tsx', 'bun']
        const [cmd, ...args] = splitCommand(String(commandString ?? '').trim())
        if (!cmd || !ALLOWED.includes(cmd)) return { success: false, error: `Command '${cmd ?? ''}' is not in the allowlist.` }

        const workspace = getCurrentWorkspacePath()
        let safeCwd = cwd
        if (workspace) {
            try {
                safeCwd = validatePath(workspace, cwd || workspace)
            } catch {
                return { success: false, error: 'Invalid Working Directory' }
            }
        }

        let executable = (await findBinary(cmd, workspace)) || cmd
        if (process.platform === 'win32' && executable === cmd && ['npm', 'npx', 'yarn', 'pnpm', 'tsc', 'vite', 'tsx'].includes(cmd)) executable = `${cmd}.cmd`
        const runId = id || `cmd-${Date.now()}`
        const r = await new Promise<StepResult>(resolve => {
            const wrapped = wrapWindowsCommand(executable, args)
            const proc = spawn(wrapped.command, wrapped.args, { cwd: safeCwd, shell: false, windowsHide: true, windowsVerbatimArguments: wrapped.windowsVerbatimArguments, env: safeEnv({ NO_UPDATE_NOTIFIER: '1' }) })
            runningProcesses.set(runId, proc)
            let output = ''
            proc.stdin?.on('error', () => undefined)
            proc.stdout?.on('data', d => { output += d.toString() })
            proc.stderr?.on('data', d => { output += d.toString() })
            const timer = setTimeout(() => void killProcessTree(proc), COMMAND_LIMIT_MS)
            const done = (partial: Partial<StepResult>) => {
                clearTimeout(timer)
                if (runningProcesses.get(runId) === proc) runningProcesses.delete(runId)
                resolve({ code: null, signal: null, stderr: '', timedOut: false, ...partial, stdout: output })
            }
            proc.on('error', err => done({ error: err.message }))
            proc.on('close', (code, signal) => done({ code, signal, timedOut: signal !== null && code === null }))
        })
        if (r.error) return { success: false, error: r.error }
        if (r.timedOut) return { success: false, error: 'Command timed out', output: r.stdout }
        return { success: r.code === 0, output: r.stdout }
    })

    ipcMain.handle('code:kill', async (_event, id: string) => {
        const proc = runningProcesses.get(id)
        if (!proc) return { success: false, error: 'Process not found' }
        runningProcesses.delete(id)
        await killProcessTree(proc)
        return { success: true }
    })

    ipcMain.handle('code:write-input', async (_event, id: string, data: string) => {
        const proc = runningProcesses.get(id)
        if (!proc?.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
            return { success: false, error: 'The program is not accepting input' }
        }
        proc.stdin.write(data)
        return { success: true }
    })

    ipcMain.handle('code:clearBinaryCache', async () => {
        clearBinaryCache()
        return { success: true }
    })

    ipcMain.handle('code:clearCache', async () => {
        clearBinaryCache()
        await fs.promises.rm(path.join(app.getPath('temp'), 'kalynt-run'), { recursive: true, force: true }).catch(() => undefined)
        return { success: true }
    })
}

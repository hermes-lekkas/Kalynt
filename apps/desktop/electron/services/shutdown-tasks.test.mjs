/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kalynt-shutdown-test-'))
after(() => fs.rm(root, { recursive: true, force: true }))

function isPidAlive(pid) {
    try {
        process.kill(pid, 0)
    } catch (err) {
        return Boolean(err && err.code === 'EPERM')
    }
    if (process.platform === 'linux') {
        try {
            const status = fsSync.readFileSync(`/proc/${pid}/status`, 'utf8')
            if (/^State:\s*[ZX]/m.test(status)) return false
        } catch {
            return false
        }
    }
    return true
}

let bundleCounter = 0
async function loadShutdownBundle() {
    const entry = fileURLToPath(new URL('./shutdown.ts', import.meta.url))
    const outFile = path.join(root, `shutdown-bundle-${++bundleCounter}.cjs`)
    await build({
        entryPoints: [entry],
        bundle: true,
        outfile: outFile,
        platform: 'node',
        format: 'cjs',
        external: ['node-pty', 'node-llama-cpp', '@node-llama-cpp/*'],
        plugins: [{
            name: 'mock-electron-for-shutdown',
            setup(b) {
                b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }))
                b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
                    contents: `
                        export const app = {
                            isPackaged: false,
                            getAppPath: () => ${JSON.stringify(root)},
                            getPath: () => ${JSON.stringify(root)},
                            getVersion: () => '2.1.0',
                            on: () => {},
                            once: () => {},
                            off: () => {},
                            removeListener: () => {}
                        };
                        export const powerMonitor = { on: () => {}, off: () => {}, removeListener: () => {} };
                        export const ipcMain = { handle: () => {} };
                        export const shell = { openExternal: async () => {} };
                        export const safeStorage = { isEncryptionAvailable: () => false };
                        export class BrowserWindow { static getAllWindows() { return []; } }
                    `
                }))
                b.onResolve({ filter: /^electron-updater$/ }, () => ({ path: 'electron-updater', namespace: 'mock-upd' }))
                b.onLoad({ filter: /.*/, namespace: 'mock-upd' }, () => ({
                    contents: `export const autoUpdater = { on: () => {}, removeAllListeners: () => {} };`
                }))
                b.onResolve({ filter: /^node-llama-cpp$/ }, () => ({ path: 'node-llama-cpp', namespace: 'mock-llama' }))
                b.onLoad({ filter: /.*/, namespace: 'mock-llama' }, () => ({
                    contents: `export const getLlama = async () => { throw new Error('mock'); };`
                }))
                b.onResolve({ filter: /^node-pty$/ }, () => ({ path: 'node-pty', namespace: 'mock-pty' }))
                b.onLoad({ filter: /.*/, namespace: 'mock-pty' }, () => ({
                    contents: `export const spawn = () => { throw new Error('mock pty'); };`
                }))
            }
        }]
    })
    return require(outFile)
}

async function loadTaskRunner() {
    const entry = fileURLToPath(new URL('../terminal/taskRunner.ts', import.meta.url))
    const outFile = path.join(root, `taskrunner-bundle-${++bundleCounter}.cjs`)
    await build({
        entryPoints: [entry],
        bundle: true,
        outfile: outFile,
        platform: 'node',
        format: 'cjs',
        plugins: [{
            name: 'mock-electron-tr',
            setup(b) {
                b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }))
                b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
                    contents: `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(root)} };`
                }))
            }
        }]
    })
    return require(outFile)
}

test('QA-26: Stop all / shutdownApp terminates TaskRunnerService child process tree while leaving independent control process alive', async () => {
    const { registerTaskRunnerForShutdown, stopEverythingWithDetails, shutdownApp } = await loadShutdownBundle()
    const { TaskRunnerService } = await loadTaskRunner()

    const runner = new TaskRunnerService()
    const unregister = registerTaskRunnerForShutdown(runner)

    // Independent control process started outside Kalynt
    const controlProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        detached: false
    })
    const pidFile = path.join(root, 'child.pid')
    const sleeperScript = path.join(root, 'sleeper.mjs')
    await fs.writeFile(sleeperScript, `
        import fs from 'node:fs';
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        setInterval(() => {}, 1000);
    `)

    try {
        assert.ok(controlProc.pid && isPidAlive(controlProc.pid), 'Control process should be alive')

        const started = await runner.executeTask({
            id: 'qa26-sleeper',
            task: {
                id: 'qa26-sleeper',
                label: 'Sleeper task',
                type: 'shell',
                command: `${JSON.stringify(process.execPath)} ${JSON.stringify(sleeperScript)}`,
                cwd: root
            }
        })
        assert.equal(started.success, true)
        assert.ok(started.executionId)

        // Wait until the nested node child writes its PID
        let childPid = 0
        for (let i = 0; i < 60; i++) {
            try {
                const raw = await fs.readFile(pidFile, 'utf8')
                if (raw.trim()) {
                    childPid = Number(raw.trim())
                    break
                }
            } catch { /* not written yet */ }
            await new Promise(r => setTimeout(r, 50))
        }
        assert.ok(childPid > 0 && isPidAlive(childPid), 'Task child process must be running before shutdown')

        const execBefore = await runner.getTaskExecution(started.executionId)
        assert.equal(execBefore?.status, 'running')

        // Execute shared shutdown/stop operation
        const detailed = await stopEverythingWithDetails()
        assert.equal(detailed.status, 'complete')
        assert.equal(detailed.counts.tasks, 1)
        assert.equal(detailed.failedCount, 0)
        assert.deepEqual(detailed.errors, [])

        // Wait briefly for OS reaper
        await new Promise(r => setTimeout(r, 150))

        // Task execution status is cancelled and child PID exited
        const execAfter = await runner.getTaskExecution(started.executionId)
        assert.equal(execAfter?.status, 'cancelled')
        assert.equal(isPidAlive(childPid), false, `Task child PID ${childPid} must have exited after Stop all`)

        // Independent control process MUST remain alive
        assert.equal(isPidAlive(controlProc.pid), true, 'Independent OS control process must not be touched')

        // Also test shutdownApp directly returns numeric StopReport including tasks
        const report = await shutdownApp()
        assert.equal(typeof report.tasks, 'number')
        assert.equal(Object.values(report).every(v => typeof v === 'number'), true)
    } finally {
        unregister()
        runner.dispose()
        try { controlProc.kill('SIGKILL') } catch { /* ignore */ }
    }
})

test('QA-26: stopEverythingWithDetails accurately reports partial and failed cleanup states', async () => {
    const { registerTaskRunnerForShutdown, stopEverythingWithDetails } = await loadShutdownBundle()

    // Partial: one runner stops 2 tasks, another fails 1 task
    const unregGood = registerTaskRunnerForShutdown({
        killAllTaskExecutions: async () => ({ stopped: 2, failed: 0, errors: [] })
    })
    const unregBad = registerTaskRunnerForShutdown({
        killAllTaskExecutions: async () => ({ stopped: 0, failed: 1, errors: ['Task stuck PID 99999'] })
    })

    try {
        const partial = await stopEverythingWithDetails()
        assert.equal(partial.status, 'partial')
        assert.equal(partial.counts.tasks, 2)
        assert.equal(partial.failedCount, 1)
        assert.equal(partial.errors.length, 1)
        assert.match(partial.errors[0].error, /stuck PID 99999/)
    } finally {
        unregGood()
    }

    // Failed: zero stopped, one failed
    try {
        const failed = await stopEverythingWithDetails()
        assert.equal(failed.status, 'failed')
        assert.equal(failed.totalStopped, 0)
        assert.equal(failed.failedCount, 1)
    } finally {
        unregBad()
    }
})

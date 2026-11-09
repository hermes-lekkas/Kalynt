/* SPDX-License-Identifier: AGPL-3.0-only
 * Real production Electron/preload/IPC smoke tests. Never uses a personal profile.
 * Run after build:vite: xvfb-run -a electron scripts/smoke.cjs --no-sandbox --disable-gpu
 */
const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const http = require('node:http')
const desktop = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kalynt-smoke-'))
const workspace = path.join(scratch, 'workspace with spaces')
fs.mkdirSync(workspace)
fs.mkdirSync(path.join(scratch, 'profile'))
app.setPath('userData', path.join(scratch, 'profile'))
app.setPath('sessionData', path.join(scratch, 'profile'))
app.setAppPath(desktop)
// Exercise the engine's packaged dependency lookup without registering or
// launching an installed app. Only this disposable harness changes these values.
if (process.env.KALYNT_SMOKE_RESOURCES) {
    const resources = path.resolve(process.env.KALYNT_SMOKE_RESOURCES)
    const asar = require('@electron/asar')
    const bundles = fs.readdirSync(path.join(desktop, 'dist-electron')).filter(file => file.endsWith('.js')).map(file => `dist-electron/${file}`)
    for (const file of [...bundles, 'dist/index.html']) {
        assert.deepEqual(asar.extractFile(path.join(resources, 'app.asar'), file), fs.readFileSync(path.join(desktop, file)), `Packaged bundle mismatch: ${file}`)
    }
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    process.defaultApp = false
}
// Importing the real entry point must not change the user's protocol association.
app.setAsDefaultProtocolClient = () => false
const failures = []
let completed = 0
let window
const deadline = setTimeout(() => { console.error('SMOKE timeout'); app.exit(1) }, 90000)
async function check(name, fn) {
    try { await fn(); completed++; console.log(`SMOKE PASS ${name}`) }
    catch (error) { failures.push(name); console.error(`SMOKE FAIL ${name}: ${error.stack || error}`) }
}
const call = (method, ...args) => window.webContents.executeJavaScript(`window.electronAPI.${method}(...${JSON.stringify(args)})`)
const ok = result => { assert.equal(result?.success, true, JSON.stringify(result)); return result }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

app.once('browser-window-created', (_, win) => {
    window = win
    win.webContents.on('preload-error', (_, _file, error) => { failures.push('preload'); console.error(error) })
    win.webContents.once('did-finish-load', () => run().catch(error => { console.error(error); app.exit(1) }))
})

async function run() {
    // Allow the renderer's initial workspace restore to finish before using the fixture.
    await delay(1200)
    await check('production preload and runtime', async () => {
        assert.equal(await window.webContents.executeJavaScript('typeof window.electronAPI.fs.readFile'), 'function')
        assert.equal(await window.webContents.executeJavaScript('typeof window.require'), 'undefined')
        if (process.env.KALYNT_SMOKE_RESOURCES) {
            const { pathToFileURL } = require('node:url')
            const engine = await import(pathToFileURL(path.join(process.resourcesPath, 'node_modules/node-llama-cpp/dist/index.js')).href)
            assert.equal(typeof engine.getLlama, 'function')
        }
    })
    await check('open workspace and file round trip', async () => {
        ok(await call('fs.setWorkspace', workspace))
        ok(await call('fs.writeFile', { path: 'src/nested/example.ts', content: 'export const answer = 42; // smoke needle\n' }))
        assert.match(ok(await call('fs.readFile', 'src/nested/example.ts')).content, /answer = 42/)
        assert.equal(ok(await call('fs.stat', 'src/nested/example.ts')).isFile, true)
        assert.equal(ok(await call('fs.readDir', 'src/nested')).items[0].name, 'example.ts')
    })
    await check('create and rename preserve existing files', async () => {
        ok(await call('fs.createFile', 'untitled.txt'))
        assert.equal((await call('fs.createFile', 'src/nested/example.ts')).success, false)
        assert.equal((await call('fs.rename', { oldPath: 'untitled.txt', newPath: 'src/nested/example.ts' })).success, false)
        ok(await call('fs.rename', { oldPath: 'untitled.txt', newPath: 'renamed.txt' }))
        ok(await call('fs.delete', 'renamed.txt'))
    })
    await check('file-save conflicts and editor recovery through production IPC', async () => {
        const file = path.join(workspace, 'recovery.txt')
        ok(await call('fs.writeFile', { path: file, content: 'external contents' }))
        const conflict = await call('fs.writeFile', { path: file, content: 'editor contents', expectedContent: 'old contents' })
        assert.equal(conflict.conflict, true)
        assert.equal(ok(await call('fs.readFile', file)).content, 'external contents')
        const state = { spaceId: 'smoke-editor', folder: workspace, paths: [file], activePath: file, files: [{ path: file, content: 'unsaved edit', diskContent: 'external contents', isDirty: true, name: 'recovery.txt', language: 'plaintext' }] }
        ok(await call('editorState.save', state))
        assert.equal((await call('editorState.load', state.spaceId, workspace)).files[0].content, 'unsaved edit')
        state.files[0].content = 'last keystroke before closing'
        ok(await call('editorState.flush', state))
        assert.equal((await call('editorState.load', state.spaceId, workspace)).files[0].content, 'last keystroke before closing')
    })
    await check('nested file search', async () => {
        const result = ok(await call('fs.search', { searchPath: workspace, pattern: 'smoke needle', filePattern: 'src/**/*.ts' }))
        assert.equal(result.results.length, 1, JSON.stringify(result))
    })
    await check('workspace file watcher', async () => {
        await window.webContents.executeJavaScript('window.__smokeChanges = []; window.__smokeUnwatch = window.electronAPI.fs.onChange(e => window.__smokeChanges.push(e)); void 0')
        ok(await call('fs.watchDir', { id: 'smoke', dirPath: workspace }))
        await delay(300)
        // Reopening a workspace is a no-op, not a request to destroy its watch.
        ok(await call('fs.setWorkspace', workspace))
        ok(await call('fs.writeFile', { path: 'watched.txt', content: 'watch me' }))
        for (let i = 0; i < 30; i++) {
            if (await window.webContents.executeJavaScript('window.__smokeChanges.some(e => e.id === "smoke" && e.path.endsWith("watched.txt"))')) break
            await delay(100)
        }
        assert.equal(await window.webContents.executeJavaScript('window.__smokeChanges.some(e => e.id === "smoke" && e.path.endsWith("watched.txt"))'), true)
        ok(await call('fs.unwatchDir', 'smoke'))
        await window.webContents.executeJavaScript('window.__smokeUnwatch()')
    })
    await check('Git init, stage, commit, diff and branch', async () => {
        ok(await call('git.init', workspace))
        execFileSync('git', ['-C', workspace, 'config', 'user.name', 'Kalynt Smoke'])
        execFileSync('git', ['-C', workspace, 'config', 'user.email', 'smoke@example.invalid'])
        ok(await call('git.add', { repoPath: workspace, files: ['.'] }))
        ok(await call('git.commit', { repoPath: workspace, message: 'Fixture' }))
        ok(await call('fs.writeFile', { path: 'watched.txt', content: 'changed' }))
        const status = ok(await call('git.status', workspace))
        assert.match(JSON.stringify(status), /watched.txt/)
        assert.match(JSON.stringify(ok(await call('git.diff', { repoPath: workspace, file: 'watched.txt' }))), /changed/)
        ok(await call('git.branch', workspace))
    })
    await check('PTY terminal spawn, output, resize and kill', async () => {
        await window.webContents.executeJavaScript('window.__smokeOutput = ""; window.__smokeOff = window.electronAPI.terminal.onData(e => { if (e.id === "smoke") window.__smokeOutput += e.data }); void 0')
        ok(await call('terminal.spawn', { id: 'smoke', cwd: workspace, cols: 80, rows: 24 }))
        assert.equal(await call('terminal.resize', { id: 'smoke', cols: 100, rows: 30 }), true)
        assert.equal(await call('terminal.write', { id: 'smoke', data: 'node -e "console.log(\'KALYNT_\' + \'SMOKE_OK\')"\r' }), true)
        for (let i = 0; i < 30; i++) {
            if (await window.webContents.executeJavaScript('window.__smokeOutput.includes("KALYNT_SMOKE_OK")')) break
            await delay(100)
        }
        assert.equal(await window.webContents.executeJavaScript('window.__smokeOutput.includes("KALYNT_SMOKE_OK")'), true)
        assert.equal(await call('terminal.kill', 'smoke'), true)
        await window.webContents.executeJavaScript('window.__smokeOff()')
    })
    await check('run a real process', async () => {
        const result = ok(await call('code.runCommand', workspace, 'node -e "console.log(6 * 7)"', 'smoke-code'))
        assert.match(result.output, /42/)
    })
    await check('detect and execute a build task', async () => {
        fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { smoke: 'node -e "console.log(42)"' } }))
        const tasks = ok(await call('build.getTasks', workspace)).tasks
        assert.ok(tasks.some(t => t.command === 'smoke'), JSON.stringify(tasks))
        await window.webContents.executeJavaScript('window.__smokeBuilds = []; window.__smokeBuildOff = window.electronAPI.build.onEnd(e => window.__smokeBuilds.push(e)); void 0')
        const started = ok(await call('build.executeTask', { label: 'smoke', type: 'npm', command: 'smoke' }, workspace))
        for (let i = 0; i < 50; i++) {
            if (await window.webContents.executeJavaScript(`window.__smokeBuilds.some(e => e.taskId === ${JSON.stringify(started.taskId)})`)) break
            await delay(100)
        }
        const ended = await window.webContents.executeJavaScript(`window.__smokeBuilds.find(e => e.taskId === ${JSON.stringify(started.taskId)})`)
        assert.equal(ended?.exitCode, 0, JSON.stringify(ended))
        await window.webContents.executeJavaScript('window.__smokeBuildOff()')
    })
    await check('agent file discovery and command execution', async () => {
        const found = await call('agent.glob', { pattern: '**/*.ts', path: workspace })
        assert.match(JSON.stringify(found), /example.ts/)
        const result = await call('agent.exec', { id: 'smoke-agent', command: 'echo agent-ok', cwd: workspace })
        assert.match(JSON.stringify(result), /agent-ok/)
    })
    await check('debug configurations and extension host', async () => {
        ok(await call('debug.getConfigurations', workspace))
        await call('extensions.list')
        await call('extensions.active')
    })
    if (process.env.KALYNT_SMOKE_PYTHON) await check('Python debugger breakpoint, stack, evaluation and continue', async () => {
        const program = path.join(workspace, 'debug-smoke.py')
        fs.writeFileSync(program, 'value = 40\nvalue += 2\nprint(value)\n')
        await window.webContents.executeJavaScript('window.__smokeStops = []; window.__smokeStopOff = window.electronAPI.debug.onStopped(e => window.__smokeStops.push(e)); void 0')
        let sessionId
        try {
            sessionId = ok(await call('debug.start', { type: 'python', request: 'launch', name: 'Smoke', python: process.env.KALYNT_SMOKE_PYTHON, program, console: 'internalConsole', justMyCode: false }, workspace, program, [{ file: program, lines: [3] }])).sessionId
            for (let i = 0; i < 100; i++) {
                if (await window.webContents.executeJavaScript(`window.__smokeStops.some(e => e.sessionId === ${JSON.stringify(sessionId)})`)) break
                await delay(100)
            }
            const stopped = await window.webContents.executeJavaScript(`window.__smokeStops.find(e => e.sessionId === ${JSON.stringify(sessionId)})`)
            assert.ok(stopped, 'Debugger did not stop at the breakpoint')
            const stack = ok(await call('debug.getCallStack', sessionId, stopped.threadId)).callStack
            assert.ok(stack.length > 0)
            assert.equal(stack[0].line, 3)
            assert.match(JSON.stringify(ok(await call('debug.evaluate', sessionId, 'value', stack[0].id))), /42/)
            ok(await call('debug.continue', sessionId, stopped.threadId))
        } finally {
            if (sessionId) await call('debug.stop', sessionId)
            await window.webContents.executeJavaScript('window.__smokeStopOff()')
        }
    })
    await check('model setup begins unconfigured', async () => {
        assert.equal((await call('ai.localServerStatus')).configured, false)
        const keys = await call('ai.keyStatus')
        assert.equal(Object.values(keys).some(Boolean), false)
    })
    await check('agent conversations survive a disk save and reload', async () => {
        const session = { id: 'smoke-session-0001', title: 'Saved conversation', spaceId: 'smoke-space', items: [{ role: 'user', content: 'Fixture question' }], createdAt: Date.now(), updatedAt: Date.now() }
        assert.equal((await call('agent.saveSession', session)).ok, true)
        const list = await call('agent.listSessions', 'smoke-space')
        assert.equal(list[0].id, session.id)
        assert.equal((await call('agent.loadSession', session.id)).items[0].content, 'Fixture question')
        session.items[0].content = 'Last prompt before closing'
        assert.equal((await call('agent.flushSession', session)).ok, true)
        assert.equal((await call('agent.loadSession', session.id)).items[0].content, 'Last prompt before closing')
        assert.equal((await call('agent.deleteSession', session.id)).ok, true)
        assert.equal(await call('agent.loadSession', session.id), null)
    })
    await check('local server configuration and streamed AI through real IPC', async () => {
        const server = http.createServer(async (req, res) => {
            if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'fixture-coder' }] })); return }
            if (req.url === '/v1/chat/completions') {
                let raw = ''; for await (const chunk of req) raw += chunk
                assert.equal(JSON.parse(raw).model, 'fixture-coder')
                res.writeHead(200, { 'Content-Type': 'text/event-stream' })
                res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Fixture response ✓' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
                return
            }
            res.writeHead(404); res.end()
        })
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        try {
            const connected = await call('ai.connectLocalServer', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 8192 })
            assert.equal(connected.ok, true, JSON.stringify(connected))
            assert.equal(connected.models[0].id, 'fixture-coder')
            const result = await call('ai.chat', 'smoke-chat', { provider: 'local-server', model: 'fixture-coder', system: 'Be concise.', items: [{ role: 'user', content: 'Test' }], maxTokens: 32 })
            assert.equal(result.ok, true, JSON.stringify(result))
            assert.equal(result.result.assistant.text, 'Fixture response ✓')
        } finally {
            await call('ai.disconnectLocalServer')
            server.closeAllConnections()
            await new Promise(resolve => server.close(resolve))
        }
        assert.equal((await call('ai.localServerStatus')).configured, false)
    })
    if (process.env.KALYNT_SMOKE_MODEL) await check('native GGUF load, generate, stream and unload', async () => {
        const modelsDir = await call('getModelsDirectory')
        const modelPath = path.join(modelsDir, 'smoke.gguf')
        fs.copyFileSync(process.env.KALYNT_SMOKE_MODEL, modelPath)
        try {
            ok(await call('loadModel', { modelId: 'smoke-native', path: modelPath, contextLength: 512, aimeConfig: { gpuLayers: 0, threads: 2, reservedMB: 256 } }))
            assert.equal((await call('getModelStatus')).modelId, 'smoke-native')
            const result = ok(await call('generateCompletion', { prompt: 'Once upon a time', maxTokens: 16, temperature: 0 }))
            assert.ok(result.text.length > 0)
            const streamed = await window.webContents.executeJavaScript(`new Promise(resolve => {
                let text = '';
                window.electronAPI.generateCompletionStream({ prompt: 'Once upon a time', maxTokens: 16, temperature: 0 }, token => { text += token }, error => resolve({ text, error }));
            })`)
            assert.ok(!streamed.error, JSON.stringify(streamed))
            assert.ok(streamed.text.length > 0)
        } finally { ok(await call('unloadModel')) }
        assert.equal((await call('getModelStatus')).modelId, null)
    })
    await check('invalid workspace recovery and closing', async () => {
        assert.equal((await call('fs.setWorkspace', path.join(workspace, 'missing'))).success, false)
        assert.equal((await call('fs.setWorkspace', path.join(workspace, 'watched.txt'))).success, false)
        assert.equal(ok(await call('fs.readFile', 'watched.txt')).content, 'changed')
        const another = path.join(scratch, 'another workspace')
        fs.mkdirSync(another)
        const switched = await Promise.all([call('fs.setWorkspace', another), call('fs.setWorkspace', workspace)])
        switched.forEach(ok)
        assert.equal(ok(await call('fs.readFile', 'watched.txt')).content, 'changed')
        ok(await call('fs.setWorkspace', null))
        assert.equal((await call('fs.readFile', 'watched.txt')).success, false)
    })
    console.log(`SMOKE RESULT ${completed} passed; ${failures.length} failed: ${failures.join(', ')}`)
    clearTimeout(deadline)
    app.once('will-quit', () => {
        fs.rmSync(scratch, { recursive: true, force: true })
        app.exit(failures.length ? 1 : 0)
    })
    app.quit()
}

require(path.join(desktop, 'dist-electron/main.js'))

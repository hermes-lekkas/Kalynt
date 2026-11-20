/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

async function loadTs(relPath, external = ['electron', 'node-pty']) {
    const entry = fileURLToPath(new URL(relPath, import.meta.url))
    const { outputFiles } = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm',
        external
    })
    return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kalynt-term-test-'))
after(() => fs.rm(root, { recursive: true, force: true }))

test('ShellIntegrationService: sanitizes IDs, scripts Bash/Zsh hooks, parses split OSC 633, and cleans up on detach', async () => {
    const { ShellIntegrationService, sanitizeTerminalId } = await loadTs('./shellIntegration.ts')

    assert.equal(sanitizeTerminalId('../../bad; rm -rf /'), '______bad__rm_-rf__')

    const svc = new ShellIntegrationService()

    // Scripts for bash & zsh
    const bashScript = svc.getShellIntegrationScript('/bin/bash')
    assert.match(bashScript, /PROMPT_COMMAND/)
    assert.match(bashScript, /__kalynt_cmd_end/)
    assert.match(bashScript, /633;E;/)
    assert.match(bashScript, /BASH_COMMAND/)

    const zshScript = svc.getShellIntegrationScript('/bin/zsh')
    assert.match(zshScript, /add-zsh-hook preexec/)
    assert.match(zshScript, /add-zsh-hook precmd/)
    assert.match(zshScript, /633;E;/)

    // prepareSpawn uses --rcfile for bash and ZDOTDIR for zsh, cleaned on detach
    const bashPrep = svc.prepareSpawn('term/../../1', '/bin/bash', { PATH: '/usr/bin' })
    assert.equal(bashPrep.args[0], '--rcfile')
    assert.ok(fsSync.existsSync(bashPrep.args[1]))
    assert.ok(path.basename(bashPrep.args[1]).startsWith('kalynt-bash-term_______1-'))

    const zshPrep = svc.prepareSpawn('term-zsh', '/bin/zsh', { PATH: '/usr/bin' })
    assert.deepEqual(zshPrep.args, [])
    assert.ok(zshPrep.env.ZDOTDIR && fsSync.existsSync(path.join(zshPrep.env.ZDOTDIR, '.zshrc')))

    // Split OSC 633 chunks + exitCode 0 + command recording
    let exitCb = null
    const fakePty = { onExit: (cb) => { exitCb = cb } }
    svc.attachToTerminal('term/../../1', fakePty, '/bin/bash')
    assert.equal(svc.hasIntegration('term/../../1'), true)

    const recorded = []
    svc.on('command_recorded', (cmd) => recorded.push(cmd))

    // Split across prefix boundary (\x1b]63 | 3;...) and mid-command boundary
    svc.processData('term/../../1', '\x1b]63')
    svc.processData('term/../../1', '3;A;/tmp/proj\x07\x1b]633;B;npm ru')
    svc.processData('term/../../1', 'n test\x07hello world\n\x1b]633;E;0\x07\x1b]633;D;0\x07')

    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].command, 'npm run test')
    assert.equal(recorded[0].cwd, '/tmp/proj')
    assert.equal(recorded[0].exitCode, 0)
    assert.equal(typeof recorded[0].startTime, 'number')
    assert.ok(recorded[0].output.includes('hello world'))

    // Closing terminal detaches integration and removes temp rcfile
    exitCb({ exitCode: 0 })
    assert.equal(svc.hasIntegration('term/../../1'), false)
    assert.equal(fsSync.existsSync(bashPrep.args[1]), false)

    svc.detachFromTerminal('term-zsh')
    assert.equal(fsSync.existsSync(zshPrep.env.ZDOTDIR), false)
    svc.dispose()
})

test('TerminalSessionManager: blocks sessionId traversal and enforces export/import path validation', async () => {
    // Load terminalManager with electron mocked via esbuild plugin
    const entry = fileURLToPath(new URL('./terminalManager.ts', import.meta.url))
    const { outputFiles } = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm',
        plugins: [{
            name: 'mock-electron',
            setup(b) {
                b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }))
                b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
                    contents: `export const app = { getPath: () => ${JSON.stringify(root)} }`
                }))
            }
        }]
    })
    const { TerminalSessionManager, isValidSessionId } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)

    assert.equal(isValidSessionId('../../etc/passwd'), false)
    assert.equal(isValidSessionId('foo/bar'), false)
    assert.equal(isValidSessionId('valid_session-1'), true)

    const sessionsDir = path.join(root, 'sessions')
    const workspaceDir = path.join(root, 'ws')
    const outsideDir = path.join(root, 'outside')
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.mkdir(workspaceDir, { recursive: true })
    await fs.mkdir(outsideDir, { recursive: true })

    const mgr = new TerminalSessionManager(sessionsDir)
    assert.throws(() => mgr.createSession({ id: '../../evil', shell: '/bin/bash', cwd: workspaceDir }))
    assert.equal(mgr.loadSession('../../evil'), null)
    assert.equal(mgr.saveSession('../../evil'), false)
    assert.equal(mgr.deleteSession('../../evil'), false)

    const session = mgr.createSession({ id: 'sess-1', shell: '/bin/bash', cwd: workspaceDir })
    assert.equal(session.id, 'sess-1')

    // Export outside workspace/sessions dir must fail
    assert.equal(mgr.exportSession('sess-1', path.join(outsideDir, 'leak.json'), workspaceDir), false)
    // Export non-json must fail
    assert.equal(mgr.exportSession('sess-1', path.join(workspaceDir, 'leak.txt'), workspaceDir), false)
    // Export inside workspace .json succeeds and imports cleanly
    const validExport = path.join(workspaceDir, 'exported.json')
    assert.equal(mgr.exportSession('sess-1', validExport, workspaceDir), true)
    assert.equal(mgr.importSession(path.join(outsideDir, 'leak.json'), workspaceDir), null)
    const importedId = mgr.importSession(validExport, workspaceDir)
    assert.ok(importedId && importedId.startsWith('imported_'))

    mgr.dispose()
})

test('taskProviders: skips node_modules/.git and gates Python tasks on Python markers', async () => {
    const { createDefaultTaskProviders, findFiles } = await loadTs('./taskProviders.ts')

    const jsOnly = path.join(root, 'js-only')
    await fs.mkdir(path.join(jsOnly, 'node_modules', 'pkg'), { recursive: true })
    await fs.mkdir(path.join(jsOnly, '.git'), { recursive: true })
    await fs.writeFile(path.join(jsOnly, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }))
    await fs.writeFile(path.join(jsOnly, 'node_modules', 'pkg', 'ignored.csproj'), '<Project/>')
    await fs.writeFile(path.join(jsOnly, '.git', 'ignored.csproj'), '<Project/>')

    const foundCsproj = await findFiles(jsOnly, '*.csproj')
    assert.deepEqual(foundCsproj, [])

    const providers = createDefaultTaskProviders()
    const pyTasksInJs = await providers.get('python').provideTasks(jsOnly)
    assert.deepEqual(pyTasksInJs, [])

    const pyProj = path.join(root, 'py-proj')
    await fs.mkdir(pyProj, { recursive: true })
    await fs.writeFile(path.join(pyProj, 'requirements.txt'), 'pytest\n')
    const pyTasks = await providers.get('python').provideTasks(pyProj)
    assert.ok(pyTasks.some(t => t.command === 'pip'))
    assert.ok(pyTasks.some(t => t.command === 'pytest'))
})

test('packageManagers: fixes Yarn global arg order and parses real Cargo metadata deps', async () => {
    const { PACKAGE_MANAGERS, buildInstallArgs, parsePackageList } = await loadTs('./packageManagers.ts')

    assert.deepEqual(buildInstallArgs(PACKAGE_MANAGERS.yarn, { global: true }), ['global', 'add'])
    assert.deepEqual(buildInstallArgs(PACKAGE_MANAGERS.npm, { global: true }), ['install', '-g'])
    assert.ok(!PACKAGE_MANAGERS.cargo.listArgs.includes('--no-deps'))

    const cargoJson = JSON.stringify({
        workspace_members: ['my-app 0.1.0 (path+file:///ws)'],
        packages: [
            {
                id: 'my-app 0.1.0 (path+file:///ws)',
                name: 'my-app',
                version: '0.1.0',
                dependencies: [
                    { name: 'serde', req: '^1.0', kind: null },
                    { name: 'criterion', req: '^0.5', kind: 'dev' }
                ]
            },
            { id: 'serde 1.0.210', name: 'serde', version: '1.0.210', description: 'Serialization' },
            { id: 'criterion 0.5.1', name: 'criterion', version: '0.5.1', description: 'Benchmarks' }
        ]
    })
    const parsed = parsePackageList('cargo', cargoJson)
    assert.equal(parsed.length, 2)
    assert.deepEqual(parsed.find(p => p.name === 'serde'), { name: 'serde', version: '1.0.210', isDev: false, description: 'Serialization' })
    assert.deepEqual(parsed.find(p => p.name === 'criterion'), { name: 'criterion', version: '0.5.1', isDev: true, description: 'Benchmarks' })
})

test('DebugAdapterGateway: handles ENOENT without uncaught error and parses UTF-8 byte-length DAP frames', async () => {
    const { DebugAdapterGateway } = await loadTs('./debugGateway.ts')
    const { debugAdapterConfigurations } = await loadTs('./languageConfigs.ts')

    // Broken placeholder configs removed
    assert.equal(debugAdapterConfigurations.node, undefined)
    assert.equal(debugAdapterConfigurations.java, undefined)
    assert.equal(debugAdapterConfigurations.php, undefined)

    const events = new EventEmitter()
    const errors = []
    events.on('debug_session_error', (e) => errors.push(e))

    const gw = new DebugAdapterGateway({
        missing: { type: 'missing', command: 'nonexistent-dap-binary-kalynt-xyz', args: [], transport: 'stdio' }
    }, events)

    const res = await gw.startDebugSession({ sessionId: 'dbg-1', languageId: 'missing', program: 'app.js' })
    assert.equal(res.success, false)
    assert.ok(errors.length >= 1)

    // Test UTF-8 byte-length DAP framing with a tiny Node echo adapter
    const adapterScript = path.join(root, 'mock-dap.mjs')
    await fs.writeFile(adapterScript, `
        let buf = Buffer.alloc(0);
        process.stdin.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            const idx = buf.indexOf('\\r\\n\\r\\n');
            if (idx === -1) return;
            const len = Number(buf.subarray(0, idx).toString('ascii').match(/Content-Length:\\s*(\\d+)/i)[1]);
            const start = idx + 4;
            if (buf.length < start + len) return;
            const req = JSON.parse(buf.subarray(start, start + len).toString('utf8'));
            buf = buf.subarray(start + len);
            const resp = JSON.stringify({ seq: 1, type: 'response', request_seq: req.seq, success: true, command: req.command, body: { greeting: 'héllo 🚀 日本語' } });
            const frame = Buffer.from('Content-Length: ' + Buffer.byteLength(resp, 'utf8') + '\\r\\n\\r\\n' + resp, 'utf8');
            // Split mid-UTF-8 multibyte sequence to test Buffer accumulation
            process.stdout.write(frame.subarray(0, 28));
            setTimeout(() => process.stdout.write(frame.subarray(28)), 10);
        });
    `)

    gw.configureDebugAdapter('mock', {
        type: 'mock',
        command: process.execPath,
        args: [adapterScript],
        transport: 'stdio'
    })

    const started = await gw.startDebugSession({ sessionId: 'dbg-utf8', languageId: 'mock', program: 'x' })
    assert.equal(started.success, true)
    const reply = await gw.sendDebugRequest('dbg-utf8', 'initialize', {})
    assert.equal(reply.body.greeting, 'héllo 🚀 日本語')

    // Pending request must reject promptly on stop
    const pending = gw.sendDebugRequest('dbg-utf8', 'neverReplies', {})
    await gw.stopDebugSession('dbg-utf8')
    await assert.rejects(pending, /stopped|exited/)
    await gw.dispose()
})

/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kalynt-dap-test-'))
after(() => fs.rm(root, { recursive: true, force: true }))

let bundleCounter = 0
async function loadDebugModule(relPath) {
    const entry = fileURLToPath(new URL(relPath, import.meta.url))
    const outFile = path.join(root, `bundle-${++bundleCounter}.cjs`)
    await build({
        entryPoints: [entry],
        bundle: true,
        outfile: outFile,
        platform: 'node',
        format: 'cjs',
        plugins: [{
            name: 'mock-electron',
            setup(b) {
                b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }))
                b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
                    contents: `
                        export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(root)}, getPath: () => ${JSON.stringify(root)} };
                        export const ipcMain = { handle: () => {} };
                        export class BrowserWindow {}
                    `
                }))
            }
        }]
    })
    return require(outFile)
}

test('QA-21: js-debug-dap discovery supports v1.140.1 release layout and never recommends invalid @vscode/js-debug-dap npm install', async () => {
    const {
        findJsDebugDapServer,
        jsDebugInstallInstructions,
        JS_DEBUG_DAP_RELEASE_VERSION,
        JS_DEBUG_DAP_RELEASE_URL
    } = await loadDebugModule('./adapters.ts')

    const instructions = jsDebugInstallInstructions()
    assert.ok(!instructions.includes('npm install -g @vscode/js-debug-dap'), 'Must not recommend nonexistent npm package')
    assert.ok(instructions.includes(JS_DEBUG_DAP_RELEASE_VERSION))
    assert.ok(instructions.includes(JS_DEBUG_DAP_RELEASE_URL))
    assert.ok(instructions.includes('dapDebugServer.js'))

    // Release archive layout: js-debug/src/dapDebugServer.js
    const fakeHome = path.join(root, 'fake-home')
    const serverFile = path.join(fakeHome, '.kalynt', 'debug-adapters', 'js-debug', 'src', 'dapDebugServer.js')
    await fs.mkdir(path.dirname(serverFile), { recursive: true })
    await fs.writeFile(serverFile, '// mock js-debug-dap\n')

    const foundFromHome = findJsDebugDapServer({ envPath: null, bundledPath: null, homeDir: fakeHome, runtimesDir: '' })
    assert.equal(foundFromHome, serverFile)

    // Discovery via KALYNT_JS_DEBUG_DAP directory or direct file
    const foundFromEnvDir = findJsDebugDapServer({
        envPath: path.join(fakeHome, '.kalynt', 'debug-adapters'),
        bundledPath: null,
        homeDir: path.join(root, 'empty-home'),
        runtimesDir: ''
    })
    assert.equal(foundFromEnvDir, serverFile)

    const foundFromEnvFile = findJsDebugDapServer({
        envPath: serverFile,
        bundledPath: null,
        homeDir: path.join(root, 'empty-home'),
        runtimesDir: ''
    })
    assert.equal(foundFromEnvFile, serverFile)
})

test('QA-21 & QA-22: multi-session js-debug-dap TCP handshake (launch + startDebugging + attach) and DAP scopes(frameId) + nested variable expansion', async () => {
    const { DebugSessionManager, buildLaunchArguments } = await loadDebugModule('./sessions.ts')

    // Verify launch args preserve type:'pwa-node' for js-debug
    const nodeArgs = buildLaunchArguments({ type: 'node', request: 'launch', name: 'Node', program: '/tmp/a.js' }, '/tmp')
    assert.equal(nodeArgs.type, 'pwa-node')
    assert.equal(nodeArgs.console, 'internalConsole')

    // Create a mock js-debug-dap server that enforces the real multi-session TCP protocol:
    // - Accepts parent connection, verifies supportsStartDebuggingRequest & launch/attach type:'pwa-node'
    // - Sends `startDebugging` reverse request to client
    // - Accepts child connection on SAME TCP port with `__pendingTargetId`
    // - Child emits `stopped`, serves `stackTrace`, `scopes(frameId)` (distinct from frameId!), `variables`, `next`, `continue`
    const mockJsDebugServer = path.join(root, 'mock-js-debug-dap.mjs')
    await fs.writeFile(mockJsDebugServer, `
        import net from 'node:net';
        const port = Number(process.argv[2]);
        const host = process.argv[3] || '127.0.0.1';

        function send(socket, msg) {
            const json = JSON.stringify(msg);
            socket.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\\r\\n\\r\\n' + json);
        }

        let seq = 1;
        let stepCount = 0;

        const server = net.createServer((socket) => {
            let buf = Buffer.alloc(0);
            let pendingLaunchSeq = null;
            let isChild = false;

            socket.on('data', (chunk) => {
                buf = Buffer.concat([buf, chunk]);
                for (;;) {
                    const idx = buf.indexOf('\\r\\n\\r\\n');
                    if (idx === -1) return;
                    const m = /Content-Length:\\s*(\\d+)/i.exec(buf.subarray(0, idx).toString('ascii'));
                    if (!m) return;
                    const len = Number(m[1]);
                    const start = idx + 4;
                    if (buf.length < start + len) return;
                    const msg = JSON.parse(buf.subarray(start, start + len).toString('utf8'));
                    buf = buf.subarray(start + len);

                    if (msg.type === 'response') continue;

                    if (msg.command === 'initialize') {
                        if (!msg.arguments?.supportsStartDebuggingRequest) {
                            send(socket, { seq: seq++, type: 'response', request_seq: msg.seq, command: 'initialize', success: false, message: 'Missing supportsStartDebuggingRequest' });
                            socket.destroy();
                            return;
                        }
                        send(socket, { seq: seq++, type: 'response', request_seq: msg.seq, command: 'initialize', success: true, body: { supportsConfigurationDoneRequest: true } });
                        send(socket, { seq: seq++, type: 'event', event: 'initialized' });
                    } else if (msg.command === 'launch' || msg.command === 'attach') {
                        if (msg.arguments?.type !== 'pwa-node') {
                            send(socket, { seq: seq++, type: 'response', request_seq: msg.seq, command: msg.command, success: false, message: 'Expected type=pwa-node' });
                            socket.destroy();
                            return;
                        }
                        pendingLaunchSeq = msg.seq;
                        isChild = Boolean(msg.arguments?.__pendingTargetId);
                        if (!isChild) {
                            // Parent binder triggers child session via startDebugging
                            send(socket, {
                                seq: seq++,
                                type: 'request',
                                command: 'startDebugging',
                                arguments: {
                                    request: msg.command,
                                    configuration: {
                                        type: 'pwa-node',
                                        name: 'Node child target',
                                        __pendingTargetId: 'target-' + msg.command
                                    }
                                }
                            });
                        }
                    } else if (msg.command === 'setBreakpoints') {
                        send(socket, {
                            seq: seq++, type: 'response', request_seq: msg.seq, command: 'setBreakpoints', success: true,
                            body: { breakpoints: (msg.arguments?.breakpoints || []).map(b => ({ verified: true, line: b.line })) }
                        });
                    } else if (msg.command === 'configurationDone') {
                        send(socket, { seq: seq++, type: 'response', request_seq: msg.seq, command: 'configurationDone', success: true });
                        if (pendingLaunchSeq !== null) {
                            send(socket, { seq: seq++, type: 'response', request_seq: pendingLaunchSeq, command: 'launch', success: true });
                            pendingLaunchSeq = null;
                        }
                        if (isChild) {
                            setTimeout(() => {
                                send(socket, { seq: seq++, type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 7 } });
                            }, 20);
                        }
                    } else if (msg.command === 'stackTrace') {
                        send(socket, {
                            seq: seq++, type: 'response', request_seq: msg.seq, command: 'stackTrace', success: true,
                            body: {
                                stackFrames: [
                                    { id: 1001, name: 'innerFn', line: 10 + stepCount, column: 1, source: { path: '/ws/app.js' } },
                                    { id: 1002, name: 'outerFn', line: 2, column: 1, source: { path: '/ws/app.js' } }
                                ]
                            }
                        });
                    } else if (msg.command === 'scopes') {
                        const frameId = msg.arguments?.frameId;
                        const scopes = frameId === 1001
                            ? [
                                { name: 'Locals', variablesReference: 5001, expensive: false },
                                { name: 'Globals', variablesReference: 5002, expensive: true }
                            ]
                            : [{ name: 'Locals', variablesReference: 5010, expensive: false }];
                        send(socket, { seq: seq++, type: 'response', request_seq: msg.seq, command: 'scopes', success: true, body: { scopes } });
                    } else if (msg.command === 'variables') {
                        const ref = msg.arguments?.variablesReference;
                        if (ref === 1001 || ref === 1002) {
                            send(socket, { seq: seq++, type: 'response', request_seq: msg.seq, command: 'variables', success: false, message: 'frameId passed as variablesReference!' });
                            continue;
                        }
                        const map = {
                            5001: [
                                { name: 'count', value: String(42 + stepCount), type: 'number', variablesReference: 0 },
                                { name: 'user', value: '{ name: "Ada" }', type: 'Object', variablesReference: 6001 }
                            ],
                            5002: [{ name: 'process', value: 'Process', type: 'Object', variablesReference: 0 }],
                            5010: [{ name: 'outerVal', value: '"hello"', type: 'string', variablesReference: 0 }],
                            6001: [{ name: 'name', value: '"Ada"', type: 'string', variablesReference: 0 }]
                        };
                        send(socket, { seq: seq++, type: 'response', request_seq: msg.seq, command: 'variables', success: true, body: { variables: map[ref] || [] } });
                    } else if (msg.command === 'next') {
                        stepCount++;
                        send(socket, { seq: seq++, type: 'response', request_seq: msg.seq, command: 'next', success: true });
                        send(socket, { seq: seq++, type: 'event', event: 'stopped', body: { reason: 'step', threadId: 7 } });
                    } else if (msg.command === 'disconnect') {
                        send(socket, { seq: seq++, type: 'response', request_seq: msg.seq, command: 'disconnect', success: true });
                        socket.end();
                    }
                }
            });
        });

        server.listen(port, host);
    `)

    const prevEnv = process.env.KALYNT_JS_DEBUG_DAP
    process.env.KALYNT_JS_DEBUG_DAP = mockJsDebugServer

    const events = []
    const fakeWindow = {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: (ch, data) => events.push({ ch, data }) }
    }
    const ws = path.join(root, 'node-ws')
    await fs.mkdir(ws, { recursive: true })
    const appJs = path.join(ws, 'app.js')
    await fs.writeFile(appJs, 'console.log(1)\n')

    const mgr = new DebugSessionManager(() => fakeWindow)
    try {
        // 1. Launch flow
        const sessionId = await mgr.startSession(
            { type: 'node', request: 'launch', name: 'Node launch', program: appJs },
            ws,
            appJs,
            [{ file: appJs, lines: [10] }]
        )

        // Wait for child stopped event
        for (let i = 0; i < 40 && !events.some(e => e.ch === 'debug:stopped'); i++) {
            await new Promise(r => setTimeout(r, 25))
        }
        assert.ok(events.some(e => e.ch === 'debug:stopped'), 'Child js-debug target must emit stopped event')

        // Stack trace from child session
        const stack = await mgr.getCallStack(sessionId, 7)
        assert.equal(stack.length, 2)
        assert.equal(stack[0].id, 1001)

        // QA-22: getScopes(sessionId, frameId) returns real variablesReference values
        const scopesFrame0 = await mgr.getScopes(sessionId, 1001)
        assert.equal(scopesFrame0.length, 2)
        assert.equal(scopesFrame0[0].name, 'Locals')
        assert.equal(scopesFrame0[0].variablesReference, 5001)
        assert.equal(scopesFrame0[1].name, 'Globals')
        assert.equal(scopesFrame0[1].variablesReference, 5002)

        // Variables for Locals & expand nested object
        const locals = await mgr.getVariables(sessionId, scopesFrame0[0].variablesReference)
        assert.equal(locals.find(v => v.name === 'count')?.value, '42')
        const userRef = locals.find(v => v.name === 'user')?.variablesReference
        assert.equal(userRef, 6001)
        const userProps = await mgr.getVariables(sessionId, userRef)
        assert.equal(userProps[0].name, 'name')
        assert.equal(userProps[0].value, '"Ada"')

        // Switch frame -> different scopes & variables
        const scopesFrame1 = await mgr.getScopes(sessionId, 1002)
        assert.equal(scopesFrame1[0].variablesReference, 5010)
        const outerVars = await mgr.getVariables(sessionId, 5010)
        assert.equal(outerVars[0].name, 'outerVal')

        // Step over -> updated variable value
        await mgr.control(sessionId, 'next', 7)
        const afterStepLocals = await mgr.getVariables(sessionId, 5001)
        assert.equal(afterStepLocals.find(v => v.name === 'count')?.value, '43')

        await mgr.stopSession(sessionId)

        // 2. Attach flow
        events.length = 0
        const attachId = await mgr.startSession(
            { type: 'node', request: 'attach', name: 'Node attach', port: 9229 },
            ws
        )
        for (let i = 0; i < 40 && !events.some(e => e.ch === 'debug:stopped'); i++) {
            await new Promise(r => setTimeout(r, 25))
        }
        assert.ok(events.some(e => e.ch === 'debug:stopped'), 'Attach child target must emit stopped event')
        await mgr.stopSession(attachId)

        // 3. Early adapter failure surfaces lifecycle phase + stderr detail (not bare "The debugger stopped")
        const crashingAdapter = path.join(root, 'crash-js-debug.mjs')
        await fs.writeFile(crashingAdapter, `
            import net from 'node:net';
            const port = Number(process.argv[2]);
            const server = net.createServer((socket) => {
                socket.once('data', () => {
                    process.stderr.write('EADDRINUSE: target port unavailable\\n');
                    socket.destroy();
                    setTimeout(() => process.exit(1), 10);
                });
            });
            server.listen(port, '127.0.0.1');
        `)
        process.env.KALYNT_JS_DEBUG_DAP = crashingAdapter
        await assert.rejects(
            mgr.startSession({ type: 'node', request: 'launch', name: 'Crash test', program: appJs }, ws),
            (err) => {
                assert.match(err.message, /initialize/i)
                assert.match(err.message, /EADDRINUSE|socket closed|exited/i)
                return true
            }
        )
    } finally {
        if (prevEnv === undefined) delete process.env.KALYNT_JS_DEBUG_DAP
        else process.env.KALYNT_JS_DEBUG_DAP = prevEnv
    }
})

test('QA-22: setupDebugHandlers registers debug:getScopes IPC channel', async () => {
    const { setupDebugHandlers } = await loadDebugModule('../debug.ts')
    const handlers = new Map()
    const fakeIpc = { handle: (ch, fn) => handlers.set(ch, fn) }
    setupDebugHandlers(fakeIpc, () => null, () => root)
    assert.equal(handlers.has('debug:getScopes'), true)
    const missingRes = await handlers.get('debug:getScopes')({}, 'nonexistent-session', 1)
    assert.equal(missingRes.success, false)
    assert.match(missingRes.error, /not found/i)
})

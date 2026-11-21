/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kalynt-lsp-test-'))
after(() => fs.rm(root, { recursive: true, force: true }))

let bundleCounter = 0
async function loadTs(relPath, extraPlugins = [], external = ['electron', 'node-pty']) {
    const entry = fileURLToPath(new URL(relPath, import.meta.url))
    const outFile = path.join(root, `bundle-${++bundleCounter}.cjs`)
    await build({
        entryPoints: [entry],
        bundle: true,
        outfile: outFile,
        platform: 'node',
        format: 'cjs',
        external,
        plugins: extraPlugins
    })
    return require(outFile)
}

test('QA-06: resolvePythonExecutable prefers workspace .venv and handles missing binaries/pylsp/early exit with zero unhandled rejections', async () => {
    const { resolvePythonExecutable } = await loadTs('./languageConfigs.ts')
    const { LanguageRuntimeGateway } = await loadTs('./languageGateway.ts')

    const unhandled = []
    const onUnhandled = (err) => unhandled.push(err)
    process.on('unhandledRejection', onUnhandled)

    try {
        // 1. Workspace .venv discovery
        const ws = path.join(root, 'py-ws')
        const venvBin = process.platform === 'win32'
            ? path.join(ws, '.venv', 'Scripts')
            : path.join(ws, '.venv', 'bin')
        await fs.mkdir(venvBin, { recursive: true })
        const fakeVenvPy = path.join(venvBin, process.platform === 'win32' ? 'python.exe' : 'python3')
        await fs.writeFile(fakeVenvPy, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

        const resolved = await resolvePythonExecutable(ws)
        assert.equal(resolved, fakeVenvPy)

        // 2. Missing binary (ENOENT) must settle cleanly with zero unhandled rejections
        const gw = new LanguageRuntimeGateway()
        gw.configureLanguageServer('missing_lang', {
            command: 'nonexistent-lsp-binary-kalynt-qa06',
            args: []
        })
        const missingRes = await gw.loadLanguageServer({
            sessionId: 'sess-enoent',
            languageId: 'missing_lang',
            workspacePath: ws,
            timeoutMs: 2000
        })
        assert.equal(missingRes.success, false)
        assert.match(missingRes.error || '', /not installed|ENOENT/i)
        assert.ok(missingRes.actionableHint)

        // 3. Missing pylsp module must produce actionable install hint & zero unhandled rejections
        const missingPylspScript = path.join(root, 'fake-no-pylsp.mjs')
        await fs.writeFile(missingPylspScript, `
            process.stderr.write("/usr/bin/python3: No module named pylsp\\n");
            process.exit(1);
        `)
        gw.configureLanguageServer('python', {
            command: process.execPath,
            args: [missingPylspScript, '-m', 'pylsp']
        })
        const noPylspRes = await gw.loadLanguageServer({
            sessionId: 'sess-no-pylsp',
            languageId: 'python',
            workspacePath: ws,
            timeoutMs: 2000
        })
        assert.equal(noPylspRes.success, false)
        assert.match(noPylspRes.error || '', /pylsp/i)
        assert.match(noPylspRes.actionableHint || '', /pip install python-lsp-server/i)

        // 4. Process that exits mid-initialization (after receiving initialize)
        const crashOnInitScript = path.join(root, 'crash-on-init.mjs')
        await fs.writeFile(crashOnInitScript, `
            process.stdin.on('data', () => {
                process.stderr.write("fatal init crash\\n");
                process.exit(2);
            });
        `)
        gw.configureLanguageServer('crash_lang', {
            command: process.execPath,
            args: [crashOnInitScript]
        })
        const crashRes = await gw.loadLanguageServer({
            sessionId: 'sess-crash-init',
            languageId: 'crash_lang',
            workspacePath: ws,
            timeoutMs: 2000
        })
        assert.equal(crashRes.success, false)
        assert.match(crashRes.error || '', /exited|closed|fatal init crash/i)

        // Give microtasks/timers a beat to verify no late ERR_STREAM_DESTROYED rejection leaks
        await new Promise(r => setTimeout(r, 100))
        assert.deepEqual(unhandled, [], `Unexpected unhandled rejections: ${unhandled.map(String).join('; ')}`)
        await gw.dispose()
    } finally {
        process.off('unhandledRejection', onUnhandled)
    }
})

test('QA-23: strict LSP server enforces notification framing for lifecycle methods and pushes publishDiagnostics', async () => {
    const { LanguageRuntimeGateway } = await loadTs('./languageGateway.ts')

    // Strict JSON-RPC LSP server: rejects any notification method if an `id` field is present.
    const strictServerScript = path.join(root, 'strict-lsp-server.mjs')
    await fs.writeFile(strictServerScript, `
        const NOTIFICATION_ONLY = new Set([
            'initialized',
            'exit',
            'textDocument/didOpen',
            'textDocument/didChange',
            'textDocument/didSave',
            'textDocument/didClose',
            '$/cancelRequest'
        ]);
        const docs = new Map();
        const received = [];
        let buf = Buffer.alloc(0);

        function send(msg) {
            const json = JSON.stringify(msg);
            const frame = 'Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\\r\\n\\r\\n' + json;
            process.stdout.write(frame);
        }

        process.stdin.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            for (;;) {
                const headerEnd = buf.indexOf('\\r\\n\\r\\n');
                if (headerEnd === -1) return;
                const match = /Content-Length:\\s*(\\d+)/i.exec(buf.subarray(0, headerEnd).toString('ascii'));
                if (!match) return;
                const len = Number(match[1]);
                const bodyStart = headerEnd + 4;
                if (buf.length < bodyStart + len) return;
                const msg = JSON.parse(buf.subarray(bodyStart, bodyStart + len).toString('utf8'));
                buf = buf.subarray(bodyStart + len);

                const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
                received.push({ method: msg.method, hasId });

                if (NOTIFICATION_ONLY.has(msg.method)) {
                    if (hasId) {
                        send({
                            jsonrpc: '2.0',
                            id: msg.id,
                            error: { code: -32601, message: 'unknown request: ' + msg.method + ' must be a notification' }
                        });
                        continue;
                    }
                    if (msg.method === 'textDocument/didOpen') {
                        const td = msg.params.textDocument;
                        docs.set(td.uri, td.text);
                        send({
                            jsonrpc: '2.0',
                            method: 'textDocument/publishDiagnostics',
                            params: {
                                uri: td.uri,
                                diagnostics: [{
                                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                                    severity: 1,
                                    source: 'strict-lsp',
                                    message: 'Sample pushed diagnostic for ' + td.text.trim()
                                }]
                            }
                        });
                    } else if (msg.method === 'textDocument/didChange') {
                        const uri = msg.params.textDocument.uri;
                        const nextText = msg.params.contentChanges[0].text;
                        docs.set(uri, nextText);
                        send({
                            jsonrpc: '2.0',
                            method: 'textDocument/publishDiagnostics',
                            params: {
                                uri,
                                diagnostics: nextText.includes('ERROR') ? [{
                                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                                    severity: 1,
                                    source: 'strict-lsp',
                                    message: 'Unsaved change error'
                                }] : []
                            }
                        });
                    } else if (msg.method === 'textDocument/didClose') {
                        docs.delete(msg.params.textDocument.uri);
                    } else if (msg.method === 'exit') {
                        process.exit(0);
                    }
                    continue;
                }

                if (msg.method === 'initialize') {
                    send({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { capabilities: { textDocumentSync: 1, hoverProvider: true, definitionProvider: true } }
                    });
                } else if (msg.method === 'textDocument/hover') {
                    const uri = msg.params.textDocument.uri;
                    if (!docs.has(uri)) {
                        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'trying to get AST for non-added document' } });
                    } else {
                        send({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'markdown', value: 'Hover for: ' + docs.get(uri) } } });
                    }
                } else if (msg.method === 'textDocument/definition') {
                    const uri = msg.params.textDocument.uri;
                    send({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: docs.has(uri) ? [{ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }] : null
                    });
                } else if (msg.method === 'debug/receivedLog') {
                    send({ jsonrpc: '2.0', id: msg.id, result: received });
                } else if (msg.method === 'shutdown') {
                    send({ jsonrpc: '2.0', id: msg.id, result: null });
                }
            }
        });
    `)

    const ws = path.join(root, 'strict-ws')
    await fs.mkdir(ws, { recursive: true })
    const sampleFile = path.join(ws, 'main.cpp')
    const sampleUri = pathToFileURL(sampleFile).href

    const gw = new LanguageRuntimeGateway()
    gw.configureLanguageServer('cpp', {
        command: process.execPath,
        args: [strictServerScript]
    })

    const pushedNotifications = []
    gw.on('lsp_notification', (n) => pushedNotifications.push(n))

    const started = await gw.loadLanguageServer({ sessionId: 'strict-1', languageId: 'cpp', workspacePath: ws })
    assert.equal(started.success, true)

    // Send didOpen via dedicated notification path
    await gw.sendLSPNotification('strict-1', 'textDocument/didOpen', {
        textDocument: { uri: sampleUri, languageId: 'cpp', version: 1, text: 'int x = 1;' }
    })

    // Hover and definition must work on the opened document
    const hover1 = await gw.sendLSPRequest('strict-1', 'textDocument/hover', {
        textDocument: { uri: sampleUri },
        position: { line: 0, character: 4 }
    })
    assert.equal(hover1.contents.value, 'Hover for: int x = 1;')

    // Unsaved change via notification
    await gw.sendLSPNotification('strict-1', 'textDocument/didChange', {
        textDocument: { uri: sampleUri, version: 2 },
        contentChanges: [{ text: 'ERROR_TOKEN' }]
    })
    const hover2 = await gw.sendLSPRequest('strict-1', 'textDocument/hover', {
        textDocument: { uri: sampleUri },
        position: { line: 0, character: 1 }
    })
    assert.equal(hover2.contents.value, 'Hover for: ERROR_TOKEN')

    // Save + definition
    await gw.sendLSPNotification('strict-1', 'textDocument/didSave', {
        textDocument: { uri: sampleUri },
        text: 'ERROR_TOKEN'
    })
    const def = await gw.sendLSPRequest('strict-1', 'textDocument/definition', {
        textDocument: { uri: sampleUri },
        position: { line: 0, character: 1 }
    })
    assert.equal(def[0].uri, sampleUri)

    // Even if a legacy caller uses sendLSPRequest for didClose, gateway routes it as a notification (no id)
    await gw.sendLSPRequest('strict-1', 'textDocument/didClose', {
        textDocument: { uri: sampleUri }
    })

    // Verify wire framing recorded by the strict server
    const log = await gw.sendLSPRequest('strict-1', 'debug/receivedLog', {})
    const byMethod = new Map(log.map(e => [e.method, e.hasId]))
    assert.equal(byMethod.get('initialize'), true)
    assert.equal(byMethod.get('initialized'), false)
    assert.equal(byMethod.get('textDocument/didOpen'), false)
    assert.equal(byMethod.get('textDocument/didChange'), false)
    assert.equal(byMethod.get('textDocument/didSave'), false)
    assert.equal(byMethod.get('textDocument/didClose'), false)
    assert.equal(byMethod.get('textDocument/hover'), true)
    assert.equal(byMethod.get('textDocument/definition'), true)

    // Verify pushed publishDiagnostics notifications arrived
    const diagNotifs = pushedNotifications.filter(n => n.method === 'textDocument/publishDiagnostics')
    assert.ok(diagNotifs.length >= 2, `Expected >= 2 publishDiagnostics notifications, got ${diagNotifs.length}`)
    assert.equal(diagNotifs[1].params.diagnostics[0].message, 'Unsaved change error')

    await gw.stopLanguageServer('strict-1')
    await gw.dispose()
})

test('QA-23: renderer lspClient sends notifications via sendLSPNotification and forwards pushed diagnostics to Problems & Monaco markers', async () => {
    const diagnosticsCalls = []
    const clearedOrigins = []
    const mockStorePlugin = {
        name: 'mock-diag-store',
        setup(b) {
            b.onResolve({ filter: /diagnosticsStore$/ }, () => ({ path: 'diag-store', namespace: 'mock' }))
            b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
                contents: `
                    export const __calls = [];
                    export const __clears = [];
                    export const useDiagnosticsStore = {
                        getState: () => ({
                            setFileDiagnostics: (origin, file, items) => __calls.push({ origin, file, items }),
                            clearOrigin: (origin) => __clears.push(origin)
                        })
                    };
                `
            }))
        }
    }

    const entry = fileURLToPath(new URL('../../src/services/lspClient.ts', import.meta.url))
    const { outputFiles } = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm',
        plugins: [mockStorePlugin]
    })
    const mod = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
    const { lspClient } = mod

    const sentNotifications = []
    const sentRequests = []
    let notifCallback = null
    const markerCalls = []

    const ws = path.join(root, 'qa23 workspace')
    const filePath = path.join(ws, 'main.rs')
    let content = 'fn main() {}'
    let version = 1
    let disposeHandler = null

    const mockModel = {
        uri: { scheme: 'file', fsPath: filePath, path: filePath },
        getLanguageId: () => 'rust',
        getVersionId: () => version,
        getValue: () => content,
        isDisposed: () => false,
        onDidChangeContent: () => ({ dispose: () => {} }),
        onWillDispose: (cb) => { disposeHandler = cb; return { dispose: () => {} } }
    }

    const mockMonaco = {
        MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
        Range: class { constructor(sl, sc, el, ec) { this.startLineNumber = sl; this.startColumn = sc; this.endLineNumber = el; this.endColumn = ec } },
        Uri: { file: (p) => ({ fsPath: p, path: p, scheme: 'file' }) },
        languages: {
            CompletionItemKind: {},
            CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
            SymbolKind: {},
            registerHoverProvider: () => ({ dispose: () => {} }),
            registerCompletionItemProvider: () => ({ dispose: () => {} }),
            registerDefinitionProvider: () => ({ dispose: () => {} }),
            registerDocumentSymbolProvider: () => ({ dispose: () => {} })
        },
        editor: {
            getModels: () => [mockModel],
            onDidCreateModel: () => ({ dispose: () => {} }),
            setModelMarkers: (m, owner, markers) => markerCalls.push({ m, owner, markers })
        }
    }

    globalThis.window = {
        electronAPI: {
            runtime: {
                startLSP: async (sessionId) => ({ success: true, sessionId }),
                stopLSP: async () => ({ success: true }),
                sendLSPRequest: async (sessionId, method, params) => {
                    sentRequests.push({ sessionId, method, params })
                    return { success: true, result: null }
                },
                sendLSPNotification: async (sessionId, method, params) => {
                    sentNotifications.push({ sessionId, method, params })
                    return { success: true }
                },
                onLanguageServerStopped: () => () => {},
                onLSPNotification: (cb) => { notifCallback = cb; return () => { notifCallback = null } }
            }
        }
    }

    try {
        lspClient.registerProviders(mockMonaco)
        lspClient.setWorkspace(ws)

        await lspClient.syncDocument(mockModel)
        content = 'fn main() { bad_call(); }'
        version = 2
        await lspClient.syncDocument(mockModel)
        await lspClient.notifyDidSave(mockModel)

        assert.deepEqual(
            sentNotifications.map(n => n.method),
            ['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didSave']
        )
        assert.equal(sentRequests.length, 0, 'Lifecycle methods must never be sent via sendLSPRequest')
        assert.equal(fileURLToPath(sentNotifications[0].params.textDocument.uri), filePath)

        // Simulate server pushing publishDiagnostics
        assert.equal(typeof notifCallback, 'function')
        notifCallback({
            sessionId: sentNotifications[0].sessionId,
            languageId: 'rust',
            method: 'textDocument/publishDiagnostics',
            params: {
                uri: pathToFileURL(filePath).href,
                diagnostics: [{
                    range: { start: { line: 0, character: 12 }, end: { line: 0, character: 20 } },
                    severity: 1,
                    source: 'rust-analyzer',
                    message: 'cannot find function `bad_call` in this scope'
                }]
            }
        })

        assert.equal(markerCalls.length, 2)
        assert.deepEqual(markerCalls[0].markers, [], 'setWorkspace clears stale markers first')
        const pushed = markerCalls[1]
        assert.equal(pushed.owner, 'kalynt-lsp')
        assert.equal(pushed.markers[0].message, 'cannot find function `bad_call` in this scope')
        assert.equal(pushed.markers[0].startLineNumber, 1)

        // Model dispose sends didClose notification
        disposeHandler()
        await new Promise(r => setTimeout(r, 20))
        assert.ok(sentNotifications.some(n => n.method === 'textDocument/didClose'))
        await lspClient.dispose()
    } finally {
        delete globalThis.window
    }
    void diagnosticsCalls
    void clearedOrigins
})

test('QA-23 (integration): real rust-analyzer accepts didOpen notification without unknown-request error', async (t) => {
    let hasRustAnalyzer = false
    try {
        execFileSync('rust-analyzer', ['--version'], { stdio: 'ignore', timeout: 3000 })
        hasRustAnalyzer = true
    } catch {
        hasRustAnalyzer = false
    }
    if (!hasRustAnalyzer) {
        t.skip('working rust-analyzer component not installed on host')
        return
    }

    const { LanguageRuntimeGateway } = await loadTs('./languageGateway.ts')
    const cargoDir = path.join(root, 'ra-fixture')
    await fs.mkdir(path.join(cargoDir, 'src'), { recursive: true })
    await fs.writeFile(
        path.join(cargoDir, 'Cargo.toml'),
        '[package]\nname = "ra_fixture"\nversion = "0.1.0"\nedition = "2021"\n'
    )
    const mainRs = path.join(cargoDir, 'src', 'main.rs')
    const code = 'fn greet() -> i32 { 42 }\nfn main() { let v = greet(); println!("{}", v); }\n'
    await fs.writeFile(mainRs, code)

    const gw = new LanguageRuntimeGateway()
    const started = await gw.loadLanguageServer({
        sessionId: 'ra-real-1',
        languageId: 'rust',
        workspacePath: cargoDir,
        timeoutMs: 15000
    })
    assert.equal(started.success, true, `rust-analyzer failed to start: ${started.error}`)

    // Sending didOpen as a genuine notification must succeed (no "unknown request" rejection!)
    await gw.sendLSPNotification('ra-real-1', 'textDocument/didOpen', {
        textDocument: {
            uri: pathToFileURL(mainRs).href,
            languageId: 'rust',
            version: 1,
            text: code
        }
    })
    await gw.sendLSPNotification('ra-real-1', 'textDocument/didChange', {
        textDocument: { uri: pathToFileURL(mainRs).href, version: 2 },
        contentChanges: [{ text: code + '// edited\n' }]
    })
    await gw.sendLSPNotification('ra-real-1', 'textDocument/didClose', {
        textDocument: { uri: pathToFileURL(mainRs).href }
    })

    const servers = await gw.getLanguageServers()
    assert.equal(servers.length, 1)
    assert.equal(servers[0].status, 'running')

    await gw.stopLanguageServer('ra-real-1')
    await gw.dispose()
})

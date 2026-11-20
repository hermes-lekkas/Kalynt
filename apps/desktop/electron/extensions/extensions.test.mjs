/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

async function loadTs(relPath) {
    const entry = fileURLToPath(new URL(relPath, import.meta.url))
    const { outputFiles } = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm',
        external: ['electron']
    })
    return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kalynt-ext-test-'))
after(() => fs.rm(root, { recursive: true, force: true }))

test('extensionRegistry: declarative extensions keep main undefined instead of defaulting to index.js', async () => {
    const { readMetadata } = await loadTs('./extensionRegistry.ts')

    const themeDir = path.join(root, 'pub.my-theme')
    await fs.mkdir(themeDir, { recursive: true })
    await fs.writeFile(path.join(themeDir, 'package.json'), JSON.stringify({
        name: 'my-theme',
        publisher: 'pub',
        version: '1.0.0',
        engines: { vscode: '^1.80.0' },
        contributes: { themes: [{ label: 'My Dark', uiTheme: 'vs-dark', path: './theme.json' }] }
    }))

    const meta = readMetadata(themeDir)
    assert.ok(meta)
    assert.equal(meta.main, undefined)

    const codeDir = path.join(root, 'pub.my-ext')
    await fs.mkdir(codeDir, { recursive: true })
    await fs.writeFile(path.join(codeDir, 'package.json'), JSON.stringify({
        name: 'my-ext',
        publisher: 'pub',
        version: '1.0.0',
        main: './dist/extension.js',
        engines: { vscode: '^1.80.0' }
    }))
    const codeMeta = readMetadata(codeDir)
    assert.equal(codeMeta.main, './dist/extension.js')
})

test('vscodeApiShim: command round-trip, core primitives, workspaceFolders, outputChannel, statusBarItem, and Memento', async () => {
    const { createVSCodeAPI, createMemento, Uri, Range, Position } = await loadTs('./vscodeApiShim.ts')

    const sent = []
    const handlers = new Map()
    const pendingResponses = new Map()
    let nextId = 1

    const context = {
        subscriptions: [],
        extensionPath: root,
        globalState: createMemento(path.join(root, 'global', 'state.json')),
        workspaceState: createMemento(path.join(root, 'ws', 'state.json'))
    }

    const vscode = createVSCodeAPI('pub.demo', context, {
        sendMessage: (msg) => {
            sent.push(msg)
            // Simulate main process forwarding execute-command back into handler
            if (msg.type === 'execute-command') {
                const { command, args, messageId } = msg.payload
                assert.equal(typeof messageId, 'number')
                const fn = handlers.get(command)
                const pending = pendingResponses.get(messageId)
                pendingResponses.delete(messageId)
                Promise.resolve(fn ? fn(...args) : undefined).then(res => pending.resolve(res), err => pending.reject(err))
            }
        },
        nextMessageId: () => nextId++,
        pendingResponses,
        registerCommandHandler: (_extId, cmd, cb) => handlers.set(cmd, cb),
        unregisterCommandHandler: (_extId, cmd) => handlers.delete(cmd),
        getRegisteredCommands: () => Array.from(handlers.keys()),
        getWorkspaceFolders: () => [{ uri: Uri.file(root), name: 'ws', index: 0 }]
    })

    // Command registration & execution round-trip
    const disp = vscode.commands.registerCommand('demo.add', (a, b) => a + b)
    assert.equal(await vscode.commands.executeCommand('demo.add', 2, 3), 5)
    disp.dispose()
    assert.equal(handlers.has('demo.add'), false)
    assert.ok(sent.some(m => m.type === 'unregister-command' && m.payload.command === 'demo.add'))

    // Core primitives
    const diag = new vscode.Diagnostic(new Range(new Position(0, 0), new Position(0, 5)), 'oops', vscode.DiagnosticSeverity.Warning)
    assert.equal(diag.message, 'oops')
    assert.equal(diag.severity, 1)

    const item = new vscode.CompletionItem('hello', vscode.CompletionItemKind.Function)
    assert.equal(item.label, 'hello')
    assert.equal(item.kind, 2)

    const tree = new vscode.TreeItem('Node', vscode.TreeItemCollapsibleState.Collapsed)
    assert.equal(tree.label, 'Node')
    assert.equal(tree.collapsibleState, 1)

    const cts = new vscode.CancellationTokenSource()
    let cancelledFired = false
    cts.token.onCancellationRequested(() => { cancelledFired = true })
    assert.equal(cts.token.isCancellationRequested, false)
    cts.cancel()
    assert.equal(cts.token.isCancellationRequested, true)
    assert.equal(cancelledFired, true)

    // workspace.onDidChangeConfiguration is an Event function & workspaceFolders works
    assert.equal(typeof vscode.workspace.onDidChangeConfiguration, 'function')
    let cfgAffected = false
    vscode.workspace.onDidChangeConfiguration((e) => { cfgAffected = e.affectsConfiguration('demo.enabled') })
    const cfg = vscode.workspace.getConfiguration('demo')
    await cfg.update('enabled', true)
    assert.equal(cfg.get('enabled'), true)
    assert.equal(cfgAffected, true)
    assert.equal(vscode.workspace.workspaceFolders[0].name, 'ws')

    // OutputChannel & StatusBarItem
    const out = vscode.window.createOutputChannel('Demo')
    out.appendLine('hello channel')
    assert.ok(sent.some(m => m.type === 'log-message' && m.payload.channel === 'Demo'))

    const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    sb.text = '$(check) Ready'
    sb.show()
    assert.ok(sent.some(m => m.type === 'status-bar-update' && m.payload.text === '$(check) Ready'))
    sb.dispose()
    assert.ok(sent.some(m => m.type === 'status-bar-dispose'))

    // Memento persistence
    await context.globalState.update('count', 42)
    const reloaded = createMemento(path.join(root, 'global', 'state.json'))
    assert.equal(reloaded.get('count'), 42)
    assert.deepEqual(reloaded.keys(), ['count'])
})

test('marketplaceService: uses Open VSX files.download and maps allVersions', async () => {
    const entry = fileURLToPath(new URL('../../src/services/extensions/marketplaceService.ts', import.meta.url))
    const { outputFiles } = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm'
    })
    const { marketplaceService } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)

    const originalFetch = globalThis.fetch
    try {
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                namespace: 'rust-lang',
                name: 'rust-analyzer',
                version: '0.4.2000',
                displayName: 'rust-analyzer',
                description: 'Rust LSP',
                allVersions: {
                    latest: 'https://open-vsx.org/api/rust-lang/rust-analyzer/0.4.2000',
                    '0.4.2000': 'https://open-vsx.org/api/rust-lang/rust-analyzer/0.4.2000',
                    '0.4.1999': 'https://open-vsx.org/api/rust-lang/rust-analyzer/0.4.1999'
                },
                files: {
                    download: 'https://open-vsx.org/api/rust-lang/rust-analyzer/linux-x64/0.4.2000/file/rust-lang.rust-analyzer-0.4.2000@linux-x64.vsix'
                }
            })
        })

        marketplaceService.clearCache()
        const details = await marketplaceService.getExtensionDetails('rust-lang', 'rust-analyzer')
        assert.deepEqual(details.versions.map(v => v.version), ['0.4.2000', '0.4.1999'])
        const dlUrl = await marketplaceService.getActualDownloadUrl('rust-lang', 'rust-analyzer', 'latest')
        assert.equal(dlUrl, 'https://open-vsx.org/api/rust-lang/rust-analyzer/linux-x64/0.4.2000/file/rust-lang.rust-analyzer-0.4.2000@linux-x64.vsix')
    } finally {
        globalThis.fetch = originalFetch
    }
})

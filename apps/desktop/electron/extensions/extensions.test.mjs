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

test('QA-12: examples/test-extension cold-start command discovery, execution, disable/uninstall removal, and reactivation', async () => {
    const extRoot = path.join(root, 'qa12-extensions')
    const storageDir = path.join(root, 'qa12-storage')
    await fs.mkdir(storageDir)
    await fs.symlink(storageDir, extRoot, 'junction')
    const testExtDir = path.join(extRoot, 'kalynt.kalynt-test-extension')
    const testExtOut = path.join(testExtDir, 'out')
    await fs.mkdir(testExtOut, { recursive: true })

    // Copy the real repository example manifest and compile its real TypeScript source
    const repoExampleDir = fileURLToPath(new URL('../../../../examples/test-extension', import.meta.url))
    await fs.copyFile(path.join(repoExampleDir, 'package.json'), path.join(testExtDir, 'package.json'))
    await build({
        entryPoints: [path.join(repoExampleDir, 'src/extension.ts')],
        outfile: path.join(testExtOut, 'example.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['vscode']
    })
    await fs.writeFile(path.join(testExtOut, 'extension.js'), `
        const example = require('./example.cjs')
        exports.activate = example.activate
        exports.deactivate = async () => {
            await new Promise(resolve => setTimeout(resolve, 120))
            example.deactivate()
        }
    `)

    // Compile the real extension host process script into our temp dir
    const hostScriptPath = path.join(root, 'extensionHostProcess.cjs')
    await build({
        entryPoints: [fileURLToPath(new URL('./extensionHostProcess.ts', import.meta.url))],
        outfile: hostScriptPath,
        bundle: true,
        platform: 'node',
        format: 'cjs'
    })

    // Load ExtensionHostManager with minimal Electron & extract-zip stubs
    const { outputFiles } = await build({
        entryPoints: [fileURLToPath(new URL('./extensionHostManager.ts', import.meta.url))],
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm',
        plugins: [{
            name: 'mock-electron',
            setup(b) {
                b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }))
                b.onResolve({ filter: /^extract-zip$/ }, () => ({ path: 'extract-zip', namespace: 'mock' }))
                b.onLoad({ filter: /^electron$/, namespace: 'mock' }, () => ({
                    contents: `export const app = { getPath: () => ${JSON.stringify(root)} }; export const ipcMain = { handle: () => {} }; export const BrowserWindow = { getAllWindows: () => [] };`,
                    loader: 'js'
                }))
                b.onLoad({ filter: /^extract-zip$/, namespace: 'mock' }, () => ({
                    contents: 'export default async function extractZip() {}',
                    loader: 'js'
                }))
            }
        }]
    })
    const { ExtensionHostManager } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)

    const notifications = []
    const manager = new ExtensionHostManager({
        extensionsDir: extRoot,
        hostScriptPath,
        registerIpc: false,
        onNotify: (channel, data) => notifications.push({ channel, data })
    })

    try {
        // 1. Cold start: contributed commands are discoverable before activation
        const coldContributions = manager.getContributions()
        assert.ok(coldContributions.commands.some(c => c.command === 'kalyntTest.hello' && c.title === 'Hello World' && c.category === 'Kalynt Test'))
        assert.ok(coldContributions.commands.some(c => c.command === 'kalyntTest.showDate'))
        assert.equal(manager.getActiveExtensions().length, 0)

        // 2. Executing the command lazily starts the host, activates the extension, and emits "Hello from Kalynt!"
        await manager.executeCommand('kalyntTest.hello')
        // Allow async IPC show-message delivery
        await new Promise(r => setTimeout(r, 80))
        assert.ok(manager.getActiveExtensions().some(e => e.id === 'kalynt.kalynt-test-extension'))
        assert.ok(
            notifications.some(n => n.channel === 'show-message' && n.data?.message === 'Hello from Kalynt!'),
            `Expected "Hello from Kalynt!" notification, got: ${JSON.stringify(notifications)}`
        )

        // 3. Disabling/deactivating removes commands from contributions and blocks execution
        await manager.deactivateExtension('kalynt.kalynt-test-extension')
        assert.equal(manager.getContributions().commands.some(c => c.command === 'kalyntTest.hello'), false)
        await assert.rejects(() => manager.executeCommand('kalyntTest.hello'), /not found|disabled/i)

        // 4. Reactivating restores commands and executes cleanly again
        notifications.length = 0
        await manager.activateExtension('kalynt.kalynt-test-extension')
        assert.ok(manager.getContributions().commands.some(c => c.command === 'kalyntTest.hello'))
        await manager.executeCommand('kalyntTest.hello')
        await new Promise(r => setTimeout(r, 80))
        assert.ok(notifications.some(n => n.channel === 'show-message' && n.data?.message === 'Hello from Kalynt!'))

        // 5. Uninstalling removes commands and files
        await manager.uninstallExtension('kalynt.kalynt-test-extension')
        assert.equal(manager.getContributions().commands.some(c => c.command === 'kalyntTest.hello'), false)
        assert.equal(manager.getExtension('kalynt.kalynt-test-extension'), undefined)
    } finally {
        await manager.stop()
    }
})

test('QA-34: contributed VS Code themes parse JSONC/include, map CSS & Monaco tokens, persist, and fall back on uninstall', async () => {
    const { readMetadata, mergeContributions, loadContributedTheme, parseJsonc } = await loadTs('./extensionRegistry.ts')

    // JSONC parser handles comments, trailing commas, and preserves URLs inside strings
    const parsed = parseJsonc(`{
        // line comment
        "url": "https://example.com//keep",
        /* block comment */
        "colors": { "editor.background": "#282c34", },
    }`)
    assert.equal(parsed.url, 'https://example.com//keep')
    assert.equal(parsed.colors['editor.background'], '#282c34')

    // Create an Atom One Dark style declarative theme extension with JSONC + include
    const themeExtDir = path.join(root, 'akamud.vscode-theme-onedark')
    const themesDir = path.join(themeExtDir, 'themes')
    await fs.mkdir(themesDir, { recursive: true })
    await fs.writeFile(path.join(themeExtDir, 'package.json'), JSON.stringify({
        name: 'vscode-theme-onedark',
        displayName: 'Atom One Dark Theme',
        publisher: 'akamud',
        version: '2.3.0',
        engines: { vscode: '^1.70.0' },
        contributes: {
            themes: [
                {
                    id: 'Atom One Dark',
                    label: 'Atom One Dark',
                    uiTheme: 'vs-dark',
                    path: './themes/OneDark.json'
                }
            ]
        }
    }))
    await fs.writeFile(path.join(themesDir, 'base.json'), `{
        "colors": {
            "sideBar.background": "#21252b",
            "editor.foreground": "#abb2bf"
        },
        "tokenColors": [
            { "scope": "comment", "settings": { "foreground": "#5c6370", "fontStyle": "italic" } }
        ]
    }`)
    await fs.writeFile(path.join(themesDir, 'OneDark.json'), `{
        // Atom One Dark child theme
        "include": "./base.json",
        "colors": {
            "editor.background": "#282c34",
            "focusBorder": "#528bff",
            "panel.border": "#181a1f",
        },
        "tokenColors": [
            { "scope": ["keyword", "storage.type"], "settings": { "foreground": "#c678dd" } },
            { "scope": "string", "settings": { "foreground": "#98c379" } },
            { "scope": "entity.name.function", "settings": { "foreground": "#61afef" } },
        ]
    }`)

    const meta = readMetadata(themeExtDir)
    assert.ok(meta)
    const contributions = mergeContributions([meta])
    assert.equal(contributions.themes.length, 1)
    const entry = contributions.themes[0]
    assert.equal(entry.id, 'akamud.vscode-theme-onedark::Atom One Dark')
    assert.equal(entry.label, 'Atom One Dark')
    assert.equal(entry.uiTheme, 'vs-dark')
    assert.equal(entry.extensionId, 'akamud.vscode-theme-onedark')

    // Disabled extension's themes are excluded
    assert.equal(mergeContributions([meta], new Set(['akamud.vscode-theme-onedark'])).themes.length, 0)

    // Load theme JSONC + include
    const loaded = loadContributedTheme(meta, entry.id)
    assert.ok(loaded)
    assert.equal(loaded.colors['editor.background'], '#282c34')
    assert.equal(loaded.colors['sideBar.background'], '#21252b')
    assert.equal(loaded.tokenColors.length, 4)

    // Path traversal outside extension directory is rejected
    const badMeta = { ...meta, contributes: { themes: [{ label: 'Bad', uiTheme: 'vs-dark', path: '../../etc/passwd' }] } }
    assert.throws(() => loadContributedTheme(badMeta, 'Bad'), /escapes extension directory/i)

    // Test renderer themeService mapping + lifecycle (select, persist, switch back, uninstall fallback)
    const themeServiceEntry = fileURLToPath(new URL('../../src/services/extensions/themeService.ts', import.meta.url))
    let storeState = {
        theme: 'dark',
        resolvedTheme: 'dark',
        extensionTheme: null,
        setTheme(t) {
            this.theme = t
            this.resolvedTheme = t === 'light' ? 'light' : 'dark'
            this.extensionTheme = null
        },
        setExtensionTheme(sel) {
            this.extensionTheme = sel
            if (sel) {
                this.theme = sel.uiTheme === 'vs' || sel.uiTheme === 'hc-light' ? 'light' : 'dark'
                this.resolvedTheme = this.theme
            }
        }
    }
    const toastMessages = []
    let installedThemeAvailable = true

    const { outputFiles: tsOut } = await build({
        entryPoints: [themeServiceEntry],
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm',
        plugins: [{
            name: 'mock-theme-deps',
            setup(b) {
                b.onResolve({ filter: /appStore$/ }, () => ({ path: 'appStore', namespace: 'mock' }))
                b.onResolve({ filter: /notificationStore$/ }, () => ({ path: 'notificationStore', namespace: 'mock' }))
                b.onResolve({ filter: /extensionService$/ }, () => ({ path: 'extensionService', namespace: 'mock' }))
                b.onResolve({ filter: /monacoSetup$/ }, () => ({ path: 'monacoSetup', namespace: 'mock' }))
                b.onLoad({ filter: /^appStore$/, namespace: 'mock' }, () => ({
                    contents: 'export const useAppStore = { getState: () => globalThis.__testAppStore };',
                    loader: 'js'
                }))
                b.onLoad({ filter: /^notificationStore$/, namespace: 'mock' }, () => ({
                    contents: 'export const useNotificationStore = { getState: () => ({ addNotification: (m, t) => globalThis.__testToasts.push({ m, t }) }) };',
                    loader: 'js'
                }))
                b.onLoad({ filter: /^extensionService$/, namespace: 'mock' }, () => ({
                    contents: `export const extensionService = {
                        scanExtensions: async () => [],
                        loadTheme: async () => globalThis.__testThemeLoader(),
                        onContributionsChanged: () => () => {},
                        onInstalledChange: () => () => {},
                        onDeactivated: () => () => {}
                    };`,
                    loader: 'js'
                }))
                b.onLoad({ filter: /^monacoSetup$/, namespace: 'mock' }, () => ({
                    contents: 'export const EDITOR_THEMES = { dark: "kalynt-dark", light: "kalynt-light" }; export const monaco = { editor: { defineTheme: () => {}, setTheme: () => {} } };',
                    loader: 'js'
                }))
            }
        }]
    })

    globalThis.__testAppStore = storeState
    globalThis.__testToasts = toastMessages
    globalThis.__testThemeLoader = () => (installedThemeAvailable ? loaded : null)

    const cssProps = new Map()
    const dataset = {}
    const origDocument = globalThis.document
    globalThis.document = {
        documentElement: {
            dataset,
            style: {
                setProperty: (k, v) => cssProps.set(k, v),
                removeProperty: (k) => cssProps.delete(k)
            }
        }
    }

    try {
        const themeSvc = await import(`data:text/javascript;base64,${Buffer.from(tsOut[0].text).toString('base64')}`)

        // Verify CSS variable mapping & Monaco token mapping
        const vars = themeSvc.mapThemeToCssVariables(loaded)
        assert.equal(vars['--bg'], '#282c34')
        assert.equal(vars['--surface'], '#21252b')
        assert.equal(vars['--text'], '#abb2bf')
        assert.equal(vars['--focus'], '#528bff')

        const monacoData = themeSvc.mapThemeToMonacoData(loaded)
        assert.equal(monacoData.base, 'vs-dark')
        assert.equal(monacoData.colors['editor.background'], '#282c34')
        assert.ok(monacoData.rules.some(r => r.token === 'comment' && r.foreground === '5c6370' && r.fontStyle === 'italic'))
        assert.ok(monacoData.rules.some(r => r.token === 'keyword' && r.foreground === 'c678dd'))
        assert.ok(monacoData.rules.some(r => r.token === 'string' && r.foreground === '98c379'))
        assert.ok(monacoData.rules.some(r => r.token === 'function' && r.foreground === '61afef'))

        // Select extension theme
        const ok = await themeSvc.selectExtensionTheme(entry)
        assert.equal(ok, true)
        assert.equal(storeState.extensionTheme.id, entry.id)
        assert.equal(dataset.theme, 'dark')
        assert.equal(dataset.extensionTheme, entry.id)
        assert.equal(cssProps.get('--bg'), '#282c34')

        // Simulate restart: persisted extensionTheme re-applies cleanly
        cssProps.clear()
        await themeSvc.syncActiveExtensionTheme()
        assert.equal(cssProps.get('--bg'), '#282c34')
        assert.equal(dataset.extensionTheme, entry.id)

        // Uninstall active theme extension -> sync falls back cleanly to built-in Dark and clears CSS overrides
        installedThemeAvailable = false
        await themeSvc.syncActiveExtensionTheme()
        assert.equal(storeState.extensionTheme, null)
        assert.equal(storeState.theme, 'dark')
        assert.equal(dataset.theme, 'dark')
        assert.equal(dataset.extensionTheme, undefined)
        assert.equal(cssProps.size, 0)
        assert.ok(toastMessages.some(t => /no longer available/i.test(t.m)))

        // Switch back to Light manually
        storeState.setTheme('light')
        await themeSvc.restoreBuiltinTheme('light')
        assert.equal(dataset.theme, 'light')
        assert.equal(cssProps.size, 0)
    } finally {
        globalThis.document = origDocument
        delete globalThis.__testAppStore
        delete globalThis.__testToasts
        delete globalThis.__testThemeLoader
    }
})

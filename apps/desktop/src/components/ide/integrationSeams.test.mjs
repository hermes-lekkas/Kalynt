/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { create, act } from 'react-test-renderer'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const storageMap = new Map()
globalThis.localStorage = {
    getItem: key => storageMap.get(key) ?? null,
    setItem: (key, value) => storageMap.set(key, value),
    removeItem: key => storageMap.delete(key)
}
globalThis.window = new EventTarget()
globalThis.Element = class FakeElement { closest() { return null } }

const { outputFiles } = await build({
    stdin: {
        contents: `
            export { useLayoutStore } from '../../stores/layoutStore'
            export { useDiagnosticsStore } from '../../stores/diagnosticsStore'
            export {
                FOCUS_SEARCH_EVENT,
                FOCUS_REPLACE_EVENT,
                focusWorkspaceSearch,
                focusWorkspaceReplace
            } from './hooks/useIdeCommands'
            export { useIdeShortcuts } from './hooks/useIdeShortcuts'
        `,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
        loader: 'ts'
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    banner: { js: `import { createRequire as testCreateRequire } from 'node:module'; const require = testCreateRequire(${JSON.stringify(import.meta.url)});` },
    plugins: [{
        name: 'integration-seams-boundaries',
        setup(b) {
            b.onResolve({ filter: /^react$/ }, args => ({
                path: args.kind === 'require-call' ? require.resolve('react') : pathToFileURL(require.resolve('react')).href,
                external: true
            }))
            b.onLoad({ filter: /components[/\\]ui[/\\]index\.ts$/ }, () => ({
                contents: 'export const hasOpenLayer = () => false',
                loader: 'ts'
            }))
        }
    }]
})

const {
    useLayoutStore,
    FOCUS_SEARCH_EVENT,
    FOCUS_REPLACE_EVENT,
    focusWorkspaceReplace,
    useIdeShortcuts
} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)

let renderer = null
afterEach(async () => {
    if (renderer) {
        await act(async () => { renderer.unmount() })
        renderer = null
    }
    useLayoutStore.setState({ sidebarOpen: true, sidePanel: 'files' })
})

test('layoutStore supports debug and outline panels and keeps them active across editor pref updates', () => {
    const store = useLayoutStore.getState()
    store.showSidePanel('debug')
    assert.equal(useLayoutStore.getState().sidePanel, 'debug')
    assert.equal(useLayoutStore.getState().sidebarOpen, true)

    store.setEditorPref({ tabSize: 4, lineNumbers: 'relative', autoSave: 'afterDelay', fontFamily: 'Fira Code' })
    assert.equal(useLayoutStore.getState().sidePanel, 'debug')

    store.toggleSidePanel('debug')
    assert.equal(useLayoutStore.getState().sidebarOpen, false)

    store.toggleSidePanel('outline')
    assert.equal(useLayoutStore.getState().sidebarOpen, true)
    assert.equal(useLayoutStore.getState().sidePanel, 'outline')

    const persisted = useLayoutStore.persist.getOptions()
    assert.equal(persisted.migrate({ sidePanel: 'corrupt-panel' }, 2).sidePanel, 'files')
    assert.equal(persisted.migrate({ sidePanel: 'debug' }, 2).sidePanel, 'debug')
    assert.equal(persisted.migrate({ sidePanel: 'outline' }, 2).sidePanel, 'outline')
})

test('focusWorkspaceReplace opens search panel and emits only FOCUS_REPLACE_EVENT', () => {
    const events = []
    const onSearch = () => events.push('search')
    const onReplace = () => events.push('replace')
    window.addEventListener(FOCUS_SEARCH_EVENT, onSearch)
    window.addEventListener(FOCUS_REPLACE_EVENT, onReplace)
    try {
        focusWorkspaceReplace()
        assert.equal(useLayoutStore.getState().sidePanel, 'search')
        assert.equal(useLayoutStore.getState().sidebarOpen, true)
        assert.deepEqual(events, ['replace'])
    } finally {
        window.removeEventListener(FOCUS_SEARCH_EVENT, onSearch)
        window.removeEventListener(FOCUS_REPLACE_EVENT, onReplace)
    }
})

test('useIdeShortcuts wires Ctrl+Shift+D, Ctrl+Shift+O, and Ctrl+Shift+H with active guard', async () => {
    const stubActions = {
        files: { files: [], activeFile: null, activePath: null, saveAll: async () => {}, closeMany: async () => true, reopenClosedTab: async () => {}, cycle() {}, selectByIndex() {} },
        runner: { isRunning: false, isBuilding: false, isDebugging: false, run: async () => {}, stopRun() {}, build: async () => {}, stopBuild: async () => {}, startDebug: async () => {}, stopDebug: async () => {}, debugStep: async () => {} },
        folder: '/project',
        canEdit: true,
        openFolder() {},
        closeFolder() {},
        newFile() {},
        saveFocusedFile() {},
        closeFocusedTab() {},
        toggleCurrentBreakpoint() {},
        runEditorAction() {},
        gitPush() {},
        gitPull() {}
    }

    function Harness({ enabled }) {
        useIdeShortcuts(enabled, stubActions)
        return null
    }

    const events = []
    const onSearch = () => events.push('search')
    const onReplace = () => events.push('replace')
    window.addEventListener(FOCUS_SEARCH_EVENT, onSearch)
    window.addEventListener(FOCUS_REPLACE_EVENT, onReplace)

    const fireKey = (key) => {
        const ev = new Event('keydown', { cancelable: true })
        Object.assign(ev, { ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key, code: `Key${key.toUpperCase()}` })
        window.dispatchEvent(ev)
        return ev
    }

    try {
        await act(async () => { renderer = create(React.createElement(Harness, { enabled: true })) })

        assert.equal(fireKey('d').defaultPrevented, true)
        assert.equal(useLayoutStore.getState().sidePanel, 'debug')

        assert.equal(fireKey('o').defaultPrevented, true)
        assert.equal(useLayoutStore.getState().sidePanel, 'outline')

        assert.equal(fireKey('h').defaultPrevented, true)
        assert.equal(useLayoutStore.getState().sidePanel, 'search')
        assert.deepEqual(events, ['replace'])

        // Disabled workspace must ignore Ctrl+Shift+D / O / H
        await act(async () => { renderer.update(React.createElement(Harness, { enabled: false })) })
        assert.equal(fireKey('d').defaultPrevented, false)
        assert.equal(useLayoutStore.getState().sidePanel, 'search')
    } finally {
        window.removeEventListener(FOCUS_SEARCH_EVENT, onSearch)
        window.removeEventListener(FOCUS_REPLACE_EVENT, onReplace)
    }
})

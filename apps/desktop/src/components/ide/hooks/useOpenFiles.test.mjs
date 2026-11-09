/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { create, act } from 'react-test-renderer'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const require = createRequire(import.meta.url)
const values = new Map()
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
globalThis.window = new EventTarget()
const { outputFiles } = await build({
    stdin: { contents: "export { useOpenFiles } from './useOpenFiles'; export { useWorkspaceFolderStore } from '../../../stores/workspaceFolderStore';", resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm',
    banner: { js: `import { createRequire as testCreateRequire } from 'node:module'; const require = testCreateRequire(${JSON.stringify(import.meta.url)});` },
    plugins: [{ name: 'hook-test-boundaries', setup(build) {
        build.onResolve({ filter: /^react$/ }, args => ({ path: args.kind === 'require-call' ? require.resolve('react') : pathToFileURL(require.resolve('react')).href, external: true }))
        build.onLoad({ filter: /components[/\\]ui[/\\]index\.ts$/ }, () => ({ contents: 'export const chooseAction = options => globalThis.chooseTestAction(options)', loader: 'ts' }))
    } }]
})
const { useOpenFiles, useWorkspaceFolderStore: folders } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
let instance, current, workspace, disks, recoveries, listeners, decisions, reads, writes, disposed
const wait = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function Harness(props) { current = useOpenFiles(props); return null }
const propsFor = (spaceId, folder) => ({ spaceId, folder, onRevealDirectory() {}, onDisposeModel: file => disposed.push(file) })
async function mount(paths = ['/project/a.txt']) {
    const spaceId = crypto.randomUUID()
    workspace = propsFor(spaceId, '/project')
    disks = new Map(paths.map(file => [file, 'original']))
    recoveries = new Map(); listeners = new Set(); decisions = []; reads = []; writes = []; disposed = []
    globalThis.chooseTestAction = async () => decisions.shift() ?? 'cancel'
    window.electronAPI = {
        platform: 'linux',
        fileExists: async file => disks.has(file),
        fs: {
            readFile: async file => { reads.push(file); return disks.has(file) ? { success: true, content: disks.get(file) } : { success: false, error: 'ENOENT' } },
            readDir: async () => ({ success: false }),
            writeFile: async args => { writes.push(args); if (args.expectedContent !== undefined && args.expectedContent !== disks.get(args.path)) return { success: false, conflict: true }; disks.set(args.path, args.content); return { success: true } },
            watchDir: async () => ({ success: true }), unwatchDir: async () => ({ success: true }),
            onChange: listener => { listeners.add(listener); return () => listeners.delete(listener) }
        },
        editorState: {
            load: async (id, folder) => recoveries.get(JSON.stringify([id, folder])) ?? null,
            save: async state => { recoveries.set(JSON.stringify([state.spaceId, state.folder]), structuredClone(state)); return { success: true } },
            flush: state => { recoveries.set(JSON.stringify([state.spaceId, state.folder]), structuredClone(state)); return { success: true } }
        }
    }
    folders.getState().setFolder(spaceId, '/project')
    folders.getState().setOpenFiles(spaceId, paths, paths[0] ?? null)
    await act(async () => { instance = create(React.createElement(Harness, workspace)); await wait() })
}
afterEach(async () => { if (instance) await act(async () => { instance.unmount(); await wait() }); instance = null })

test('restores tabs and restores a dirty buffer after switching workspaces', async () => {
    await mount()
    assert.equal(current.files.length, 1)
    await act(async () => current.updateContent('/project/a.txt', 'unsaved change'))
    const another = propsFor(crypto.randomUUID(), '/other')
    await act(async () => { instance.update(React.createElement(Harness, another)); await wait() })
    await act(async () => { instance.update(React.createElement(Harness, workspace)); await wait() })
    assert.equal(current.files[0].content, 'unsaved change')
    assert.equal(current.files[0].isDirty, true)
    assert.equal(disks.get('/project/a.txt'), 'original')
})
test('typing while a save is pending does not mark the newer edits clean', async () => {
    await mount()
    await act(async () => current.updateContent('/project/a.txt', 'first edit'))
    const gate = deferred(), original = window.electronAPI.fs.writeFile
    window.electronAPI.fs.writeFile = async args => { await gate.promise; return original(args) }
    let saving
    await act(async () => { saving = current.saveFile(); await wait() })
    await act(async () => current.updateContent('/project/a.txt', 'second edit'))
    await act(async () => { gate.resolve(); await saving })
    assert.equal(disks.get('/project/a.txt'), 'first edit')
    assert.equal(current.files[0].content, 'second edit')
    assert.equal(current.files[0].isDirty, true)
    await act(async () => { await current.saveFile() })
    assert.equal(disks.get('/project/a.txt'), 'second edit')
    assert.equal(current.files[0].isDirty, false)
})
test('an external disk change requires an explicit overwrite decision', async () => {
    await mount()
    await act(async () => current.updateContent('/project/a.txt', 'my edit'))
    disks.set('/project/a.txt', 'external edit')
    await act(async () => { assert.equal(await current.saveFile(), false) })
    assert.equal(disks.get('/project/a.txt'), 'external edit')
    assert.equal(current.files[0].isDirty, true)
    decisions.push('overwrite')
    await act(async () => { assert.equal(await current.saveFile(), true) })
    assert.equal(disks.get('/project/a.txt'), 'my edit')
})
test('closing several clean files removes all of them in the same event tick', async () => {
    await mount(['/project/a.txt', '/project/b.txt'])
    await act(async () => { current.handleDeleted('/project') })
    assert.deepEqual(current.files, [])
    assert.equal(current.activePath, null)
})
test('a late open response cannot append an old file to the new workspace', async () => {
    await mount([])
    const gate = deferred()
    window.electronAPI.fs.readFile = () => gate.promise
    let opening
    await act(async () => { opening = current.openFile('/project/slow.txt'); await wait() })
    await act(async () => { instance.update(React.createElement(Harness, propsFor('another-workspace', '/other'))); await wait() })
    await act(async () => { gate.resolve({ success: true, content: 'old workspace' }); await opening })
    assert.deepEqual(current.files, [])
})
test('close with Save keeps the tab if further edits arrive during the save', async () => {
    await mount()
    await act(async () => current.updateContent('/project/a.txt', 'first edit'))
    const gate = deferred(), original = window.electronAPI.fs.writeFile
    window.electronAPI.fs.writeFile = async args => { await gate.promise; return original(args) }
    decisions.push('save')
    let closing
    await act(async () => { closing = current.closeFile('/project/a.txt'); await wait() })
    await act(async () => current.updateContent('/project/a.txt', 'keep this edit'))
    await act(async () => { gate.resolve(); await closing })
    assert.equal(current.files[0].content, 'keep this edit')
    assert.equal(current.files[0].isDirty, true)
})
test('normal close flushes recovery, and a new hook instance restores the dirty buffer', async () => {
    await mount()
    await act(async () => current.updateContent('/project/a.txt', 'survive restart'))
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    const saved = recoveries.get(JSON.stringify([workspace.spaceId, workspace.folder]))
    assert.equal(saved.files[0].content, 'survive restart')
    await act(async () => { instance.unmount(); await wait() })
    await act(async () => { instance = create(React.createElement(Harness, workspace)); await wait() })
    assert.equal(current.files[0].content, 'survive restart')
    assert.equal(current.files[0].isDirty, true)
})
test('failed recovery storage prevents closing with unsaved changes', async () => {
    await mount()
    await act(async () => current.updateContent('/project/a.txt', 'keep safe'))
    window.electronAPI.editorState.flush = () => { throw new Error('Disk full') }
    const closing = new Event('beforeunload', { cancelable: true })
    await act(async () => { window.dispatchEvent(closing) })
    assert.equal(closing.defaultPrevented, true)
    assert.equal(current.files[0].content, 'keep safe')
})

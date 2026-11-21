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
    stdin: {
        contents: `
            export { useOpenFiles } from './useOpenFiles'
            export { useWorkspaceFolderStore } from '../../../stores/workspaceFolderStore'
            export { useLayoutStore } from '../../../stores/layoutStore'
            export { useNotificationStore } from '../../../stores/notificationStore'
        `,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
        loader: 'ts'
    },
    bundle: true, write: false, platform: 'node', format: 'esm',
    banner: { js: `import { createRequire as testCreateRequire } from 'node:module'; const require = testCreateRequire(${JSON.stringify(import.meta.url)});` },
    plugins: [{ name: 'hook-test-boundaries', setup(build) {
        build.onResolve({ filter: /^react$/ }, args => ({ path: args.kind === 'require-call' ? require.resolve('react') : pathToFileURL(require.resolve('react')).href, external: true }))
        build.onLoad({ filter: /components[/\\]ui[/\\]index\.ts$/ }, () => ({ contents: 'export const chooseAction = options => globalThis.chooseTestAction(options)', loader: 'ts' }))
        build.onLoad({ filter: /editor[/\\]monacoSetup\.ts$/ }, () => ({ contents: 'export const updateWorkspaceExtraLib = (p, c) => { globalThis.extraLibUpdates?.push([p, c]) }', loader: 'ts' }))
    } }]
})
const {
    useOpenFiles,
    useWorkspaceFolderStore: folders,
    useLayoutStore: layoutStore,
    useNotificationStore: notificationStore
} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
let instance, current, workspace, disks, recoveries, listeners, decisions, reads, writes, disposed
const wait = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function Harness(props) { current = useOpenFiles(props); return null }
const propsFor = (spaceId, folder, extra = {}) => ({ spaceId, folder, onRevealDirectory() {}, onDisposeModel: file => disposed.push(file), ...extra })
async function mount(paths = ['/project/a.txt'], extraProps = {}) {
    const spaceId = crypto.randomUUID()
    workspace = propsFor(spaceId, '/project', extraProps)
    disks = new Map(paths.map(file => [file, 'original']))
    recoveries = new Map(); listeners = new Set(); decisions = []; reads = []; writes = []; disposed = []
    layoutStore.setState({ autoSave: 'off', formatOnSave: false })
    notificationStore.setState({ notifications: [] })
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
test('closing an active tab selects an adjacent tab that remains open', async () => {
    await mount(['/project/a.txt', '/project/b.txt', '/project/c.txt'])
    await act(async () => { current.setActivePath('/project/b.txt'); current.forceClose('/project/b.txt') })
    assert.equal(current.activePath, '/project/c.txt')
    await act(async () => current.forceClose('/project/c.txt'))
    assert.equal(current.activePath, '/project/a.txt')
    assert.equal(current.activeFile.path, '/project/a.txt')
})
test('a save waiting on file existence cannot write after switching workspaces', async () => {
    await mount()
    await act(async () => current.updateContent('/project/a.txt', 'old workspace edit'))
    const gate = deferred()
    window.electronAPI.fileExists = () => gate.promise
    let saving
    await act(async () => { saving = current.saveFile(); await wait() })
    await act(async () => { instance.update(React.createElement(Harness, propsFor(crypto.randomUUID(), '/other'))); await wait() })
    await act(async () => { gate.resolve(true); assert.equal(await saving, false) })
    assert.deepEqual(writes, [])
    assert.equal(disks.get('/project/a.txt'), 'original')
})
for (const method of ['closeFile', 'closeMany']) test(`a pending ${method} decision cannot close another workspace's tabs`, async () => {
    await mount()
    await act(async () => current.updateContent('/project/a.txt', 'old workspace edit'))
    const gate = deferred()
    globalThis.chooseTestAction = () => gate.promise
    let closing
    await act(async () => { closing = current[method](method === 'closeFile' ? '/project/a.txt' : undefined); await wait() })
    const another = propsFor(crypto.randomUUID(), '/project')
    folders.getState().setFolder(another.spaceId, '/project')
    folders.getState().setOpenFiles(another.spaceId, ['/project/a.txt'], '/project/a.txt')
    await act(async () => { instance.update(React.createElement(Harness, another)); await wait() })
    await act(async () => current.updateContent('/project/a.txt', 'new workspace edit'))
    await act(async () => { gate.resolve('discard'); await closing })
    assert.equal(current.files[0].content, 'new workspace edit')
    assert.equal(current.files[0].isDirty, true)
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
test('openFile with preserveActive loads file without replacing active primary tab', async () => {
    await mount(['/project/a.txt'])
    disks.set('/project/b.ts', 'export const b = 2\n')
    let opened
    await act(async () => {
        opened = await current.openFile('/project/b.ts', undefined, undefined, { preserveActive: true })
    })
    assert.equal(opened, '/project/b.ts')
    assert.equal(current.activePath, '/project/a.txt')
    assert.equal(current.files.some(f => f.path === '/project/b.ts'), true)
})
test('saving or externally updating a TypeScript file updates Monaco extraLib live', async () => {
    globalThis.extraLibUpdates = []
    await mount(['/project/app.ts', '/project/notes.txt'])
    await act(async () => current.updateContent('/project/app.ts', 'export const x = 1\n'))
    await act(async () => { assert.equal(await current.saveFile('/project/app.ts'), true); await wait() })
    await act(async () => current.updateContent('/project/notes.txt', 'plain text'))
    await act(async () => { assert.equal(await current.saveFile('/project/notes.txt'), true); await wait() })
    assert.deepEqual(globalThis.extraLibUpdates, [['/project/app.ts', 'export const x = 1\n']])
    await act(async () => {
        window.dispatchEvent(new CustomEvent('kalynt-file-changed', { detail: { path: '/project/app.ts', content: 'export const x = 2\n' } }))
        await wait()
    })
    assert.deepEqual(globalThis.extraLibUpdates, [
        ['/project/app.ts', 'export const x = 1\n'],
        ['/project/app.ts', 'export const x = 2\n']
    ])
})

test('QA-17: manual save formats when formatOnSave is enabled, while afterDelay and onFocusChange auto-save skip formatting', async () => {
    const formattedPaths = []
    await mount(['/project/app.ts', '/project/other.ts'], {
        onFormatBeforeSave: async filePath => {
            formattedPaths.push(filePath)
            const currentFile = current.files.find(f => f.path === filePath)
            if (currentFile) {
                current.updateContent(filePath, currentFile.content.trim() + ';\n')
            }
        }
    })
    await act(async () => { layoutStore.setState({ formatOnSave: true }) })

    // 1. Manual save runs formatter and writes formatted output.
    await act(async () => current.updateContent('/project/app.ts', 'const x=1'))
    await act(async () => { assert.equal(await current.saveFile('/project/app.ts'), true); await wait() })
    assert.deepEqual(formattedPaths, ['/project/app.ts'])
    assert.equal(disks.get('/project/app.ts'), 'const x=1;\n')

    // 2. Auto-save onFocusChange (tab switch + window blur) writes unformatted and skips formatter.
    await act(async () => { layoutStore.setState({ autoSave: 'onFocusChange', formatOnSave: true }) })
    await act(async () => current.updateContent('/project/app.ts', 'const y=2'))
    await act(async () => { current.setActivePath('/project/other.ts'); await wait(); await wait() })
    assert.equal(disks.get('/project/app.ts'), 'const y=2')
    assert.deepEqual(formattedPaths, ['/project/app.ts'])

    await act(async () => current.updateContent('/project/other.ts', 'const z=3'))
    await act(async () => { window.dispatchEvent(new Event('blur')); await wait(); await wait() })
    assert.equal(disks.get('/project/other.ts'), 'const z=3')
    assert.deepEqual(formattedPaths, ['/project/app.ts'])

    // 3. Auto-save afterDelay writes unformatted after delay and skips formatter.
    await act(async () => { layoutStore.setState({ autoSave: 'afterDelay', formatOnSave: true }) })
    await act(async () => current.updateContent('/project/other.ts', 'const w=4'))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1150)); await wait() })
    assert.equal(disks.get('/project/other.ts'), 'const w=4')
    assert.deepEqual(formattedPaths, ['/project/app.ts'])
})

test('QA-17: formatter failure warns and saves unformatted without data loss; cancellation aborts cleanly', async () => {
    let mode = 'fail'
    const gate = deferred()
    await mount(['/project/app.ts'], {
        onFormatBeforeSave: async () => {
            if (mode === 'fail') throw new Error('Prettier crashed')
            if (mode === 'canceled-in-place') {
                const err = new Error('Canceled')
                err.name = 'Canceled'
                throw err
            }
            if (mode === 'wait-for-switch') {
                await gate.promise
            }
        }
    })
    await act(async () => { layoutStore.setState({ formatOnSave: true }) })

    // Real formatter failure: warns user and saves unformatted content with zero data loss.
    await act(async () => current.updateContent('/project/app.ts', 'const unformatted=1'))
    await act(async () => { assert.equal(await current.saveFile('/project/app.ts'), true); await wait() })
    assert.equal(disks.get('/project/app.ts'), 'const unformatted=1')
    assert.equal(current.files[0].isDirty, false)
    assert.ok(
        notificationStore.getState().notifications.some(n => n.type === 'warning' && n.message.includes('Prettier crashed')),
        'expected warning notification for formatter failure'
    )

    // Normal cancellation during format (e.g. Monaco Canceled): saves without warning toast.
    notificationStore.setState({ notifications: [] })
    mode = 'canceled-in-place'
    await act(async () => current.updateContent('/project/app.ts', 'const afterCancel=2'))
    await act(async () => { assert.equal(await current.saveFile('/project/app.ts'), true); await wait() })
    assert.equal(disks.get('/project/app.ts'), 'const afterCancel=2')
    assert.equal(notificationStore.getState().notifications.length, 0)

    // Workspace switch while format is awaiting cancels the save without writing to disk.
    mode = 'wait-for-switch'
    await act(async () => current.updateContent('/project/app.ts', 'const staleEdit=3'))
    let pendingSave
    await act(async () => { pendingSave = current.saveFile('/project/app.ts'); await wait() })
    await act(async () => { instance.update(React.createElement(Harness, propsFor(crypto.randomUUID(), '/other'))); await wait() })
    await act(async () => { gate.resolve(); assert.equal(await pendingSave, false) })
    assert.equal(disks.get('/project/app.ts'), 'const afterCancel=2')
})

test('QA-17: concurrent disk change during format-on-save preserves disk until resolved', async () => {
    await mount(['/project/app.ts'], {
        onFormatBeforeSave: async filePath => {
            const currentFile = current.files.find(f => f.path === filePath)
            if (currentFile) {
                current.updateContent(filePath, currentFile.content + ' /* formatted */')
            }
            // Simulate another tool modifying the file on disk while formatting ran.
            disks.set(filePath, 'external tool edit')
        }
    })
    await act(async () => { layoutStore.setState({ formatOnSave: true }) })
    await act(async () => current.updateContent('/project/app.ts', 'const x = 1'))

    // Cancel preserves disk content and keeps buffer dirty.
    decisions.push('cancel')
    await act(async () => { assert.equal(await current.saveFile('/project/app.ts'), false); await wait() })
    assert.equal(disks.get('/project/app.ts'), 'external tool edit')
    assert.equal(current.files[0].isDirty, true)

    // Overwrite writes the formatted buffer explicitly.
    decisions.push('overwrite')
    await act(async () => { assert.equal(await current.saveFile('/project/app.ts'), true); await wait() })
    assert.equal(disks.get('/project/app.ts'), 'const x = 1 /* formatted */ /* formatted */')
    assert.equal(current.files[0].isDirty, false)
})

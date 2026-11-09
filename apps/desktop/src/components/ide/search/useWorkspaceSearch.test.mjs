/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
globalThis.localStorage = { getItem: () => null, setItem() {} }
globalThis.window = {}
const { outputFiles } = await build({
    stdin: { contents: "export {useWorkspaceSearch} from './useWorkspaceSearch'; export * from './searchUtils'", resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm',
    banner: { js: `import {createRequire as testRequire} from 'node:module'; const require = testRequire(${JSON.stringify(import.meta.url)});` },
    plugins: [{ name: 'test-boundaries', setup(build) {
        build.onResolve({ filter: /^react$/ }, args => ({ path: args.kind === 'require-call' ? require.resolve('react') : pathToFileURL(require.resolve('react')).href, external: true }))
        build.onLoad({ filter: /components[/\\]ui[/\\]index\.ts$/ }, () => ({ contents: 'export const confirmAction = async () => true', loader: 'ts' }))
    } }]
})
const { useWorkspaceSearch, buildPattern, matchesInclude, splitList } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
let instance, current, disks, writes, buffers
function Harness({ folder }) { current = useWorkspaceSearch(folder, buffers); return null }
async function mount(entries, openFiles = []) {
    disks = new Map(entries); writes = []
    buffers = { files: openFiles, updateContent(file, content) { const found = this.files.find(f => f.path === file); found.content = content; found.isDirty = true } }
    // Match the production callback's lexical receiver (not a class method).
    buffers.updateContent = buffers.updateContent.bind(buffers)
    window.electronAPI = { fs: {
        readDir: async dir => {
            const items = new Map()
            for (const file of disks.keys()) {
                if (!file.startsWith(dir + '/')) continue
                const rest = file.slice(dir.length + 1), name = rest.split('/')[0]
                items.set(name, { name, path: dir + '/' + name, isDirectory: rest.includes('/') })
            }
            return { success: true, items: [...items.values()] }
        },
        readFile: async file => ({ success: true, content: disks.get(file) }),
        writeFile: async options => { writes.push(options); if (options.expectedContent !== disks.get(options.path)) return { success: false, conflict: true }; disks.set(options.path, options.content); return { success: true } }
    } }
    await act(async () => { instance = create(React.createElement(Harness, { folder: '/project' })) })
}
afterEach(async () => { if (instance) await act(async () => instance.unmount()); instance = null })
async function search(query, replacement = '', regex = false) {
    await act(async () => { current.setQuery(query); current.setReplacement(replacement); current.setKeepCase(false); current.setOptions({ regex, caseSensitive: true, wholeWord: false }) })
    await act(async () => current.search())
}
test('whole-word regex alternatives honor both boundaries', () => {
    const pattern = buildPattern('foo|bar', { regex: true, caseSensitive: true, wholeWord: true })
    assert.deepEqual('foobar foo bar barista'.match(pattern), ['foo', 'bar'])
})
test('include patterns support nested paths, braces, extension shorthand and single-directory stars', () => {
    const patterns = splitList('src/**/*.{ts,tsx}, .json')
    assert.deepEqual(patterns, ['src/**/*.{ts,tsx}', '.json'])
    assert.equal(matchesInclude('src/components/Button.tsx', patterns), true)
    assert.equal(matchesInclude('src/top.ts', patterns), true)
    assert.equal(matchesInclude('test/Button.tsx', patterns), false)
    assert.equal(matchesInclude('config/package.json', patterns), true)
    assert.equal(matchesInclude('src/nested/a.ts', ['src/*.ts']), false)
})
test('search and replacement use dirty buffers and leave their disk version intact', async () => {
    const file = '/project/a.txt'
    await mount([[file, 'disk version']], [{ path: file, content: 'unsaved needle', isDirty: true }])
    await search('needle', 'replacement')
    assert.equal(current.results.length, 1)
    await act(async () => current.replaceOne(current.results[0]))
    assert.equal(buffers.files[0].content, 'unsaved replacement')
    assert.equal(buffers.files[0].isDirty, true)
    assert.equal(disks.get(file), 'disk version')
    assert.equal(writes.length, 0)
})
test('single-match regex replacement retains lookahead and capture-group context', async () => {
    const file = '/project/a.txt'
    await mount([[file, 'foobar fooz']])
    await search('foo(?=bar)', 'X', true)
    await act(async () => current.replaceOne(current.results[0]))
    assert.equal(disks.get(file), 'Xbar fooz')
    disks.set(file, 'a=1 b=2')
    await search('([ab])=(\\d+)', '$1:$2', true)
    await act(async () => current.replaceOne(current.results[0]))
    assert.equal(disks.get(file), 'a:1 b=2')
})
test('literal whitespace queries are not trimmed', async () => {
    const file = '/project/a.txt'
    await mount([[file, 'one  two']]); await search('  ', ' ')
    assert.equal(current.results.length, 1)
    await act(async () => current.replaceOne(current.results[0]))
    assert.equal(disks.get(file), 'one two')
})
test('changing query without rerunning search cannot replace stale results', async () => {
    const file = '/project/a.txt'
    await mount([[file, 'old needle']]); await search('needle', 'replacement')
    const match = current.results[0]
    await act(async () => current.setQuery('old'))
    await act(async () => current.replaceOne(match))
    assert.equal(disks.get(file), 'old needle')
})
test('changing workspaces clears results and invalidates an in-flight search', async () => {
    await mount([['/project/a.txt', 'needle']])
    await act(async () => current.setQuery('needle'))
    let resolve
    window.electronAPI.fs.readFile = () => new Promise(r => { resolve = r })
    let searching
    await act(async () => { searching = current.search(); await new Promise(r => setImmediate(r)) })
    await act(async () => instance.update(React.createElement(Harness, { folder: '/other' })))
    await act(async () => { resolve({ success: true, content: 'needle' }); await searching })
    assert.deepEqual(current.results, [])
    assert.equal(current.searching, false)
})

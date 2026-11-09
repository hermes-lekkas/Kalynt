/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('./model-download.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { registerModelDownloadHandlers } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kalynt-download-'))
const handlers = new Map()
registerModelDownloadHandlers({ handle: (name, fn) => handlers.set(name, fn) }, () => null, () => root)
const invoke = (name, arg) => handlers.get(name)(null, arg)
const payload = Buffer.from('abcdefghij')
const server = http.createServer((req, res) => {
    if (req.url === '/bad-redirect') { res.writeHead(302, { Location: 'file:///tmp/model' }); res.end(); return }
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/full' }); res.end(); return }
    if (req.url === '/slow') {
        res.writeHead(200, { 'Content-Length': payload.length })
        res.write(payload.subarray(0, 4))
        const timer = setTimeout(() => res.end(payload.subarray(4)), 500)
        res.on('close', () => clearTimeout(timer))
        return
    }
    if (req.url === '/unsatisfied' || req.url === '/complete') {
        res.writeHead(416, { 'Content-Range': 'bytes */10' }); res.end(); return
    }
    if (req.headers.range && req.url !== '/ignore-range') {
        const offset = req.url === '/wrong-range' ? 1 : Number(req.headers.range.match(/\d+/)[0])
        res.writeHead(206, { 'Content-Range': `bytes ${offset}-9/10`, 'Content-Length': 10 - offset })
        res.end(payload.subarray(offset)); return
    }
    res.writeHead(200, { 'Content-Length': payload.length }); res.end(payload)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }) })
const download = (id, route) => invoke('download-model', { modelId: id, filename: `${id}.gguf`, url: base + route, expectedSize: 100 /* deliberately approximate */ })

test('downloads atomically and follows a relative HTTP redirect', { timeout: 5000 }, async () => {
    const result = await download('full', '/redirect')
    assert.equal(result.success, true, JSON.stringify(result))
    assert.deepEqual(await fs.readFile(result.path), payload)
    await assert.rejects(fs.stat(result.path + '.part'))
})
test('resumes from partial bytes and restarts if the server ignores Range', { timeout: 5000 }, async () => {
    for (const [id, route] of [['range', '/full'], ['restart', '/ignore-range']]) {
        await fs.writeFile(path.join(root, id + '.gguf.part'), payload.subarray(0, 4))
        const result = await download(id, route)
        assert.equal(result.success, true, JSON.stringify(result))
        assert.deepEqual(await fs.readFile(result.path), payload)
    }
})
test('does not publish partial or mismatched range responses as completed models', { timeout: 5000 }, async () => {
    for (const [id, route] of [['bad416', '/unsatisfied'], ['bad206', '/wrong-range']]) {
        await fs.writeFile(path.join(root, id + '.gguf.part'), payload.subarray(0, 4))
        const result = await download(id, route)
        assert.equal(result.success, false, JSON.stringify(result))
        await assert.rejects(fs.stat(path.join(root, id + '.gguf')))
    }
    await fs.writeFile(path.join(root, 'already.gguf.part'), payload)
    assert.equal((await download('already', '/complete')).success, true)
})
test('rejects an unsupported redirect without crashing the process', { timeout: 5000 }, async () => {
    const result = await download('redirect', '/bad-redirect')
    assert.equal(result.success, false)
    assert.match(result.error, /URL|protocol/i)
})
test('pause keeps partial bytes; resume finishes; cancel removes paused data', { timeout: 5000 }, async () => {
    const pending = download('paused', '/slow')
    for (let i = 0; i < 100; i++) {
        const stat = await fs.stat(path.join(root, 'paused.gguf.part')).catch(() => null)
        if (stat?.size > 0) break
        await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal((await invoke('pause-download', 'paused')).success, true)
    assert.equal((await pending).paused, true)
    const partial = await fs.readFile(path.join(root, 'paused.gguf.part'))
    assert.equal(partial.length, 4)
    assert.equal((await download('paused', '/full')).success, true)
    assert.deepEqual(await fs.readFile(path.join(root, 'paused.gguf')), payload)
    const cancel = download('canceled', '/slow')
    await new Promise(resolve => setTimeout(resolve, 50))
    await invoke('cancel-download', 'canceled')
    assert.equal((await cancel).canceled, true)
})

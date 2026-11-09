/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('./checkpoints.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { snapshot, restore } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kalynt-undo-'))
const api = {
    async stat(file) { try { const s = await fs.stat(file); return { success: true, isDirectory: s.isDirectory(), size: s.size } } catch (error) { return { success: false, error: String(error) } } },
    async readFile(file) { return { success: true, content: await fs.readFile(file, 'utf8') } },
    async writeFile({ path: file, content }) { await fs.writeFile(file, content); return { success: true } },
    async delete(file) { await fs.rm(file); return { success: true } }
}
globalThis.window = { electronAPI: { fs: api } }
after(() => fs.rm(root, { recursive: true, force: true }))
test('undo restores edits and deletions and removes files created during a run', async () => {
    const checkpoint = { files: {}, undone: false }
    const existing = path.join(root, 'existing.txt'), deleted = path.join(root, 'deleted.txt'), created = path.join(root, 'created.txt')
    await fs.writeFile(existing, 'original'); await fs.writeFile(deleted, 'bring back')
    for (const file of [existing, deleted, created]) await snapshot(checkpoint, file)
    await fs.writeFile(existing, 'changed'); await snapshot(checkpoint, existing)
    await fs.rm(deleted); await fs.writeFile(created, 'new')
    assert.deepEqual(await restore(checkpoint), [])
    assert.equal(await fs.readFile(existing, 'utf8'), 'original')
    assert.equal(await fs.readFile(deleted, 'utf8'), 'bring back')
    await assert.rejects(fs.stat(created))
    assert.equal(checkpoint.undone, true)
})
test('a partial undo remains retryable without overwriting already restored files', async () => {
    const a = path.join(root, 'retry-a'), b = path.join(root, 'retry-b')
    const checkpoint = { files: { [a]: 'original a', [b]: 'original b' }, undone: false }
    const originalWrite = api.writeFile
    api.writeFile = async args => args.path === b ? { success: false } : originalWrite(args)
    try {
        assert.deepEqual(await restore(checkpoint), [b])
        assert.equal(checkpoint.undone, false)
        await fs.writeFile(a, 'user edit after partial undo')
    } finally { api.writeFile = originalWrite }
    assert.deepEqual(await restore(checkpoint), [])
    assert.equal(await fs.readFile(a, 'utf8'), 'user edit after partial undo')
    assert.equal(await fs.readFile(b, 'utf8'), 'original b')
    assert.equal(checkpoint.undone, true)
})
test('an IPC failure on one file does not prevent restoring the other files', async () => {
    const a = path.join(root, 'throw-a'), b = path.join(root, 'throw-b')
    const checkpoint = { files: { [a]: 'a', [b]: 'b' }, undone: false }
    const originalWrite = api.writeFile
    api.writeFile = async args => { if (args.path === a) throw new Error('IPC unavailable'); return originalWrite(args) }
    try {
        assert.deepEqual(await restore(checkpoint), [a])
        assert.equal(await fs.readFile(b, 'utf8'), 'b')
    } finally { api.writeFile = originalWrite }
})

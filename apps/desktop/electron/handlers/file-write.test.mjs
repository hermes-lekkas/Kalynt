/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('./file-write.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { writeTextFile } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kalynt-save-'))
after(() => fs.rm(root, { recursive: true, force: true }))
test('conflicting saves preserve the external contents', async () => {
    const file = path.join(root, 'conflict.txt')
    await fs.writeFile(file, 'external')
    assert.equal((await writeTextFile(file, 'editor', 'utf8', 'original')).conflict, true)
    assert.equal(await fs.readFile(file, 'utf8'), 'external')
    assert.equal((await writeTextFile(file, 'editor', 'utf8', 'external')).success, true)
    assert.equal(await fs.readFile(file, 'utf8'), 'editor')
})
test('simultaneous compare-and-write requests cannot both replace the same baseline', async () => {
    const file = path.join(root, 'concurrent.txt')
    await fs.writeFile(file, 'base')
    const results = await Promise.all([writeTextFile(file, 'first', 'utf8', 'base'), writeTextFile(file, 'second', 'utf8', 'base')])
    assert.equal(results.filter(r => r.success).length, 1)
    assert.equal(results.filter(r => r.conflict).length, 1)
    assert.equal(await fs.readFile(file, 'utf8'), 'first')
})
test('saves preserve UTF-8 BOM, CRLF and executable file permissions', async () => {
    const file = path.join(root, 'format.sh')
    await fs.writeFile(file, '\uFEFFbefore\r\n', { mode: 0o755 })
    assert.equal((await writeTextFile(file, 'after\r\n', 'utf8', '\uFEFFbefore\r\n')).bom, true)
    assert.equal(await fs.readFile(file, 'utf8'), '\uFEFFafter\r\n')
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o755)
    assert.ok((await fs.readdir(root)).every(name => !name.endsWith('.tmp')))
})
test('saving through a symlink preserves the link and updates its target', { skip: process.platform === 'win32' }, async () => {
    const target = path.join(root, 'target'), link = path.join(root, 'link')
    await fs.writeFile(target, 'before'); await fs.symlink(target, link)
    assert.equal((await writeTextFile(link, 'after', 'utf8', 'before')).success, true)
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true)
    assert.equal(await fs.readFile(target, 'utf8'), 'after')
})

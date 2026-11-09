/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('./pathValidator.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { validatePath } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kalynt-path-'))
const workspace = path.join(root, 'workspace'), outside = path.join(root, 'outside')
await fs.mkdir(workspace); await fs.mkdir(outside)
after(() => fs.rm(root, { recursive: true, force: true }))
test('new files are validated against symlinked parent directories', async () => {
    const link = path.join(workspace, 'linked')
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => validatePath(workspace, path.join(link, 'nested', 'new.txt')), /symlink/)
    const inside = path.join(workspace, 'inside'), validLink = path.join(workspace, 'inside-link')
    await fs.mkdir(inside)
    await fs.symlink(inside, validLink, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(validatePath(workspace, path.join(validLink, 'new.txt')), path.join(validLink, 'new.txt'))
})
test('filesystem roots, missing ordinary parents and dot-prefixed names work', () => {
    assert.equal(validatePath(path.parse(root).root, root), root)
    assert.equal(validatePath(workspace, 'missing/new.txt'), path.join(workspace, 'missing/new.txt'))
    assert.equal(validatePath(workspace, '..cache/a.txt'), path.join(workspace, '..cache/a.txt'))
    assert.throws(() => validatePath(workspace, outside), /traversal/)
    assert.throws(() => validatePath(workspace, workspace + '-sibling/file.txt'), /traversal/)
})
test('Windows paths remain case-insensitive', { skip: process.platform !== 'win32' }, () => {
    assert.equal(validatePath(workspace.toUpperCase(), workspace.toLowerCase()), path.resolve(workspace.toLowerCase()))
})

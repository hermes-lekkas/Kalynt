/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('./editor-state.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { saveEditorState, loadEditorState } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'kalynt-recovery-'))
const folder = path.join(profile, 'workspace'); await fs.mkdir(folder)
after(() => fs.rm(profile, { recursive: true, force: true }))
const file = path.join(folder, 'edited.txt')
const state = { spaceId: 'workspace-one', folder, paths: [file], activePath: file, files: [{ path: file, name: 'edited.txt', content: 'unsaved change', diskContent: 'original', language: 'plaintext', isDirty: true }] }
test('dirty buffers round-trip through disk and remain isolated per workspace', async () => {
    assert.equal(saveEditorState(profile, state).success, true)
    assert.deepEqual(loadEditorState(profile, state.spaceId, folder), state)
    assert.equal(loadEditorState(profile, 'other-workspace', folder), null)
    const files = await fs.readdir(path.join(profile, 'editor-state'))
    assert.equal(files.length, 1)
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(profile, 'editor-state', files[0]))).mode & 0o777, 0o600)
})
test('clearing the last dirty buffer updates recovery instead of resurrecting discarded edits', () => {
    assert.equal(saveEditorState(profile, { ...state, paths: [], activePath: null, files: [] }).success, true)
    assert.deepEqual(loadEditorState(profile, state.spaceId, folder).files, [])
})
test('invalid recovery inputs do not replace an existing backup', () => {
    saveEditorState(profile, state)
    assert.equal(saveEditorState(profile, { ...state, files: [{ ...state.files[0], path: path.join(profile, 'outside.txt') }] }).success, false)
    assert.deepEqual(loadEditorState(profile, state.spaceId, folder), state)
})

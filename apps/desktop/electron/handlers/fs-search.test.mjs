/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./fs-search.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'no-bundled-ripgrep', setup(build) {
        build.onLoad({ filter: /[/\\]binary-manager\.ts$/ }, () => ({ contents: 'export const binaryManager = { getRipgrepPath: () => null }', loader: 'ts' }))
    } }]
})
const { searchFolder } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kalynt-search-'))
after(() => fs.rm(root, { recursive: true, force: true }))
for (const file of ['src/top.ts', 'src/nested/deep.ts', 'src/nested/deeper/leaf.ts', 'src/nested/other.js', 'test/top.ts', 'src/file1.txt']) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), 'First line\nSearch needle\n')
}
const paths = async pattern => {
    const result = await searchFolder(root, 'search NEEDLE', pattern)
    assert.equal(result.success, true)
    assert.ok(result.results.every(hit => hit.line === 2))
    return result.results.map(hit => hit.file.split(path.sep).join('/')).sort()
}
test('recursive search globs include zero, one and multiple nested directories', async () => {
    assert.deepEqual(await paths('src/**/*.ts'), ['src/nested/deep.ts', 'src/nested/deeper/leaf.ts', 'src/top.ts'])
})
test('single stars cannot cross directory boundaries; basename filters still work', async () => {
    assert.deepEqual(await paths('src/*.ts'), ['src/top.ts'])
    assert.deepEqual(await paths('*.ts'), ['src/nested/deep.ts', 'src/nested/deeper/leaf.ts', 'src/top.ts', 'test/top.ts'])
})
test('question-mark globs and literal dots preserve their meanings', async () => {
    assert.deepEqual(await paths('src/file?.txt'), ['src/file1.txt'])
    assert.deepEqual(await paths('src/file?.txtx'), [])
})

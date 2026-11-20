/* SPDX-License-Identifier: AGPL-3.0-only */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./fileLinkProvider.ts', import.meta.url))
const { outputFiles } = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    external: ['@xterm/xterm']
})
const { extractFileLinks, resolveTerminalFilePath } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
)

test('extractFileLinks parses POSIX, Windows, MSBuild, and Python traceback links while ignoring URLs', () => {
    const tsLinks = extractFileLinks('  src/components/App.tsx:42:10 - error TS2304')
    assert.equal(tsLinks.length, 1)
    assert.equal(tsLinks[0].filePath, 'src/components/App.tsx')
    assert.equal(tsLinks[0].line, 42)
    assert.equal(tsLinks[0].column, 10)

    const msbuildLinks = extractFileLinks('apps/desktop/src/main.ts(18,5): warning')
    assert.equal(msbuildLinks.length, 1)
    assert.equal(msbuildLinks[0].filePath, 'apps/desktop/src/main.ts')
    assert.equal(msbuildLinks[0].line, 18)
    assert.equal(msbuildLinks[0].column, 5)

    const pyLinks = extractFileLinks('  File "/workspace/app.py", line 99, in main')
    assert.equal(pyLinks.length, 1)
    assert.equal(pyLinks[0].filePath, '/workspace/app.py')
    assert.equal(pyLinks[0].line, 99)

    const urlLinks = extractFileLinks('Listening on https://example.com:8443/index.html:10:2')
    assert.equal(urlLinks.length, 0)
})

test('resolveTerminalFilePath resolves relative paths against workspace folder', () => {
    assert.equal(resolveTerminalFilePath('./src/app.ts', '/repo/app'), '/repo/app/src/app.ts')
    assert.equal(resolveTerminalFilePath('/abs/file.ts', '/repo/app'), '/abs/file.ts')
    assert.equal(resolveTerminalFilePath('src/app.ts', null), 'src/app.ts')
})

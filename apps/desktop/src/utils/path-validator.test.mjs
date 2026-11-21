/* SPDX-License-Identifier: AGPL-3.0-only */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('./path-validator.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { validatePath } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
test('legitimate filenames containing dots and normalized subpaths open correctly', () => {
    assert.equal(validatePath('foo..bar.ts', '/project').normalizedPath, '/project/foo..bar.ts')
    assert.equal(validatePath('src/../main.ts', '/project').normalizedPath, '/project/main.ts')
})
test('workspace boundaries distinguish sibling prefixes and POSIX case', () => {
    assert.equal(validatePath('/project-two/a.ts', '/project').valid, false)
    assert.equal(validatePath('/PROJECT/a.ts', '/project').valid, false)
    assert.equal(validatePath('../outside.ts', '/project').valid, false)
    assert.equal(validatePath('/tmp/a.ts', '/').valid, true)
})
test('Windows drives and UNC paths normalize without losing their root', () => {
    assert.equal(validatePath('src\\main.ts', 'C:\\Project').normalizedPath, 'C:/Project/src/main.ts')
    assert.equal(validatePath('c:\\project\\main.ts', 'C:\\Project').valid, true)
    assert.equal(validatePath('C:\\ProjectElsewhere\\main.ts', 'C:\\Project').valid, false)
    assert.equal(validatePath('src\\main.ts', '\\\\server\\share').normalizedPath, '//server/share/src/main.ts')
})

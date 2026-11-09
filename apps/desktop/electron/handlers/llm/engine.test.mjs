/* SPDX-License-Identifier: AGPL-3.0-only */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('./engine.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', external: ['node-llama-cpp'] })
const { fitContextToBudget } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const estimate = context => ({ cpuRam: 1000 + context * 10 })
test('small training contexts are not increased to a 512-token minimum', () => {
    assert.deepEqual(fitContextToBudget(estimate, 5000, 128), { contextSize: 128, capped: false })
    assert.equal(fitContextToBudget(estimate, 100, 128).contextSize, 128)
})
test('context size is reduced to the available budget for ordinary models', () => {
    const fitted = fitContextToBudget(estimate, 11000, 8192)
    assert.equal(fitted.capped, true)
    assert.equal(fitted.contextSize, 1000)
    assert.ok(estimate(fitted.contextSize).cpuRam <= 11000)
})
test('a sufficient budget retains the requested context', () => {
    assert.deepEqual(fitContextToBudget(estimate, 100000, 8192), { contextSize: 8192, capped: false })
})

/* SPDX-License-Identifier: AGPL-3.0-only */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../aiService.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { pickProvider, aiService } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const values = new Map()
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
const choose = choice => values.set('kalynt-agent-model', JSON.stringify(choice))

test('a missing local server never falls back to a configured cloud key', () => {
    choose({ mode: 'cloud', provider: 'local-server', cloudModel: 'coder' })
    assert.equal(pickProvider({ anthropic: true }), null)
    assert.equal(pickProvider({ anthropic: true, 'local-server': true }), 'local-server')
})
test('built-in offline selection suppresses cloud background requests', () => {
    choose({ mode: 'offline', provider: 'anthropic' })
    assert.equal(pickProvider({ anthropic: true, openai: true }), null)
})
test('a server without a selected model is not considered ready for background requests', () => {
    choose({ mode: 'cloud', provider: 'local-server', cloudModel: '' })
    assert.equal(pickProvider({ anthropic: true, 'local-server': true }), null)
})
test('local background requests keep the chosen model and small output budget', async () => {
    choose({ mode: 'cloud', provider: 'local-server', cloudModel: 'my-coder' })
    let captured
    globalThis.window = { electronAPI: { ai: {
        onEvent() {}, cancel: async () => ({ ok: true }),
        chat: async (_id, request) => {
            captured = request
            return { ok: true, result: { assistant: { text: 'completion', model: request.model }, stopReason: 'end' } }
        }
    } } }
    const response = await aiService.chat([{ role: 'user', content: 'Complete a function.' }], 'local-server', { maxTokens: 256 })
    assert.equal(response.content, 'completion')
    assert.equal(captured.provider, 'local-server')
    assert.equal(captured.model, 'my-coder')
    assert.equal(captured.maxTokens, 256)
})

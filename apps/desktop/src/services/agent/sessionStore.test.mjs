/* SPDX-License-Identifier: AGPL-3.0-only */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../../stores/agentSessionStore.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { useAgentSessionStore: store } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
globalThis.localStorage = { getItem: () => '1' }
globalThis.window = { electronAPI: { agent: {
    listSessions: async () => ({ success: false }),
    loadSession: async () => ({ success: false }),
    saveSession: async () => ({ ok: false, error: 'Disk is full' })
} } }
test('an incompatible session list cannot poison the agent store', async () => {
    await store.getState().loadList('workspace')
    assert.deepEqual(store.getState().summaries, [])
})
test('invalid session data does not replace the current conversation', async () => {
    const session = store.getState().create('workspace')
    await store.getState().open('invalid')
    assert.equal(store.getState().current.id, session.id)
})
test('a rejected disk write is reported as a failure rather than a saved conversation', async () => {
    const session = store.getState().current
    session.items.push({ role: 'user', content: 'Keep this conversation' })
    await assert.rejects(store.getState().saveNow(), /Disk is full/)
    assert.deepEqual(store.getState().summaries, [])
    assert.equal(store.getState().current.items[0].content, 'Keep this conversation')
    window.electronAPI.agent.saveSession = async () => ({ ok: true })
    await store.getState().saveNow()
    assert.equal(store.getState().summaries[0].id, session.id)
})
test('failed saves stay available when creating another conversation', async () => {
    window.electronAPI.agent.saveSession = async () => ({ ok: false, error: 'Disk full' })
    const previous = store.getState().current
    previous.items.push({ role: 'user', content: 'Retain while switching' })
    const fresh = store.getState().create('workspace')
    await new Promise(resolve => setImmediate(resolve))
    assert.notEqual(fresh.id, previous.id)
    await store.getState().loadList('workspace')
    assert.ok(store.getState().summaries.some(s => s.id === previous.id))
    await store.getState().open(previous.id)
    assert.equal(store.getState().current.items.at(-1).content, 'Retain while switching')
    window.electronAPI.agent.saveSession = async () => ({ ok: true })
    await store.getState().saveNow()
})
test('closing synchronously acknowledges saving the latest conversation', () => {
    let saved
    window.electronAPI.agent.flushSession = session => { saved = structuredClone(session); return { ok: true } }
    assert.equal(store.getState().flushNow().ok, true)
    assert.equal(saved.id, store.getState().current.id)
    window.electronAPI.agent.flushSession = () => ({ ok: false, error: 'Disk full' })
    assert.deepEqual(store.getState().flushNow(), { ok: false, error: 'Disk full' })
    window.electronAPI.agent.flushSession = () => ({ ok: true })
    assert.equal(store.getState().flushNow().ok, true)
})

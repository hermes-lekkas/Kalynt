/* SPDX-License-Identifier: AGPL-3.0-only
 * Two isolated peer modules, real Web Crypto and Yjs; no public signaling.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { outputFiles } = await build({
    stdin: { contents: "export * from './encryptedProvider'; export { Doc, encodeStateAsUpdate, applyUpdate } from 'yjs';", resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'shared-yjs-runtime', setup(build) {
        build.onResolve({ filter: /^yjs$/ }, () => ({ path: pathToFileURL(require.resolve('yjs')).href, external: true }))
    } }]
})
const source = `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
const first = await import(source + '#peer1'), second = await import(source + '#peer2')
after(() => { first.decryptionCache.destroy(); second.decryptionCache.destroy() })
test('two peers with a shared room password and salt exchange encrypted document updates', async () => {
    const salt = await first.initializeRoomEncryption('smoke-room', 'test password')
    await second.initializeRoomEncryption('smoke-room', 'test password', salt)
    const a = new first.Doc(), b = new second.Doc()
    a.getText('code').insert(0, 'const answer = 42;')
    const encrypted = await first.encryptRoomMessage('smoke-room', first.encodeStateAsUpdate(a))
    assert.equal(Buffer.from(encrypted).includes(Buffer.from('const answer')), false)
    second.applyUpdate(b, await second.decryptRoomMessage('smoke-room', encrypted))
    assert.equal(b.getText('code').toString(), 'const answer = 42;')
    b.getText('code').insert(18, '\n// reviewed')
    first.applyUpdate(a, await first.decryptRoomMessage('smoke-room', await second.encryptRoomMessage('smoke-room', second.encodeStateAsUpdate(b))))
    assert.equal(a.getText('code').toString(), b.getText('code').toString())
    a.destroy(); b.destroy()
    first.disableRoomEncryption('smoke-room'); second.disableRoomEncryption('smoke-room')
})
test('wrong passwords and modified ciphertext are rejected', async () => {
    const salt = await first.initializeRoomEncryption('wrong-password', 'right')
    await second.initializeRoomEncryption('wrong-password', 'wrong', salt)
    const encrypted = await first.encryptRoomMessage('wrong-password', new TextEncoder().encode('private code'))
    await assert.rejects(second.decryptRoomMessage('wrong-password', encrypted), /Decryption failed/)
    await second.initializeRoomEncryption('wrong-password', 'right', salt)
    encrypted[encrypted.length - 1] ^= 1
    await assert.rejects(second.decryptRoomMessage('wrong-password', encrypted), /Decryption failed/)
    first.disableRoomEncryption('wrong-password'); second.disableRoomEncryption('wrong-password')
})
test('a zero-prefixed AES-GCM IV decrypts normally and still rejects the wrong key', async () => {
    const room = 'zero-iv'
    const salt = await first.initializeRoomEncryption(room, 'right')
    await second.initializeRoomEncryption(room, 'wrong', salt)
    const iv = new Uint8Array(12), text = new TextEncoder().encode('authenticated message')
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, first.getRoomEncryptionState(room).key, text)
    const packet = new Uint8Array(12 + ciphertext.byteLength)
    packet.set(iv); packet.set(new Uint8Array(ciphertext), 12)
    assert.deepEqual(await first.decryptRoomMessage(room, packet), text)
    await assert.rejects(second.decryptRoomMessage(room, packet), /Decryption failed/)
    first.disableRoomEncryption(room); second.disableRoomEncryption(room)
})
test('encrypted rooms reject plaintext and truncated packets', async () => {
    const room = 'reject-plaintext'
    await first.initializeRoomEncryption(room, 'right')
    for (const packet of [new Uint8Array(), new Uint8Array([0, 1]), new TextEncoder().encode('plaintext message longer than the encrypted minimum')]) {
        await assert.rejects(first.decryptRoomMessage(room, packet), /Decryption failed/)
    }
    first.disableRoomEncryption(room)
})
test('unready or failed encryption never returns plaintext in an encrypted room', async () => {
    const room = 'encryption-failure', text = new TextEncoder().encode('private message')
    const initialized = first.initializeRoomEncryption(room, 'right')
    await assert.rejects(first.encryptRoomMessage(room, text), /not ready/)
    await assert.rejects(first.decryptRoomMessage(room, text), /not ready/)
    await initialized
    // A non-encryption key simulates the crypto provider rejecting a request.
    first.getRoomEncryptionState(room).key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    await assert.rejects(first.encryptRoomMessage(room, text), /Encryption failed/)
    first.disableRoomEncryption(room)
    assert.deepEqual(await first.encryptRoomMessage(room, text), text)
})

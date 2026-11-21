/* SPDX-License-Identifier: AGPL-3.0-only
 * Two isolated peer modules, real Web Crypto, ECDSA, Awareness, and Yjs; no public signaling.
 * Covers encryption, QA-07 (Shared Files), QA-08 (mixed 2.0/2.1 protocol),
 * QA-09 (deep links), QA-10 (presence across reconnect), QA-31 (room auth transitions),
 * and QA-33 (durable bans, guest disconnect enforcement, unban).
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const servicesDir = fileURLToPath(new URL('.', import.meta.url))

const bundleContents = `
export * from './encryptedProvider';
export { encryptionService, ROOM_ENCRYPTION_PROTOCOL_VERSION } from './encryptionService';
export { p2pService, normalizeRoomId } from './p2pService';
export { FileTransferService, FILE_CHUNK_SIZE, MAX_FILE_CHUNKS, computeSha256Hex } from './fileTransferService';
export { memberSyncService, buildBanRecordPayload } from './memberSyncService';
export { useMemberStore } from '../stores/memberStore';
export { useAppStore } from '../stores/appStore';
export { useNotificationStore } from '../stores/notificationStore';
export { classifyDecryptFailure } from '../components/agent/team/useTeamChat';
export { Doc, encodeStateAsUpdate, applyUpdate } from 'yjs';
export { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness';
`

const { outputFiles } = await build({
    stdin: { contents: bundleContents, resolveDir: servicesDir, loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    define: { 'import.meta.env': '{}' },
    plugins: [{
        name: 'shared-yjs-runtime',
        setup(b) {
            b.onResolve({ filter: /^yjs$/ }, () => ({ path: pathToFileURL(require.resolve('yjs')).href, external: true }))
            b.onResolve({ filter: /^y-protocols\/awareness$/ }, () => ({ path: pathToFileURL(require.resolve('y-protocols/awareness')).href, external: true }))
            // Stub browser-only React / UI / y-indexeddb / y-webrtc / themeService / monaco-editor when running pure Node unit tests
            b.onResolve({ filter: /^(react|y-indexeddb|y-webrtc)$/ }, args => ({ path: args.path, namespace: 'node-stub' }))
            b.onResolve({ filter: /(?:themeService|monaco-editor)/ }, args => ({ path: args.path, namespace: 'node-stub' }))
            b.onLoad({ filter: /.*/, namespace: 'node-stub' }, args => {
                if (/(?:themeService|monaco-editor)/.test(args.path)) {
                    return {
                        contents: `
                            export const applyExtensionTheme = async () => {};
                            export const clearExtensionTheme = () => {};
                            export const syncActiveExtensionTheme = async () => {};
                            export const restoreExtensionTheme = async () => {};
                            export default {};
                        `,
                        loader: 'js'
                    }
                }
                if (args.path === 'react') {
                    return {
                        contents: `
                            export const useState = (v) => [typeof v === 'function' ? v() : v, () => {}];
                            export const useEffect = () => {};
                            export const useRef = (v) => ({ current: v });
                            export const useCallback = (fn) => fn;
                            export const useMemo = (fn) => fn();
                            export default {};
                        `,
                        loader: 'js'
                    }
                }
                if (args.path === 'y-indexeddb') {
                    return {
                        contents: `
                            export class IndexeddbPersistence {
                                constructor() { this.synced = true; }
                                on() {}
                                off() {}
                                destroy() {}
                            }
                        `,
                        loader: 'js'
                    }
                }
                if (args.path === 'y-webrtc') {
                    return {
                        contents: `
                            import { Awareness } from 'y-protocols/awareness';
                            export class WebrtcProvider {
                                constructor(roomName, doc, opts = {}) {
                                    this.roomName = roomName;
                                    this.doc = doc;
                                    this.opts = opts;
                                    this.awareness = new Awareness(doc);
                                    this.signalingConns = [];
                                    this.connected = true;
                                    this.key = null;
                                    this._listeners = new Map();
                                }
                                on(ev, fn) {
                                    if (!this._listeners.has(ev)) this._listeners.set(ev, new Set());
                                    this._listeners.get(ev).add(fn);
                                }
                                off(ev, fn) { this._listeners.get(ev)?.delete(fn); }
                                emit(ev, args = []) { this._listeners.get(ev)?.forEach(fn => fn(...args)); }
                                connect() { this.connected = true; }
                                disconnect() { this.connected = false; }
                                destroy() { this.connected = false; this.awareness.destroy(); }
                            }
                        `,
                        loader: 'js'
                    }
                }
                return { contents: 'export default {};', loader: 'js' }
            })
        }
    }]
})

const source = `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
const first = await import(source + '#peer1')
const second = await import(source + '#peer2')

after(() => {
    first.decryptionCache.destroy()
    second.decryptionCache.destroy()
    first.encryptionService.destroy()
    second.encryptionService.destroy()
    first.p2pService.destroy()
    second.p2pService.destroy()
})

function makeMemoryFile(name, bytes, type = 'application/octet-stream') {
    const copy = new Uint8Array(bytes)
    return {
        name,
        size: copy.byteLength,
        type,
        async arrayBuffer() {
            return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
        }
    }
}

function syncDocs(a, b) {
    const updateA = first.encodeStateAsUpdate(a)
    second.applyUpdate(b, updateA)
    const updateB = second.encodeStateAsUpdate(b)
    first.applyUpdate(a, updateB)
}

function syncAwareness(a, b) {
    const uA = first.encodeAwarenessUpdate(a, [a.clientID])
    second.applyAwarenessUpdate(b, uA, 'remote')
    const uB = second.encodeAwarenessUpdate(b, [b.clientID])
    first.applyAwarenessUpdate(a, uB, 'remote')
}

// ---------------------------------------------------------------------------
// Core E2EE tests (existing)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// QA-07: Shared Files (single canonical Y.Doc, 64 KiB chunking, SHA-256, incomplete detection)
// ---------------------------------------------------------------------------

test('QA-07: small and 6 MiB files sync over the single live Y.Doc with verified SHA-256 integrity', async () => {
    const roomId = 'qa07-files-room'
    const hostDoc = new first.Doc()
    const guestDoc = new second.Doc()

    const hostTransfer = new first.FileTransferService()
    const guestTransfer = new second.FileTransferService()
    hostTransfer.setLocalUserIdForTest('host-user')
    guestTransfer.setLocalUserIdForTest('guest-user')

    hostTransfer.init(roomId, hostDoc)
    guestTransfer.init(roomId, guestDoc)

    // 1. Small 1 KiB file while nobody else is connected -> local-only on host
    const smallBytes = new Uint8Array(1024)
    for (let i = 0; i < smallBytes.length; i++) smallBytes[i] = (i * 31) & 0xff
    const expectedSmallHash = await first.computeSha256Hex(smallBytes)

    const smallRes = await hostTransfer.shareFile(makeMemoryFile('notes.txt', smallBytes, 'text/plain'), 'Host')
    assert.equal(smallRes.success, true)
    assert.equal(smallRes.checksum, expectedSmallHash)

    const hostFilesBeforePeer = hostTransfer.getFiles()
    assert.equal(hostFilesBeforePeer.length, 1)
    assert.equal(hostFilesBeforePeer[0].transferState, 'local-only')

    // Sync hostDoc -> guestDoc and verify receiver gets the file cleanly
    syncDocs(hostDoc, guestDoc)
    const guestSmallFiles = guestTransfer.getFiles()
    assert.equal(guestSmallFiles.length, 1)
    assert.equal(guestSmallFiles[0].transferState, 'ready')
    const smallAssembled = await guestTransfer.assembleFileBytes(guestSmallFiles[0])
    assert.equal(smallAssembled.ok, true)
    assert.equal(smallAssembled.checksum, expectedSmallHash)
    assert.deepEqual(smallAssembled.bytes, smallBytes)

    // 2. 6 MiB file -> 96 x 64 KiB chunks, verified SHA-256 on receiver
    const sixMib = new Uint8Array(6 * 1024 * 1024)
    for (let i = 0; i < sixMib.length; i += 257) sixMib[i] = (i * 17) & 0xff
    const expectedSixMibHash = await first.computeSha256Hex(sixMib)

    const largeRes = await hostTransfer.shareFile(makeMemoryFile('bundle-6mib.bin', sixMib), 'Host')
    assert.equal(largeRes.success, true)
    assert.equal(largeRes.checksum, expectedSixMibHash)

    syncDocs(hostDoc, guestDoc)
    const guestLarge = guestTransfer.getFiles().find(f => f.name === 'bundle-6mib.bin')
    assert.ok(guestLarge, '6 MiB file should appear on receiver')
    assert.equal(guestLarge.chunkCount, 96)
    assert.equal(guestLarge.receivedChunks, 96)
    assert.equal(guestLarge.transferState, 'ready')

    const largeAssembled = await guestTransfer.assembleFileBytes(guestLarge)
    assert.equal(largeAssembled.ok, true)
    assert.equal(largeAssembled.bytes.byteLength, sixMib.byteLength)
    assert.equal(largeAssembled.checksum, expectedSixMibHash)

    // 3. Corrupted chunk fails SHA-256 verification
    const chunksMap = guestDoc.getMap('file-chunks')
    const chunk0 = chunksMap.get(`${guestLarge.id}-0`)
    chunksMap.set(`${guestLarge.id}-0`, { ...chunk0, data: Buffer.from(new Uint8Array(first.FILE_CHUNK_SIZE).fill(0xaa)).toString('base64') })
    const corrupted = await guestTransfer.assembleFileBytes(guestLarge)
    assert.equal(corrupted.ok, false)
    assert.match(corrupted.error, /SHA-256 mismatch/i)

    hostTransfer.destroy()
    guestTransfer.destroy()
    hostDoc.destroy()
    guestDoc.destroy()
})

test('QA-07: incomplete transfer is detected when sender closes before all chunks arrive', async () => {
    const roomId = 'qa07-incomplete-room'
    const guestDoc = new second.Doc()
    const guestTransfer = new second.FileTransferService()
    guestTransfer.setLocalUserIdForTest('guest-user')
    guestTransfer.init(roomId, guestDoc)

    // Simulate metadata + only 2 of 4 chunks arriving before sender closes (0 connected peers)
    const fileId = 'partial-file-1'
    const payload = new Uint8Array(first.FILE_CHUNK_SIZE).fill(0x42)
    const b64 = Buffer.from(payload).toString('base64')
    guestDoc.getMap('shared-files').set(fileId, {
        id: fileId,
        name: 'interrupted.bin',
        size: 4 * first.FILE_CHUNK_SIZE,
        type: 'application/octet-stream',
        uploadedAt: Date.now(),
        uploadedBy: 'Host',
        ownerId: 'host-user',
        tier: 'small',
        chunkCount: 4,
        uploadComplete: false,
        isLocal: false
    })
    const chunksMap = guestDoc.getMap('file-chunks')
    chunksMap.set(`${fileId}-0`, { fileId, index: 0, data: b64 })
    chunksMap.set(`${fileId}-1`, { fileId, index: 1, data: b64 })

    const files = guestTransfer.getFiles()
    assert.equal(files.length, 1)
    assert.equal(files[0].receivedChunks, 2)
    assert.equal(files[0].totalChunks, 4)
    assert.equal(files[0].transferState, 'incomplete')

    const assembled = await guestTransfer.assembleFileBytes(files[0])
    assert.equal(assembled.ok, false)
    assert.deepEqual(assembled.missingChunks, [2, 3])

    guestTransfer.destroy()
    guestDoc.destroy()
})

// ---------------------------------------------------------------------------
// QA-08: Mixed 2.0/2.1 encrypted rooms vs wrong password
// ---------------------------------------------------------------------------

test('QA-08: v2 vs legacy message failure classification and keyCheck vs protocol mismatch', async () => {
    assert.equal(first.ROOM_ENCRYPTION_PROTOCOL_VERSION, 2)

    // Message-level classification: legacy v2.0 (missing encryptionVersion) vs v2.1 wrong password
    assert.equal(first.classifyDecryptFailure({ encryptionVersion: undefined }, 'authenticated'), 'incompatible-version')
    assert.equal(first.classifyDecryptFailure({ encryptionVersion: 1 }, 'authenticated'), 'incompatible-version')
    assert.equal(first.classifyDecryptFailure({ encryptionVersion: 2 }, 'authenticated'), 'wrong-password')
    assert.equal(first.classifyDecryptFailure({ encryptionVersion: 2 }, 'protocol-mismatch'), 'incompatible-version')

    // Deterministic keyCheck matches across isolated peers regardless of roomId casing, differs on wrong password
    await first.initializeRoomEncryption('QA08-Room', 'shared-secret')
    await second.initializeRoomEncryption('qa08-room', 'shared-secret')
    const check1 = first.encryptionService.getRoomKeyCheck('qa08-room')
    const check2 = second.encryptionService.getRoomKeyCheck('QA08-ROOM')
    assert.ok(check1 && check2)
    assert.equal(check1, check2)

    await second.initializeRoomEncryption('qa08-room', 'wrong-secret')
    const wrongCheck = second.encryptionService.getRoomKeyCheck('qa08-room')
    assert.notEqual(check1, wrongCheck)

    // Provider awareness check distinguishes protocol-mismatch (Kalynt 2.0 peer) from auth-failed (wrong password)
    const docA = new first.Doc()
    const providerA = first.p2pService.connect('qa08-room', docA, 'shared-secret')
    const legacyDoc = new second.Doc()
    const legacyAwareness = new second.Awareness(legacyDoc)
    // Legacy Kalynt 2.0 peer publishes user without protocol.version === 2
    legacyAwareness.setLocalState({ user: { name: 'Legacy 2.0 Peer' } })
    syncAwareness(legacyAwareness, providerA.awareness)
    assert.equal(first.p2pService.getRoomAuthInfo('qa08-room').status, 'protocol-mismatch')
    assert.equal(first.p2pService.getRoomAuthInfo('qa08-room').incompatiblePeers, 1)

    // Upgrade peer to v2 with wrong keyCheck -> transitions distinctly to auth-failed
    legacyAwareness.setLocalState({
        user: { name: 'V2 Wrong Password Peer' },
        protocol: { version: 2, encrypted: true, keyCheck: wrongCheck }
    })
    syncAwareness(legacyAwareness, providerA.awareness)
    assert.equal(first.p2pService.getRoomAuthInfo('qa08-room').status, 'auth-failed')

    // Correct keyCheck -> transitions to authenticated
    legacyAwareness.setLocalState({
        user: { name: 'V2 Matching Peer' },
        protocol: { version: 2, encrypted: true, keyCheck: check1 }
    })
    syncAwareness(legacyAwareness, providerA.awareness)
    assert.equal(first.p2pService.getRoomAuthInfo('qa08-room').status, 'authenticated')

    first.p2pService.disconnect('qa08-room')
    first.disableRoomEncryption('qa08-room')
    second.disableRoomEncryption('qa08-room')
    legacyAwareness.destroy(); legacyDoc.destroy(); docA.destroy()
})

// ---------------------------------------------------------------------------
// QA-09: Deep links (`lock=1`, normalization, malformed link rejection)
// ---------------------------------------------------------------------------

test('QA-09: generateRoomLink and parseRoomLink handle lock=1 and reject malformed links', () => {
    const lockedUrl = first.p2pService.generateRoomLink('Design-Room_42', undefined, 'Design Sync', { passwordProtected: true })
    assert.equal(lockedUrl, 'kalynt://join/design-room_42#n=Design%20Sync&lock=1')
    assert.equal(lockedUrl.includes('p='), false, 'Password must never be embedded in lock=1 invite links')

    const parsedLocked = first.p2pService.parseRoomLink(lockedUrl)
    assert.deepEqual(parsedLocked, {
        roomId: 'design-room_42',
        password: undefined,
        spaceName: 'Design Sync',
        passwordProtected: true
    })

    const unlockedUrl = first.p2pService.generateRoomLink('OpenRoom', undefined, 'Open Space', { passwordProtected: false })
    assert.equal(unlockedUrl, 'kalynt://join/openroom#n=Open%20Space')
    const parsedUnlocked = first.p2pService.parseRoomLink(unlockedUrl)
    assert.equal(parsedUnlocked?.passwordProtected, false)
    assert.equal(parsedUnlocked?.roomId, 'openroom')

    // Malformed / unsafe links must be rejected
    const malformed = [
        '',
        'https://example.com/join/room-1',
        'kalynt://settings/room-1',
        'kalynt://join/',
        'kalynt://join/../secret',
        'kalynt://join/a/b/c',
        'kalynt://join/room-1#javascript:alert(1)',
        'kalynt://join/room-1?q=<script>alert(1)</script>',
        'not a link at all'
    ]
    for (const bad of malformed) {
        assert.equal(first.p2pService.parseRoomLink(bad), null, `Expected malformed link to be rejected: ${bad}`)
    }

    // Verify main.ts contains cold-start argv + macOS open-url + deep-link:consume wiring
    const mainSrc = fs.readFileSync(path.resolve(servicesDir, '../../electron/main.ts'), 'utf8')
    assert.match(mainSrc, /extractDeepLinkFromArgv\(process\.argv\.slice\(1\)\)/)
    assert.match(mainSrc, /ipcMain\.handle\('deep-link:consume'/)
    assert.match(mainSrc, /app\.on\('open-url'/)
})

// ---------------------------------------------------------------------------
// QA-10: Presence across provider reconnect / swap
// ---------------------------------------------------------------------------

test('QA-10: room listeners and memberSyncService stay synchronized across provider reconnect', async () => {
    const roomId = 'qa10-presence-room'
    const doc = new first.Doc()
    const seenProviders = []
    let latestPeerCount = -1

    const initialProvider = first.p2pService.connect(roomId, doc, undefined)
    const unsub = first.p2pService.addRoomListener(roomId, {
        onProvider: p => seenProviders.push(p),
        onPeers: peers => { latestPeerCount = peers.length }
    })

    // Seeded immediately on subscription
    assert.equal(latestPeerCount, 0)

    await first.memberSyncService.initializeSpace(roomId, doc, initialProvider.awareness, 'owner-10', 'Owner Ten')

    // Reconnect (e.g. after setting a room password in Settings) replaces the WebrtcProvider
    await first.initializeRoomEncryption(roomId, 'new-pass')
    const reconnectedProvider = await first.p2pService.reconnect(roomId, 'new-pass', doc)
    assert.ok(reconnectedProvider)
    assert.notEqual(reconnectedProvider, initialProvider)
    assert.equal(seenProviders.includes(reconnectedProvider), true)

    // Rebind memberSyncService to the swapped awareness (as useYjs.ts onProvider does)
    first.memberSyncService.updateAwareness(roomId, reconnectedProvider.awareness)

    // Remote peer joins the NEW provider's awareness -> presence updates immediately
    const remoteDoc = new second.Doc()
    const remoteAwareness = new second.Awareness(remoteDoc)
    remoteAwareness.setLocalState({
        user: { id: 'guest-10', name: 'Guest Ten' },
        protocol: {
            version: 2,
            encrypted: true,
            keyCheck: first.encryptionService.getRoomKeyCheck(roomId)
        }
    })
    syncAwareness(remoteAwareness, reconnectedProvider.awareness)

    assert.equal(latestPeerCount, 1)
    assert.equal(first.p2pService.getPeerCount(roomId), 1)
    assert.equal(first.memberSyncService.getOnlineUsers(roomId).includes('guest-10'), true)

    unsub()
    first.memberSyncService.cleanup(roomId)
    first.p2pService.disconnect(roomId)
    first.disableRoomEncryption(roomId)
    remoteAwareness.destroy(); remoteDoc.destroy(); doc.destroy()
})

// ---------------------------------------------------------------------------
// QA-31: Auth status transitions & waitForRoomAuth
// ---------------------------------------------------------------------------

test('QA-31: waitForRoomAuth distinguishes offline peers (key-configured), auth-failed, and authenticated', async () => {
    const roomId = 'qa31-auth-room'
    const doc = new first.Doc()
    await first.initializeRoomEncryption(roomId, 'secret-31')
    const provider = first.p2pService.connect(roomId, doc, 'secret-31')

    // 1. All peers offline -> settles cleanly to key-configured (never falsely claims authenticated)
    const offlineAuth = await first.p2pService.waitForRoomAuth(roomId, 60)
    assert.equal(offlineAuth.status, 'key-configured')

    // 2. Online peer with mismatched keyCheck -> settles immediately to auth-failed
    const peerDoc = new second.Doc()
    const peerAwareness = new second.Awareness(peerDoc)
    const pendingFail = first.p2pService.waitForRoomAuth(roomId, 500)
    peerAwareness.setLocalState({
        user: { name: 'Owner' },
        protocol: { version: 2, encrypted: true, keyCheck: 'mismatch-key-check' }
    })
    syncAwareness(peerAwareness, provider.awareness)
    const failedAuth = await pendingFail
    assert.equal(failedAuth.status, 'auth-failed')

    // 3. Reconnect with matching key -> settles immediately to authenticated
    const provider2 = await first.p2pService.reconnect(roomId, 'secret-31', doc)
    const pendingOk = first.p2pService.waitForRoomAuth(roomId, 500)
    peerAwareness.setLocalState({
        user: { name: 'Owner' },
        protocol: {
            version: 2,
            encrypted: true,
            keyCheck: first.encryptionService.getRoomKeyCheck(roomId)
        }
    })
    syncAwareness(peerAwareness, provider2.awareness)
    const okAuth = await pendingOk
    assert.equal(okAuth.status, 'authenticated')

    first.p2pService.disconnect(roomId)
    first.disableRoomEncryption(roomId)
    peerAwareness.destroy(); peerDoc.destroy(); doc.destroy()
})

// ---------------------------------------------------------------------------
// QA-33: Durable ban records, guest disconnect enforcement, unban & rejoin
// ---------------------------------------------------------------------------

test('QA-33: durable ban persists across restarts, disconnects guest, blocks rejoin, and lifts cleanly', async () => {
    const spaceId = 'qa33-ban-room'
    const ownerId = 'owner-user-33'
    const guestId = 'guest-user-33'

    first.useMemberStore.setState({ userId: ownerId, displayName: 'Alice Owner', spaceMembers: {} })
    second.useMemberStore.setState({ userId: guestId, displayName: 'Bob Guest', spaceMembers: {} })
    second.useAppStore.setState({
        currentSpace: { id: spaceId, name: 'QA-33 Space', type: 'shared', createdAt: Date.now(), lastModified: Date.now() }
    })

    const ownerDoc = new first.Doc()
    const guestDoc = new second.Doc()
    const ownerAwareness = new first.Awareness(ownerDoc)
    const guestAwareness = new second.Awareness(guestDoc)

    // Owner creates space with ECDSA owner proof
    await first.memberSyncService.initializeSpace(spaceId, ownerDoc, ownerAwareness, ownerId, 'Alice Owner')
    syncDocs(ownerDoc, guestDoc)
    syncAwareness(ownerAwareness, guestAwareness)

    // Guest joins space
    await second.memberSyncService.initializeSpace(spaceId, guestDoc, guestAwareness, guestId, 'Bob Guest')
    syncDocs(ownerDoc, guestDoc)
    syncAwareness(ownerAwareness, guestAwareness)

    assert.equal(first.useMemberStore.getState().spaceMembers[spaceId].members.some(m => m.userId === guestId), true)

    // Owner bans guest with a reason
    const banned = await first.memberSyncService.banMember(spaceId, guestId, 'Disruptive edits')
    assert.equal(banned, true)

    // Durable ban record is immediately exposed in owner's store for Lift ban (even though removed from active members)
    const ownerSpace = first.useMemberStore.getState().spaceMembers[spaceId]
    assert.equal(ownerSpace.members.some(m => m.userId === guestId), false)
    assert.equal(ownerSpace.bannedMembers.length, 1)
    assert.equal(ownerSpace.bannedMembers[0].userId, guestId)
    assert.equal(ownerSpace.bannedMembers[0].displayName, 'Bob Guest')
    assert.equal(ownerSpace.bannedMembers[0].banReason, 'Disruptive edits')
    assert.equal(ownerSpace.bannedMembers[0].isBanned, true)
    assert.ok(ownerDoc.getMap('bannedRecords').get(guestId), 'Signed ban record must be persisted in Y.Doc')

    // Sync Y.Doc update to guest (even without awareness moderation event) -> durable ban enforces disconnect!
    syncDocs(ownerDoc, guestDoc)
    // Allow async ECDSA signature verification on durable ban record to settle
    await new Promise(r => setTimeout(r, 80))

    assert.equal(second.useAppStore.getState().currentSpace, null, 'Banned guest must be disconnected from workspace')
    assert.equal(
        second.useNotificationStore.getState().notifications.some(n => /banned/i.test(n.message)),
        true,
        'Banned guest should receive a ban notification'
    )

    // Simulate guest restarting & attempting to rejoin while still banned -> blocked immediately
    second.useAppStore.setState({
        currentSpace: { id: spaceId, name: 'QA-33 Space', type: 'shared', createdAt: Date.now(), lastModified: Date.now() }
    })
    const rejoinAwareness = new second.Awareness(guestDoc)
    await second.memberSyncService.initializeSpace(spaceId, guestDoc, rejoinAwareness, guestId, 'Bob Guest')
    assert.equal(second.useAppStore.getState().currentSpace, null, 'Banned guest must remain blocked on rejoin')

    // Owner lifts ban -> removed from banned + bannedRecords + bannedMembers
    const unbanned = await first.memberSyncService.unbanMember(spaceId, guestId)
    assert.equal(unbanned, true)
    assert.equal(first.useMemberStore.getState().spaceMembers[spaceId].bannedMembers.length, 0)
    assert.equal(ownerDoc.getMap('banned').has(guestId), false)
    assert.equal(ownerDoc.getMap('bannedRecords').has(guestId), false)

    // Sync unban to guest -> guest can now rejoin cleanly
    syncDocs(ownerDoc, guestDoc)
    second.useAppStore.setState({
        currentSpace: { id: spaceId, name: 'QA-33 Space', type: 'shared', createdAt: Date.now(), lastModified: Date.now() }
    })
    const afterUnbanAwareness = new second.Awareness(guestDoc)
    await second.memberSyncService.initializeSpace(spaceId, guestDoc, afterUnbanAwareness, guestId, 'Bob Guest')
    assert.equal(second.useAppStore.getState().currentSpace?.id, spaceId, 'Unbanned guest must be able to rejoin')

    first.memberSyncService.cleanup(spaceId)
    second.memberSyncService.cleanup(spaceId)
    ownerAwareness.destroy(); guestAwareness.destroy(); rejoinAwareness.destroy(); afterUnbanAwareness.destroy()
    ownerDoc.destroy(); guestDoc.destroy()
})

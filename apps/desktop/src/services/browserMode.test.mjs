/* SPDX-License-Identifier: AGPL-3.0-only
 * Run: node --test apps/desktop/src/services/browserMode.test.mjs
 * Regression tests for QA-30 (browser dev mode Open folder & desktop-only feedback).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles: shimOut } = await build({
    entryPoints: [fileURLToPath(new URL('../electronShim.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm'
})
const { electronAPIShim } = await import(`data:text/javascript;base64,${Buffer.from(shimOut[0].text).toString('base64')}`)

test('QA-30: electronShim reports explicit unsupported error instead of silent cancellation for fs.openFolder', async () => {
    assert.equal(electronAPIShim.platform, 'browser')
    assert.equal(await electronAPIShim.getVersion(), '2.1.0-web')
    assert.deepEqual(await electronAPIShim.consumePendingDeepLinks(), [])

    const res = await electronAPIShim.fs.openFolder()
    assert.equal(res.success, false)
    assert.equal(res.canceled, false)
    assert.match(res.error || '', /requires the desktop app/i)

    // Verify QA-22/23/12/34 preload shims exist on electronAPIShim
    assert.equal(typeof electronAPIShim.runtime.sendLSPNotification, 'function')
    assert.equal(typeof electronAPIShim.runtime.onLSPNotification, 'function')
    assert.equal(typeof electronAPIShim.runtime.onLanguageServerError, 'function')
    assert.deepEqual(await electronAPIShim.debug.getScopes(), { success: true, scopes: [] })
    assert.equal(typeof electronAPIShim.extensions.executeCommand, 'function')
    assert.equal(typeof electronAPIShim.extensions.loadTheme, 'function')
    assert.equal(typeof electronAPIShim.extensions.onContributionsChanged, 'function')
})

test('QA-30: pickFolder and openFolderAsWorkspace emit visible feedback in browser mode instead of silent no-op', async () => {
    const notifications = []
    globalThis.__qa30Notifs = notifications
    const origWindow = globalThis.window
    globalThis.window = { electronAPI: electronAPIShim }

    const { outputFiles } = await build({
        entryPoints: [fileURLToPath(new URL('../components/home/workspaceActions.ts', import.meta.url))],
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm',
        plugins: [{
            name: 'mock-stores',
            setup(b) {
                b.onResolve({ filter: /stores\/(appStore|workspaceFolderStore|layoutStore|notificationStore)$/ }, args => ({
                    path: args.path.split('/').pop(),
                    namespace: 'mock'
                }))
                b.onLoad({ filter: /^notificationStore$/, namespace: 'mock' }, () => ({
                    contents: 'export const useNotificationStore = { getState: () => ({ addNotification: (message, type) => globalThis.__qa30Notifs.push({ message, type }) }) };',
                    loader: 'js'
                }))
                b.onLoad({ filter: /^(appStore|workspaceFolderStore|layoutStore)$/, namespace: 'mock' }, () => ({
                    contents: 'export const useAppStore = { getState: () => ({ spaces: [], createSpace: () => ({}), setCurrentSpace: () => {} }) }; export const useWorkspaceFolderStore = { getState: () => ({ records: {}, touch: () => {}, setFolder: () => {} }) }; export const folderName = () => ""; export const useLayoutStore = { getState: () => ({ setMainView: () => {} }) };',
                    loader: 'js'
                }))
            }
        }]
    })

    try {
        const actions = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
        assert.equal(actions.isBrowserMode(), true)
        const picked = await actions.pickFolder()
        assert.equal(picked, null)
        assert.equal(notifications.length, 1)
        assert.match(notifications[0].message, /requires the desktop app/i)

        await actions.openFolderAsWorkspace()
        assert.equal(notifications.length, 2)
        assert.match(notifications[1].message, /requires the desktop app/i)
    } finally {
        globalThis.window = origWindow
        delete globalThis.__qa30Notifs
    }
})

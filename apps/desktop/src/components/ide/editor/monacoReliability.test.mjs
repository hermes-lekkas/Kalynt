/* SPDX-License-Identifier: AGPL-3.0-only */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./monacoReliability.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm'
})

const {
    WORKSPACE_TYPE_FILE_GLOB,
    toWorkspaceRelativePath,
    isIgnoredWorkspaceRelativePath,
    discoverWorkspaceTypeFilesFromApi,
    prioritizeWorkspaceTypeFiles,
    resolveTsConfigBaseUrl,
    isCancellationError,
    installMonacoCancellationHandler
} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)

test('QA-11: fast glob discovery succeeds when workspace lives below ignored ancestor directories', async () => {
    const roots = [
        '/home/roody/.cache/kalynt-qa-2026/ts-project',
        '/var/tmp/build/out/node_modules/my workspace'
    ]

    for (const root of roots) {
        let seenPattern = ''
        const api = {
            agent: {
                glob: async ({ pattern }) => {
                    seenPattern = pattern
                    return {
                        ok: true,
                        files: [
                            'src/main.ts',
                            `${root}/src/lib.ts`,
                            'src/types.d.ts',
                            'src/helper.js',
                            'src/App.jsx',
                            'src/esm.mjs',
                            'src/cjs.cjs',
                            'node_modules/pkg/index.d.ts',
                            'build/output.js',
                            'dist/bundle.js',
                            '.cache/generated.ts',
                            'src/styles.css'
                        ]
                    }
                }
            }
        }

        const discovered = await discoverWorkspaceTypeFilesFromApi(root, api)
        assert.equal(seenPattern, WORKSPACE_TYPE_FILE_GLOB)
        assert.deepEqual(discovered, [
            `${root}/src/main.ts`,
            `${root}/src/lib.ts`,
            `${root}/src/types.d.ts`,
            `${root}/src/helper.js`,
            `${root}/src/App.jsx`,
            `${root}/src/esm.mjs`,
            `${root}/src/cjs.cjs`
        ])
    }
})

test('QA-11: fallback readDir BFS discovers TS and JS files under ignored ancestor directories and spaces', async () => {
    const root = '/home/roody/.cache/Project With Spaces'
    const tree = new Map([
        [root, [
            { name: 'src', path: `${root}/src`, isDirectory: true, isFile: false },
            { name: 'node_modules', path: `${root}/node_modules`, isDirectory: true, isFile: false },
            { name: 'build', path: `${root}/build`, isDirectory: true, isFile: false },
            { name: 'index.mjs', path: `${root}/index.mjs`, isDirectory: false, isFile: true }
        ]],
        [`${root}/src`, [
            { name: 'main.js', path: `${root}/src/main.js`, isDirectory: false, isFile: true },
            { name: 'lib.jsx', path: `${root}/src/lib.jsx`, isDirectory: false, isFile: true },
            { name: 'util.cjs', path: `${root}/src/util.cjs`, isDirectory: false, isFile: true },
            { name: 'README.md', path: `${root}/src/README.md`, isDirectory: false, isFile: true }
        ]],
        [`${root}/node_modules`, [
            { name: 'dep.js', path: `${root}/node_modules/dep.js`, isDirectory: false, isFile: true }
        ]],
        [`${root}/build`, [
            { name: 'compiled.js', path: `${root}/build/compiled.js`, isDirectory: false, isFile: true }
        ]]
    ])

    const api = {
        fs: {
            readDir: async dir => ({ success: true, items: tree.get(dir) ?? [] })
        }
    }

    const discovered = await discoverWorkspaceTypeFilesFromApi(root, api)
    assert.deepEqual(discovered, [
        `${root}/index.mjs`,
        `${root}/src/main.js`,
        `${root}/src/lib.jsx`,
        `${root}/src/util.cjs`
    ])
})

test('QA-11: path helpers keep ancestor ignores separate and support tsconfig/jsconfig paths + spaces', () => {
    assert.equal(
        toWorkspaceRelativePath('/home/u/.cache/proj/src/lib.ts', '/home/u/.cache/proj'),
        'src/lib.ts'
    )
    assert.equal(
        toWorkspaceRelativePath('c:\\build\\proj\\src\\a.ts', 'C:\\build\\proj'),
        'src/a.ts'
    )
    assert.equal(toWorkspaceRelativePath('/etc/passwd', '/home/u/.cache/proj'), null)
    assert.equal(isIgnoredWorkspaceRelativePath('src/build.ts'), false)
    assert.equal(isIgnoredWorkspaceRelativePath('build/out.ts'), true)
    assert.equal(isIgnoredWorkspaceRelativePath('src/node_modules/x.ts'), true)

    const fakeToUri = fsPath => `file://${encodeURI(fsPath)}`
    // Explicit baseUrl with spaces
    assert.equal(
        resolveTsConfigBaseUrl('/tmp/my workspace', './src', true, fakeToUri),
        'file:///tmp/my%20workspace/src'
    )
    // TS 4.1+ paths without explicit baseUrl defaults to workspace root URI
    assert.equal(
        resolveTsConfigBaseUrl('/tmp/my workspace', undefined, true, fakeToUri),
        'file:///tmp/my%20workspace'
    )
    // No baseUrl and no paths -> undefined
    assert.equal(
        resolveTsConfigBaseUrl('/tmp/my workspace', undefined, false, fakeToUri),
        undefined
    )

    const ordered = prioritizeWorkspaceTypeFiles(
        ['/p/src/helper.js', '/p/src/main.ts', '/p/src/env.d.ts'],
        10
    )
    assert.deepEqual(ordered, ['/p/src/env.d.ts', '/p/src/main.ts', '/p/src/helper.js'])
})

test('QA-18: isCancellationError matches only genuine cancellations and not unexpected errors', () => {
    const monacoCanceled = new Error('Canceled')
    monacoCanceled.name = 'Canceled'
    assert.equal(isCancellationError(monacoCanceled), true)
    assert.equal(isCancellationError(new Error('Canceled')), true)
    assert.equal(isCancellationError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), true)
    assert.equal(isCancellationError({ type: 'cancelation', msg: 'operation is manually canceled' }), true)
    assert.equal(isCancellationError('Canceled'), true)

    assert.equal(isCancellationError(new Error('TextModel got disposed before DiffEditorWidget model got reset')), false)
    assert.equal(isCancellationError(new TypeError('Cannot read properties of null')), false)
    assert.equal(isCancellationError(new Error('EACCES: permission denied')), false)
    assert.equal(isCancellationError(null), false)
    assert.equal(isCancellationError(undefined), false)
})

test('QA-18: window cancellation handler suppresses normal Canceled events while preserving real errors', () => {
    const target = new EventTarget()
    const dispose = installMonacoCancellationHandler(target)

    try {
        const canceledRejection = new Event('unhandledrejection', { cancelable: true })
        canceledRejection.reason = Object.assign(new Error('Canceled'), { name: 'Canceled' })
        target.dispatchEvent(canceledRejection)
        assert.equal(canceledRejection.defaultPrevented, true)

        const loaderRejection = new Event('unhandledrejection', { cancelable: true })
        loaderRejection.reason = { type: 'cancelation', msg: 'operation is manually canceled' }
        target.dispatchEvent(loaderRejection)
        assert.equal(loaderRejection.defaultPrevented, true)

        const realRejection = new Event('unhandledrejection', { cancelable: true })
        realRejection.reason = new Error('Unexpected worker crash')
        target.dispatchEvent(realRejection)
        assert.equal(realRejection.defaultPrevented, false)

        const canceledWindowError = new Event('error', { cancelable: true })
        canceledWindowError.error = Object.assign(new Error('Canceled'), { name: 'Canceled' })
        target.dispatchEvent(canceledWindowError)
        assert.equal(canceledWindowError.defaultPrevented, true)

        const realWindowError = new Event('error', { cancelable: true })
        realWindowError.error = new Error('Actual bug')
        target.dispatchEvent(realWindowError)
        assert.equal(realWindowError.defaultPrevented, false)
    } finally {
        dispose()
    }

    // After cleanup, events are no longer intercepted.
    const afterDispose = new Event('unhandledrejection', { cancelable: true })
    afterDispose.reason = new Error('Canceled')
    target.dispatchEvent(afterDispose)
    assert.equal(afterDispose.defaultPrevented, false)
})

/* SPDX-License-Identifier: AGPL-3.0-only */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./monacoDiffLifecycle.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm'
})

const { mountManagedDiffEditor } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
)

/**
 * Fake Monaco runtime that strictly enforces Monaco 0.52's DiffEditorWidget
 * invariant: disposing either attached TextModel before `diffEditor.setModel(null)`
 * throws `TextModel got disposed before DiffEditorWidget model got reset`.
 */
function createStrictFakeMonaco() {
    const models = new Map()
    const events = []
    let theme = ''

    const createModel = (value, language = 'plaintext', uri) => {
        const uriKey = typeof uri === 'string' ? uri : uri?.toString?.() ?? `inmemory://model/${models.size + 1}`
        if (models.has(uriKey)) {
            throw new Error(`Model URI collision: ${uriKey}`)
        }
        const willDisposeListeners = new Set()
        let disposed = false
        let currentValue = value
        let currentLanguage = language

        const model = {
            uri: { toString: () => uriKey, scheme: uri?.scheme ?? 'inmemory', path: uri?.path ?? '' },
            getValue: () => currentValue,
            setValue: next => {
                if (disposed) throw new Error('Cannot setValue on disposed model')
                currentValue = next
            },
            getLanguageId: () => currentLanguage,
            setLanguage: next => { currentLanguage = next },
            isDisposed: () => disposed,
            onWillDispose: listener => {
                willDisposeListeners.add(listener)
                return { dispose: () => willDisposeListeners.delete(listener) }
            },
            dispose: () => {
                if (disposed) return
                events.push(`disposeModel:${uriKey}`)
                for (const listener of [...willDisposeListeners]) listener()
                disposed = true
                models.delete(uriKey)
            }
        }
        models.set(uriKey, model)
        return model
    }

    const monacoApi = {
        Uri: {
            from: ({ scheme, path }) => ({
                scheme,
                path,
                toString: () => `${scheme}://${path}`
            }),
            file: filePath => ({
                scheme: 'file',
                path: filePath,
                toString: () => `file://${filePath}`
            })
        },
        editor: {
            createModel,
            getModels: () => Array.from(models.values()),
            getModel: uri => models.get(typeof uri === 'string' ? uri : uri.toString()) ?? null,
            setModelLanguage: (model, languageId) => {
                model.setLanguage(languageId)
            },
            setTheme: next => {
                theme = next
            },
            createDiffEditor: (_container, initialOptions) => {
                let attached = null
                let subscriptions = []
                let editorDisposed = false
                let currentOptions = { ...initialOptions }

                const clearSubs = () => {
                    subscriptions.forEach(s => s.dispose())
                    subscriptions = []
                }

                return {
                    getModel: () => attached,
                    setModel: next => {
                        events.push(next === null ? 'setModel:null' : 'setModel:pair')
                        clearSubs()
                        attached = next
                        if (next) {
                            for (const m of [next.original, next.modified]) {
                                subscriptions.push(m.onWillDispose(() => {
                                    throw new Error('TextModel got disposed before DiffEditorWidget model got reset')
                                }))
                            }
                        }
                    },
                    updateOptions: opts => {
                        if (editorDisposed) throw new Error('Cannot updateOptions on disposed diff editor')
                        currentOptions = { ...currentOptions, ...opts }
                    },
                    getOptions: () => currentOptions,
                    dispose: () => {
                        if (editorDisposed) return
                        events.push('disposeDiffEditor')
                        clearSubs()
                        editorDisposed = true
                    }
                }
            }
        }
    }

    return {
        monacoApi,
        events,
        getTheme: () => theme,
        getLiveModels: () => Array.from(models.values())
    }
}

test('QA-05: detaches both models before disposing diff editor and owned models', () => {
    const fake = createStrictFakeMonaco()
    const controller = mountManagedDiffEditor(fake.monacoApi, {}, {
        original: 'const a = 1\n',
        modified: 'const a = 2\n',
        language: 'typescript',
        options: { renderSideBySide: true, readOnly: true },
        theme: 'kalynt-dark'
    })

    assert.equal(fake.getLiveModels().length, 2)
    assert.equal(fake.getTheme(), 'kalynt-dark')

    controller.dispose()

    assert.equal(controller.isDisposed(), true)
    assert.equal(fake.getLiveModels().length, 0)

    const resetIdx = fake.events.indexOf('setModel:null')
    const disposeEditorIdx = fake.events.indexOf('disposeDiffEditor')
    const firstModelDisposeIdx = fake.events.findIndex(e => e.startsWith('disposeModel:'))

    assert.ok(resetIdx >= 0, 'expected setModel(null) on dispose')
    assert.ok(disposeEditorIdx > resetIdx, 'diffEditor.dispose() must happen after setModel(null)')
    assert.ok(firstModelDisposeIdx > disposeEditorIdx, 'model disposal must happen after diffEditor.dispose()')

    // Double dispose is a safe no-op.
    assert.doesNotThrow(() => controller.dispose())
})

test('QA-05: repeated changed-file and history diff open/close leaks zero models and preserves main editor model', () => {
    const fake = createStrictFakeMonaco()

    // Simulate the same file already open in the main CodeEditor.
    const mainFileUri = fake.monacoApi.Uri.file('/workspace/src/app.ts')
    const mainEditorModel = fake.monacoApi.editor.createModel('export const live = true\n', 'typescript', mainFileUri)

    assert.equal(fake.getLiveModels().length, 1)

    for (let i = 0; i < 8; i++) {
        const controller = mountManagedDiffEditor(fake.monacoApi, {}, {
            original: `export const v = ${i}\n`,
            modified: `export const v = ${i + 1}\n`,
            language: 'typescript',
            options: { renderSideBySide: i % 2 === 0 },
            theme: i % 2 === 0 ? 'kalynt-dark' : 'kalynt-light'
        })

        // Two dedicated diff models + 1 main editor model = 3 total.
        assert.equal(fake.getLiveModels().length, 3)

        // Toggle layout and update content/language in-place without leaking models.
        controller.updateOptions({ renderSideBySide: i % 2 !== 0 })
        controller.updateContent(`old ${i}`, `new ${i}`, 'javascript')
        controller.updateTheme('kalynt-light')
        assert.equal(fake.getLiveModels().length, 3)

        controller.dispose()
        assert.equal(fake.getLiveModels().length, 1)
        assert.equal(mainEditorModel.isDisposed(), false)
        assert.equal(mainEditorModel.getValue(), 'export const live = true\n')
    }

    // Only the untouched main editor model remains.
    assert.deepEqual(fake.getLiveModels(), [mainEditorModel])
})

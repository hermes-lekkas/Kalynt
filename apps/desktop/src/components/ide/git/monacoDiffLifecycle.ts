/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Explicit lifecycle manager for Monaco DiffEditor instances (QA-05).
 * Creates dedicated non-file (`kalynt-diff://`) text models owned solely by
 * the diff view so main-editor `file://` models are never aliased or disposed,
 * and ALWAYS calls `diffEditor.setModel(null)` before disposing the editor
 * and its owned models.
 */

export interface DiffTextModelLike {
    getValue(): string
    setValue(value: string): void
    getLanguageId?(): string
    isDisposed?(): boolean
    dispose(): void
}

export interface DiffEditorLike<
    TModel extends DiffTextModelLike = DiffTextModelLike,
    TOptions extends object = Record<string, unknown>
> {
    setModel(model: { original: TModel; modified: TModel } | null): void
    getModel(): { original: TModel | null; modified: TModel | null } | null
    updateOptions(options: TOptions): void
    dispose(): void
}

export interface DiffMonacoLike<
    TModel extends DiffTextModelLike = DiffTextModelLike,
    TOptions extends object = Record<string, unknown>
> {
    Uri: {
        from(components: { scheme: string; path: string }): unknown
    }
    editor: {
        createModel(value: string, language?: string, uri?: unknown): TModel
        createDiffEditor(container: HTMLElement, options?: TOptions): DiffEditorLike<TModel, TOptions>
        setModelLanguage(model: TModel, languageId: string): void
        setTheme(themeName: string): void
    }
}

export interface ManagedDiffMountOptions<TOptions extends object = Record<string, unknown>> {
    original: string
    modified: string
    language: string
    options: TOptions
    theme: string
}

export interface ManagedDiffController<TOptions extends object = Record<string, unknown>> {
    updateContent: (original: string, modified: string, language: string) => void
    updateOptions: (options: TOptions) => void
    updateTheme: (theme: string) => void
    dispose: () => void
    isDisposed: () => boolean
}

let diffInstanceCounter = 0

function safeDisposeModel(model: DiffTextModelLike | null): void {
    if (!model) return
    if (typeof model.isDisposed === 'function' && model.isDisposed()) return
    model.dispose()
}

export function mountManagedDiffEditor<
    TModel extends DiffTextModelLike,
    TOptions extends object = Record<string, unknown>
>(
    monacoApi: DiffMonacoLike<TModel, TOptions>,
    container: HTMLElement,
    initial: ManagedDiffMountOptions<TOptions>
): ManagedDiffController<TOptions> {
    const instanceId = ++diffInstanceCounter
    const lang = initial.language || 'plaintext'
    const originalUri = monacoApi.Uri.from({ scheme: 'kalynt-diff', path: `/diff-${instanceId}/original` })
    const modifiedUri = monacoApi.Uri.from({ scheme: 'kalynt-diff', path: `/diff-${instanceId}/modified` })

    let ownedOriginal: TModel | null = monacoApi.editor.createModel(initial.original ?? '', lang, originalUri)
    let ownedModified: TModel | null = monacoApi.editor.createModel(initial.modified ?? '', lang, modifiedUri)
    let editor: DiffEditorLike<TModel, TOptions> | null = monacoApi.editor.createDiffEditor(container, initial.options)
    let disposed = false

    editor.setModel({ original: ownedOriginal, modified: ownedModified })
    monacoApi.editor.setTheme(initial.theme)

    return {
        updateContent(original: string, modified: string, language: string) {
            if (disposed || !ownedOriginal || !ownedModified) return
            const nextLang = language || 'plaintext'
            if (!ownedOriginal.isDisposed?.()) {
                if (ownedOriginal.getValue() !== original) ownedOriginal.setValue(original)
                if (ownedOriginal.getLanguageId?.() !== nextLang) {
                    monacoApi.editor.setModelLanguage(ownedOriginal, nextLang)
                }
            }
            if (!ownedModified.isDisposed?.()) {
                if (ownedModified.getValue() !== modified) ownedModified.setValue(modified)
                if (ownedModified.getLanguageId?.() !== nextLang) {
                    monacoApi.editor.setModelLanguage(ownedModified, nextLang)
                }
            }
        },
        updateOptions(options: TOptions) {
            if (disposed || !editor) return
            editor.updateOptions(options)
        },
        updateTheme(theme: string) {
            if (disposed) return
            monacoApi.editor.setTheme(theme)
        },
        dispose() {
            if (disposed) return
            disposed = true

            const ed = editor
            const orig = ownedOriginal
            const mod = ownedModified
            editor = null
            ownedOriginal = null
            ownedModified = null

            // Step 1: Detach both models from the DiffEditorWidget BEFORE disposing
            // either the diff editor or the models (prevents Monaco's
            // "TextModel got disposed before DiffEditorWidget model got reset").
            try {
                ed?.setModel(null)
            } finally {
                // Step 2: Dispose the DiffEditorWidget itself.
                try {
                    ed?.dispose()
                } finally {
                    // Step 3: Dispose ONLY the models created/owned exclusively by this view.
                    safeDisposeModel(orig)
                    safeDisposeModel(mod)
                }
            }
        },
        isDisposed() {
            return disposed
        }
    }
}

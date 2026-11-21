/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Renderer-side Language Server Protocol client bridged to Electron's
 * window.electronAPI.runtime.{startLSP, sendLSPRequest, stopLSP}.
 * Provides hover, completion, definition, document symbols, and pull
 * diagnostics for supported non-TS languages (Python, Go, Rust, C, C++),
 * gracefully no-oping whenever a language server binary is not installed.
 */
import type * as Monaco from 'monaco-editor'
import { useDiagnosticsStore, type DiagnosticItem, type DiagnosticSeverity } from '../stores/diagnosticsStore'

export const LSP_LANGUAGES = ['python', 'go', 'rust', 'c', 'cpp'] as const
export type LspLanguage = (typeof LSP_LANGUAGES)[number]

/** Maps Monaco language ids to backend languageGateway server configuration keys. */
function backendLanguageId(languageId: string): string | null {
    switch (languageId) {
        case 'python': return 'python'
        case 'go': return 'go'
        case 'rust': return 'rust'
        case 'c':
        case 'cpp': return 'cpp'
        default: return null
    }
}

interface LspSessionEntry {
    sessionId: string
    serverLang: string
    workspacePath: string
    pullDiagnosticsSupported: boolean
    openedUris: Map<string, number>
}

interface LspPosition {
    line: number
    character: number
}

interface LspRange {
    start: LspPosition
    end: LspPosition
}

interface LspLocation {
    uri: string
    range: LspRange
}

interface LspLocationLink {
    targetUri: string
    targetRange: LspRange
    targetSelectionRange?: LspRange
}

interface LspDiagnostic {
    range?: LspRange
    severity?: number
    code?: string | number
    source?: string
    message?: string
}

interface LspDocumentSymbol {
    name: string
    detail?: string
    kind?: number
    range?: LspRange
    selectionRange?: LspRange
    children?: LspDocumentSymbol[]
    location?: LspLocation
}

const LSP_MARKER_OWNER = 'kalynt-lsp'

function toFileUri(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/')
    if (normalized.startsWith('file://')) return normalized
    const drivePath = /^[A-Za-z]:\//.test(normalized)
    const leadingDrive = drivePath ? normalized.slice(0, 2) : ''
    const encoded = normalized.slice(leadingDrive.length)
        .split('/')
        .map(seg => encodeURIComponent(seg))
        .join('/')
    return drivePath ? `file:///${leadingDrive}${encoded}` : `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
}

function fromFileUri(uri: string): string {
    if (!uri.startsWith('file://')) return uri
    let path = decodeURIComponent(uri.replace(/^file:\/\//, ''))
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
    return path
}

function modelFilePath(model: Monaco.editor.ITextModel): string | null {
    if (model.uri.scheme !== 'file') return null
    const raw = model.uri.fsPath || model.uri.path
    if (!raw) return null
    let p = raw.replace(/\\/g, '/')
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
    return p
}

function mapLspSeverity(severity?: number): DiagnosticSeverity {
    switch (severity) {
        case 1: return 'error'
        case 2: return 'warning'
        case 3: return 'info'
        case 4: return 'hint'
        default: return 'info'
    }
}

function mapMonacoSeverity(monaco: typeof Monaco, severity?: number): Monaco.MarkerSeverity {
    switch (severity) {
        case 1: return monaco.MarkerSeverity.Error
        case 2: return monaco.MarkerSeverity.Warning
        case 3: return monaco.MarkerSeverity.Info
        case 4: return monaco.MarkerSeverity.Hint
        default: return monaco.MarkerSeverity.Info
    }
}

function mapCompletionKind(monaco: typeof Monaco, kind?: number): Monaco.languages.CompletionItemKind {
    const k = monaco.languages.CompletionItemKind
    switch (kind) {
        case 1: return k.Text
        case 2: return k.Method
        case 3: return k.Function
        case 4: return k.Constructor
        case 5: return k.Field
        case 6: return k.Variable
        case 7: return k.Class
        case 8: return k.Interface
        case 9: return k.Module
        case 10: return k.Property
        case 11: return k.Unit
        case 12: return k.Value
        case 13: return k.Enum
        case 14: return k.Keyword
        case 15: return k.Snippet
        case 16: return k.Color
        case 17: return k.File
        case 18: return k.Reference
        case 19: return k.Folder
        case 20: return k.EnumMember
        case 21: return k.Constant
        case 22: return k.Struct
        case 23: return k.Event
        case 24: return k.Operator
        case 25: return k.TypeParameter
        default: return k.Text
    }
}

function mapSymbolKind(monaco: typeof Monaco, kind?: number): Monaco.languages.SymbolKind {
    const s = monaco.languages.SymbolKind
    switch (kind) {
        case 1: return s.File
        case 2: return s.Module
        case 3: return s.Namespace
        case 4: return s.Package
        case 5: return s.Class
        case 6: return s.Method
        case 7: return s.Property
        case 8: return s.Field
        case 9: return s.Constructor
        case 10: return s.Enum
        case 11: return s.Interface
        case 12: return s.Function
        case 13: return s.Variable
        case 14: return s.Constant
        case 15: return s.String
        case 16: return s.Number
        case 17: return s.Boolean
        case 18: return s.Array
        case 19: return s.Object
        case 20: return s.Key
        case 21: return s.Null
        case 22: return s.EnumMember
        case 23: return s.Struct
        case 24: return s.Event
        case 25: return s.Operator
        case 26: return s.TypeParameter
        default: return s.Function
    }
}

function toMonacoRange(monaco: typeof Monaco, range?: LspRange): Monaco.IRange {
    if (!range) return new monaco.Range(1, 1, 1, 1)
    return new monaco.Range(
        Math.max(1, (range.start?.line ?? 0) + 1),
        Math.max(1, (range.start?.character ?? 0) + 1),
        Math.max(1, (range.end?.line ?? 0) + 1),
        Math.max(1, (range.end?.character ?? 0) + 1)
    )
}

function extractHoverMarkdown(contents: unknown): Monaco.IMarkdownString[] {
    if (!contents) return []
    if (typeof contents === 'string') return [{ value: contents }]
    if (Array.isArray(contents)) {
        return contents.flatMap(entry => extractHoverMarkdown(entry))
    }
    if (typeof contents === 'object') {
        const obj = contents as { kind?: string; value?: string; language?: string }
        if (typeof obj.value === 'string') {
            if (obj.language) return [{ value: `\`\`\`${obj.language}\n${obj.value}\n\`\`\`` }]
            return [{ value: obj.value }]
        }
    }
    return []
}

class LspClientManager {
    private sessions = new Map<string, LspSessionEntry>()
    private starting = new Map<string, Promise<LspSessionEntry | null>>()
    private unavailable = new Map<string, { error: string; actionableHint?: string }>()
    private workspacePath: string | null = null
    private providersRegistered = false
    private disposables: Monaco.IDisposable[] = []
    private diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>()
    private monacoRef: typeof Monaco | null = null
    private stopListenerOff: (() => void) | null = null
    private notificationListenerOff: (() => void) | null = null

    private sessionKey(workspacePath: string, serverLang: string): string {
        return `${workspacePath.replace(/\\/g, '/')}::${serverLang}`
    }

    getUnavailableReason(languageId: string, workspaceOverride?: string | null): { error: string; actionableHint?: string } | null {
        const workspace = (workspaceOverride ?? this.workspacePath)?.replace(/\\/g, '/')
        const serverLang = backendLanguageId(languageId)
        if (!workspace || !serverLang) return null
        return this.unavailable.get(this.sessionKey(workspace, serverLang)) ?? null
    }

    setWorkspace(workspacePath: string | null): void {
        const prev = this.workspacePath
        const next = workspacePath ? workspacePath.replace(/\\/g, '/') : null
        if (prev === next) return
        this.workspacePath = next
        if (prev) {
            void this.stopWorkspace(prev)
        }
        useDiagnosticsStore.getState().clearOrigin('lsp')
        if (this.monacoRef) {
            for (const model of this.monacoRef.editor.getModels()) {
                if (!model.isDisposed()) {
                    this.monacoRef.editor.setModelMarkers(model, LSP_MARKER_OWNER, [])
                }
            }
        }
    }

    getWorkspace(): string | null {
        return this.workspacePath
    }

    async ensureSession(languageId: string, workspaceOverride?: string | null): Promise<LspSessionEntry | null> {
        const runtime = typeof window !== 'undefined' ? window.electronAPI?.runtime : undefined
        if (!runtime?.startLSP || !runtime?.sendLSPRequest) return null

        const workspace = (workspaceOverride ?? this.workspacePath)?.replace(/\\/g, '/')
        const serverLang = backendLanguageId(languageId)
        if (!workspace || !serverLang) return null

        const key = this.sessionKey(workspace, serverLang)
        if (this.unavailable.has(key)) return null

        const existing = this.sessions.get(key)
        if (existing) return existing

        const inflight = this.starting.get(key)
        if (inflight) return inflight

        const sessionId = `kalynt-lsp-${serverLang}-${Date.now()}`
        const promise = runtime
            .startLSP(sessionId, serverLang, workspace, { timeoutMs: 8000 })
            .then(result => {
                this.starting.delete(key)
                if (!result?.success) {
                    // Server binary or module unavailable; remember actionable reason and gracefully no-op.
                    const typed = result as { error?: string; actionableHint?: string } | undefined
                    this.unavailable.set(key, {
                        error: typed?.error || `${serverLang} language server is unavailable`,
                        actionableHint: typed?.actionableHint
                    })
                    return null
                }
                const entry: LspSessionEntry = {
                    sessionId: (result as { sessionId?: string }).sessionId ?? sessionId,
                    serverLang,
                    workspacePath: workspace,
                    pullDiagnosticsSupported: true,
                    openedUris: new Map()
                }
                this.sessions.set(key, entry)
                return entry
            })
            .catch((err) => {
                this.starting.delete(key)
                this.unavailable.set(key, {
                    error: err instanceof Error ? err.message : String(err)
                })
                return null
            })

        this.starting.set(key, promise)
        return promise
    }

    private async sendRequest<T>(session: LspSessionEntry, method: string, params: unknown): Promise<T | null> {
        const runtime = typeof window !== 'undefined' ? window.electronAPI?.runtime : undefined
        if (!runtime?.sendLSPRequest) return null
        try {
            const response = await runtime.sendLSPRequest(session.sessionId, method, params)
            if (!response?.success) return null
            return (response.result ?? null) as T | null
        } catch {
            return null
        }
    }

    private async sendNotification(session: LspSessionEntry, method: string, params?: unknown): Promise<boolean> {
        const runtime = typeof window !== 'undefined' ? window.electronAPI?.runtime : undefined
        if (!runtime) return false
        try {
            const sendNotif = (runtime as { sendLSPNotification?: (sessionId: string, method: string, params?: unknown) => Promise<{ success?: boolean }> }).sendLSPNotification
            if (typeof sendNotif === 'function') {
                const response = await sendNotif(session.sessionId, method, params)
                return Boolean(response?.success)
            }
            // Fallback for older shims (gateway also routes standard notifications cleanly)
            if (typeof runtime.sendLSPRequest === 'function') {
                const response = await runtime.sendLSPRequest(session.sessionId, method, params)
                return Boolean(response?.success)
            }
            return false
        } catch {
            return false
        }
    }

    private applyDiagnostics(
        filePath: string,
        rawItems: LspDiagnostic[],
        sourceFallback: string,
        explicitModel?: Monaco.editor.ITextModel | null
    ): void {
        const validItems = rawItems.filter(d => typeof d?.message === 'string' && d.message.length > 0)
        const items: DiagnosticItem[] = validItems.map((d, idx) => ({
            id: `lsp:${filePath}:${(d.range?.start?.line ?? 0) + 1}:${(d.range?.start?.character ?? 0) + 1}:${idx}`,
            file: filePath,
            line: Math.max(1, (d.range?.start?.line ?? 0) + 1),
            column: Math.max(1, (d.range?.start?.character ?? 0) + 1),
            endLine: d.range?.end ? d.range.end.line + 1 : undefined,
            endColumn: d.range?.end ? d.range.end.character + 1 : undefined,
            severity: mapLspSeverity(d.severity),
            message: d.message ?? '',
            source: d.source || sourceFallback,
            code: d.code != null ? String(d.code) : undefined,
            origin: 'lsp'
        }))

        useDiagnosticsStore.getState().setFileDiagnostics('lsp', filePath, items)

        if (this.monacoRef) {
            const monaco = this.monacoRef
            const normalizedPath = filePath.replace(/\\/g, '/')
            const model = (explicitModel && !explicitModel.isDisposed())
                ? explicitModel
                : monaco.editor.getModels().find(m => !m.isDisposed() && modelFilePath(m) === normalizedPath) ?? null

            if (model && !model.isDisposed()) {
                const markers: Monaco.editor.IMarkerData[] = validItems.map(d => {
                    const r = toMonacoRange(monaco, d.range)
                    return {
                        severity: mapMonacoSeverity(monaco, d.severity),
                        message: d.message ?? '',
                        source: d.source || sourceFallback,
                        code: d.code != null ? String(d.code) : undefined,
                        startLineNumber: r.startLineNumber,
                        startColumn: r.startColumn,
                        endLineNumber: r.endLineNumber,
                        endColumn: r.endColumn
                    }
                })
                monaco.editor.setModelMarkers(model, LSP_MARKER_OWNER, markers)
            }
        }
    }

    handleServerNotification(data: { sessionId: string; languageId?: string; method: string; params: unknown }): void {
        if (!data || data.method !== 'textDocument/publishDiagnostics') return
        const params = data.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined
        if (!params?.uri) return

        const filePath = fromFileUri(params.uri).replace(/\\/g, '/')
        const rawItems = Array.isArray(params.diagnostics) ? params.diagnostics : []
        let sourceFallback = data.languageId || 'lsp'
        for (const entry of this.sessions.values()) {
            if (entry.sessionId === data.sessionId) {
                sourceFallback = entry.serverLang
                break
            }
        }
        this.applyDiagnostics(filePath, rawItems, sourceFallback)
    }

    async syncDocument(model: Monaco.editor.ITextModel): Promise<LspSessionEntry | null> {
        const filePath = modelFilePath(model)
        if (!filePath) return null
        const lang = model.getLanguageId()
        const session = await this.ensureSession(lang)
        if (!session) return null

        const uri = toFileUri(filePath)
        const version = model.getVersionId()
        const lastVersion = session.openedUris.get(uri)

        if (lastVersion === version) return session

        if (lastVersion === undefined) {
            session.openedUris.set(uri, version)
            await this.sendNotification(session, 'textDocument/didOpen', {
                textDocument: {
                    uri,
                    languageId: lang,
                    version,
                    text: model.getValue()
                }
            })
        } else {
            session.openedUris.set(uri, version)
            await this.sendNotification(session, 'textDocument/didChange', {
                textDocument: { uri, version },
                contentChanges: [{ text: model.getValue() }]
            })
        }

        return session
    }

    async notifyDidSave(model: Monaco.editor.ITextModel): Promise<void> {
        const filePath = modelFilePath(model)
        if (!filePath) return
        const session = await this.syncDocument(model)
        if (!session) return
        const uri = toFileUri(filePath)
        await this.sendNotification(session, 'textDocument/didSave', {
            textDocument: { uri },
            text: model.getValue()
        })
    }

    async notifyDidClose(model: Monaco.editor.ITextModel): Promise<void> {
        const filePath = modelFilePath(model)
        if (!filePath) return
        const serverLang = backendLanguageId(model.getLanguageId())
        const workspace = this.workspacePath?.replace(/\\/g, '/')
        if (!serverLang || !workspace) return
        const session = this.sessions.get(this.sessionKey(workspace, serverLang))
        if (!session) return

        const uri = toFileUri(filePath)
        if (!session.openedUris.has(uri)) return
        session.openedUris.delete(uri)
        await this.sendNotification(session, 'textDocument/didClose', {
            textDocument: { uri }
        })
    }

    scheduleDiagnostics(model: Monaco.editor.ITextModel): void {
        const filePath = modelFilePath(model)
        if (!filePath) return
        if (!backendLanguageId(model.getLanguageId())) return

        const existing = this.diagnosticTimers.get(filePath)
        if (existing) clearTimeout(existing)

        const timer = setTimeout(() => {
            this.diagnosticTimers.delete(filePath)
            if (model.isDisposed()) return
            void this.pullDiagnostics(model)
        }, 500)
        this.diagnosticTimers.set(filePath, timer)
    }

    async pullDiagnostics(model: Monaco.editor.ITextModel): Promise<void> {
        const filePath = modelFilePath(model)
        if (!filePath) return
        const session = await this.syncDocument(model)
        if (!session || !session.pullDiagnosticsSupported || model.isDisposed()) return

        const runtime = typeof window !== 'undefined' ? window.electronAPI?.runtime : undefined
        if (!runtime?.sendLSPRequest) return

        const uri = toFileUri(filePath)
        try {
            const response = await runtime.sendLSPRequest(session.sessionId, 'textDocument/diagnostic', {
                textDocument: { uri }
            })
            if (!response?.success) {
                const errText = String(response?.error ?? '').toLowerCase()
                if (errText.includes('method not found') || errText.includes('unhandled') || errText.includes('-32601')) {
                    session.pullDiagnosticsSupported = false
                }
                return
            }

            const result = response.result as { items?: LspDiagnostic[] } | LspDiagnostic[] | null
            const rawItems: LspDiagnostic[] = Array.isArray(result)
                ? result
                : Array.isArray(result?.items)
                    ? result.items
                    : []

            this.applyDiagnostics(filePath, rawItems, session.serverLang, model)
        } catch {
            session.pullDiagnosticsSupported = false
        }
    }

    async getDocumentSymbols(model: Monaco.editor.ITextModel): Promise<LspDocumentSymbol[]> {
        const filePath = modelFilePath(model)
        if (!filePath) return []
        const session = await this.syncDocument(model)
        if (!session) return []
        const result = await this.sendRequest<LspDocumentSymbol[]>(session, 'textDocument/documentSymbol', {
            textDocument: { uri: toFileUri(filePath) }
        })
        return Array.isArray(result) ? result : []
    }

    registerProviders(monaco: typeof Monaco): void {
        if (this.providersRegistered) return
        this.providersRegistered = true
        this.monacoRef = monaco

        // Listen for backend server stops to evict dead sessions cleanly.
        const runtime = typeof window !== 'undefined' ? window.electronAPI?.runtime : undefined
        const off = runtime?.onLanguageServerStopped?.((data: { sessionId: string }) => {
            for (const [key, entry] of this.sessions.entries()) {
                if (entry.sessionId === data.sessionId) {
                    this.sessions.delete(key)
                    break
                }
            }
        }) as unknown
        if (typeof off === 'function') this.stopListenerOff = off as () => void

        // Listen for server-pushed LSP notifications (e.g. textDocument/publishDiagnostics).
        const onNotif = (runtime as { onLSPNotification?: (cb: (data: { sessionId: string; languageId?: string; method: string; params: unknown }) => void) => unknown } | undefined)?.onLSPNotification
        const offNotif = onNotif?.((data) => {
            this.handleServerNotification(data)
        })
        if (typeof offNotif === 'function') this.notificationListenerOff = offNotif as () => void

        for (const lang of LSP_LANGUAGES) {
            // Hover provider
            this.disposables.push(
                monaco.languages.registerHoverProvider(lang, {
                    provideHover: async (model, position) => {
                        const filePath = modelFilePath(model)
                        if (!filePath) return null
                        const session = await this.syncDocument(model)
                        if (!session) return null
                        const hover = await this.sendRequest<{ contents?: unknown; range?: LspRange }>(
                            session,
                            'textDocument/hover',
                            {
                                textDocument: { uri: toFileUri(filePath) },
                                position: { line: position.lineNumber - 1, character: position.column - 1 }
                            }
                        )
                        if (!hover?.contents) return null
                        const contents = extractHoverMarkdown(hover.contents)
                        if (!contents.length) return null
                        return {
                            contents,
                            range: hover.range ? toMonacoRange(monaco, hover.range) : undefined
                        }
                    }
                })
            )

            // Completion provider
            this.disposables.push(
                monaco.languages.registerCompletionItemProvider(lang, {
                    triggerCharacters: ['.', ':', '>', '/'],
                    provideCompletionItems: async (model, position) => {
                        const filePath = modelFilePath(model)
                        if (!filePath) return { suggestions: [] }
                        const session = await this.syncDocument(model)
                        if (!session) return { suggestions: [] }
                        const res = await this.sendRequest<
                            | { items?: Array<Record<string, unknown>>; isIncomplete?: boolean }
                            | Array<Record<string, unknown>>
                        >(session, 'textDocument/completion', {
                            textDocument: { uri: toFileUri(filePath) },
                            position: { line: position.lineNumber - 1, character: position.column - 1 }
                        })
                        if (!res) return { suggestions: [] }
                        const rawItems = Array.isArray(res) ? res : Array.isArray(res.items) ? res.items : []
                        const word = model.getWordUntilPosition(position)
                        const defaultRange = new monaco.Range(
                            position.lineNumber,
                            word.startColumn,
                            position.lineNumber,
                            word.endColumn
                        )

                        const suggestions: Monaco.languages.CompletionItem[] = rawItems.slice(0, 200).map(item => {
                            const label = String(item.label ?? '')
                            const textEdit = item.textEdit as { newText?: string; range?: LspRange } | undefined
                            const insertText = typeof textEdit?.newText === 'string'
                                ? textEdit.newText
                                : typeof item.insertText === 'string'
                                    ? item.insertText
                                    : label
                            const isSnippet = item.insertTextFormat === 2
                            const doc = item.documentation
                            const documentation = typeof doc === 'string'
                                ? doc
                                : doc && typeof doc === 'object' && typeof (doc as { value?: string }).value === 'string'
                                    ? { value: (doc as { value: string }).value }
                                    : undefined
                            return {
                                label,
                                kind: mapCompletionKind(monaco, typeof item.kind === 'number' ? item.kind : undefined),
                                detail: typeof item.detail === 'string' ? item.detail : undefined,
                                documentation,
                                insertText,
                                insertTextRules: isSnippet
                                    ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                                    : undefined,
                                sortText: typeof item.sortText === 'string' ? item.sortText : undefined,
                                filterText: typeof item.filterText === 'string' ? item.filterText : undefined,
                                range: textEdit?.range ? toMonacoRange(monaco, textEdit.range) : defaultRange
                            }
                        })

                        return {
                            suggestions,
                            incomplete: !Array.isArray(res) && Boolean(res.isIncomplete)
                        }
                    }
                })
            )

            // Definition provider
            this.disposables.push(
                monaco.languages.registerDefinitionProvider(lang, {
                    provideDefinition: async (model, position) => {
                        const filePath = modelFilePath(model)
                        if (!filePath) return null
                        const session = await this.syncDocument(model)
                        if (!session) return null
                        const res = await this.sendRequest<LspLocation | LspLocation[] | LspLocationLink[]>(
                            session,
                            'textDocument/definition',
                            {
                                textDocument: { uri: toFileUri(filePath) },
                                position: { line: position.lineNumber - 1, character: position.column - 1 }
                            }
                        )
                        if (!res) return null
                        const list = Array.isArray(res) ? res : [res]
                        const locations: Monaco.languages.Location[] = []
                        for (const entry of list) {
                            if ('targetUri' in entry && entry.targetUri) {
                                locations.push({
                                    uri: monaco.Uri.file(fromFileUri(entry.targetUri)),
                                    range: toMonacoRange(monaco, entry.targetSelectionRange ?? entry.targetRange)
                                })
                            } else if ('uri' in entry && entry.uri) {
                                locations.push({
                                    uri: monaco.Uri.file(fromFileUri(entry.uri)),
                                    range: toMonacoRange(monaco, entry.range)
                                })
                            }
                        }
                        return locations
                    }
                })
            )

            // Document symbol provider (enriches breadcrumbs & outline)
            this.disposables.push(
                monaco.languages.registerDocumentSymbolProvider(lang, {
                    provideDocumentSymbols: async (model) => {
                        const raw = await this.getDocumentSymbols(model)
                        const convert = (sym: LspDocumentSymbol): Monaco.languages.DocumentSymbol => {
                            const range = toMonacoRange(monaco, sym.range ?? sym.location?.range)
                            const selectionRange = toMonacoRange(monaco, sym.selectionRange ?? sym.range ?? sym.location?.range)
                            return {
                                name: sym.name,
                                detail: sym.detail ?? '',
                                kind: mapSymbolKind(monaco, sym.kind),
                                tags: [],
                                range,
                                selectionRange,
                                children: Array.isArray(sym.children) ? sym.children.map(convert) : []
                            }
                        }
                        return raw.filter(s => !!s?.name).map(convert)
                    }
                })
            )
        }

        // Watch newly created models for supported LSP languages to sync & pull diagnostics.
        const attachModel = (model: Monaco.editor.ITextModel) => {
            if (!backendLanguageId(model.getLanguageId())) return
            this.scheduleDiagnostics(model)
            const changeSub = model.onDidChangeContent(() => {
                if (backendLanguageId(model.getLanguageId())) {
                    this.scheduleDiagnostics(model)
                }
            })
            const disposeSub = model.onWillDispose(() => {
                changeSub.dispose()
                disposeSub.dispose()
                void this.notifyDidClose(model)
                const filePath = modelFilePath(model)
                if (filePath) {
                    const timer = this.diagnosticTimers.get(filePath)
                    if (timer) {
                        clearTimeout(timer)
                        this.diagnosticTimers.delete(filePath)
                    }
                    useDiagnosticsStore.getState().setFileDiagnostics('lsp', filePath, [])
                }
            })
        }

        monaco.editor.getModels().forEach(attachModel)
        this.disposables.push(monaco.editor.onDidCreateModel(attachModel))
    }

    async stopWorkspace(workspacePath: string): Promise<void> {
        const normalized = workspacePath.replace(/\\/g, '/')
        const runtime = typeof window !== 'undefined' ? window.electronAPI?.runtime : undefined
        const toStop: Array<[string, LspSessionEntry]> = []
        for (const [key, entry] of this.sessions.entries()) {
            if (entry.workspacePath === normalized) {
                toStop.push([key, entry])
            }
        }
        for (const [key, entry] of toStop) {
            this.sessions.delete(key)
            for (const uri of entry.openedUris.keys()) {
                await this.sendNotification(entry, 'textDocument/didClose', { textDocument: { uri } })
            }
            entry.openedUris.clear()
            await runtime?.stopLSP?.(entry.sessionId).catch(() => undefined)
        }
        for (const key of Array.from(this.unavailable.keys())) {
            if (key.startsWith(`${normalized}::`)) this.unavailable.delete(key)
        }
    }

    async dispose(): Promise<void> {
        this.diagnosticTimers.forEach(t => clearTimeout(t))
        this.diagnosticTimers.clear()
        this.stopListenerOff?.()
        this.stopListenerOff = null
        this.notificationListenerOff?.()
        this.notificationListenerOff = null
        this.disposables.forEach(d => d.dispose())
        this.disposables = []
        this.providersRegistered = false
        const runtime = typeof window !== 'undefined' ? window.electronAPI?.runtime : undefined
        const entries = Array.from(this.sessions.values())
        this.sessions.clear()
        this.starting.clear()
        this.unavailable.clear()
        await Promise.all(entries.map(e => runtime?.stopLSP?.(e.sessionId).catch(() => undefined)))
    }
}

export const lspClient = new LspClientManager()

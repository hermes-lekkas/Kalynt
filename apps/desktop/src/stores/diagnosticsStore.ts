/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Central diagnostics store aggregating live Monaco editor markers, build
 * task problems, and LSP diagnostics. Emits `kalynt-diagnostics-summary` on
 * window whenever error/warning counts change so StatusBar stays live.
 */
import { create } from 'zustand'
import type * as Monaco from 'monaco-editor'

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'
export type DiagnosticOrigin = 'monaco' | 'build' | 'lsp'

export interface DiagnosticItem {
    id: string
    file: string
    line: number
    column: number
    endLine?: number
    endColumn?: number
    severity: DiagnosticSeverity
    message: string
    source?: string
    code?: string
    origin: DiagnosticOrigin
}

export interface DiagnosticCounts {
    errors: number
    warnings: number
    infos: number
    total: number
}

export interface RawBuildProblem {
    file?: string
    line?: number
    column?: number
    endLine?: number
    endColumn?: number
    severity?: string
    message?: string
    code?: string | number
    source?: string
}

interface MonacoMarkerLike {
    resource?: { fsPath?: string; path?: string; scheme?: string; toString?: () => string }
    owner?: string
    severity: number
    message: string
    startLineNumber: number
    startColumn: number
    endLineNumber?: number
    endColumn?: number
    source?: string
    code?: string | { value: string }
}

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
    error: 0,
    warning: 1,
    info: 2,
    hint: 3
}

function normalizeFilePath(rawPath: string): string {
    let p = rawPath.replace(/\\/g, '/')
    // Strip leading slash on Windows drive paths like /C:/Users/...
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
    return p
}

function uriToFilePath(resource?: MonacoMarkerLike['resource']): string | null {
    if (!resource) return null
    if (resource.scheme && resource.scheme !== 'file') return null
    const raw = resource.fsPath || resource.path
    if (!raw) return null
    return normalizeFilePath(raw)
}

function monacoSeverity(level: number): DiagnosticSeverity {
    // Monaco MarkerSeverity: Hint=1, Info=2, Warning=4, Error=8
    if (level >= 8) return 'error'
    if (level >= 4) return 'warning'
    if (level >= 2) return 'info'
    return 'hint'
}

function normalizeSeverity(raw?: string): DiagnosticSeverity {
    const lower = (raw ?? '').toLowerCase()
    if (lower.includes('err')) return 'error'
    if (lower.includes('warn')) return 'warning'
    if (lower.includes('hint')) return 'hint'
    return 'info'
}

function mergeDiagnostics(byOrigin: Record<DiagnosticOrigin, DiagnosticItem[]>): {
    items: DiagnosticItem[]
    counts: DiagnosticCounts
} {
    const combined = [...byOrigin.monaco, ...byOrigin.lsp, ...byOrigin.build]
    const seen = new Set<string>()
    const deduped: DiagnosticItem[] = []

    for (const item of combined) {
        const key = `${item.file.toLowerCase()}|${item.line}|${item.column}|${item.severity}|${item.message}`
        if (seen.has(key)) continue
        seen.add(key)
        deduped.push(item)
    }

    deduped.sort((a, b) => {
        const fileCmp = a.file.localeCompare(b.file)
        if (fileCmp !== 0) return fileCmp
        const sevCmp = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
        if (sevCmp !== 0) return sevCmp
        if (a.line !== b.line) return a.line - b.line
        return a.column - b.column
    })

    let errors = 0
    let warnings = 0
    let infos = 0
    for (const item of deduped) {
        if (item.severity === 'error') errors++
        else if (item.severity === 'warning') warnings++
        else infos++
    }

    return {
        items: deduped,
        counts: { errors, warnings, infos, total: deduped.length }
    }
}

let lastDispatchedErrors = -1
let lastDispatchedWarnings = -1

function emitSummaryIfChanged(counts: DiagnosticCounts) {
    if (typeof window === 'undefined') return
    if (counts.errors === lastDispatchedErrors && counts.warnings === lastDispatchedWarnings) return
    lastDispatchedErrors = counts.errors
    lastDispatchedWarnings = counts.warnings
    window.dispatchEvent(
        new CustomEvent('kalynt-diagnostics-summary', {
            detail: {
                errors: counts.errors,
                warnings: counts.warnings,
                infos: counts.infos,
                total: counts.total
            }
        })
    )
}

interface DiagnosticsState {
    byOrigin: Record<DiagnosticOrigin, DiagnosticItem[]>
    items: DiagnosticItem[]
    counts: DiagnosticCounts
    setOriginDiagnostics: (origin: DiagnosticOrigin, items: DiagnosticItem[]) => void
    setFileDiagnostics: (origin: DiagnosticOrigin, file: string, items: DiagnosticItem[]) => void
    setBuildProblems: (problems: RawBuildProblem[], workspaceRoot?: string | null) => void
    syncMonacoMarkers: (markers: ReadonlyArray<MonacoMarkerLike>) => void
    clearOrigin: (origin: DiagnosticOrigin) => void
    clearAll: () => void
}

const EMPTY_BY_ORIGIN: Record<DiagnosticOrigin, DiagnosticItem[]> = {
    monaco: [],
    build: [],
    lsp: []
}

const EMPTY_COUNTS: DiagnosticCounts = {
    errors: 0,
    warnings: 0,
    infos: 0,
    total: 0
}

export const useDiagnosticsStore = create<DiagnosticsState>((set, get) => {
    const commit = (byOrigin: Record<DiagnosticOrigin, DiagnosticItem[]>) => {
        const { items, counts } = mergeDiagnostics(byOrigin)
        set({ byOrigin, items, counts })
        emitSummaryIfChanged(counts)
    }

    return {
        byOrigin: EMPTY_BY_ORIGIN,
        items: [],
        counts: EMPTY_COUNTS,

        setOriginDiagnostics: (origin, items) => {
            const current = get().byOrigin
            const next: Record<DiagnosticOrigin, DiagnosticItem[]> = {
                monaco: origin === 'monaco' ? items : current.monaco,
                build: origin === 'build' ? items : current.build,
                lsp: origin === 'lsp' ? items : current.lsp
            }
            commit(next)
        },

        setFileDiagnostics: (origin, file, fileItems) => {
            const normalized = normalizeFilePath(file)
            const current = get().byOrigin
            const existing = origin === 'monaco' ? current.monaco : origin === 'build' ? current.build : current.lsp
            const filtered = existing.filter(item => item.file.toLowerCase() !== normalized.toLowerCase())
            const updated = [...filtered, ...fileItems.map(item => ({ ...item, file: normalized, origin }))]
            const next: Record<DiagnosticOrigin, DiagnosticItem[]> = {
                monaco: origin === 'monaco' ? updated : current.monaco,
                build: origin === 'build' ? updated : current.build,
                lsp: origin === 'lsp' ? updated : current.lsp
            }
            commit(next)
        },

        setBuildProblems: (problems, workspaceRoot) => {
            const root = workspaceRoot ? normalizeFilePath(workspaceRoot).replace(/\/+$/, '') : null
            const parsed: DiagnosticItem[] = []
            for (let i = 0; i < problems.length; i++) {
                const raw = problems[i]
                if (!raw?.file || !raw?.message) continue
                let file = normalizeFilePath(raw.file)
                if (root && !file.startsWith('/') && !/^[A-Za-z]:\//.test(file)) {
                    file = `${root}/${file}`
                }
                const line = Math.max(1, Number(raw.line) || 1)
                const column = Math.max(1, Number(raw.column) || 1)
                parsed.push({
                    id: `build:${file}:${line}:${column}:${i}`,
                    file,
                    line,
                    column,
                    endLine: raw.endLine,
                    endColumn: raw.endColumn,
                    severity: normalizeSeverity(raw.severity),
                    message: String(raw.message).trim(),
                    source: raw.source || 'build',
                    code: raw.code != null ? String(raw.code) : undefined,
                    origin: 'build'
                })
            }
            get().setOriginDiagnostics('build', parsed)
        },

        syncMonacoMarkers: (markers) => {
            const next: DiagnosticItem[] = []
            for (let i = 0; i < markers.length; i++) {
                const marker = markers[i]
                // LSP markers set directly on Monaco are tracked under the 'lsp' origin.
                if (marker.owner === 'kalynt-lsp') continue
                const file = uriToFilePath(marker.resource)
                if (!file || !marker.message) continue
                const code = typeof marker.code === 'string'
                    ? marker.code
                    : marker.code && typeof marker.code === 'object'
                        ? String(marker.code.value)
                        : undefined
                next.push({
                    id: `monaco:${file}:${marker.startLineNumber}:${marker.startColumn}:${i}`,
                    file,
                    line: Math.max(1, marker.startLineNumber || 1),
                    column: Math.max(1, marker.startColumn || 1),
                    endLine: marker.endLineNumber,
                    endColumn: marker.endColumn,
                    severity: monacoSeverity(marker.severity),
                    message: marker.message,
                    source: marker.source || marker.owner || 'editor',
                    code,
                    origin: 'monaco'
                })
            }
            get().setOriginDiagnostics('monaco', next)
        },

        clearOrigin: (origin) => {
            get().setOriginDiagnostics(origin, [])
        },

        clearAll: () => {
            commit({ monaco: [], build: [], lsp: [] })
        }
    }
})

let monacoAttached = false
let markerSyncTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Subscribes once to Monaco's global marker change feed so diagnostics in
 * every open model stay reflected in the Problems panel and StatusBar.
 */
export function attachMonacoDiagnostics(monacoInstance: typeof Monaco): void {
    if (monacoAttached) return
    monacoAttached = true

    const syncNow = () => {
        try {
            const markers = monacoInstance.editor.getModelMarkers({})
            useDiagnosticsStore.getState().syncMonacoMarkers(markers)
        } catch {
            // Monaco may not be initialized in headless test environments
        }
    }

    monacoInstance.editor.onDidChangeMarkers(() => {
        if (markerSyncTimer) clearTimeout(markerSyncTimer)
        markerSyncTimer = setTimeout(() => {
            markerSyncTimer = null
            syncNow()
        }, 120)
    })

    syncNow()
}

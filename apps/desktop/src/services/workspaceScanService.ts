/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { aiService, type AIProvider } from './aiService'
import { offlineLLMService } from './offlineLLMService'

export type IssueType = 'bug' | 'security' | 'performance' | 'improvement'
export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type ScanScope = 'sampled' | 'full'
export type ScanOutcome = 'completed' | 'partial' | 'canceled' | 'failed'
export type OmittedReason = 'file_cap' | 'depth_limit' | 'short_file' | 'empty_file' | 'unreadable' | 'canceled' | 'error'

export interface ReviewedRange {
    startLine: number
    endLine: number
    totalLines: number
    truncated: boolean
}

export interface ScanIssue {
    file: string
    path: string
    type: IssueType
    severity: Severity
    line?: number
    description: string
    suggestion: string
    reviewedRange?: ReviewedRange
}

export interface ScanError {
    file: string
    path: string
    reason: string
}

export interface OmittedFile {
    file: string
    path: string
    reason: OmittedReason
    detail?: string
}

export interface ScanLimits {
    scope: ScanScope
    maxFiles: number | null
    maxDepth: number | null
    minLines: number
    maxLinesPerFile: number
}

export interface ScanProgress {
    current: number
    total: number
    currentFile: string
    status: 'indexing' | 'analyzing' | 'completed' | 'canceled' | 'error'
}

export interface ScanStats {
    totalFiles: number
    discoveredFiles: number
    selectedFiles: number
    analyzedFiles: number
    omittedFiles: number
    clippedFiles: number
    ignoredDirs: number
    omittedByReason: Partial<Record<OmittedReason, number>>
    scope: ScanScope
    limits: ScanLimits
    duration: number
}

export interface ScanResult {
    outcome: ScanOutcome
    issues: ScanIssue[]
    errors: ScanError[]
    omitted: OmittedFile[]
    stats: ScanStats
    message?: string
}

export interface WorkspaceScanDeps {
    readDir: (path: string) => Promise<{ success?: boolean; items?: Array<{ name: string; isDirectory: boolean; size?: number }> } | undefined>
    readFile: (path: string) => Promise<{ success?: boolean; content?: string; error?: string } | undefined>
    chat: (
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        provider: AIProvider,
        options: { temperature?: number; maxTokens?: number; model?: string; signal?: AbortSignal }
    ) => Promise<{ content: string; error?: string }>
    offlineGenerate?: (
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        options: { temperature?: number; maxTokens?: number }
    ) => Promise<string>
    offlineCancel?: () => Promise<unknown>
    offlineIsGenerating?: () => boolean
}

export interface ScanOptions {
    aiMode: 'cloud' | 'offline'
    provider: AIProvider
    cloudModel?: string
    loadedModelId?: string | null
    scope?: ScanScope
    onProgress: (progress: ScanProgress) => void
    deps?: WorkspaceScanDeps
}

interface DiscoveredFile {
    name: string
    path: string
    size?: number
    depth: number
}

export const SAMPLED_MAX_FILES = 25
export const SAMPLED_MAX_DEPTH = 5
export const SAMPLED_MIN_LINES = 5
const MAX_SAFE_WALK_DEPTH = 64

export function getScanLimits(scope: ScanScope, aiMode: 'cloud' | 'offline'): ScanLimits {
    const maxLinesPerFile = aiMode === 'offline' ? 80 : 500
    if (scope === 'full') {
        return {
            scope: 'full',
            maxFiles: null,
            maxDepth: null,
            minLines: 1,
            maxLinesPerFile
        }
    }
    return {
        scope: 'sampled',
        maxFiles: SAMPLED_MAX_FILES,
        maxDepth: SAMPLED_MAX_DEPTH,
        minLines: SAMPLED_MIN_LINES,
        maxLinesPerFile
    }
}

function summarizeOmitted(omitted: OmittedFile[]): Partial<Record<OmittedReason, number>> {
    const counts: Partial<Record<OmittedReason, number>> = {}
    for (const entry of omitted) {
        counts[entry.reason] = (counts[entry.reason] ?? 0) + 1
    }
    return counts
}

function defaultDeps(): WorkspaceScanDeps {
    return {
        readDir: (p) => globalThis.window?.electronAPI?.fs?.readDir(p),
        readFile: (p) => globalThis.window?.electronAPI?.fs?.readFile(p),
        chat: (messages, provider, options) => aiService.chat(messages, provider, options),
        offlineGenerate: (messages, options) => offlineLLMService.generate(messages, options),
        offlineCancel: () => offlineLLMService.cancelGeneration(),
        offlineIsGenerating: () => offlineLLMService?.isGenerating() ?? false
    }
}

export class WorkspaceScanService {
    private static instance: WorkspaceScanService
    private isScanning = false
    private shouldStop = false
    private abortController: AbortController | null = null
    private activeScan: Promise<ScanResult> | null = null
    private activeDeps: WorkspaceScanDeps | null = null

    private constructor() {}

    static getInstance(): WorkspaceScanService {
        if (!WorkspaceScanService.instance) {
            WorkspaceScanService.instance = new WorkspaceScanService()
        }
        return WorkspaceScanService.instance
    }

    async stopScan() {
        this.shouldStop = true
        this.abortController?.abort()
        const deps = this.activeDeps
        if (deps?.offlineIsGenerating?.()) {
            await deps.offlineCancel?.().catch(() => undefined)
        } else if (!deps && offlineLLMService?.isGenerating()) {
            await offlineLLMService.cancelGeneration().catch(() => undefined)
        }
        if (this.activeScan) {
            await this.activeScan.catch(() => undefined)
        }
    }

    async scanWorkspace(
        workspacePath: string,
        options: ScanOptions
    ): Promise<ScanResult> {
        const scope: ScanScope = options.scope ?? 'sampled'
        const limits = getScanLimits(scope, options.aiMode)
        if (this.isScanning) {
            return {
                outcome: 'failed',
                issues: [],
                errors: [{ file: 'Review', path: '', reason: 'A workspace review is already running.' }],
                omitted: [],
                stats: {
                    totalFiles: 0,
                    discoveredFiles: 0,
                    selectedFiles: 0,
                    analyzedFiles: 0,
                    omittedFiles: 0,
                    clippedFiles: 0,
                    ignoredDirs: 0,
                    omittedByReason: {},
                    scope,
                    limits,
                    duration: 0
                },
                message: 'A workspace review is already running.'
            }
        }
        this.isScanning = true
        this.shouldStop = false
        const controller = new AbortController()
        this.abortController = controller
        const deps = options.deps ?? defaultDeps()
        this.activeDeps = deps

        const run = this.executeScan(workspacePath, options, limits, deps, controller.signal)
        this.activeScan = run
        try {
            return await run
        } finally {
            if (this.abortController === controller) this.abortController = null
            if (this.activeScan === run) this.activeScan = null
            if (this.activeDeps === deps) this.activeDeps = null
            this.isScanning = false
        }
    }

    private async executeScan(
        workspacePath: string,
        options: ScanOptions,
        limits: ScanLimits,
        deps: WorkspaceScanDeps,
        signal: AbortSignal
    ): Promise<ScanResult> {
        const startTime = Date.now()
        const errors: ScanError[] = []
        const omitted: OmittedFile[] = []
        const allIssues: ScanIssue[] = []
        let analyzedFiles = 0
        let clippedFiles = 0

        try {
            options.onProgress({ current: 0, total: 0, currentFile: 'Indexing workspace...', status: 'indexing' })

            const { files: allCodeFiles, ignoredDirs } = await this.collectFiles(workspacePath, deps, signal)

            if (this.shouldStop || signal.aborted) {
                for (const file of allCodeFiles) {
                    omitted.push({ file: file.name, path: file.path, reason: 'canceled', detail: 'Stopped during indexing' })
                }
                options.onProgress({ current: 0, total: allCodeFiles.length, currentFile: 'Review canceled', status: 'canceled' })
                return {
                    outcome: 'canceled',
                    issues: [],
                    errors: [],
                    omitted,
                    stats: {
                        totalFiles: allCodeFiles.length,
                        discoveredFiles: allCodeFiles.length,
                        selectedFiles: 0,
                        analyzedFiles: 0,
                        omittedFiles: omitted.length,
                        clippedFiles: 0,
                        ignoredDirs,
                        omittedByReason: summarizeOmitted(omitted),
                        scope: limits.scope,
                        limits,
                        duration: Date.now() - startTime
                    },
                    message: 'Review canceled during indexing.'
                }
            }

            // Separate files outside sampled depth limit vs eligible files
            const withinDepth: DiscoveredFile[] = []
            for (const file of allCodeFiles) {
                if (limits.maxDepth !== null && file.depth > limits.maxDepth) {
                    omitted.push({
                        file: file.name,
                        path: file.path,
                        reason: 'depth_limit',
                        detail: `Nested at depth ${file.depth} (sampled limit: ${limits.maxDepth})`
                    })
                } else {
                    withinDepth.push(file)
                }
            }

            const prioritized = this.prioritizeFiles(withinDepth)
            const filesToAnalyze = limits.maxFiles !== null ? prioritized.slice(0, limits.maxFiles) : prioritized
            if (limits.maxFiles !== null && prioritized.length > limits.maxFiles) {
                for (const skipped of prioritized.slice(limits.maxFiles)) {
                    omitted.push({
                        file: skipped.name,
                        path: skipped.path,
                        reason: 'file_cap',
                        detail: `Outside sampled file cap (${limits.maxFiles} files)`
                    })
                }
            }

            if (filesToAnalyze.length === 0) {
                const outcome: ScanOutcome = omitted.length > 0 ? 'partial' : 'completed'
                options.onProgress({ current: 0, total: 0, currentFile: allCodeFiles.length === 0 ? 'No supported code files found' : 'Scan complete', status: 'completed' })
                return {
                    outcome,
                    issues: [],
                    errors: [],
                    omitted,
                    stats: {
                        totalFiles: allCodeFiles.length,
                        discoveredFiles: allCodeFiles.length,
                        selectedFiles: 0,
                        analyzedFiles: 0,
                        omittedFiles: omitted.length,
                        clippedFiles: 0,
                        ignoredDirs,
                        omittedByReason: summarizeOmitted(omitted),
                        scope: limits.scope,
                        limits,
                        duration: Date.now() - startTime
                    },
                    message: allCodeFiles.length === 0
                        ? 'No supported code files were found in this workspace.'
                        : 'No files were eligible under the current sampled limits.'
                }
            }

            options.onProgress({ current: 0, total: filesToAnalyze.length, currentFile: 'Starting analysis...', status: 'analyzing' })

            let stoppedAtIndex = -1

            for (let i = 0; i < filesToAnalyze.length; i++) {
                if (this.shouldStop || signal.aborted) {
                    stoppedAtIndex = i
                    break
                }

                const file = filesToAnalyze[i]
                options.onProgress({ current: i + 1, total: filesToAnalyze.length, currentFile: file.name, status: 'analyzing' })

                try {
                    const fileOutcome = await this.analyzeFile(file, options, limits, deps, signal)
                    if (fileOutcome.issues.length > 0) {
                        allIssues.push(...fileOutcome.issues)
                    }
                    if (fileOutcome.status === 'canceled') {
                        stoppedAtIndex = i
                        break
                    }
                    if (fileOutcome.status === 'omitted') {
                        omitted.push({
                            file: file.name,
                            path: file.path,
                            reason: fileOutcome.reason,
                            detail: fileOutcome.detail
                        })
                        if (fileOutcome.reason === 'unreadable') {
                            errors.push({ file: file.name, path: file.path, reason: fileOutcome.detail ?? 'Could not read file' })
                        }
                    } else {
                        analyzedFiles++
                        if (fileOutcome.clipped) clippedFiles++
                    }
                } catch (e) {
                    if (this.shouldStop || signal.aborted) {
                        stoppedAtIndex = i
                        break
                    }
                    const reason = e instanceof Error ? e.message : 'Unknown error'
                    errors.push({ file: file.name, path: file.path, reason })
                    omitted.push({ file: file.name, path: file.path, reason: 'error', detail: reason })
                    console.error(`Failed to analyze ${file.name}:`, reason)
                }
            }

            const wasCanceled = this.shouldStop || signal.aborted || stoppedAtIndex >= 0
            if (wasCanceled) {
                const startIdx = stoppedAtIndex >= 0 ? stoppedAtIndex : filesToAnalyze.length
                for (let j = startIdx; j < filesToAnalyze.length; j++) {
                    const remaining = filesToAnalyze[j]
                    omitted.push({ file: remaining.name, path: remaining.path, reason: 'canceled', detail: 'Stopped before review finished' })
                }
            }

            // Sort issues by severity
            const severityOrder: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }
            allIssues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

            let outcome: ScanOutcome
            let message: string | undefined
            if (wasCanceled) {
                outcome = 'canceled'
                message = analyzedFiles === 0
                    ? 'Review canceled before any files were analyzed.'
                    : `Review canceled after ${analyzedFiles} of ${filesToAnalyze.length} files.`
            } else if (analyzedFiles === 0 && errors.length > 0) {
                outcome = 'failed'
                message = `Review failed across all ${errors.length} file${errors.length === 1 ? '' : 's'}.`
            } else if (errors.length > 0 || omitted.length > 0 || clippedFiles > 0) {
                outcome = 'partial'
                message = `Analyzed ${analyzedFiles} of ${allCodeFiles.length} discovered files.`
            } else {
                outcome = 'completed'
            }

            options.onProgress({
                current: wasCanceled ? analyzedFiles : filesToAnalyze.length,
                total: filesToAnalyze.length,
                currentFile: outcome === 'canceled' ? 'Review canceled' : outcome === 'failed' ? 'Review failed' : 'Scan complete',
                status: outcome === 'canceled' ? 'canceled' : outcome === 'failed' ? 'error' : 'completed'
            })

            return {
                outcome,
                issues: allIssues,
                errors,
                omitted,
                stats: {
                    totalFiles: allCodeFiles.length,
                    discoveredFiles: allCodeFiles.length,
                    selectedFiles: filesToAnalyze.length,
                    analyzedFiles,
                    omittedFiles: omitted.length,
                    clippedFiles,
                    ignoredDirs,
                    omittedByReason: summarizeOmitted(omitted),
                    scope: limits.scope,
                    limits,
                    duration: Date.now() - startTime
                },
                message
            }
        } catch (error) {
            console.error('Scan error:', error)
            const reason = error instanceof Error ? error.message : String(error)
            options.onProgress({ current: analyzedFiles, total: 0, currentFile: 'Error occurred', status: 'error' })
            return {
                outcome: 'failed',
                issues: allIssues,
                errors: [...errors, { file: 'Review', path: '', reason }],
                omitted,
                stats: {
                    totalFiles: analyzedFiles + omitted.length,
                    discoveredFiles: analyzedFiles + omitted.length,
                    selectedFiles: analyzedFiles,
                    analyzedFiles,
                    omittedFiles: omitted.length,
                    clippedFiles,
                    ignoredDirs: 0,
                    omittedByReason: summarizeOmitted(omitted),
                    scope: limits.scope,
                    limits,
                    duration: Date.now() - startTime
                },
                message: reason
            }
        }
    }

    private async collectFiles(
        dirPath: string,
        deps: WorkspaceScanDeps,
        signal: AbortSignal
    ): Promise<{ files: DiscoveredFile[]; ignoredDirs: number }> {
        const codeExtensions = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|py|rs|go|java|c|cpp|h|hpp|yaml|yml|xml|sql|sh|bash|ps1|rb|php|swift|kt|scala|vue|svelte|lua|r|m|mm|zig|nim|ex|exs|clj|hs|fs|dart|toml|ini|cfg|conf)$/i
        const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'venv', '.venv', 'target', 'coverage', '.cache', '.turbo', '.vercel', 'vendor', '.idea', '.vscode'])
        const allCodeFiles: DiscoveredFile[] = []
        let ignoredDirs = 0

        const collect = async (currentPath: string, depth = 0) => {
            if (depth > MAX_SAFE_WALK_DEPTH || this.shouldStop || signal.aborted) return

            const result = await deps.readDir(currentPath)
            if (this.shouldStop || signal.aborted) return
            if (!result?.success || !result.items) return

            for (const item of result.items) {
                if (this.shouldStop || signal.aborted) return
                if (ignoreDirs.has(item.name) || item.name.startsWith('.')) {
                    if (item.isDirectory) ignoredDirs++
                    continue
                }

                const fullPath = `${currentPath}${currentPath.endsWith('/') || currentPath.endsWith('\\') ? '' : '/'}${item.name}`

                if (item.isDirectory) {
                    await collect(fullPath, depth + 1)
                } else if (codeExtensions.test(item.name)) {
                    allCodeFiles.push({ name: item.name, path: fullPath, size: item.size, depth })
                }
            }
        }

        await collect(dirPath)
        return { files: allCodeFiles, ignoredDirs }
    }

    private prioritizeFiles(files: DiscoveredFile[]): DiscoveredFile[] {
        const priorityPatterns = [/index\./i, /main\./i, /app\./i, /config/i, /\.config\./i, /service/i, /util/i, /helper/i]
        return files
            .map(f => ({
                ...f,
                priority: priorityPatterns.some(p => p.test(f.name)) ? 0 : 1
            }))
            .sort((a, b) => a.priority - b.priority || (a.size || 0) - (b.size || 0) || a.path.localeCompare(b.path))
    }

    private async analyzeFile(
        file: DiscoveredFile,
        options: ScanOptions,
        limits: ScanLimits,
        deps: WorkspaceScanDeps,
        signal: AbortSignal
    ): Promise<
        | { status: 'analyzed'; issues: ScanIssue[]; clipped: boolean }
        | { status: 'omitted'; issues: ScanIssue[]; reason: OmittedReason; detail?: string }
        | { status: 'canceled'; issues: ScanIssue[] }
    > {
        const content = await deps.readFile(file.path)
        if (this.shouldStop || signal.aborted) return { status: 'canceled', issues: [] }
        if (!content?.success || typeof content.content !== 'string') {
            return { status: 'omitted', issues: [], reason: 'unreadable', detail: content?.error ?? 'Could not read file' }
        }
        if (!content.content.trim()) {
            return { status: 'omitted', issues: [], reason: 'empty_file', detail: 'Empty file' }
        }

        const lines = content.content.split(/\r?\n/)
        const lineCount = lines.length
        if (lineCount < limits.minLines) {
            return {
                status: 'omitted',
                issues: [],
                reason: 'short_file',
                detail: `${lineCount} line${lineCount === 1 ? '' : 's'} (under ${limits.minLines}-line sampled threshold)`
            }
        }

        const maxLines = limits.maxLinesPerFile
        const chunks: Array<{ startLine: number; endLine: number; text: string; truncated: boolean }> = []

        if (limits.scope === 'sampled') {
            const endLine = Math.min(lineCount, maxLines)
            chunks.push({
                startLine: 1,
                endLine,
                text: lines.slice(0, endLine).join('\n'),
                truncated: lineCount > maxLines
            })
        } else {
            for (let offset = 0; offset < lineCount; offset += maxLines) {
                const startLine = offset + 1
                const endLine = Math.min(lineCount, offset + maxLines)
                chunks.push({
                    startLine,
                    endLine,
                    text: lines.slice(offset, endLine).join('\n'),
                    truncated: false
                })
            }
        }

        const language = this.getLanguage(file.name)
        const issues: ScanIssue[] = []
        let clipped = false

        for (const chunk of chunks) {
            if (this.shouldStop || signal.aborted) {
                return { status: 'canceled', issues }
            }
            if (chunk.truncated) clipped = true

            const rangeNote = `${lineCount} lines total, showing lines ${chunk.startLine}-${chunk.endLine}`
            const prompt = options.aiMode === 'offline'
                ? `Review "${file.name}" (${rangeNote}) for bugs and issues.\n\n${chunk.text}\n\nRespond with ONLY this JSON (no other text):\n{"issues":[{"type":"bug","severity":"high","line":${chunk.startLine},"description":"what is wrong","suggestion":"how to fix"}]}\nIf no issues: {"issues":[]}`
                : `Analyze this ${language} code for bugs, security issues, and improvements.\n\nFile: ${file.name} (${rangeNote})\n\n\`\`\`${language.toLowerCase()}\n${chunk.text}\n\`\`\`\n\nFind REAL issues only. Output JSON with issues array. If no issues, return {"issues": []}`

            const response = await this.invokeModel(prompt, language, options, deps, signal)
            if (this.shouldStop || signal.aborted) {
                return { status: 'canceled', issues }
            }

            const reviewedRange: ReviewedRange = {
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                totalLines: lineCount,
                truncated: chunk.truncated
            }
            issues.push(...this.parseIssues(response, file, reviewedRange))
        }

        return { status: 'analyzed', issues, clipped }
    }

    private async invokeModel(
        prompt: string,
        language: string,
        options: ScanOptions,
        deps: WorkspaceScanDeps,
        signal: AbortSignal
    ): Promise<string> {
        if (options.aiMode === 'offline' && options.loadedModelId && deps.offlineGenerate) {
            await deps.offlineCancel?.().catch((error) => {
                console.warn('[WorkspaceScan] Failed to cancel previous generation:', error)
            })
            if (signal.aborted) return ''

            const timeoutMs = 60000
            let timeoutId: ReturnType<typeof setTimeout> | undefined

            try {
                const generatePromise = deps.offlineGenerate([
                    { role: 'system', content: 'You are a code reviewer. Output ONLY valid JSON.' },
                    { role: 'user', content: prompt }
                ], { temperature: 0.1, maxTokens: 512 })

                const timeoutPromise = new Promise<string>((_, reject) => {
                    timeoutId = setTimeout(() => {
                        reject(new Error('Analysis timeout'))
                        deps.offlineCancel?.().catch((error) => {
                            console.warn('[WorkspaceScan] Failed to cancel generation on timeout:', error)
                        })
                    }, timeoutMs)
                })

                return await Promise.race([generatePromise, timeoutPromise])
            } finally {
                if (timeoutId) clearTimeout(timeoutId)
            }
        }

        const timeoutMs = 120000
        const fileController = new AbortController()
        let timedOut = false
        const onScanAbort = () => fileController.abort()
        if (signal.aborted) return ''
        signal.addEventListener('abort', onScanAbort, { once: true })
        const timeoutId = setTimeout(() => {
            timedOut = true
            fileController.abort()
        }, timeoutMs)

        try {
            const cloudResponse = await deps.chat([
                { role: 'system', content: `You are a senior ${language} code reviewer. Find bugs, security issues, and improvements. Output valid JSON only.` },
                { role: 'user', content: prompt }
            ], options.provider, {
                temperature: 0.1,
                maxTokens: 1200,
                model: options.cloudModel,
                signal: fileController.signal
            })
            if (signal.aborted) return ''
            if (timedOut) throw new Error('Analysis timeout')
            if (cloudResponse.error) throw new Error('Cloud AI error: ' + cloudResponse.error)
            return cloudResponse.content
        } finally {
            clearTimeout(timeoutId)
            signal.removeEventListener('abort', onScanAbort)
        }
    }

    private parseIssues(response: string, file: DiscoveredFile, reviewedRange: ReviewedRange): ScanIssue[] {
        try {
            let jsonStr = response
            const jsonMatch = /```json?\n?([\s\S]*?)\n?```/.exec(response) || /\{[\s\S]*\}/.exec(response)
            if (jsonMatch) jsonStr = jsonMatch[1] || jsonMatch[0]

            const analysis = JSON.parse(jsonStr)
            if (!analysis.issues || !Array.isArray(analysis.issues)) return []

            return analysis.issues
                .filter((issue: any) => issue?.description && issue?.suggestion)
                .map((issue: any) => ({
                    file: file.name,
                    path: file.path,
                    type: issue.type || 'improvement',
                    severity: issue.severity || 'medium',
                    line: typeof issue.line === 'number' ? issue.line : undefined,
                    description: String(issue.description),
                    suggestion: String(issue.suggestion),
                    reviewedRange
                }))
        } catch {
            console.warn(`[Scan] Failed to parse response for ${file.name}:`, response?.slice(0, 200))
            return []
        }
    }

    private getLanguage(fileName: string): string {
        const ext = fileName.split('.').pop()?.toLowerCase() || ''
        const langMap: Record<string, string> = {
            'ts': 'TypeScript', 'tsx': 'TypeScript/React', 'js': 'JavaScript', 'jsx': 'JavaScript/React',
            'mjs': 'JavaScript', 'cjs': 'JavaScript',
            'py': 'Python', 'rs': 'Rust', 'go': 'Go', 'java': 'Java', 'c': 'C', 'cpp': 'C++',
            'h': 'C Header', 'hpp': 'C++ Header', 'swift': 'Swift', 'kt': 'Kotlin',
            'rb': 'Ruby', 'php': 'PHP', 'sql': 'SQL', 'sh': 'Shell', 'bash': 'Bash',
            'vue': 'Vue', 'svelte': 'Svelte', 'scala': 'Scala', 'dart': 'Dart', 'lua': 'Lua',
            'r': 'R', 'ex': 'Elixir', 'hs': 'Haskell', 'fs': 'F#', 'clj': 'Clojure', 'zig': 'Zig'
        }
        return langMap[ext] || ext.toUpperCase()
    }
}

export const workspaceScanService = WorkspaceScanService.getInstance()

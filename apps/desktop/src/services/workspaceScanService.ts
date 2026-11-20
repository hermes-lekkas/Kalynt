/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { aiService, AIProvider } from './aiService'
import { offlineLLMService } from './offlineLLMService'

export type IssueType = 'bug' | 'security' | 'performance' | 'improvement'
export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface ScanIssue {
    file: string
    path: string
    type: IssueType
    severity: Severity
    line?: number
    description: string
    suggestion: string
}

export interface ScanError {
    file: string
    path: string
    reason: string
}

export interface ScanProgress {
    current: number
    total: number
    currentFile: string
    status: 'indexing' | 'analyzing' | 'completed' | 'error'
}

export interface ScanResult {
    issues: ScanIssue[]
    errors: ScanError[]
    stats: {
        totalFiles: number
        analyzedFiles: number
        duration: number
    }
}

export class WorkspaceScanService {
    private static instance: WorkspaceScanService
    private isScanning = false
    private shouldStop = false
    private abortController: AbortController | null = null
    private activeScan: Promise<ScanResult> | null = null

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
        if (offlineLLMService?.isGenerating()) {
            await offlineLLMService.cancelGeneration()
        }
        if (this.activeScan) {
            await this.activeScan.catch(() => undefined)
        }
    }

    async scanWorkspace(
        workspacePath: string,
        options: {
            aiMode: 'cloud' | 'offline',
            provider: AIProvider,
            cloudModel?: string,
            loadedModelId?: string | null,
            onProgress: (progress: ScanProgress) => void
        }
    ): Promise<ScanResult> {
        if (this.isScanning) return { issues: [], errors: [], stats: { totalFiles: 0, analyzedFiles: 0, duration: 0 } }
        this.isScanning = true
        this.shouldStop = false
        const controller = new AbortController()
        this.abortController = controller

        const run = this.executeScan(workspacePath, options, controller.signal)
        this.activeScan = run
        try {
            return await run
        } finally {
            if (this.abortController === controller) this.abortController = null
            if (this.activeScan === run) this.activeScan = null
            this.isScanning = false
        }
    }

    private async executeScan(
        workspacePath: string,
        options: {
            aiMode: 'cloud' | 'offline',
            provider: AIProvider,
            cloudModel?: string,
            loadedModelId?: string | null,
            onProgress: (progress: ScanProgress) => void
        },
        signal: AbortSignal
    ): Promise<ScanResult> {
        const startTime = Date.now()
        const errors: ScanError[] = []

        try {
            options.onProgress({ current: 0, total: 0, currentFile: 'Indexing workspace...', status: 'indexing' })

            const allCodeFiles = await this.collectFiles(workspacePath)

            if (this.shouldStop || signal.aborted) return { issues: [], errors: [], stats: { totalFiles: allCodeFiles.length, analyzedFiles: 0, duration: Date.now() - startTime } }

            const filesToAnalyze = this.prioritizeFiles(allCodeFiles).slice(0, 25)

            if (filesToAnalyze.length === 0) {
                options.onProgress({ current: 0, total: 0, currentFile: 'No files found', status: 'completed' })
                return { issues: [], errors: [], stats: { totalFiles: allCodeFiles.length, analyzedFiles: 0, duration: Date.now() - startTime } }
            }

            options.onProgress({ current: 0, total: filesToAnalyze.length, currentFile: 'Starting analysis...', status: 'analyzing' })

            const allIssues: ScanIssue[] = []
            let analyzedFiles = 0

            for (let i = 0; i < filesToAnalyze.length; i++) {
                if (this.shouldStop || signal.aborted) break

                const file = filesToAnalyze[i]
                options.onProgress({ current: i + 1, total: filesToAnalyze.length, currentFile: file.name, status: 'analyzing' })

                try {
                    const issues = await this.analyzeFile(file, options, signal)
                    if (this.shouldStop || signal.aborted) break
                    allIssues.push(...issues)
                    analyzedFiles++
                } catch (e) {
                    if (this.shouldStop || signal.aborted) break
                    const reason = e instanceof Error ? e.message : 'Unknown error'
                    errors.push({ file: file.name, path: file.path, reason })
                    console.error(`Failed to analyze ${file.name}:`, reason)
                }
            }

            // Sort issues by severity
            const severityOrder: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }
            allIssues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

            options.onProgress({
                current: filesToAnalyze.length,
                total: filesToAnalyze.length,
                currentFile: 'Scan complete',
                status: 'completed'
            })

            return {
                issues: allIssues,
                errors,
                stats: {
                    totalFiles: allCodeFiles.length,
                    analyzedFiles,
                    duration: Date.now() - startTime
                }
            }
        } catch (error) {
            console.error('Scan error:', error)
            options.onProgress({ current: 0, total: 0, currentFile: 'Error occurred', status: 'error' })
            throw error
        }
    }

    private async collectFiles(dirPath: string): Promise<{ name: string; path: string; size?: number }[]> {
        const codeExtensions = /\.(ts|tsx|js|jsx|json|md|css|scss|html|py|rs|go|java|c|cpp|h|hpp|yaml|yml|xml|sql|sh|bash|ps1|rb|php|swift|kt|scala|vue|svelte|lua|r|m|mm|zig|nim|ex|exs|clj|hs|fs|dart|toml|ini|cfg|conf)$/i
        const ignoreDirs = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'venv', '.venv', 'target', 'coverage', '.cache', '.turbo', '.vercel', 'vendor', '.idea', '.vscode']
        const allCodeFiles: { name: string; path: string; size?: number }[] = []

        const collect = async (path: string, depth = 0) => {
            if (depth > 5 || this.shouldStop) return

            const result = await globalThis.window.electronAPI?.fs.readDir(path)
            if (!result?.success || !result.items) return

            for (const item of result.items) {
                if (ignoreDirs.includes(item.name) || item.name.startsWith('.')) continue

                const fullPath = `${path}${path.endsWith('/') || path.endsWith('\\') ? '' : '/'}${item.name}`

                if (item.isDirectory) {
                    await collect(fullPath, depth + 1)
                } else if (codeExtensions.test(item.name)) {
                    allCodeFiles.push({ name: item.name, path: fullPath, size: item.size })
                }
            }
        }

        await collect(dirPath)
        return allCodeFiles
    }

    private prioritizeFiles(files: { name: string; path: string; size?: number }[]): { name: string; path: string; size?: number }[] {
        const priorityPatterns = [/index\./i, /main\./i, /app\./i, /config/i, /\.config\./i, /service/i, /util/i, /helper/i]
        return files
            .map(f => ({
                ...f,
                priority: priorityPatterns.some(p => p.test(f.name)) ? 0 : 1
            }))
            .sort((a, b) => a.priority - b.priority || (a.size || 0) - (b.size || 0))
    }

    private async analyzeFile(
        file: { name: string; path: string },
        options: { aiMode: 'cloud' | 'offline', provider: AIProvider, cloudModel?: string, loadedModelId?: string | null },
        signal: AbortSignal
    ): Promise<ScanIssue[]> {
        const content = await globalThis.window.electronAPI?.fs.readFile(file.path)
        if (!content?.success || !content.content) return []

        const lineCount = content.content.split('\n').length
        if (lineCount < 5) return []

        // Fewer lines for offline models - small models choke on large context
        const maxLines = options.aiMode === 'offline' ? 80 : 500
        const fileContent = content.content.split('\n').slice(0, maxLines).join('\n')
        const language = this.getLanguage(file.name)

        // Simpler prompt for offline models - explicit JSON example helps small models
        const prompt = options.aiMode === 'offline'
            ? `Review "${file.name}" for bugs and issues.\n\n${fileContent}\n\nRespond with ONLY this JSON (no other text):\n{"issues":[{"type":"bug","severity":"high","description":"what is wrong","suggestion":"how to fix"}]}\nIf no issues: {"issues":[]}`
            : `Analyze this ${language} code for bugs, security issues, and improvements.\n\nFile: ${file.name} (${lineCount} lines total, showing first ${Math.min(lineCount, maxLines)})\n\n\`\`\`${language.toLowerCase()}\n${fileContent}\n\`\`\`\n\nFind REAL issues only. Output JSON with issues array. If no issues, return {"issues": []}`

        let response: string

        if (options.aiMode === 'offline' && options.loadedModelId) {
            // Cancel any lingering generation from a previous file
            await offlineLLMService.cancelGeneration().catch((error) => {
                console.warn('[WorkspaceScan] Failed to cancel previous generation:', error)
            })
            if (signal.aborted) return []

            const timeoutMs = 60000 // 60s per file for offline - small models should be fast
            let timeoutId: ReturnType<typeof setTimeout> | undefined

            try {
                const generatePromise = offlineLLMService.generate([
                    { role: 'system', content: 'You are a code reviewer. Output ONLY valid JSON.' },
                    { role: 'user', content: prompt }
                ], { temperature: 0.1, maxTokens: 512 })

                const timeoutPromise = new Promise<string>((_, reject) => {
                    timeoutId = setTimeout(() => {
                        // Reject IMMEDIATELY - don't await cancel (it could hang and block rejection)
                        reject(new Error('Analysis timeout'))
                        offlineLLMService.cancelGeneration().catch((error) => {
                            console.warn('[WorkspaceScan] Failed to cancel generation on timeout:', error)
                        })
                    }, timeoutMs)
                })

                response = await Promise.race([generatePromise, timeoutPromise])
            } finally {
                // Always clear timeout to prevent stale timeouts from cancelling future generations
                if (timeoutId) clearTimeout(timeoutId)
            }
        } else {
            const timeoutMs = 120000 // 120s for cloud APIs
            const fileController = new AbortController()
            let timedOut = false
            const onScanAbort = () => fileController.abort()
            if (signal.aborted) return []
            signal.addEventListener('abort', onScanAbort, { once: true })
            const timeoutId = setTimeout(() => {
                timedOut = true
                fileController.abort()
            }, timeoutMs)

            try {
                const cloudResponse = await aiService.chat([
                    { role: 'system', content: `You are a senior ${language} code reviewer. Find bugs, security issues, and improvements. Output valid JSON only.` },
                    { role: 'user', content: prompt }
                ], options.provider, {
                    temperature: 0.1,
                    maxTokens: 1200,
                    model: options.cloudModel,
                    signal: fileController.signal
                })
                if (signal.aborted) return []
                if (timedOut) throw new Error('Analysis timeout')
                if (cloudResponse.error) throw new Error('Cloud AI error: ' + cloudResponse.error)
                response = cloudResponse.content
            } finally {
                clearTimeout(timeoutId)
                signal.removeEventListener('abort', onScanAbort)
            }
        }

        // Parse JSON with error handling - small models often produce malformed output
        try {
            let jsonStr = response
            const jsonMatch = /```json?\n?([\s\S]*?)\n?```/.exec(response) || /\{[\s\S]*\}/.exec(response)
            if (jsonMatch) jsonStr = jsonMatch[1] || jsonMatch[0]

            const analysis = JSON.parse(jsonStr)
            if (!analysis.issues || !Array.isArray(analysis.issues)) return []

            return analysis.issues
                .filter((issue: any) => issue.description && issue.suggestion)
                .map((issue: any) => ({
                    file: file.name,
                    path: file.path,
                    type: issue.type || 'improvement',
                    severity: issue.severity || 'medium',
                    line: issue.line,
                    description: issue.description,
                    suggestion: issue.suggestion
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

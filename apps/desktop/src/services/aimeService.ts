/**
 * AIME (AI Memory Engine) Service
 * Handles codebase indexing, symbol extraction, and context retrieval (RAG).
 * 
 * Now with Web Worker support for non-blocking indexing!
 */

import Fuse from 'fuse.js'
import { logger } from '../utils/logger'
import { treeSitterService } from './treeSitterService'
import AIMEWorker from '../workers/aimeWorker?worker'

export interface CodeSymbol {
    name: string
    type: 'class' | 'function' | 'interface' | 'variable' | 'method'
    filePath: string
    line: number
    content: string
}

export interface IndexedFile {
    path: string
    lastModified: number
    symbols: CodeSymbol[]
    // Removed `content` and `tokenCount` to save RAM
}

class AIMEService {
    private index: IndexedFile[] = []
    private fuse: Fuse<CodeSymbol> | null = null
    private isIndexing = false
    private workspacePath: string | null = null
    private avgdl = 0 // Average document length for BM25

    // Web Worker for off-thread indexing
    private worker: Worker | null = null
    private workerCallbacks = new Map<string, (data: any) => void>()
    private useWorker = true // Feature flag

    // Background work pauses for a while after a memory-pressure signal.
    private suspendedUntil = 0
    private suspended = () => Date.now() < this.suspendedUntil

    constructor() {
        if (typeof window !== 'undefined') {
            window.addEventListener('kalynt-suspend-background', () => {
                this.suspendedUntil = Date.now() + 5 * 60_000
                // Stop an in-flight indexing pass.
                this.worker?.postMessage({ type: 'cancel' })
                logger.agent.warn('AIME: Indexing paused by memory pressure')
            })
        }
    }

    /**
     * Open IndexedDB for AIME persistence
     */
    private openDB(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('kalynt-aime-db', 1)
            request.onupgradeneeded = () => {
                const db = request.result
                if (!db.objectStoreNames.contains('aime-index')) {
                    db.createObjectStore('aime-index', { keyPath: 'workspacePath' })
                }
            }
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(new Error(request.error?.message || 'AIME IndexedDB failed'))
        })
    }

    /**
     * Save the current index to persistent storage
     */
    private async saveIndex() {
        if (!this.workspacePath) return
        try {
            const db = await this.openDB()
            const transaction = db.transaction(['aime-index'], 'readwrite')
            const store = transaction.objectStore('aime-index')
            store.put({
                workspacePath: this.workspacePath,
                index: this.index,
                timestamp: Date.now()
            })
            logger.agent.debug('AIME: Index saved to persistent storage')
        } catch (error) {
            logger.agent.warn('AIME: Failed to save index', error)
        }
    }

    /**
     * Load an existing index from persistent storage
     */
    private async loadIndex(path: string): Promise<IndexedFile[] | null> {
        try {
            const db = await this.openDB()
            const transaction = db.transaction(['aime-index'], 'readonly')
            const store = transaction.objectStore('aime-index')
            const request = store.get(path)

            return new Promise((resolve) => {
                request.onsuccess = () => {
                    resolve(request.result?.index || null)
                }
                request.onerror = () => resolve(null)
            })
        } catch {
            return null
        }
    }

    /**
     * Initialize the Web Worker
     */
    private initWorker(): Worker | null {
        if (this.worker) return this.worker
        if (!this.useWorker) return null

        try {
            this.worker = new AIMEWorker()
            this.worker!.onmessage = (event) => this.handleWorkerMessage(event.data)
            this.worker!.onerror = (error) => {
                console.error('[AIME] Worker error:', error)
                this.useWorker = false // Fall back to main thread
            }
            return this.worker
        } catch (error) {
            console.warn('[AIME] Failed to create worker, using main thread:', error)
            this.useWorker = false
            return null
        }
    }

    /**
     * Handle messages from the Web Worker
     */
    private handleWorkerMessage(data: any) {
        switch (data.type) {
            case 'indexingStarted':
                logger.agent.info('AIME Worker: Indexing started', { totalFiles: data.totalFiles })
                break
            case 'indexingProgress':
                logger.agent.debug('AIME Worker: Progress', {
                    processed: data.processed,
                    total: data.total
                })
                break
            case 'indexingComplete': {
                this.isIndexing = false
                logger.agent.info('AIME Worker: Indexing complete', {
                    processed: data.processed,
                    failed: data.failed,
                    totalSymbols: data.totalSymbols
                })
                // Resolve the pending promise
                const completeCallback = this.workerCallbacks.get('indexComplete')
                if (completeCallback) {
                    completeCallback(data)
                    this.workerCallbacks.delete('indexComplete')
                }

                // RAM Optimization: Destroy the worker's V8 isolate immediately after indexing
                if (this.worker) {
                    this.worker.terminate()
                    this.worker = null
                    logger.agent.debug('AIME Worker: Terminated to free V8 isolate memory')
                }
                break
            }
            case 'searchResults': {
                const searchCallback = this.workerCallbacks.get(`search:${data.query}`)
                if (searchCallback) {
                    searchCallback(data.results)
                    this.workerCallbacks.delete(`search:${data.query}`)
                }
                break
            }
            case 'error':
                logger.agent.error('AIME Worker error:', data)
                break
        }
    }

    /**
     * Send message to worker with callback
     */
    private async sendToWorker(type: string, payload: any, callbackKey: string, timeoutMs = 60000): Promise<any> {
        const worker = this.initWorker()
        if (!worker) throw new Error('Worker not available')

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.workerCallbacks.delete(callbackKey)
                reject(new Error('Worker timeout'))
            }, timeoutMs)

            this.workerCallbacks.set(callbackKey, (data: any) => {
                clearTimeout(timeout)
                resolve(data)
            })

            worker.postMessage({ type, ...payload })
        })
    }

    /**
     * Initialize indexing for a workspace (with Web Worker support)
     */
    async indexWorkspace(path: string) {
        if (this.isIndexing || this.suspended()) return
        this.isIndexing = true
        this.workspacePath = path

        logger.agent.info('AIME: Initializing codebase indexing', { path, useWorker: this.useWorker })

        try {
            // 1. Try to load from persistent storage first
            const cachedIndex = await this.loadIndex(path)
            if (cachedIndex && cachedIndex.length > 0) {
                this.index = cachedIndex
                this.buildSearchIndex()
                logger.agent.info('AIME: Loaded index from cache', { files: this.index.length })

                // Trigger fast incremental re-index for changed files
                this.isIndexing = false // Temporarily unlock
                await this.reindexChanged()
                this.isIndexing = true // Re-lock for potential full index logic below if needed

                // If we have enough files, we consider it "done" for now
                if (this.index.length > 0) {
                    this.isIndexing = false
                    return
                }
            }

            this.index = []

            // 2. Full index logic follows...
            // Try Web Worker first
            if (this.useWorker) {
                const files = await this.collectFiles(path)
                if (files.length > 0) {
                    const fileData = await this.loadFileContents(files, path)
                    const worker = this.initWorker()
                    if (worker) {
                        await this.indexWithWorker(fileData)
                        return
                    }
                }
            }

            // Fall back to main thread
            await treeSitterService.init()
            await this.scanDirectory(path)
            this.buildSearchIndex()
            await this.saveIndex()
            logger.agent.info('AIME: Indexing complete (main thread)', {
                files: this.index.length,
                symbols: this.getTotalSymbolCount()
            })
        } catch (error) {
            logger.agent.error('AIME: Indexing failed', { error })
        } finally {
            this.isIndexing = false
        }
    }

    /**
     * Collect files to index
     */
    private async collectFiles(dir: string, files: string[] = []): Promise<string[]> {
        const electronAPI = globalThis.window.electronAPI
        if (!electronAPI) return files

        const res = await electronAPI.fs.readDir(dir)
        if (!res?.success || !res.items) return files

        const EXCLUDE_DIRS = new Set([
            'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
            '.cache', '.vscode', '.idea', '__pycache__', 'target', 'bin', 'obj',
            '.gradle', '.nuget', 'vendor', '.terraform', '.serverless'
        ])
        
        // Comprehensive language support
        const INCLUDE_EXTS = new Set([
            // JavaScript/TypeScript ecosystem
            'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'esm',
            // Python
            'py', 'pyw', 'pyi',
            // Java/Kotlin/JVM
            'java', 'kt', 'kts', 'groovy', 'scala', 'sc',
            // C/C++
            'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx',
            // C#/.NET
            'cs', 'csx', 'vb', 'fs', 'fsx',
            // Go
            'go',
            // Rust
            'rs', 'rlib',
            // Ruby
            'rb', 'rbw', 'rake', 'gemspec',
            // PHP
            'php', 'phtml', 'php3', 'php4', 'php5', 'phps',
            // Swift/Objective-C
            'swift', 'm', 'mm',
            // Web
            'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'styl',
            // Shell/Scripts
            'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
            // Data/Config
            'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf',
            // SQL
            'sql', 'psql', 'mysql',
            // Documentation
            'md', 'mdx', 'rst', 'txt',
            // Other languages
            'lua', 'r', 'rmd', 'dart', 'flutter', 'kotlin', 'clj', 'cljs',
            'elm', 'erl', 'hrl', 'ex', 'exs', 'hs', 'lhs', 'ml', 'mli',
            'nim', 'nims', 'cr', 'odin', 'zig', 'v', 'vsh', 'wat', 'wast'
        ])

        for (const item of res.items) {
            const itemPath = `${dir}/${item.name}`
            if (item.isDirectory) {
                if (!EXCLUDE_DIRS.has(item.name) && !item.name.startsWith('.')) {
                    await this.collectFiles(itemPath, files)
                }
            } else {
                const ext = item.name.split('.').pop()?.toLowerCase() || ''
                if (INCLUDE_EXTS.has(ext)) {
                    files.push(itemPath)
                }
            }
        }

        return files
    }

    /**
     * Load file contents for worker
     */
    private async loadFileContents(filePaths: string[], workspacePath: string): Promise<any[]> {
        const electronAPI = globalThis.window.electronAPI
        const files: any[] = []

        for (const path of filePaths) {
            try {
                const res = await electronAPI?.fs.readFile(path)
                if (res?.success && res.content) {
                    // The real mtime, so later incremental re-indexes see real changes.
                    const stats = await electronAPI?.fs.stat(path).catch(() => undefined)
                    files.push({
                        path,
                        content: res.content,
                        lastModified: stats?.mtime || 0,
                        relativePath: path.replace(workspacePath, '').replace(/^[/\\]/, '')
                    })
                }
            } catch (error) {
                console.warn(`[AIME] Failed to load file: ${path}`, error)
            }
        }

        return files
    }

    /**
     * Index files using Web Worker, then sync worker-parsed results to main thread
     */
    private async indexWithWorker(files: any[]): Promise<void> {
        logger.agent.info('AIME: Delegating indexing to Web Worker', { fileCount: files.length })

        // Large workspaces take a while; the timeout scales with the file count.
        const timeoutMs = 30000 + files.length * 60
        const result = await this.sendToWorker('indexWorkspace', { files }, 'indexComplete', timeoutMs)

        if (result?.indexData) {
            for (const entry of result.indexData) {
                const symbols: CodeSymbol[] = (entry.symbols || []).map((s: any) => ({
                    name: s.name,
                    type: s.type === 'class' ? 'class' : s.type === 'variable' ? 'variable' : 'function',
                    filePath: entry.path,
                    line: s.line,
                    content: s.context || ''
                }))
                this.index.push({
                    path: entry.path,
                    lastModified: entry.lastModified || Date.now(),
                    symbols
                })
            }
            this.buildSearchIndex()
            await this.saveIndex()
        }

        logger.agent.info('AIME: Worker indexing completed and synced to main thread', {
            files: this.index.length,
            symbols: this.getTotalSymbolCount()
        })
    }

    private async scanDirectory(dir: string) {
        const electronAPI = globalThis.window.electronAPI
        if (!electronAPI) return

        const res = await electronAPI.fs.readDir(dir)
        if (!res?.success || !res.items) return

        const EXCLUDE_DIRS = new Set([
            'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
            '.cache', '.vscode', '.idea', '__pycache__', 'target', 'bin', 'obj',
            '.gradle', '.nuget', 'vendor', '.terraform', '.serverless'
        ])
        
        // Comprehensive language support (same as collectFiles)
        const INCLUDE_EXTS = new Set([
            'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'esm',
            'py', 'pyw', 'pyi',
            'java', 'kt', 'kts', 'groovy', 'scala', 'sc',
            'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx',
            'cs', 'csx', 'vb', 'fs', 'fsx',
            'go',
            'rs', 'rlib',
            'rb', 'rbw', 'rake', 'gemspec',
            'php', 'phtml', 'php3', 'php4', 'php5', 'phps',
            'swift', 'm', 'mm',
            'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'styl',
            'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
            'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf',
            'sql', 'psql', 'mysql',
            'md', 'mdx', 'rst', 'txt',
            'lua', 'r', 'rmd', 'dart', 'flutter', 'kotlin', 'clj', 'cljs',
            'elm', 'erl', 'hrl', 'ex', 'exs', 'hs', 'lhs', 'ml', 'mli',
            'nim', 'nims', 'cr', 'odin', 'zig', 'v', 'vsh', 'wat', 'wast'
        ])

        for (const item of res.items) {
            const itemPath = `${dir}/${item.name}`
            if (item.isDirectory) {
                if (!EXCLUDE_DIRS.has(item.name) && !item.name.startsWith('.')) {
                    await this.scanDirectory(itemPath)
                }
            } else {
                const ext = item.name.split('.').pop()?.toLowerCase() || ''
                if (INCLUDE_EXTS.has(ext)) {
                    await this.indexFile(itemPath)
                }
            }
        }
    }

    private async indexFile(filePath: string) {
        const electronAPI = globalThis.window.electronAPI
        try {
            const res = await electronAPI.fs.readFile(filePath)
            if (!res?.success || !res.content) return

            const stats = await electronAPI.fs.stat(filePath)
            const symbols = await this.extractSymbols(res.content, filePath)

            this.index.push({
                path: filePath,
                lastModified: stats?.mtime || Date.now(),
                symbols
            })
        } catch (error) {
            console.error(`[AIME] Failed to index file: ${filePath}`, error)
        }
    }

    /**
     * Symbol extraction using Tree-sitter with regex fallback.
     */
    private async extractSymbols(content: string, filePath: string): Promise<CodeSymbol[]> {
        // 1. Try Tree-sitter for structural precision
        try {
            const tsSymbols = await treeSitterService.parseSymbols(content, filePath)
            if (tsSymbols.length > 0) {
                return tsSymbols.map(s => ({
                    ...s,
                    filePath
                }))
            }
        } catch (error) {
            console.warn(`[AIME] Tree-sitter failed for ${filePath}, falling back to regex:`, error)
        }

        // 2. Fallback to robust regex patterns
        const symbols: CodeSymbol[] = []
        const lines = content.split('\n')

        // Regex for common language constructs
        const patterns = [
            // Classes (support export and abstract)
            { type: 'class' as const, regex: /(?:export\s+|abstract\s+)*class\s+([A-Z][a-zA-Z0-9_]*)/g },
            // Functions (regular and async)
            { type: 'function' as const, regex: /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)/g },
            // Arrow function assignments (const/let Name = (...) => )
            { type: 'function' as const, regex: /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g },
            // Interface / Type definitions
            { type: 'interface' as const, regex: /(?:export\s+)?(?:interface|type)\s+([A-Z][a-zA-Z0-9_]*)/g },
            // Python functions (def name:)
            { type: 'function' as const, regex: /def\s+([a-zA-Z0-9_]+)\s*\(/g },
            // Go functions (func Name() )
            { type: 'function' as const, regex: /func\s+([a-zA-Z0-9_]+)\s*\(/g },
            // Rust struct/enum/trait/fn
            { type: 'interface' as const, regex: /struct\s+([A-Z][a-zA-Z0-9_]*)/g },
            { type: 'interface' as const, regex: /enum\s+([A-Z][a-zA-Z0-9_]*)/g },
            { type: 'interface' as const, regex: /trait\s+([A-Z][a-zA-Z0-9_]*)/g },
            { type: 'function' as const, regex: /fn\s+([a-zA-Z0-9_]+)/g },
            // Method definitions in objects or classes (name(...) { )
            { type: 'method' as const, regex: /^\s*([a-zA-Z0-9_]+)\s*\([^)]*\)\s*{/g }
        ]

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            // Skip comments and empty lines for better accuracy
            if (line.trim().startsWith('//') || line.trim().startsWith('/*') || line.trim().startsWith('*')) continue

            for (const pattern of patterns) {
                pattern.regex.lastIndex = 0
                let match
                while ((match = pattern.regex.exec(line)) !== null) {
                    // Check if name is not a keyword
                    const name = match[1]
                    const keywords = ['if', 'for', 'while', 'switch', 'return', 'await', 'async', 'const', 'let', 'var']
                    if (keywords.includes(name)) continue

                    symbols.push({
                        name,
                        type: pattern.type,
                        filePath,
                        line: i + 1,
                        content: line.trim()
                    })
                }
            }
        }

        return symbols
    }

    private buildSearchIndex() {
        const allSymbols = this.index.flatMap(f => f.symbols)
        this.fuse = new Fuse(allSymbols, {
            keys: [
                { name: 'name', weight: 0.7 },
                { name: 'filePath', weight: 0.3 }
            ],
            threshold: 0.3,
            ignoreLocation: true,
            includeScore: true
        })

        // Calculate average document length for BM25 (Approximated from symbols to save RAM)
        const totalSymbols = this.index.reduce((acc, f) => acc + f.symbols.length, 0)
        this.avgdl = this.index.length > 0 ? totalSymbols / this.index.length : 0
    }

    private tokenize(text: string): string[] {
        return text.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 2)
    }

    private async calculateBM25(query: string, file: IndexedFile): Promise<number> {
        const electronAPI = globalThis.window.electronAPI
        if (!electronAPI) return 0

        const res = await electronAPI.fs.readFile(file.path)
        if (!res?.success || !res.content) return 0

        const tokens = this.tokenize(query)
        const fileTokens = this.tokenize(res.content)
        const k1 = 1.2
        const b = 0.75
        let score = 0

        const docFreqs: Record<string, number> = {}
        for (const token of fileTokens) {
            docFreqs[token] = (docFreqs[token] || 0) + 1
        }

        for (const q of tokens) {
            const f_q = docFreqs[q] || 0
            if (f_q === 0) continue

            // Approximated IDF based on symbols instead of full content retention
            const n_q = this.index.filter(f => f.symbols.some(s => s.name.toLowerCase().includes(q) || s.content.toLowerCase().includes(q))).length
            const idf = Math.log((this.index.length - n_q + 0.5) / (n_q + 0.5) + 1)

            // Approximate token count based on file structure
            const approximateTokenCount = fileTokens.length
            score += idf * (f_q * (k1 + 1)) / (f_q + k1 * (1 - b + b * (approximateTokenCount / (this.avgdl * 10)))) // Adjust avgdl scale
        }

        return score
    }

    private getTotalSymbolCount(): number {
        return this.index.reduce((acc, f) => acc + f.symbols.length, 0)
    }

    /**
     * Search for relevant symbols/files based on a query
     */
    async search(query: string, limit = 10): Promise<CodeSymbol[]> {
        if (!this.fuse) return []

        // 1. Get fuzzy matches for symbols
        const fuseResults = this.fuse.search(query)

        // 2. Calculate BM25 for files containing these symbols
        const scoredSymbolsPromises = fuseResults.map(async (res) => {
            const symbol = res.item
            const file = this.index.find(f => f.path === symbol.filePath)
            const bm25 = file ? await this.calculateBM25(query, file) : 0

            // Normalize scores (Fuse score is 0-1 where 0 is perfect, BM25 is typically > 0 where higher is better)
            // We want a combined score where HIGHER is better
            const normalizedFuse = 1 - (res.score || 0)
            const normalizedBM25 = Math.min(1, bm25 / 10) // Heuristic normalization

            const combinedScore = (normalizedFuse * 0.4) + (normalizedBM25 * 0.6)

            return { symbol, score: combinedScore }
        })

        const scoredSymbols = await Promise.all(scoredSymbolsPromises)

        // Sort by combined score descending
        return scoredSymbols
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(s => s.symbol)
    }

    /**
     * Retrieve relevant context for an LLM prompt.
     * Uses a hybrid approach: Repo Map for awareness + Targeted snippets for precision.
     */
    async retrieveContext(query: string, maxFiles: number = 8): Promise<string> {
        const symbols = await this.search(query, 20)
        if (symbols.length === 0 && this.index.length > 0) {
            // If no symbols match, try a fallback Repo Map
            return this.generateRepoMap(1500)
        }
        if (symbols.length === 0) return 'No relevant context found.'

        let context = '### Codebase Context\n\n'

        // Add a small repo map for structural awareness
        const repoMap = this.generateRepoMap(800)
        if (repoMap) {
            context += repoMap + '\n---\n\n'
        }

        context += '#### Targeted Code Snippets\n\n'

        // Group by file to reduce redundant reading and keep related code together
        const filePaths = [...new Set(symbols.map(s => s.filePath))].slice(0, maxFiles)

        for (const filePath of filePaths) {
            const file = this.index.find(f => f.path === filePath)
            if (file) {
                // Fetch content on demand to save RAM
                const electronAPI = globalThis.window.electronAPI
                if (!electronAPI) continue

                const fileRef = await electronAPI.fs.readFile(file.path)
                if (!fileRef?.success || !fileRef.content) continue

                const relativePath = this.workspacePath ? filePath.replace(this.workspacePath, '').replace(/^[/\\]/, '') : filePath
                context += `File: ${relativePath}\n\`\`\`\n`

                // Collect all symbols for this file that matched the query
                const fileSymbols = symbols.filter(s => s.filePath === filePath)

                // Get a merged window of lines to show
                const lineWindows: Array<{ start: number, end: number }> = fileSymbols.map(s => ({
                    start: Math.max(0, s.line - 15),
                    end: s.line + 25
                }))

                // Merge overlapping windows
                const mergedWindows: Array<{ start: number, end: number }> = []
                if (lineWindows.length > 0) {
                    lineWindows.sort((a, b) => a.start - b.start)
                    let current = lineWindows[0]
                    for (let i = 1; i < lineWindows.length; i++) {
                        if (lineWindows[i].start <= current.end) {
                            current.end = Math.max(current.end, lineWindows[i].end)
                        } else {
                            mergedWindows.push(current)
                            current = lineWindows[i]
                        }
                    }
                    mergedWindows.push(current)
                }

                const lines = fileRef.content.split('\n')
                for (const window of mergedWindows) {
                    const start = window.start
                    const end = Math.min(lines.length, window.end)
                    if (start > 0) context += '// ...\n'
                    context += lines.slice(start, end).join('\n') + '\n'
                    if (end < lines.length) context += '// ...\n'
                }

                context += '\n```\n\n'
            }
        }

        return context
    }

    /**
     * Generate a Repository Map: a condensed structural skeleton of the codebase.
     * Contains only signatures, class/function names, and file structure.
     * Fits into the LLM context window for navigation without reading every file.
     * (Per research report Section 4.1 - Repo Mapping)
     */
    generateRepoMap(maxTokens: number = 3000): string {
        if (this.index.length === 0) return ''

        let map = '### Repository Map (Project Skeleton)\n\n'
        let currentTokens = 10

        // Group symbols by file and sort by significance
        const sortedFiles = [...this.index]
            .sort((a, b) => b.symbols.length - a.symbols.length)

        for (const file of sortedFiles) {
            const relativePath = this.workspacePath
                ? file.path.replace(this.workspacePath, '').replace(/^[/\\]/, '')
                : file.path

            let fileContent = `${relativePath}:\n`

            // Prioritize important symbols
            const priorityOrder = { 'class': 1, 'interface': 2, 'function': 3, 'method': 4, 'variable': 5 }
            const sortedSymbols = [...file.symbols].sort((a, b) => {
                const pA = priorityOrder[a.type as keyof typeof priorityOrder] || 99
                const pB = priorityOrder[b.type as keyof typeof priorityOrder] || 99
                if (pA !== pB) return pA - pB
                return a.line - b.line
            })

            for (const symbol of sortedSymbols) {
                const typePrefixMap: Record<string, string> = {
                    'class': 'class',
                    'interface': 'interface',
                    'method': '  method',
                    'function': 'fn',
                    'variable': 'var'
                }
                const typePrefix = typePrefixMap[symbol.type] || 'var'
                const line = `  ${typePrefix} ${symbol.name} (L${symbol.line})\n`

                // Estimate tokens (roughly 4 chars per token)
                const lineTokens = Math.ceil(line.length / 4)

                if (currentTokens + lineTokens > maxTokens) break

                fileContent += line
                currentTokens += lineTokens
            }

            if (currentTokens > maxTokens) break
            map += fileContent + '\n'
        }

        return map
    }

    /**
     * Retrieve context with repo map included for broader project awareness.
     * Combines targeted symbol search with structural overview.
     */
    async retrieveContextWithMap(query: string, maxSymbolContext: number = 2000, maxMapTokens: number = 1500): Promise<string> {
        let context = ''

        // Add repo map for project-wide awareness
        const repoMap = this.generateRepoMap(maxMapTokens)
        if (repoMap) {
            context += repoMap + '\n'
        }

        // Add targeted symbol context
        const symbolContext = await this.retrieveContext(query)
        if (symbolContext !== 'No relevant context found.') {
            // Trim to budget
            context += symbolContext.slice(0, maxSymbolContext)
        }

        return context || 'No relevant context found.'
    }

    /**
     * Incremental re-index: re-indexes files that changed since the last
     * index, picks up files that are new to the workspace, and drops ones
     * that no longer exist.
     */
    async reindexChanged() {
        if (this.isIndexing || this.suspended() || !this.workspacePath) return

        const electronAPI = globalThis.window.electronAPI
        if (!electronAPI) return

        const indexed = new Set(this.index.map(f => f.path))
        let updated = 0
        let removed = 0

        for (let i = 0; i < this.index.length; i++) {
            const file = this.index[i]
            let stats: { mtime?: number } | undefined
            try {
                stats = await electronAPI.fs.stat(file.path)
            } catch {
                // File is gone; drop it from the index.
                this.index.splice(i, 1)
                i--
                removed++
                continue
            }
            try {
                if (stats?.mtime && stats.mtime > file.lastModified) {
                    const res = await electronAPI.fs.readFile(file.path)
                    if (res?.success && res.content) {
                        const symbols = await this.extractSymbols(res.content, file.path)
                        this.index[i] = {
                            ...file,
                            lastModified: stats.mtime,
                            symbols
                        }
                        updated++
                    }
                }
            } catch {
                // A failed read leaves the stale entry; the next pass retries it.
            }
        }

        // Files added since the last full index.
        let added = 0
        try {
            const current = await this.collectFiles(this.workspacePath)
            for (const path of current) {
                if (indexed.has(path)) continue
                await this.indexFile(path)
                added++
            }
        } catch (error) {
            logger.agent.warn('AIME: New-file scan failed', { error })
        }

        if (updated > 0 || added > 0 || removed > 0) {
            this.buildSearchIndex()
            await this.saveIndex()
            logger.agent.info('AIME: Incremental re-index', { updated, added, removed })
        }
    }

    getStats() {
        return {
            isIndexing: this.isIndexing,
            filesIndexed: this.index.length,
            totalSymbols: this.getTotalSymbolCount(),
            workspace: this.workspacePath
        }
    }
}

export const aimeService = new AIMEService()

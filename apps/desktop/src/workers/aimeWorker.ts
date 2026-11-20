/**
 * AIME Web Worker
 * 
 * This worker handles code indexing and semantic analysis off the main thread,
 * preventing UI blocking during workspace indexing.
 */

// Worker state
let isIndexing = false
let shouldCancel = false

// Linear-time per-line regex patterns (no nested quantifiers / ReDoS, no stale /g lastIndex)
interface LinePattern {
    type: 'function' | 'class' | 'interface'
    regex: RegExp
}

const JS_PATTERNS: LinePattern[] = [
    { type: 'function', regex: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]/ },
    { type: 'class', regex: /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/ }
]

const TS_PATTERNS: LinePattern[] = [
    ...JS_PATTERNS,
    { type: 'interface', regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/ },
    { type: 'interface', regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>\n]{1,80}>)?\s*=/ }
]

// Matches `const/let/var foo = ...` declarations to check for arrow/function initializers without backtracking.
const JS_VAR_DECL = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/

const LINE_PARSERS: Record<string, LinePattern[]> = {
    javascript: JS_PATTERNS,
    typescript: TS_PATTERNS,
    python: [
        { type: 'function', regex: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/ },
        { type: 'class', regex: /^\s*class\s+([A-Za-z_]\w*)\b/ }
    ],
    rust: [
        { type: 'function', regex: /^\s*(?:pub(?:\([^)\n]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\b/ },
        { type: 'class', regex: /^\s*(?:pub(?:\([^)\n]*\))?\s+)?(?:struct|enum)\s+([A-Za-z_]\w*)\b/ },
        { type: 'interface', regex: /^\s*(?:pub(?:\([^)\n]*\))?\s+)?trait\s+([A-Za-z_]\w*)\b/ }
    ],
    go: [
        { type: 'function', regex: /^\s*func\s+(?:\([^)\n]*\)\s*)?([A-Za-z_]\w*)\s*[([<]/ },
        { type: 'class', regex: /^\s*type\s+([A-Za-z_]\w*)\s+struct\b/ },
        { type: 'interface', regex: /^\s*type\s+([A-Za-z_]\w*)\s+interface\b/ }
    ]
}

// File extensions to language mapping
const EXTENSION_MAP: Record<string, string> = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go'
}

// Index storage
interface CodeSymbol {
    name: string
    type: 'function' | 'class' | 'interface' | 'variable'
    filePath: string
    line: number
    context: string
}

interface FileIndex {
    path: string
    relativePath: string
    language: string
    symbols: CodeSymbol[]
    content: string
    lastIndexed: number
}

const fileIndex = new Map<string, FileIndex>()

function isJsFunctionInitializer(lines: string[], index: number, eqPos: number): boolean {
    const rhs = lines[index].slice(eqPos + 1).trim()
    if (!rhs) return false
    if (rhs.startsWith('function') || rhs.startsWith('async function')) return true
    if (rhs.includes('=>')) return true
    // Multi-line arrow function header: `const Foo = (\n ... \n) =>`
    if (/^(?:async\s+)?(?:<[^>\n]*>\s*)?\(/.test(rhs)) {
        const limit = Math.min(lines.length, index + 6)
        for (let j = index + 1; j < limit; j++) {
            if (lines[j].includes('=>')) return true
            if (lines[j].includes(';')) return false
        }
    }
    return false
}

// Parse file content line-by-line in O(N) time and extract symbols
function parseFile(filePath: string, content: string, relativePath: string, lastModified = 0): FileIndex {
    const dot = filePath.lastIndexOf('.')
    const ext = dot >= 0 ? filePath.substring(dot).toLowerCase() : ''
    const language = EXTENSION_MAP[ext] || 'unknown'
    const patterns = LINE_PARSERS[language]

    const symbols: CodeSymbol[] = []

    if (patterns) {
        const lines = content.split('\n')
        const isJsLike = language === 'javascript' || language === 'typescript'

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
                continue
            }

            let matched = false
            for (const pattern of patterns) {
                pattern.regex.lastIndex = 0
                const match = pattern.regex.exec(line)
                if (match?.[1]) {
                    symbols.push({
                        name: match[1],
                        type: pattern.type,
                        filePath,
                        line: i + 1,
                        context: trimmed
                    })
                    matched = true
                    break
                }
            }

            if (!matched && isJsLike) {
                const varMatch = JS_VAR_DECL.exec(line)
                if (varMatch?.[1]) {
                    const eqPos = line.indexOf('=', varMatch[0].length)
                    if (eqPos !== -1 && line[eqPos + 1] !== '=' && isJsFunctionInitializer(lines, i, eqPos)) {
                        symbols.push({
                            name: varMatch[1],
                            type: 'function',
                            filePath,
                            line: i + 1,
                            context: trimmed
                        })
                    }
                }
            }
        }
    }

    return {
        path: filePath,
        relativePath,
        language,
        symbols,
        content: content.substring(0, 50000), // Limit stored content
        lastIndexed: lastModified || Date.now()
    }
}

// Calculate relevance score for a query
function calculateRelevance(query: string, file: FileIndex): number {
    const queryLower = query.toLowerCase()
    const queryTerms = queryLower.split(/\s+/)
    let score = 0
    
    // Check file path
    if (file.relativePath.toLowerCase().includes(queryLower)) {
        score += 10
    }
    
    // Check symbols
    for (const symbol of file.symbols) {
        const symbolNameLower = symbol.name.toLowerCase()
        
        // Exact match
        if (symbolNameLower === queryLower) {
            score += 100
        }
        // Contains query
        else if (symbolNameLower.includes(queryLower)) {
            score += 50
        }
        // Contains query terms
        else if (queryTerms.every(term => symbolNameLower.includes(term))) {
            score += 25
        }
    }
    
    // Check content
    const contentLower = file.content.toLowerCase()
    if (contentLower.includes(queryLower)) {
        score += 5
    }
    
    return score
}

// Handle messages from main thread
self.onmessage = async (event: MessageEvent) => {
    const message = event.data
    
    switch (message.type) {
        case 'indexFile':
            await handleIndexFile(message)
            break
            
        case 'indexWorkspace':
            await handleIndexWorkspace(message)
            break
            
        case 'search':
            handleSearch(message)
            break
            
        case 'cancel':
            shouldCancel = true
            self.postMessage({ type: 'cancelled' })
            break
            
        case 'clear':
            fileIndex.clear()
            self.postMessage({ type: 'cleared' })
            break
    }
}

async function handleIndexFile(message: any) {
    try {
        const index = parseFile(message.filePath, message.content, message.relativePath)
        fileIndex.set(message.filePath, index)
        
        self.postMessage({
            type: 'fileIndexed',
            filePath: message.filePath,
            symbolCount: index.symbols.length
        })
    } catch (error) {
        self.postMessage({
            type: 'error',
            filePath: message.filePath,
            error: String(error)
        })
    }
}

async function handleIndexWorkspace(message: any) {
    if (isIndexing) {
        self.postMessage({ type: 'error', error: 'Already indexing' })
        return
    }
    
    isIndexing = true
    shouldCancel = false
    fileIndex.clear()
    
    let processed = 0
    let failed = 0
    
    self.postMessage({
        type: 'indexingStarted',
        totalFiles: message.files.length
    })
    
    for (const file of message.files) {
        if (shouldCancel) {
            break
        }
        
        try {
            const index = parseFile(file.path, file.content, file.relativePath, file.lastModified)
            fileIndex.set(file.path, index)
            processed++
            
            // Report progress every 10 files
            if (processed % 10 === 0) {
                self.postMessage({
                    type: 'indexingProgress',
                    processed,
                    total: message.files.length
                })
            }
            
            // Small yield to prevent blocking
            if (processed % 5 === 0) {
                await new Promise(resolve => setTimeout(resolve, 0))
            }
        } catch (error) {
            failed++
            self.postMessage({
                type: 'fileError',
                filePath: file.path,
                error: String(error)
            })
        }
    }
    
    isIndexing = false
    
    const indexData = Array.from(fileIndex.values()).map(f => ({
        path: f.path,
        relativePath: f.relativePath,
        symbols: f.symbols,
        content: f.content.substring(0, 50000),
        language: f.language,
        lastModified: f.lastIndexed
    }))
    
    self.postMessage({
        type: 'indexingComplete',
        processed,
        failed,
        cancelled: shouldCancel,
        totalSymbols: indexData.reduce((sum, f) => sum + f.symbols.length, 0),
        indexData
    })
}

function handleSearch(message: any) {
    const query = message.query.toLowerCase()
    const maxResults = message.maxResults || 10
    
    const results: Array<{
        file: FileIndex
        score: number
        relevantSymbols: CodeSymbol[]
    }> = []
    
    for (const file of fileIndex.values()) {
        const score = calculateRelevance(query, file)
        
        if (score > 0) {
            // Find most relevant symbols
            const relevantSymbols = file.symbols
                .map(s => ({
                    symbol: s,
                    score: calculateSymbolRelevance(query, s)
                }))
                .filter(s => s.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, 3)
                .map(s => s.symbol)
            
            results.push({ file, score, relevantSymbols })
        }
    }
    
    // Sort by score and limit results
    results.sort((a, b) => b.score - a.score)
    const topResults = results.slice(0, maxResults)
    
    self.postMessage({
        type: 'searchResults',
        query: message.query,
        results: topResults.map(r => ({
            path: r.file.path,
            relativePath: r.file.relativePath,
            language: r.file.language,
            score: r.score,
            symbols: r.relevantSymbols
        }))
    })
}

function calculateSymbolRelevance(query: string, symbol: CodeSymbol): number {
    const queryLower = query.toLowerCase()
    const nameLower = symbol.name.toLowerCase()
    
    if (nameLower === queryLower) return 100
    if (nameLower.includes(queryLower)) return 50
    
    // Check individual terms
    const terms = queryLower.split(/\s+/)
    const matchingTerms = terms.filter(t => nameLower.includes(t))
    return matchingTerms.length * 10
}

// Export for TypeScript (not actually used in worker context)
export {}

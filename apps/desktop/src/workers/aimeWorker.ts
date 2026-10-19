/**
 * AIME Web Worker
 * 
 * This worker handles code indexing and semantic analysis off the main thread,
 * preventing UI blocking during workspace indexing.
 */

// Worker state
let isIndexing = false
let shouldCancel = false

// Simple regex-based parsers for supported languages
const PARSERS: Record<string, {
    functionPattern: RegExp
    classPattern: RegExp
}> = {
    javascript: {
        // eslint-disable-next-line security/detect-unsafe-regex
        functionPattern: /(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\s*\()/g,
        // eslint-disable-next-line security/detect-unsafe-regex
        classPattern: /class\s+(\w+)(?:\s+extends\s+(\w+))?/g
    },
    typescript: {
        // eslint-disable-next-line security/detect-unsafe-regex
        functionPattern: /(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*:\s*[^=]+=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\s*\()/g,
        // eslint-disable-next-line security/detect-unsafe-regex
        classPattern: /class\s+(\w+)(?:\s+extends\s+(\w+))?/g
    },
    python: {
        // eslint-disable-next-line security/detect-unsafe-regex
        functionPattern: /def\s+(\w+)\s*\(/g,
        // eslint-disable-next-line security/detect-unsafe-regex
        classPattern: /class\s+(\w+)(?:\([^)]*\))?\s*:/g
    },
    rust: {
        // eslint-disable-next-line security/detect-unsafe-regex
        functionPattern: /(?:pub\s+)?fn\s+(\w+)\s*\(/g,
        // eslint-disable-next-line security/detect-unsafe-regex
        classPattern: /(?:pub\s+)?struct\s+(\w+)|(?:pub\s+)?enum\s+(\w+)/g
    },
    go: {
        functionPattern: /func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/g,
        classPattern: /type\s+(\w+)\s+struct/g
    }
}

// File extensions to language mapping
const EXTENSION_MAP: Record<string, string> = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go'
}

// Index storage
interface CodeSymbol {
    name: string
    type: 'function' | 'class' | 'variable'
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

// Parse file content and extract symbols
function parseFile(filePath: string, content: string, relativePath: string, lastModified = 0): FileIndex {
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
    const language = EXTENSION_MAP[ext] || 'unknown'
    const parser = PARSERS[language]
    
    const symbols: CodeSymbol[] = []
    
    if (parser) {
        const lines = content.split('\n')
        
        // Extract functions
        let match
        while ((match = parser.functionPattern.exec(content)) !== null) {
            const name = match[1] || match[2]
            if (name) {
                const line = content.substring(0, match.index).split('\n').length
                symbols.push({
                    name,
                    type: 'function',
                    filePath,
                    line,
                    context: lines[line - 1]?.trim() || ''
                })
            }
        }
        
        // Extract classes
        while ((match = parser.classPattern.exec(content)) !== null) {
            const name = match[1]
            if (name) {
                const line = content.substring(0, match.index).split('\n').length
                symbols.push({
                    name,
                    type: 'class',
                    filePath,
                    line,
                    context: lines[line - 1]?.trim() || ''
                })
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

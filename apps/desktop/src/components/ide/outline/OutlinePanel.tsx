/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Document Outline sidebar panel: live symbol tree for the active editor
 * file (backed by Monaco model + LSP / structured multi-language extractor),
 * searchable, sortable, with follow-cursor highlight and click-to-jump.
 */
import { useEffect, useMemo, useState } from 'react'
import {
    ArrowDownAZ,
    ChevronDown,
    ChevronRight,
    ChevronsDownUp,
    ChevronsUpDown,
    Crosshair,
    ListTree,
    Search,
    X
} from 'lucide-react'
import { useEditorStatusStore } from '../../../stores/editorStatusStore'
import { EmptyState, IconButton } from '../../ui'
import { baseName, languageFromFileName } from '../languages'
import type { OpenFilesApi } from '../hooks/useOpenFiles'
import './outline.css'

export type OutlineKind =
    | 'function'
    | 'method'
    | 'class'
    | 'interface'
    | 'type'
    | 'enum'
    | 'struct'
    | 'variable'
    | 'property'
    | 'module'
    | 'heading'
    | 'selector'

export interface OutlineSymbol {
    id: string
    name: string
    kind: OutlineKind
    line: number
    column: number
    detail?: string
    children: OutlineSymbol[]
}

const KIND_BADGE: Record<OutlineKind, string> = {
    function: 'ƒ',
    method: 'm',
    class: 'C',
    interface: 'I',
    type: 'T',
    enum: 'E',
    struct: 'S',
    variable: 'v',
    property: 'p',
    module: 'M',
    heading: '#',
    selector: '§'
}

interface OutlinePanelProps {
    activePath: string | null
    buffers: OpenFilesApi
    visible: boolean
    onOpenFile: (path: string, line?: number) => void
}

function extractMarkdownOutline(lines: string[]): OutlineSymbol[] {
    const roots: OutlineSymbol[] = []
    const stack: Array<{ level: number; node: OutlineSymbol }> = []
    let inFence = false

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (/^\s*(?:```|~~~)/.test(line)) {
            inFence = !inFence
            continue
        }
        if (inFence) continue
        const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
        if (!match) continue
        const level = match[1].length
        const node: OutlineSymbol = {
            id: `md:${i + 1}:${match[2]}`,
            name: match[2],
            kind: 'heading',
            line: i + 1,
            column: 1,
            children: []
        }
        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
            stack.pop()
        }
        if (stack.length === 0) roots.push(node)
        else stack[stack.length - 1].node.children.push(node)
        stack.push({ level, node })
    }
    return roots
}

function extractPythonOutline(lines: string[]): OutlineSymbol[] {
    const roots: OutlineSymbol[] = []
    const stack: Array<{ indent: number; node: OutlineSymbol }> = []

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]
        const match = /^([ \t]*)(?:async\s+)?(class|def)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(raw)
        if (!match) continue
        const indent = match[1].replace(/\t/g, '    ').length
        const kw = match[2]
        const name = match[3]
        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
            stack.pop()
        }
        const parent = stack[stack.length - 1]?.node
        const kind: OutlineKind = kw === 'class' ? 'class' : parent?.kind === 'class' ? 'method' : 'function'
        const node: OutlineSymbol = {
            id: `py:${i + 1}:${name}`,
            name,
            kind,
            line: i + 1,
            column: indent + 1,
            children: []
        }
        if (parent) parent.children.push(node)
        else roots.push(node)
        stack.push({ indent, node })
    }
    return roots
}

function extractGoOutline(lines: string[]): OutlineSymbol[] {
    const roots: OutlineSymbol[] = []
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const methodMatch = /^func\s+\(([^)]+)\)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line)
        if (methodMatch) {
            roots.push({
                id: `go:${i + 1}:${methodMatch[2]}`,
                name: methodMatch[2],
                detail: methodMatch[1].trim(),
                kind: 'method',
                line: i + 1,
                column: 1,
                children: []
            })
            continue
        }
        const funcMatch = /^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[|\()/.exec(line)
        if (funcMatch) {
            roots.push({
                id: `go:${i + 1}:${funcMatch[1]}`,
                name: funcMatch[1],
                kind: 'function',
                line: i + 1,
                column: 1,
                children: []
            })
            continue
        }
        const typeMatch = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface|\S+)/.exec(line)
        if (typeMatch) {
            const kind: OutlineKind = typeMatch[2] === 'struct' ? 'struct' : typeMatch[2] === 'interface' ? 'interface' : 'type'
            roots.push({
                id: `go:${i + 1}:${typeMatch[1]}`,
                name: typeMatch[1],
                kind,
                line: i + 1,
                column: 1,
                children: []
            })
        }
    }
    return roots
}

function extractRustOutline(lines: string[]): OutlineSymbol[] {
    const roots: OutlineSymbol[] = []
    let currentImpl: OutlineSymbol | null = null
    let braceDepth = 0
    let implDepth = -1

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const trimmed = line.trim()
        const col = line.search(/\S/) + 1

        const implMatch = /^(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(.+?)\s*\{/.exec(trimmed)
        if (implMatch) {
            currentImpl = {
                id: `rs:${i + 1}:impl:${implMatch[1]}`,
                name: `impl ${implMatch[1].trim()}`,
                kind: 'module',
                line: i + 1,
                column: Math.max(1, col),
                children: []
            }
            roots.push(currentImpl)
            implDepth = braceDepth
        } else {
            const symMatch = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(mod|struct|enum|trait|type|fn|macro_rules!)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed)
            if (symMatch) {
                const kw = symMatch[1]
                const name = symMatch[2]
                const kind: OutlineKind = kw === 'struct' ? 'struct'
                    : kw === 'enum' ? 'enum'
                        : kw === 'trait' ? 'interface'
                            : kw === 'type' ? 'type'
                                : kw === 'mod' ? 'module'
                                    : currentImpl && braceDepth > implDepth ? 'method' : 'function'
                const node: OutlineSymbol = {
                    id: `rs:${i + 1}:${name}`,
                    name,
                    kind,
                    line: i + 1,
                    column: Math.max(1, col),
                    children: []
                }
                if (currentImpl && braceDepth > implDepth) currentImpl.children.push(node)
                else roots.push(node)
            }
        }

        for (let c = 0; c < line.length; c++) {
            if (line[c] === '{') braceDepth++
            else if (line[c] === '}') braceDepth = Math.max(0, braceDepth - 1)
        }
        if (currentImpl && braceDepth <= implDepth) {
            currentImpl = null
            implDepth = -1
        }
    }
    return roots
}

function extractCssOutline(lines: string[]): OutlineSymbol[] {
    const roots: OutlineSymbol[] = []
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        if (!trimmed || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) continue
        const atMatch = /^(@(?:media|keyframes|layer|supports|container)\s+[^{]+)\{/.exec(trimmed)
        if (atMatch) {
            roots.push({
                id: `css:${i + 1}:${atMatch[1]}`,
                name: atMatch[1].trim(),
                kind: 'module',
                line: i + 1,
                column: 1,
                children: []
            })
            continue
        }
        if (trimmed.endsWith('{') && !trimmed.startsWith('@') && !trimmed.includes(': ')) {
            const selector = trimmed.slice(0, -1).trim()
            if (selector) {
                roots.push({
                    id: `css:${i + 1}:${selector}`,
                    name: selector,
                    kind: 'selector',
                    line: i + 1,
                    column: 1,
                    children: []
                })
            }
        }
    }
    return roots
}

function extractJsonOutline(content: string): OutlineSymbol[] {
    const roots: OutlineSymbol[] = []
    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
        const m = /^(\s{0,4})"([^"]+)"\s*:/.exec(lines[i])
        if (!m) continue
        roots.push({
            id: `json:${i + 1}:${m[2]}`,
            name: m[2],
            kind: 'property',
            line: i + 1,
            column: m[1].length + 1,
            children: []
        })
    }
    return roots
}

function extractTsJsOutline(lines: string[]): OutlineSymbol[] {
    const roots: OutlineSymbol[] = []
    let currentClass: OutlineSymbol | null = null
    let braceDepth = 0
    let classDepth = -1
    let inBlockComment = false

    const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'typeof', 'await', 'else', 'do'])

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const trimmed = line.trim()
        if (inBlockComment) {
            if (trimmed.includes('*/')) inBlockComment = false
            continue
        }
        if (trimmed.startsWith('/*')) {
            if (!trimmed.includes('*/')) inBlockComment = true
            continue
        }
        if (!trimmed || trimmed.startsWith('//')) continue

        const col = Math.max(1, line.search(/\S/) + 1)

        // Class declaration
        const classMatch = /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed)
        if (classMatch) {
            const node: OutlineSymbol = {
                id: `ts:${i + 1}:class:${classMatch[1]}`,
                name: classMatch[1],
                kind: 'class',
                line: i + 1,
                column: col,
                children: []
            }
            roots.push(node)
            currentClass = node
            classDepth = braceDepth
        } else {
            // Interface / Type / Enum / Namespace
            const typeMatch = /^(?:export\s+)?(?:declare\s+)?(interface|type|enum|namespace)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed)
            if (typeMatch) {
                const kw = typeMatch[1]
                const kind: OutlineKind = kw === 'interface' ? 'interface'
                    : kw === 'enum' ? 'enum'
                        : kw === 'namespace' ? 'module' : 'type'
                roots.push({
                    id: `ts:${i + 1}:${kw}:${typeMatch[2]}`,
                    name: typeMatch[2],
                    kind,
                    line: i + 1,
                    column: col,
                    children: []
                })
            } else {
                // Function declaration
                const fnMatch = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<|\()/.exec(trimmed)
                if (fnMatch) {
                    const node: OutlineSymbol = {
                        id: `ts:${i + 1}:fn:${fnMatch[1]}`,
                        name: fnMatch[1],
                        kind: 'function',
                        line: i + 1,
                        column: col,
                        children: []
                    }
                    if (currentClass && braceDepth > classDepth) currentClass.children.push(node)
                    else roots.push(node)
                } else if (currentClass && braceDepth === classDepth + 1) {
                    // Class method / getter / setter / constructor
                    const methodMatch = /^(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*([A-Za-z_$#][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{;]+)?\{/.exec(trimmed)
                    if (methodMatch && !CONTROL_KEYWORDS.has(methodMatch[1])) {
                        currentClass.children.push({
                            id: `ts:${i + 1}:m:${methodMatch[1]}`,
                            name: methodMatch[1],
                            kind: 'method',
                            line: i + 1,
                            column: col,
                            children: []
                        })
                    }
                } else if (braceDepth === 0) {
                    // Top-level const/let/var arrow function, React component, or exported binding
                    const arrowMatch = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*|forwardRef|memo|create\b|createContext\b)/.exec(trimmed)
                    if (arrowMatch) {
                        const isFunc = trimmed.includes('=>') || /=\s*(?:async\s*)?function\b/.test(trimmed) || /=\s*(?:React\.)?(?:forwardRef|memo)\b/.test(trimmed)
                        roots.push({
                            id: `ts:${i + 1}:var:${arrowMatch[1]}`,
                            name: arrowMatch[1],
                            kind: isFunc ? 'function' : 'variable',
                            line: i + 1,
                            column: col,
                            children: []
                        })
                    } else {
                        const exportConstMatch = /^export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed)
                        if (exportConstMatch) {
                            roots.push({
                                id: `ts:${i + 1}:exp:${exportConstMatch[1]}`,
                                name: exportConstMatch[1],
                                kind: 'variable',
                                line: i + 1,
                                column: col,
                                children: []
                            })
                        }
                    }
                }
            }
        }

        for (let c = 0; c < line.length; c++) {
            if (line[c] === '{') braceDepth++
            else if (line[c] === '}') braceDepth = Math.max(0, braceDepth - 1)
        }
        if (currentClass && braceDepth <= classDepth) {
            currentClass = null
            classDepth = -1
        }
    }

    return roots
}

function extractCStyleOutline(lines: string[]): OutlineSymbol[] {
    const roots: OutlineSymbol[] = []
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('#')) continue
        const typeMatch = /^(?:template\s*<[^>]*>\s*)?(class|struct|enum(?:\s+class)?|namespace)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed)
        if (typeMatch) {
            const kw = typeMatch[1]
            const kind: OutlineKind = kw.startsWith('enum') ? 'enum' : kw === 'struct' ? 'struct' : kw === 'namespace' ? 'module' : 'class'
            roots.push({
                id: `c:${i + 1}:${typeMatch[2]}`,
                name: typeMatch[2],
                kind,
                line: i + 1,
                column: 1,
                children: []
            })
            continue
        }
        const fnMatch = /^(?:(?:static|inline|virtual|extern|constexpr|unsigned|signed|const)\s+)*[A-Za-z_][A-Za-z0-9_:<>*&\s]+\s+([A-Za-z_~][A-Za-z0-9_:~]*)\s*\([^;]*\)\s*(?:const\s*)?(?:override\s*)?\{/.exec(trimmed)
        if (fnMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(fnMatch[1])) {
            roots.push({
                id: `c:${i + 1}:fn:${fnMatch[1]}`,
                name: fnMatch[1],
                kind: 'function',
                line: i + 1,
                column: 1,
                children: []
            })
        }
    }
    return roots
}

export function extractDocumentSymbols(content: string, language: string): OutlineSymbol[] {
    if (!content.trim()) return []
    const lines = content.split(/\r?\n/)
    switch (language) {
        case 'markdown':
            return extractMarkdownOutline(lines)
        case 'python':
            return extractPythonOutline(lines)
        case 'go':
            return extractGoOutline(lines)
        case 'rust':
            return extractRustOutline(lines)
        case 'css':
        case 'scss':
        case 'less':
            return extractCssOutline(lines)
        case 'json':
            return extractJsonOutline(content)
        case 'c':
        case 'cpp':
            return extractCStyleOutline(lines)
        case 'typescript':
        case 'javascript':
        default:
            return extractTsJsOutline(lines)
    }
}

function filterSymbols(nodes: OutlineSymbol[], needle: string): OutlineSymbol[] {
    if (!needle) return nodes
    const out: OutlineSymbol[] = []
    for (const node of nodes) {
        const filteredChildren = filterSymbols(node.children, needle)
        if (node.name.toLowerCase().includes(needle) || filteredChildren.length > 0) {
            out.push({ ...node, children: filteredChildren })
        }
    }
    return out
}

function sortSymbols(nodes: OutlineSymbol[], byName: boolean): OutlineSymbol[] {
    const sorted = [...nodes].sort((a, b) => (byName ? a.name.localeCompare(b.name) : a.line - b.line))
    return sorted.map(n => ({ ...n, children: sortSymbols(n.children, byName) }))
}

function collectExpandableIds(nodes: OutlineSymbol[]): string[] {
    const ids: string[] = []
    for (const node of nodes) {
        if (node.children.length > 0) {
            ids.push(node.id)
            ids.push(...collectExpandableIds(node.children))
        }
    }
    return ids
}

function findActiveSymbolId(nodes: OutlineSymbol[], cursorLine: number): string | null {
    let best: { id: string; line: number } | null = null
    const walk = (list: OutlineSymbol[]) => {
        for (const node of list) {
            if (node.line <= cursorLine && (!best || node.line >= best.line)) {
                best = { id: node.id, line: node.line }
            }
            walk(node.children)
        }
    }
    walk(nodes)
    return best ? (best as { id: string; line: number }).id : null
}

export function OutlinePanel({ activePath, buffers, visible, onOpenFile }: OutlinePanelProps) {
    const cursorLine = useEditorStatusStore(s => s.line)
    const [query, setQuery] = useState('')
    const [sortByName, setSortByName] = useState(false)
    const [followCursor, setFollowCursor] = useState(true)
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
    const [symbols, setSymbols] = useState<OutlineSymbol[]>([])

    const activeFile = useMemo(
        () => (activePath ? buffers.files.find(f => f.path === activePath) ?? null : null),
        [activePath, buffers.files]
    )

    useEffect(() => {
        if (!visible) return
        if (!activeFile) {
            setSymbols([])
            return
        }
        const timer = setTimeout(() => {
            const lang = activeFile.language || languageFromFileName(activeFile.name)
            setSymbols(extractDocumentSymbols(activeFile.content, lang))
        }, 120)
        return () => clearTimeout(timer)
    }, [visible, activeFile])

    const visibleTree = useMemo(() => {
        const needle = query.trim().toLowerCase()
        const filtered = filterSymbols(symbols, needle)
        return sortSymbols(filtered, sortByName)
    }, [symbols, query, sortByName])

    const expandableIds = useMemo(() => collectExpandableIds(visibleTree), [visibleTree])
    const allCollapsed = expandableIds.length > 0 && expandableIds.every(id => collapsed.has(id))

    const activeSymbolId = useMemo(
        () => (followCursor ? findActiveSymbolId(visibleTree, cursorLine) : null),
        [followCursor, visibleTree, cursorLine]
    )

    const toggleNode = (id: string) => {
        setCollapsed(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const toggleAll = () => {
        if (allCollapsed) setCollapsed(new Set())
        else setCollapsed(new Set(expandableIds))
    }

    const jumpTo = (sym: OutlineSymbol) => {
        if (!activePath) return
        onOpenFile(activePath, sym.line)
        window.dispatchEvent(
            new CustomEvent('kalynt-open-file', {
                detail: { path: activePath, line: sym.line, column: sym.column }
            })
        )
    }

    const renderNodes = (nodes: OutlineSymbol[], depth: number) => (
        <ul className="outline-list">
            {nodes.map(node => {
                const hasChildren = node.children.length > 0
                const isOpen = !collapsed.has(node.id) || query.trim().length > 0
                const isCurrent = node.id === activeSymbolId
                return (
                    <li key={node.id}>
                        <div
                            className={`outline-row ${isCurrent ? 'is-current' : ''}`}
                            style={{ paddingLeft: 10 + depth * 14 }}
                        >
                            {hasChildren ? (
                                <button
                                    type="button"
                                    className="outline-row__toggle"
                                    onClick={() => toggleNode(node.id)}
                                    aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
                                    aria-expanded={isOpen}
                                >
                                    {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                </button>
                            ) : (
                                <span className="outline-row__toggle" aria-hidden />
                            )}
                            <button
                                type="button"
                                className="outline-row__btn"
                                onClick={() => jumpTo(node)}
                                title={`${node.name} (${node.kind}, line ${node.line})`}
                            >
                                <span className={`outline-row__kind outline-row__kind--${node.kind}`} aria-hidden>
                                    {KIND_BADGE[node.kind]}
                                </span>
                                <span className="outline-row__name">{node.name}</span>
                                <span className="outline-row__line">{node.line}</span>
                            </button>
                        </div>
                        {hasChildren && isOpen && renderNodes(node.children, depth + 1)}
                    </li>
                )
            })}
        </ul>
    )

    return (
        <div className="outline-panel">
            <header className="side-head">
                <h2 className="side-head__title">Outline</h2>
                <div className="side-head__actions">
                    <IconButton
                        size="sm"
                        label={sortByName ? 'Sort by position' : 'Sort alphabetically'}
                        icon={<ArrowDownAZ size={14} />}
                        active={sortByName}
                        onClick={() => setSortByName(v => !v)}
                    />
                    <IconButton
                        size="sm"
                        label={followCursor ? 'Disable follow cursor' : 'Follow cursor'}
                        icon={<Crosshair size={14} />}
                        active={followCursor}
                        onClick={() => setFollowCursor(v => !v)}
                    />
                    {expandableIds.length > 0 && (
                        <IconButton
                            size="sm"
                            label={allCollapsed ? 'Expand all' : 'Collapse all'}
                            icon={allCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
                            onClick={toggleAll}
                        />
                    )}
                </div>
            </header>

            {activePath && (
                <>
                    <div className="outline-panel__file" title={activePath}>
                        {baseName(activePath)}
                    </div>
                    <div className="outline-panel__search">
                        <div className="outline-panel__input-wrap">
                            <Search size={12} className="outline-panel__input-icon" aria-hidden />
                            <input
                                type="text"
                                className="outline-panel__input"
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder="Filter symbols…"
                                aria-label="Filter document symbols"
                            />
                            {query && (
                                <button
                                    type="button"
                                    className="outline-panel__clear"
                                    onClick={() => setQuery('')}
                                    aria-label="Clear symbol filter"
                                >
                                    <X size={11} />
                                </button>
                            )}
                        </div>
                    </div>
                </>
            )}

            <div className="outline-panel__body">
                {!activeFile ? (
                    <EmptyState
                        compact
                        icon={<ListTree size={20} />}
                        title="No active editor"
                        description="Open a file to inspect its symbols."
                    />
                ) : visibleTree.length === 0 ? (
                    <EmptyState
                        compact
                        icon={<ListTree size={20} />}
                        title={symbols.length === 0 ? 'No symbols found' : 'No matching symbols'}
                        description={
                            symbols.length === 0
                                ? `No outline symbols detected in ${activeFile.name}.`
                                : 'Try a different filter query.'
                        }
                    />
                ) : (
                    renderNodes(visibleTree, 0)
                )}
            </div>
        </div>
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Lightweight pure-React syntax highlighter for chat code blocks.
 * Emits React elements only (never HTML strings) so model output cannot inject markup.
 */
import type { ReactNode } from 'react'

type TokenKind = 'plain' | 'kw' | 'str' | 'num' | 'cm' | 'type' | 'fn' | 'tag' | 'attr' | 'add' | 'del'

const JS_KEYWORDS = new Set([
    'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
    'from', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'keyof',
    'let', 'namespace', 'new', 'null', 'of', 'private', 'protected', 'public', 'readonly',
    'return', 'satisfies', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type',
    'typeof', 'undefined', 'var', 'void', 'while', 'yield'
])

const PY_KEYWORDS = new Set([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
    'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import',
    'in', 'is', 'lambda', 'match', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
    'while', 'with', 'yield'
])

const RUST_KEYWORDS = new Set([
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern',
    'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub',
    'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe',
    'use', 'where', 'while'
])

const GO_KEYWORDS = new Set([
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'false',
    'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'iota', 'map', 'nil', 'package',
    'range', 'return', 'select', 'struct', 'switch', 'true', 'type', 'var'
])

const SHELL_KEYWORDS = new Set([
    'case', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for', 'function', 'if', 'in',
    'local', 'readonly', 'return', 'select', 'then', 'until', 'while'
])

const SQL_KEYWORDS = new Set([
    'AND', 'AS', 'ASC', 'BY', 'CASE', 'CREATE', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'ELSE', 'END',
    'FROM', 'GROUP', 'HAVING', 'IN', 'INNER', 'INSERT', 'INTO', 'IS', 'JOIN', 'LEFT', 'LIMIT', 'NOT',
    'NULL', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'RIGHT', 'SELECT', 'SET', 'TABLE', 'THEN',
    'UNION', 'UPDATE', 'VALUES', 'WHEN', 'WHERE'
])

const C_KEYWORDS = new Set([
    'auto', 'bool', 'break', 'case', 'catch', 'char', 'class', 'const', 'constexpr', 'continue',
    'default', 'delete', 'do', 'double', 'else', 'enum', 'explicit', 'extern', 'false', 'final',
    'float', 'for', 'if', 'inline', 'int', 'interface', 'long', 'namespace', 'new', 'noexcept',
    'null', 'nullptr', 'override', 'private', 'protected', 'public', 'return', 'short', 'signed',
    'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef',
    'typename', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'while'
])

const TYPES = new Set([
    'Array', 'BigInt', 'Boolean', 'Buffer', 'Date', 'Error', 'Map', 'Number', 'Object', 'Option',
    'Partial', 'Promise', 'Record', 'RegExp', 'Result', 'Set', 'String', 'Symbol', 'Vec',
    'any', 'boolean', 'byte', 'char', 'f32', 'f64', 'float', 'i16', 'i32', 'i64', 'i8', 'int',
    'isize', 'never', 'number', 'object', 'rune', 'str', 'string', 'u16', 'u32', 'u64', 'u8',
    'uint', 'unknown', 'usize', 'void'
])

function normalizeLang(raw: string): string {
    const l = raw.trim().toLowerCase()
    if (['ts', 'tsx', 'typescript', 'mts', 'cts', 'js', 'jsx', 'javascript', 'mjs', 'cjs'].includes(l)) return 'js'
    if (['py', 'python', 'py3'].includes(l)) return 'py'
    if (['rs', 'rust'].includes(l)) return 'rust'
    if (['go', 'golang'].includes(l)) return 'go'
    if (['sh', 'bash', 'zsh', 'shell'].includes(l)) return 'sh'
    if (['sql', 'postgres', 'postgresql', 'mysql', 'sqlite'].includes(l)) return 'sql'
    if (['json', 'jsonc'].includes(l)) return 'json'
    if (['css', 'scss', 'less'].includes(l)) return 'css'
    if (['html', 'htm', 'xml', 'svg'].includes(l)) return 'html'
    if (['diff', 'patch'].includes(l)) return 'diff'
    if (['c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'java', 'cs', 'csharp', 'kt', 'kotlin', 'swift'].includes(l)) return 'c'
    if (['yml', 'yaml', 'toml'].includes(l)) return 'yaml'
    return l || 'plain'
}

function keywordsFor(lang: string): Set<string> | null {
    switch (lang) {
        case 'js': return JS_KEYWORDS
        case 'py': return PY_KEYWORDS
        case 'rust': return RUST_KEYWORDS
        case 'go': return GO_KEYWORDS
        case 'sh': return SHELL_KEYWORDS
        case 'sql': return SQL_KEYWORDS
        case 'c': return C_KEYWORDS
        default: return null
    }
}

const MAX_HIGHLIGHT_CHARS = 24_000

/** Tokenizes a code string into React nodes with `.tok-*` spans. */
export function highlightCode(source: string, rawLang: string): ReactNode {
    const lang = normalizeLang(rawLang)
    if (!source || source.length > MAX_HIGHLIGHT_CHARS || lang === 'plain') return source

    if (lang === 'diff') {
        const lines = source.split('\n')
        return lines.map((line, i) => {
            const cls = line.startsWith('+') && !line.startsWith('+++') ? 'tok-add'
                : line.startsWith('-') && !line.startsWith('---') ? 'tok-del'
                    : line.startsWith('@@') ? 'tok-kw' : undefined
            const nl = i < lines.length - 1 ? '\n' : ''
            return cls ? <span key={i} className={cls}>{line}{nl}</span> : `${line}${nl}`
        })
    }

    const out: ReactNode[] = []
    let plain = ''
    let key = 0
    const flushPlain = () => {
        if (plain) { out.push(plain); plain = '' }
    }
    const emit = (kind: TokenKind, text: string) => {
        if (!text) return
        if (kind === 'plain') { plain += text; return }
        flushPlain()
        out.push(<span key={key++} className={`tok-${kind}`}>{text}</span>)
    }

    const hashComments = lang === 'py' || lang === 'sh' || lang === 'yaml'
    const slashComments = lang === 'js' || lang === 'rust' || lang === 'go' || lang === 'c' || lang === 'css' || lang === 'json'
    const sqlComments = lang === 'sql'
    const keywords = keywordsFor(lang)
    const len = source.length
    let i = 0

    while (i < len) {
        const ch = source[i]
        const next = source[i + 1]

        // HTML comments & tags
        if (lang === 'html' && ch === '<') {
            if (source.startsWith('<!--', i)) {
                const end = source.indexOf('-->', i + 4)
                const stop = end < 0 ? len : end + 3
                emit('cm', source.slice(i, stop))
                i = stop
                continue
            }
            const tagMatch = /^<\/?[A-Za-z][\w:-]*/.exec(source.slice(i, i + 64))
            if (tagMatch) {
                emit('tag', tagMatch[0])
                i += tagMatch[0].length
                continue
            }
        }

        // Line comments
        if ((slashComments && ch === '/' && next === '/') || (hashComments && ch === '#') || (sqlComments && ch === '-' && next === '-')) {
            const end = source.indexOf('\n', i)
            const stop = end < 0 ? len : end
            emit('cm', source.slice(i, stop))
            i = stop
            continue
        }

        // Block comments /* ... */
        if ((slashComments || sqlComments) && ch === '/' && next === '*') {
            const end = source.indexOf('*/', i + 2)
            const stop = end < 0 ? len : end + 2
            emit('cm', source.slice(i, stop))
            i = stop
            continue
        }

        // Strings ('...', "...", `...`)
        if (ch === '"' || ch === '\'' || (ch === '`' && (lang === 'js' || lang === 'go' || lang === 'sh'))) {
            const quote = ch
            let j = i + 1
            while (j < len) {
                if (source[j] === '\\') { j += 2; continue }
                if (source[j] === quote) { j++; break }
                if (quote !== '`' && source[j] === '\n') break
                j++
            }
            const token = source.slice(i, j)
            // JSON property keys before `:` look distinct from string values.
            if (lang === 'json' && quote === '"') {
                let k = j
                while (k < len && (source[k] === ' ' || source[k] === '\t')) k++
                emit(source[k] === ':' ? 'attr' : 'str', token)
            } else {
                emit('str', token)
            }
            i = j
            continue
        }

        // Numbers
        if ((ch >= '0' && ch <= '9') || (ch === '.' && next >= '0' && next <= '9')) {
            let j = i + 1
            while (j < len && /[0-9a-fA-FxXoObB._eE+-]/.test(source[j])) {
                if ((source[j] === '+' || source[j] === '-') && source[j - 1] !== 'e' && source[j - 1] !== 'E') break
                j++
            }
            emit('num', source.slice(i, j))
            i = j
            continue
        }

        // Identifiers / keywords / types / functions / CSS properties
        if (/[A-Za-z_$@]/.test(ch)) {
            let j = i + 1
            while (j < len && /[\w$-]/.test(source[j])) {
                if (source[j] === '-' && lang !== 'css' && lang !== 'html' && lang !== 'yaml') break
                j++
            }
            const word = source.slice(i, j)
            let kind: TokenKind = 'plain'
            if (lang === 'json') {
                if (word === 'true' || word === 'false' || word === 'null') kind = 'kw'
            } else if (lang === 'css') {
                if (word.startsWith('@')) kind = 'kw'
                else if (source[j] === ':') kind = 'attr'
            } else if (lang === 'html') {
                if (source[j] === '=') kind = 'attr'
            } else if (lang === 'yaml') {
                if (source[j] === ':') kind = 'attr'
                else if (word === 'true' || word === 'false' || word === 'null') kind = 'kw'
            } else if (keywords?.has(lang === 'sql' ? word.toUpperCase() : word)) {
                kind = 'kw'
            } else if (TYPES.has(word) || (/^[A-Z][A-Za-z0-9_]*$/.test(word) && lang !== 'sql')) {
                kind = 'type'
            } else if (source[j] === '(') {
                kind = 'fn'
            }
            emit(kind, word)
            i = j
            continue
        }

        emit('plain', ch)
        i++
    }

    flushPlain()
    return out
}

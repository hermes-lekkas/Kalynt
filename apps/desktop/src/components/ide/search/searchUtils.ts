/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export interface SearchOptions {
    regex: boolean
    caseSensitive: boolean
    wholeWord: boolean
}

export interface SearchMatch {
    filePath: string
    fileName: string
    line: number
    column: number
    matchText: string
    before: string
    after: string
}

const BINARY_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'bmp', 'woff', 'woff2', 'ttf', 'eot', 'otf',
    'mp3', 'mp4', 'wav', 'avi', 'mov', 'webm', 'zip', 'tar', 'gz', 'rar', '7z', 'pdf', 'doc', 'docx',
    'xls', 'xlsx', 'exe', 'dll', 'so', 'dylib', 'bin', 'pyc', 'wasm', 'o', 'a', 'class', 'jar', 'lock'
])

export const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function isBinaryFile(fileName: string): boolean {
    const ext = fileName.split('.').pop()?.toLowerCase() || ''
    return BINARY_EXTENSIONS.has(ext)
}

/** Builds the search pattern, or returns an error message for an invalid regex. */
export function buildPattern(query: string, options: SearchOptions): RegExp | string {
    let source = options.regex ? query : escapeRegex(query)
    if (options.wholeWord) source = `\\b(?:${source})\\b`
    try {
        return new RegExp(source, options.caseSensitive ? 'g' : 'gi')
    } catch (error) {
        return error instanceof Error ? error.message : 'Invalid regular expression'
    }
}

/** Keeps the replacement's casing in line with what it replaces (FOO → BAR, Foo → Bar). */
export function preserveCase(original: string, replacement: string): string {
    if (!original) return replacement
    if (original === original.toUpperCase() && original !== original.toLowerCase()) return replacement.toUpperCase()
    if (original === original.toLowerCase()) return replacement.toLowerCase()
    if (original[0] === original[0].toUpperCase()) return replacement.charAt(0).toUpperCase() + replacement.slice(1)
    return replacement
}

/** Computes the inline replacement preview for a single matched substring. */
export function formatReplacementPreview(
    matchText: string,
    replacement: string,
    keepCase: boolean,
    isRegex: boolean,
    pattern?: RegExp | null
): string {
    if (!replacement) return ''
    if (!isRegex) return keepCase ? preserveCase(matchText, replacement) : replacement
    if (!pattern) return replacement
    try {
        const single = new RegExp(pattern.source, pattern.flags.replace('g', ''))
        return matchText.replace(single, replacement)
    } catch {
        return replacement
    }
}

/** Extracts all matches of `pattern` in `content`, capped at `maxRemaining`. */
export function extractMatchesInText(
    filePath: string,
    fileName: string,
    content: string,
    pattern: RegExp,
    maxRemaining: number
): { matches: SearchMatch[]; truncated: boolean } {
    const matches: SearchMatch[] = []
    if (maxRemaining <= 0) return { matches, truncated: true }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i]
        pattern.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = pattern.exec(line)) !== null) {
            if (m[0].length === 0) { pattern.lastIndex++; continue }
            if (matches.length >= maxRemaining) return { matches, truncated: true }
            matches.push({
                filePath,
                fileName,
                line: i + 1,
                column: m.index + 1,
                matchText: m[0],
                // Short leading context keeps the match itself in view in a narrow side bar.
                before: (m.index > 18 ? '…' : '') + line.slice(Math.max(0, m.index - 18), m.index).trimStart(),
                after: line.slice(m.index + m[0].length, m.index + m[0].length + 80)
            })
        }
    }
    return { matches, truncated: false }
}

export function splitList(value: string): string[] {
    const parts: string[] = []
    let depth = 0, start = 0
    for (let i = 0; i < value.length; i++) {
        if (value[i] === '{') depth++
        else if (value[i] === '}') depth = Math.max(0, depth - 1)
        else if (value[i] === ',' && depth === 0) { parts.push(value.slice(start, i).trim()); start = i + 1 }
    }
    parts.push(value.slice(start).trim())
    return parts.filter(Boolean)
}

function expandBraces(pattern: string): string[] {
    const match = /\{([^{}]+)\}/.exec(pattern)
    if (!match) return [pattern]
    return match[1].split(',').flatMap(part => expandBraces(pattern.slice(0, match.index) + part + pattern.slice(match.index + match[0].length)))
}

function globRegex(pattern: string): RegExp {
    let source = ''
    for (let i = 0; i < pattern.length; i++) {
        if (pattern[i] === '*' && pattern[i + 1] === '*') {
            i++
            if (pattern[i + 1] === '/') { source += '(?:.*/)?'; i++ }
            else source += '.*'
        } else if (pattern[i] === '*') source += '[^/]*'
        else if (pattern[i] === '?') source += '[^/]'
        else source += escapeRegex(pattern[i])
    }
    return new RegExp(`^${source}$`, 'i')
}

/** Accepts extension shorthand, names and workspace-relative glob patterns. */
export function matchesInclude(fileName: string, include: string[]): boolean {
    if (include.length === 0) return true
    const relative = fileName.replace(/\\/g, '/').replace(/^\.\//, '')
    const name = relative.split('/').pop()!.toLowerCase()
    return include.some(raw => expandBraces(raw).some(value => {
        const pattern = value.replace(/^\.\//, '').toLowerCase()
        if (/[*?{]/.test(pattern) || pattern.includes('/')) return globRegex(pattern).test(pattern.includes('/') ? relative : name)
        if (pattern.startsWith('.')) return name.endsWith(pattern)
        return name === pattern || name.endsWith(`.${pattern}`)
    }))
}

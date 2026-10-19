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
    'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'webp', 'bmp', 'woff', 'woff2', 'ttf', 'eot', 'otf',
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
    if (options.wholeWord) source = `\\b${source}\\b`
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

export function splitList(value: string): string[] {
    return value.split(',').map(s => s.trim()).filter(Boolean)
}

/** Matches "ts", ".ts", "*.ts" or a full file name against an include list. */
export function matchesInclude(fileName: string, include: string[]): boolean {
    if (include.length === 0) return true
    const lower = fileName.toLowerCase()
    return include.some(raw => {
        const pattern = raw.toLowerCase().replace(/^\*/, '')
        if (pattern.startsWith('.')) return lower.endsWith(pattern)
        return lower === pattern || lower.endsWith(`.${pattern}`)
    })
}

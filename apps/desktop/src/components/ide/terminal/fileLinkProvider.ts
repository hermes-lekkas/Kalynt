/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * xterm link provider for clickable `file:line:col`, `file(line,col)` and
 * Python traceback file links that open directly in the IDE editor via the
 * `kalynt-open-file` window event.
 */
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import path from 'path-browserify'

export interface ParsedFileLink {
    /** Exact matched text in the line */
    text: string
    /** 0-based start offset in the line string */
    startIndex: number
    /** 0-based exclusive end offset in the line string */
    endIndex: number
    filePath: string
    line?: number
    column?: number
}

// Non-backtracking linear-time patterns for common compiler/stacktrace file locations.
// 1. Python traceback: File "/path/to/foo.py", line 42
const PYTHON_TRACE_RE = /File "([^"\r\n]+)", line (\d+)/g

// 2. Standard file:line(:col) or file(line(,col)) paths
// Matches POSIX (/a/b.ts:10:2, ./a/b.ts:10, src/a.ts:10:2) and Windows (C:\a\b.ts:10:2, a\b.ts(10,2))
const FILE_LOC_RE =
    /(?:^|[\s(['"`])((?:[A-Za-z]:[\\/]+|[\\/]+)?(?:[^\s:'"()[\]<>|*?`/\\]+[\\/]+)*[^\s:'"()[\]<>|*?`/\\]+\.[A-Za-z0-9]{1,10})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))/g

function isAbsolutePath(filePath: string): boolean {
    return filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\')
}

function isUrlPrefix(line: string, matchStart: number): boolean {
    const before = line.slice(Math.max(0, matchStart - 10), matchStart)
    return /(?:https?|wss?|ftp|file):\/\/$/i.test(before) || /^mailto:$/i.test(before)
}

export function extractFileLinks(line: string): ParsedFileLink[] {
    if (!line || line.length > 4096) return []

    const links: ParsedFileLink[] = []
    const occupied: Array<[number, number]> = []

    const overlaps = (start: number, end: number) =>
        occupied.some(([s, e]) => start < e && end > s)

    // Python tracebacks first (more specific)
    PYTHON_TRACE_RE.lastIndex = 0
    let pyMatch: RegExpExecArray | null
    while ((pyMatch = PYTHON_TRACE_RE.exec(line)) !== null) {
        const filePath = pyMatch[1]
        const lineNum = Number.parseInt(pyMatch[2], 10)
        const startIndex = pyMatch.index
        const endIndex = startIndex + pyMatch[0].length
        if (filePath && !Number.isNaN(lineNum) && !overlaps(startIndex, endIndex)) {
            occupied.push([startIndex, endIndex])
            links.push({
                text: pyMatch[0],
                startIndex,
                endIndex,
                filePath,
                line: lineNum
            })
        }
    }

    // Compiler / linter / Node / Rust / Go / TypeScript / MSBuild file:line:col links
    FILE_LOC_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = FILE_LOC_RE.exec(line)) !== null) {
        const filePath = match[1]
        if (!filePath) continue

        // Skip leading separator character captured by (?:^|[\s(['"`])
        const leadOffset = match[0].indexOf(filePath)
        const startIndex = match.index + Math.max(0, leadOffset)
        const text = match[0].slice(Math.max(0, leadOffset))
        const endIndex = startIndex + text.length

        if (isUrlPrefix(line, startIndex)) continue
        if (/^(?:https?|wss?|ftp|mailto):/i.test(filePath)) continue
        if (overlaps(startIndex, endIndex)) continue

        const lineStr = match[2] ?? match[4]
        const colStr = match[3] ?? match[5]
        const lineNum = lineStr ? Number.parseInt(lineStr, 10) : undefined
        const colNum = colStr ? Number.parseInt(colStr, 10) : undefined

        if (lineNum !== undefined && (Number.isNaN(lineNum) || lineNum <= 0)) continue

        occupied.push([startIndex, endIndex])
        links.push({
            text,
            startIndex,
            endIndex,
            filePath,
            line: lineNum,
            column: colNum !== undefined && !Number.isNaN(colNum) && colNum > 0 ? colNum : undefined
        })
    }

    return links
}

export function resolveTerminalFilePath(filePath: string, folder: string | null): string {
    if (!folder || isAbsolutePath(filePath)) return filePath
    const isWin = /^[A-Za-z]:[\\/]/.test(folder)
    const normalizedFolder = isWin ? folder.replace(/\\/g, '/') : folder
    const normalizedFile = filePath.replace(/\\/g, '/')
    return path.normalize(`${normalizedFolder}/${normalizedFile}`)
}

export function createFileLinkProvider(
    xterm: Terminal,
    getFolder: () => string | null
): ILinkProvider {
    return {
        provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
            const bufferLine = xterm.buffer.active.getLine(bufferLineNumber - 1)
            if (!bufferLine) {
                callback(undefined)
                return
            }

            const text = bufferLine.translateToString(true)
            const parsed = extractFileLinks(text)
            if (parsed.length === 0) {
                callback(undefined)
                return
            }

            const links: ILink[] = parsed.map(item => ({
                text: item.text,
                range: {
                    start: { x: item.startIndex + 1, y: bufferLineNumber },
                    end: { x: item.endIndex, y: bufferLineNumber }
                },
                decorations: {
                    pointerCursor: true,
                    underline: true
                },
                activate: () => {
                    const resolved = resolveTerminalFilePath(item.filePath, getFolder())
                    window.dispatchEvent(new CustomEvent('kalynt-open-file', {
                        detail: {
                            path: resolved,
                            line: item.line,
                            column: item.column
                        }
                    }))
                }
            }))

            callback(links)
        }
    }
}

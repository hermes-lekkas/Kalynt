/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Line diff (Myers' O(ND) algorithm) for showing the agent's edits, folded
 * into hunks with a few lines of context.
 */
import type { DiffLine } from './types'

type Op = { type: 'context' | 'add' | 'remove'; text: string }

function myers(a: string[], b: string[]): Op[] {
    const n = a.length
    const m = b.length
    const max = n + m
    const offset = max + 1
    const v = new Int32Array(2 * max + 3)
    const trace: Int32Array[] = []
    let found = false
    for (let d = 0; d <= max && !found; d++) {
        trace.push(v.slice())
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
            let y = x - k
            while (x < n && y < m && a[x] === b[y]) { x++; y++ }
            v[offset + k] = x
            if (x >= n && y >= m) { found = true; break }
        }
    }
    // Walk the trace backwards to recover the edit script.
    const ops: Op[] = []
    let x = n
    let y = m
    for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
        const vd = trace[d]
        const k = x - y
        const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1
        const prevX = d === 0 ? 0 : vd[offset + prevK]
        const prevY = prevX - prevK
        while (x > prevX && y > prevY) { ops.push({ type: 'context', text: a[x - 1] }); x--; y-- }
        if (d > 0) {
            if (x === prevX) { ops.push({ type: 'add', text: b[y - 1] }); y-- }
            else { ops.push({ type: 'remove', text: a[x - 1] }); x-- }
        }
    }
    while (x > 0 && y > 0) { ops.push({ type: 'context', text: a[x - 1] }); x--; y-- }
    return ops.reverse()
}

const splitLines = (text: string) => text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')

/** Diff of two file versions as hunks; very large inputs fall back to a summary. */
export function diffLines(before: string | null, after: string, context = 3): { lines: DiffLine[]; added: number; removed: number } {
    const a = splitLines(before ?? '')
    const b = splitLines(after)
    if (a.length + b.length > 20000) {
        return { lines: [{ type: 'gap', text: `Large change: ${a.length} → ${b.length} lines` }], added: b.length, removed: a.length }
    }
    // Trim the shared head and tail first; most edits touch a small region.
    let head = 0
    while (head < a.length && head < b.length && a[head] === b[head]) head++
    let tail = 0
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
    const ops: Op[] = [
        ...a.slice(0, head).map(text => ({ type: 'context' as const, text })),
        ...myers(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
        ...a.slice(a.length - tail).map(text => ({ type: 'context' as const, text }))
    ]

    let oldLine = 0
    let newLine = 0
    let added = 0
    let removed = 0
    const numbered: DiffLine[] = ops.map(op => {
        if (op.type === 'context') return { type: 'context', text: op.text, oldLine: ++oldLine, newLine: ++newLine }
        if (op.type === 'add') { added++; return { type: 'add', text: op.text, newLine: ++newLine } }
        removed++
        return { type: 'remove', text: op.text, oldLine: ++oldLine }
    })

    // Keep only changes plus `context` lines around them.
    const keep = new Array(numbered.length).fill(false)
    numbered.forEach((line, i) => {
        if (line.type === 'context') return
        for (let j = Math.max(0, i - context); j <= Math.min(numbered.length - 1, i + context); j++) keep[j] = true
    })
    const lines: DiffLine[] = []
    let skipped = 0
    numbered.forEach((line, i) => {
        if (keep[i]) {
            if (skipped) lines.push({ type: 'gap', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` })
            skipped = 0
            lines.push(line)
        } else skipped++
    })
    if (skipped && lines.length) lines.push({ type: 'gap', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` })
    return { lines, added, removed }
}

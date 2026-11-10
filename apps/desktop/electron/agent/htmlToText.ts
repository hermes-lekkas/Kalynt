/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Turns an HTML page into readable Markdown-like text for the agent: the main
 * content with headings, lists, links and code blocks kept, and scripts,
 * styles, navigation and other page chrome removed. Dependency-free.
 */

const NAMED: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', times: '×'
}

export function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
        if (code[0] === '#') {
            const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
            return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole
        }
        return NAMED[code.toLowerCase()] ?? whole
    })
}

/**
 * Applies a removal until the text stops changing, so removed pieces can't
 * join into a new match (as in `<scr<script></script>ipt>`).
 */
function removeAll(text: string, pattern: RegExp): string {
    let previous: string
    do {
        previous = text
        text = text.replace(pattern, '')
    } while (text !== previous)
    return text
}

/** Removes every tag, including one left unclosed at the end. */
export function stripTags(html: string): string {
    return removeAll(html, /<[^>]*>/g).replace(/<[^>]*$/, '')
}

/** Links to these schemes are kept as plain text. */
const UNSAFE_SCHEME = /^\s*(javascript|data|vbscript):/i

/** Elements whose content is never useful to read. */
const DROP = /<(script|style|noscript|svg|template|iframe|canvas|form|select|button)\b[\s\S]*?<\/\1>/gi
/** Page chrome, removed only when there is a <main> or <article> to fall back on. */
const CHROME = /<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi

function absolutize(href: string, base: string): string {
    try { return new URL(href, base).toString() } catch { return href }
}

export function htmlToText(html: string, baseUrl: string): { title: string; text: string } {
    const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim())
    let body = removeAll(removeAll(html, /<!--[\s\S]*?-->/g), DROP)
    const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body)
    body = main ? main[2] : removeAll(/<body[^>]*>([\s\S]*)<\/body>/i.exec(body)?.[1] ?? body, CHROME)

    // Code blocks first, so their whitespace survives.
    const codeBlocks: string[] = []
    body = body.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
        codeBlocks.push(decodeEntities(stripTags(inner)).replace(/\n+$/, ''))
        return `\n\u0000CODE${codeBlocks.length - 1}\u0000\n`
    })

    body = body
        .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${stripTags(inner).trim()}\n\n`)
        .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
            const text = stripTags(inner).trim()
            const target = decodeEntities(href)
            if (!text || target.startsWith('#') || UNSAFE_SCHEME.test(target)) return text
            return `[${text}](${absolutize(target, baseUrl)})`
        })
        .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => '`' + stripTags(inner) + '`')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<\/(p|div|section|ul|ol|table|tr|blockquote|li|dd|dt)>/gi, '\n')
        .replace(/<(br|hr)\s*\/?>/gi, '\n')
        .replace(/<t[dh][^>]*>/gi, ' | ')

    let text = decodeEntities(stripTags(body))
        .replace(/[ \t\f\v ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, n: string) => '```\n' + codeBlocks[Number(n)] + '\n```')
    return { title, text }
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Web access for the AI agent, from the main process (no CORS limits):
 *   agent:web-fetch   { url, maxChars?, allowPrivate? } -> { ok, url, title, content, contentType }
 *   agent:web-search  { query, count? }  -> { ok, results: [{ title, url, snippet }] }
 * Search needs no API key: DuckDuckGo's lite page, with Bing as a fallback.
 */
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import zlib from 'node:zlib'
import type { IpcMain } from 'electron'
import { htmlToText, decodeEntities } from './htmlToText'
import { resolvePublicUrl, type ResolvedPublicHost } from './netGuard'

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Kalynt'
const MAX_BYTES = 5_000_000
const TIMEOUT_MS = 20_000

const MAX_REDIRECTS = 8

interface PinnedResponse {
    status: number
    headers: http.IncomingHttpHeaders
    body: Buffer
}

function requestOnce(url: URL, pinned: ResolvedPublicHost, headers: Record<string, string>, signal: AbortSignal): Promise<PinnedResponse> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error('Aborted'))
            return
        }
        const host = url.hostname.replace(/^\[|\]$/g, '')
        const transport = url.protocol === 'https:' ? https : http
        const lookup = (_hostname: string, opts: unknown, cb: (...args: any[]) => void) => {
            const callback = typeof opts === 'function' ? opts as (...args: any[]) => void : cb
            if (typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all) {
                callback(null, [{ address: pinned.address, family: pinned.family }])
            } else {
                callback(null, pinned.address, pinned.family)
            }
        }
        const req = transport.request(url, {
            method: 'GET',
            headers: {
                'User-Agent': USER_AGENT,
                'Accept-Language': 'en-US,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                ...headers
            },
            lookup: lookup as http.RequestOptions['lookup'],
            ...(url.protocol === 'https:' && !isIP(host) ? { servername: host } : {}),
            signal
        }, res => {
            const status = res.statusCode ?? 0
            // Do not read redirect response bodies; drain and return headers immediately.
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume()
                resolve({ status, headers: res.headers, body: Buffer.alloc(0) })
                return
            }

            const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase()
            const stream: NodeJS.ReadableStream = encoding === 'gzip'
                ? res.pipe(zlib.createGunzip())
                : encoding === 'deflate'
                    ? res.pipe(zlib.createInflate())
                    : encoding === 'br'
                        ? res.pipe(zlib.createBrotliDecompress())
                        : res

            const chunks: Buffer[] = []
            let size = 0
            let settled = false
            const finish = () => {
                if (settled) return
                settled = true
                resolve({ status, headers: res.headers, body: Buffer.concat(chunks) })
            }
            stream.on('data', (chunk: Buffer | string) => {
                if (settled) return
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                size += buf.byteLength
                if (size > MAX_BYTES) {
                    const remaining = MAX_BYTES - (size - buf.byteLength)
                    if (remaining > 0) chunks.push(buf.subarray(0, remaining))
                    res.destroy()
                    finish()
                    return
                }
                chunks.push(buf)
            })
            stream.on('end', finish)
            stream.on('error', err => {
                if (settled) return
                settled = true
                reject(err)
            })
        })
        req.on('error', reject)
        req.end()
    })
}

/**
 * GET with IP pinning (blocks DNS rebinding), size cap, and timeout.
 * Every hop of a redirect chain must use http/https and resolve to a public address.
 */
async function fetchText(url: string, headers: Record<string, string> = {}): Promise<{ text: string; contentType: string; finalUrl: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
        let current = new URL(url)
        let response: PinnedResponse
        for (let hop = 0; ; hop++) {
            if (current.protocol !== 'http:' && current.protocol !== 'https:') {
                throw new Error('Only http and https URLs can be fetched.')
            }
            const pinned = await resolvePublicUrl(current)
            response = await requestOnce(current, pinned, headers, controller.signal)
            const location = typeof response.headers.location === 'string' ? response.headers.location : undefined
            if (response.status < 300 || response.status >= 400 || !location) break
            if (hop >= MAX_REDIRECTS) throw new Error('The site redirected too many times.')
            current = new URL(location, current)
        }
        if (response.status < 200 || response.status >= 300) throw new Error(`The site answered with HTTP ${response.status}.`)
        const text = new TextDecoder().decode(response.body)
        const contentType = String(response.headers['content-type'] ?? '')
        return { text, contentType, finalUrl: current.href }
    } catch (error) {
        if (controller.signal.aborted) throw new Error('The site took too long to answer.')
        throw error
    } finally {
        clearTimeout(timer)
    }
}

export interface SearchResult {
    title: string
    url: string
    snippet: string
}

const stripTags = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

/** DuckDuckGo lite: result links carry the target in a `uddg` parameter. */
function parseDuckDuckGo(html: string): SearchResult[] {
    const results: SearchResult[] = []
    const linkRe = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g
    const snippets = [...html.matchAll(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)].map(m => stripTags(m[1]))
    let match: RegExpExecArray | null
    let i = 0
    while ((match = linkRe.exec(html)) !== null) {
        let url = decodeEntities(match[1])
        const target = /[?&]uddg=([^&]+)/.exec(url)
        if (target) url = decodeURIComponent(target[1])
        if (url.startsWith('//')) url = `https:${url}`
        if (/duckduckgo\.com\/y\.js|ad_domain/.test(url)) { i++; continue }
        results.push({ title: stripTags(match[2]), url, snippet: snippets[i] ?? '' })
        i++
    }
    return results
}

/** Bing: links are wrapped in a tracking URL whose `u` parameter holds base64 of the target. */
function parseBing(html: string): SearchResult[] {
    const results: SearchResult[] = []
    for (const block of html.split('<li class="b_algo"').slice(1)) {
        const link = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
        if (!link) continue
        let url = decodeEntities(link[1])
        const wrapped = /[?&]u=a1([^&]+)/.exec(url)
        if (wrapped) {
            try { url = Buffer.from(wrapped[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') } catch { /* keep wrapped URL */ }
        }
        const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)
        results.push({ title: stripTags(link[2]), url, snippet: snippet ? stripTags(snippet[1]) : '' })
    }
    return results
}

export async function webSearch(query: string, count = 8): Promise<SearchResult[]> {
    const q = encodeURIComponent(query)
    const errors: string[] = []
    try {
        const { text } = await fetchText(`https://lite.duckduckgo.com/lite/?q=${q}`)
        const results = parseDuckDuckGo(text)
        if (results.length) return results.slice(0, count)
    } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
    }
    try {
        const { text } = await fetchText(`https://www.bing.com/search?q=${q}&setlang=en`)
        const results = parseBing(text)
        if (results.length) return results.slice(0, count)
    } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
    }
    if (errors.length) throw new Error(`Search failed: ${errors.join('; ')}`)
    return []
}

export async function webFetch(rawUrl: string, maxChars = 40_000): Promise<{ url: string; title: string; content: string; contentType: string; truncated: boolean }> {
    let url: URL
    try { url = new URL(rawUrl) } catch { throw new Error('That is not a valid URL.') }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs can be fetched.')
    const { text, contentType, finalUrl } = await fetchText(url.toString(), { Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5' })
    let title = ''
    let content = text
    if (/html|xml/.test(contentType) || /^\s*<(!doctype|html)/i.test(text)) {
        const converted = htmlToText(text, finalUrl)
        title = converted.title
        content = converted.text
    } else if (/json/.test(contentType)) {
        try { content = JSON.stringify(JSON.parse(text), null, 2) } catch { /* keep as-is */ }
    } else if (!/text|javascript|csv|yaml|markdown/.test(contentType) && contentType) {
        throw new Error(`This URL returned ${contentType}, which can't be read as text.`)
    }
    const truncated = content.length > maxChars
    return { url: finalUrl, title, content: truncated ? content.slice(0, maxChars) : content, contentType, truncated }
}

export function registerAgentWebHandlers(ipcMain: IpcMain): void {
    ipcMain.handle('agent:web-search', async (_event, options: { query: string; count?: number }) => {
        const query = typeof options?.query === 'string' ? options.query.trim() : ''
        if (!query) return { ok: false, error: 'Enter a search query.' }
        try {
            return { ok: true, results: await webSearch(query, Math.min(Math.max(options.count ?? 8, 1), 20)) }
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    ipcMain.handle('agent:web-fetch', async (_event, options: { url: string; maxChars?: number; allowPrivate?: boolean }) => {
        try {
            const maxChars = Math.min(Math.max(options?.maxChars ?? 40_000, 1000), 200_000)
            // Always ignore renderer-supplied allowPrivate to prevent SSRF from untrusted IPC callers.
            return { ok: true, ...(await webFetch(String(options?.url ?? ''), maxChars)) }
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
    })
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Small HTTPS helpers that follow redirects (GitHub and most download sites redirect).
 */
import fs from 'fs'
import https from 'https'
import http from 'http'
import type { IncomingMessage } from 'http'

const HEADERS = { 'User-Agent': 'Kalynt', Accept: '*/*' }
const MAX_REDIRECTS = 8
const IDLE_TIMEOUT_MS = 60_000

function open(url: string, redirects = 0): Promise<{ response: IncomingMessage; finalUrl: string }> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https:') ? https : http
        const request = client.get(url, { headers: HEADERS }, response => {
            const status = response.statusCode ?? 0
            if (status >= 300 && status < 400 && response.headers.location) {
                response.resume()
                if (redirects >= MAX_REDIRECTS) return reject(new Error('Too many redirects'))
                resolve(open(new URL(response.headers.location, url).toString(), redirects + 1))
                return
            }
            if (status !== 200) {
                response.resume()
                reject(new Error(`${new URL(url).host} answered HTTP ${status}`))
                return
            }
            resolve({ response, finalUrl: url })
        })
        request.setTimeout(IDLE_TIMEOUT_MS, () => request.destroy(new Error('The download stalled')))
        request.on('error', reject)
    })
}

export async function getJson<T>(url: string): Promise<T> {
    const { response } = await open(url)
    const chunks: Buffer[] = []
    for await (const chunk of response) chunks.push(chunk as Buffer)
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

export interface DownloadProgress {
    bytesDownloaded: number
    totalBytes: number
    speed: number
}

/** Downloads to `dest`; resolves with the URL it finally came from (after redirects). */
export async function downloadFile(url: string, dest: string, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<string> {
    const { response, finalUrl } = await open(url)
    const total = Number(response.headers['content-length'] || 0)
    let received = 0
    let lastTick = Date.now()
    let lastBytes = 0
    const file = fs.createWriteStream(dest)
    const abort = () => response.destroy(new Error('Cancelled'))
    signal?.addEventListener('abort', abort)
    try {
        await new Promise<void>((resolve, reject) => {
            response.on('data', (chunk: Buffer) => {
                received += chunk.length
                const now = Date.now()
                if (now - lastTick >= 500) {
                    onProgress({ bytesDownloaded: received, totalBytes: total, speed: Math.round((received - lastBytes) / ((now - lastTick) / 1000)) })
                    lastTick = now
                    lastBytes = received
                }
            })
            response.on('error', reject)
            response.on('aborted', () => reject(new Error('The connection dropped')))
            file.on('error', reject)
            file.on('finish', resolve)
            response.pipe(file)
        })
    } finally {
        signal?.removeEventListener('abort', abort)
        file.close()
    }
    if (total > 0 && received < total) throw new Error('The download was incomplete')
    onProgress({ bytesDownloaded: received, totalBytes: total || received, speed: 0 })
    return finalUrl
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Model downloads. Data goes to "<file>.part" and is renamed into place only
 * once the full size has arrived, so a half-downloaded model is never mistaken
 * for an installed one. Pausing keeps the .part file and a later download
 * resumes it with a Range request.
 */
import fs from 'fs'
import http, { type ClientRequest } from 'http'
import https from 'https'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { BrowserWindow as BrowserWindowType } from 'electron'
import { validatePath } from '../utils/pathValidator'
import { sendToWindow } from '../utils/window'

type StopReason = 'paused' | 'canceled'

interface ActiveDownload {
    stop: (reason: StopReason) => void
}

const activeDownloads = new Map<string, ActiveDownload>()
/** .part files by model, kept while a download is running or paused. */
const partFiles = new Map<string, string>()

export interface ModelDownloadHandlerOptions {
    /** Internal unit-test hook only (never exposed over IPC): allows http://127.0.0.1 mock servers. */
    allowLocalTestServer?: boolean
}

interface DownloadOptions {
    modelId: string
    url: string
    filename: string
    expectedSize: number
}

interface DownloadResult {
    success: boolean
    path?: string
    error?: string
    paused?: boolean
    canceled?: boolean
}

const MAX_REDIRECTS = 5
const IDLE_TIMEOUT_MS = 60_000
const PROGRESS_INTERVAL_MS = 500

const sizeOf = (file: string) => {
    try { return fs.statSync(file).size } catch { return 0 }
}

function removeQuietly(file: string) {
    fs.promises.rm(file, { force: true }).catch(err => console.warn('[Download] Could not remove', file, err))
}

function isPrivateV4(address: string): boolean {
    const parts = address.split('.').map(Number)
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
    const [a, b] = parts
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168) || a >= 224
}

function isPrivateAddress(raw: string): boolean {
    const address = raw.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
    const family = isIP(address)
    if (family === 4) return isPrivateV4(address)
    if (family !== 6) return true
    const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(address)
    if (mapped) {
        if (mapped[1]) return isPrivateV4(mapped[1])
        const hi = parseInt(mapped[2], 16), lo = parseInt(mapped[3], 16)
        return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    return address === '::' || address === '::1' || /^f[cd]/.test(address) || /^fe[89ab]/.test(address) || /^ff/.test(address)
}

interface ResolvedAddress {
    address: string
    family: 4 | 6
}

/**
 * Validates that a download URL (or redirect target) uses HTTPS and resolves
 * exclusively to public IP addresses. Returns the resolved addresses so the
 * socket lookup can pin them and prevent DNS-rebinding TOCTOU attacks.
 */
async function validateDownloadUrl(rawUrl: string, allowLocalTestServer: boolean): Promise<{ parsedUrl: URL; addresses: ResolvedAddress[] }> {
    let parsedUrl: URL
    try {
        parsedUrl = new URL(rawUrl)
    } catch {
        throw new Error('Invalid download URL')
    }

    if (parsedUrl.username || parsedUrl.password) {
        throw new Error('Download URL must not contain embedded credentials')
    }

    const host = parsedUrl.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
    if (!host) throw new Error('Invalid download URL host')

    const isLoopbackTest = allowLocalTestServer && (host === '127.0.0.1' || host === '::1' || host === 'localhost')
    if (isLoopbackTest) {
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            throw new Error('Unsupported download URL protocol')
        }
        const addr = host === '::1' ? { address: '::1', family: 6 as const } : { address: '127.0.0.1', family: 4 as const }
        return { parsedUrl, addresses: [addr] }
    }

    if (parsedUrl.protocol !== 'https:') {
        throw new Error('Only HTTPS model download URLs are allowed')
    }

    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        throw new Error('Downloads from local or private hosts are not allowed')
    }

    const ipVersion = isIP(host)
    let addresses: ResolvedAddress[]
    if (ipVersion === 4 || ipVersion === 6) {
        addresses = [{ address: host, family: ipVersion }]
    } else {
        const records = await lookup(host, { all: true, verbatim: true })
        if (!records.length) throw new Error('Could not resolve download host')
        addresses = records.map(r => ({ address: r.address, family: r.family === 6 ? 6 : 4 }))
    }

    if (addresses.some(r => isPrivateAddress(r.address))) {
        throw new Error('Downloads from private or loopback addresses are not allowed')
    }

    return { parsedUrl, addresses }
}

/** Pauses and aborts all in-flight model downloads; called on shutdown / stop-all. */
export function abortAllModelDownloads(): number {
    const downloads = [...activeDownloads.values()]
    for (const download of downloads) {
        download.stop('paused')
    }
    return downloads.length
}

export function registerModelDownloadHandlers(
    ipcMain: Electron.IpcMain,
    getMainWindow: () => BrowserWindowType | null,
    getModelsDir: () => string,
    handlerOptions?: ModelDownloadHandlerOptions
) {
    const allowLocalTestServer = handlerOptions?.allowLocalTestServer === true

    ipcMain.handle('download-model', async (_event, options: DownloadOptions): Promise<DownloadResult> => {
        const { modelId, filename, expectedSize } = options

        if (activeDownloads.has(modelId)) {
            return { success: false, error: 'This model is already downloading' }
        }
        if (typeof options?.url !== 'string' || !options.url.trim()) {
            return { success: false, error: 'Invalid download URL' }
        }
        try {
            await validateDownloadUrl(options.url, allowLocalTestServer)
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : 'Invalid download URL' }
        }

        let destPath: string
        try {
            destPath = validatePath(getModelsDir(), filename)
        } catch {
            return { success: false, error: 'Invalid model filename' }
        }
        const partPath = `${destPath}.part`
        partFiles.set(modelId, partPath)

        // Older versions wrote straight to the final name. Adopt such a file as
        // the partial download; if it is complete the server answers 416.
        if (!fs.existsSync(partPath) && fs.existsSync(destPath)) {
            try { fs.renameSync(destPath, partPath) } catch { /* in use: download afresh */ }
        }

        return new Promise<DownloadResult>(resolve => {
            let request: ClientRequest | null = null
            let file: fs.WriteStream | null = null
            let settled = false
            let stopReason: StopReason | null = null
            let redirects = 0

            const finish = (result: DownloadResult, after?: () => void) => {
                if (settled) return
                settled = true
                activeDownloads.delete(modelId)
                const done = () => { after?.(); resolve(result) }
                if (file && !file.closed) file.close(done)
                else done()
            }

            const fail = (error: string) => {
                if (stopReason === 'canceled') {
                    partFiles.delete(modelId)
                    finish({ success: false, canceled: true }, () => removeQuietly(partPath))
                } else if (stopReason === 'paused') {
                    finish({ success: false, paused: true })
                } else {
                    finish({ success: false, error })
                }
            }

            activeDownloads.set(modelId, {
                stop: reason => {
                    stopReason = reason
                    request?.destroy()
                    fail(reason)
                }
            })

            const get = (url: string) => {
                void (async () => {
                    if (settled) return
                    let parsedUrl: URL
                    let addresses: ResolvedAddress[]
                    try {
                        ({ parsedUrl, addresses } = await validateDownloadUrl(url, allowLocalTestServer))
                    } catch (err) {
                        return fail(err instanceof Error ? err.message : 'Invalid download URL or redirect protocol')
                    }
                    if (settled) return

                    const startByte = sizeOf(partPath)
                    const client = parsedUrl.protocol === 'https:' ? https : http
                    const pinnedLookup = (_hostname: string, opts: unknown, cb?: (...args: any[]) => void) => {
                        const callback = typeof opts === 'function' ? (opts as (...args: any[]) => void) : cb!
                        const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all === true
                        if (all) {
                            callback(null, addresses.map(a => ({ address: a.address, family: a.family })))
                        } else {
                            callback(null, addresses[0].address, addresses[0].family)
                        }
                    }

                    const host = parsedUrl.hostname.replace(/^\[|\]$/g, '')
                    const reqOptions: https.RequestOptions = {
                        headers: startByte > 0 ? { Range: `bytes=${startByte}-` } : {},
                        lookup: pinnedLookup as any,
                        ...(parsedUrl.protocol === 'https:' && !isIP(host) ? { servername: host } : {})
                    }

                    request = client.get(parsedUrl, reqOptions, response => {
                        const status = response.statusCode ?? 0

                        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
                            response.resume()
                            if (++redirects > MAX_REDIRECTS) return fail('Too many redirects')
                            try { return get(new URL(response.headers.location, parsedUrl).toString()) }
                            catch { return fail('Invalid download redirect URL') }
                        }

                        // The .part file already holds everything.
                        if (status === 416 && startByte > 0) {
                            response.resume()
                            const total = /^bytes \*\/(\d+)$/i.exec(response.headers['content-range'] || '')
                            if (total && Number(total[1]) === startByte) return complete(startByte)
                            return fail('The server rejected the partial download. Cancel it and start again.')
                        }

                        if (status !== 200 && status !== 206) {
                            response.resume()
                            return fail(`The server answered HTTP ${status}`)
                        }

                        // A 200 means the server ignored the Range header: start over.
                        const resumed = status === 206
                        let received = resumed ? startByte : 0
                        // Catalog sizes are approximate; only Content-Length is exact.
                        const length = Number(response.headers['content-length'] || 0)
                        let exactTotal = length > 0 ? length + (resumed ? startByte : 0) : 0
                        if (resumed) {
                            const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers['content-range'] || '')
                            if (!range || Number(range[1]) !== startByte || Number(range[2]) < startByte || Number(range[3]) <= Number(range[2]) || (length > 0 && Number(range[2]) - startByte + 1 !== length)) {
                                response.resume()
                                return fail('The server returned an invalid resume range. Cancel the download and start again.')
                            }
                            exactTotal = Number(range[3])
                        }
                        const total = exactTotal || expectedSize

                        file = fs.createWriteStream(partPath, { flags: resumed ? 'a' : 'w' })
                        file.on('error', err => fail(`Couldn't write the model file: ${err.message}`))

                        let lastTick = Date.now()
                        let lastBytes = received
                        const progress = (force = false) => {
                            const now = Date.now()
                            if (!force && now - lastTick < PROGRESS_INTERVAL_MS) return
                            const speed = Math.max(0, Math.round((received - lastBytes) / Math.max((now - lastTick) / 1000, 0.001)))
                            lastTick = now
                            lastBytes = received
                            sendToWindow(getMainWindow(), 'download-progress', { modelId, bytesDownloaded: received, totalBytes: total, speed })
                        }

                        response.on('data', (chunk: Buffer) => {
                            received += chunk.length
                            progress()
                        })
                        response.on('aborted', () => fail('The connection dropped. Resume to continue.'))
                        response.on('error', err => fail(err.message))
                        response.pipe(file)
                        file.on('finish', () => {
                            if (settled) return
                            progress(true)
                            if (exactTotal > 0 && received !== exactTotal) {
                                fail('The connection dropped. Resume to continue.')
                            } else {
                                complete(received)
                            }
                        })
                    })

                    request.setTimeout(IDLE_TIMEOUT_MS, () => request?.destroy(new Error('The download stalled')))
                    request.on('error', err => fail(err.message))
                })()
            }

            const complete = (bytes: number) => {
                console.log(`[Download] ${modelId} complete (${bytes} bytes)`)
                partFiles.delete(modelId)
                const close = file && !file.closed ? new Promise<void>(r => file!.close(() => r())) : Promise.resolve()
                close
                    .then(() => fs.promises.rename(partPath, destPath))
                    .then(() => finish({ success: true, path: destPath }))
                    .catch(err => fail(`Couldn't finish the download: ${err.message}`))
            }

            console.log('[Download] Starting', modelId)
            get(options.url)
        })
    })

    // Stops the transfer and keeps the .part file for a later resume.
    ipcMain.handle('pause-download', async (_event, modelId: string) => {
        const download = activeDownloads.get(modelId)
        if (!download) return { success: false, error: 'Download not found' }
        download.stop('paused')
        return { success: true }
    })

    // Resuming is a new download-model call; this only reports whether one is running.
    ipcMain.handle('resume-download', async (_event, modelId: string) => {
        if (activeDownloads.has(modelId)) return { success: false, error: 'Download already active' }
        return { success: true }
    })

    // Stops the transfer and removes the partial file.
    ipcMain.handle('cancel-download', async (_event, modelId: string) => {
        const download = activeDownloads.get(modelId)
        if (download) {
            download.stop('canceled')
            return { success: true }
        }
        // A paused download has no transfer but still has its .part file.
        const partPath = partFiles.get(modelId)
        if (partPath) {
            partFiles.delete(modelId)
            removeQuietly(partPath)
        }
        return { success: true }
    })
}

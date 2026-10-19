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
import type { BrowserWindow as BrowserWindowType } from 'electron'
import { validatePath } from '../utils/pathValidator'

type StopReason = 'paused' | 'canceled'

interface ActiveDownload {
    stop: (reason: StopReason) => void
}

const activeDownloads = new Map<string, ActiveDownload>()
/** .part files by model, kept while a download is running or paused. */
const partFiles = new Map<string, string>()

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

export function registerModelDownloadHandlers(
    ipcMain: Electron.IpcMain,
    getMainWindow: () => BrowserWindowType | null,
    getModelsDir: () => string
) {
    ipcMain.handle('download-model', async (_event, options: DownloadOptions): Promise<DownloadResult> => {
        const { modelId, filename, expectedSize } = options

        if (activeDownloads.has(modelId)) {
            return { success: false, error: 'This model is already downloading' }
        }
        if (!/^https?:\/\//i.test(options.url || '')) {
            return { success: false, error: 'Invalid download URL' }
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
                const startByte = sizeOf(partPath)
                const client = url.startsWith('https:') ? https : http
                request = client.get(url, { headers: startByte > 0 ? { Range: `bytes=${startByte}-` } : {} }, response => {
                    const status = response.statusCode ?? 0

                    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
                        response.resume()
                        if (++redirects > MAX_REDIRECTS) return fail('Too many redirects')
                        return get(new URL(response.headers.location, url).toString())
                    }

                    // The .part file already holds everything.
                    if (status === 416 && startByte > 0) {
                        response.resume()
                        return complete(startByte)
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
                    const exactTotal = length > 0 ? length + (resumed ? startByte : 0) : 0
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
                        getMainWindow()?.webContents.send('download-progress', { modelId, bytesDownloaded: received, totalBytes: total, speed })
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
                        if (exactTotal > 0 && received < exactTotal) {
                            fail('The connection dropped. Resume to continue.')
                        } else {
                            complete(received)
                        }
                    })
                })

                request.setTimeout(IDLE_TIMEOUT_MS, () => request?.destroy(new Error('The download stalled')))
                request.on('error', err => fail(err.message))
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

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Downloading extension packages from Open VSX and unpacking them into the
 * extensions folder.
 */
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { app } from 'electron'
import extractZip from 'extract-zip'
import { downloadFile } from '../services/runtimes/http'

// Marketplace downloads start at Open VSX; extension ids become folder names.
const MARKETPLACE_HOSTS = /(^|\.)open-vsx\.org$/i
const EXTENSION_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/i

/** A .vsix path inside the app's temp folder, or an error. */
export function tempVsixPath(target: string): string {
    const temp = path.resolve(app.getPath('temp'))
    const resolved = path.resolve(target)
    if (!resolved.startsWith(temp + path.sep) || !resolved.toLowerCase().endsWith('.vsix')) {
        throw new Error('Extensions can only be downloaded to a .vsix file in the temporary folder')
    }
    return resolved
}

export async function downloadVsix(url: string, targetPath: string): Promise<void> {
    const target = tempVsixPath(targetPath)
    const start = new URL(url)
    if (start.protocol !== 'https:' || !MARKETPLACE_HOSTS.test(start.hostname)) {
        throw new Error('Extensions can only be downloaded from Open VSX')
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    try {
        const finalUrl = await downloadFile(url, target, () => undefined)
        if (!finalUrl.startsWith('https:')) throw new Error('Refused a download that left HTTPS')
        // Open VSX answers a missing extension by redirecting to its /error page.
        if (/\/error(\/|$|\?)/.test(new URL(finalUrl).pathname)) {
            throw new Error('Extension not found on Open VSX. It may not exist or may have been removed.')
        }
    } catch (error) {
        fs.rmSync(target, { force: true })
        throw error
    }
}

/**
 * Unpacks a .vsix into `extensionsDir/<publisher.name>` and returns that id.
 * `beforeReplace` runs when an older copy of the same extension is about to be removed.
 */
export async function unpackVsix(vsixPath: string, extensionsDir: string, beforeReplace: (id: string) => Promise<void>): Promise<string> {
    if (!fs.existsSync(vsixPath)) throw new Error(`VSIX file not found: ${vsixPath}`)
    const size = fs.statSync(vsixPath).size
    if (size < 100) throw new Error(`The VSIX file is too small (${size} bytes); the download probably failed.`)

    const tempDir = path.join(os.tmpdir(), `kalynt-ext-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`)
    fs.mkdirSync(tempDir, { recursive: true })
    try {
        // extract-zip rejects entries that would land outside tempDir.
        await extractZip(vsixPath, { dir: tempDir })
        const source = path.join(tempDir, 'extension')
        const manifestPath = path.join(source, 'package.json')
        if (!fs.existsSync(manifestPath)) throw new Error('Invalid VSIX: missing extension/package.json')

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
        if (!manifest.name || !manifest.publisher) throw new Error('Invalid VSIX: manifest missing name or publisher')
        const id = `${manifest.publisher}.${manifest.name}`
        // The id becomes a folder name: refuse anything that could point elsewhere.
        if (!EXTENSION_ID.test(id) || id.includes('..')) throw new Error(`Invalid extension id: ${id}`)

        const target = path.join(extensionsDir, id)
        if (fs.existsSync(target)) {
            await beforeReplace(id)
            fs.rmSync(target, { recursive: true, force: true })
        }
        // Copy rather than rename: the temp folder may be on another drive.
        fs.cpSync(source, target, { recursive: true })
        return id
    } catch (error) {
        throw new Error(`Failed to install extension: ${(error as Error).message}`)
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
        // A downloaded package in the temp folder is no longer needed; a user-chosen .vsix stays.
        try { fs.rmSync(tempVsixPath(vsixPath), { force: true }) } catch { /* not ours */ }
    }
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Runtimes Kalynt installed into its own folder. Their bin folders are put on
 * PATH for terminals and programs Kalynt starts; the system PATH and shell
 * profiles are never changed.
 */
import fs from 'fs'
import path from 'path'

export interface ManagedRuntime {
    version: string
    installPath: string
    binDirs: string[]
    env?: Record<string, string>
}

let runtimesDir = ''
let cache: Record<string, ManagedRuntime> | null = null

const manifestPath = () => path.join(runtimesDir, 'runtimes.json')

export function setRuntimesDir(dir: string): void {
    runtimesDir = dir
    cache = null
}

export function getRuntimesDir(): string {
    return runtimesDir
}

export function readManifest(): Record<string, ManagedRuntime> {
    if (cache) return cache
    try {
        cache = runtimesDir && fs.existsSync(manifestPath()) ? JSON.parse(fs.readFileSync(manifestPath(), 'utf-8')) : {}
    } catch {
        cache = {}
    }
    return cache!
}

function writeManifest(next: Record<string, ManagedRuntime>): void {
    const tmp = `${manifestPath()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, manifestPath())
    cache = next
}

export function recordRuntime(id: string, runtime: ManagedRuntime): void {
    writeManifest({ ...readManifest(), [id]: runtime })
}

export function forgetRuntime(id: string): void {
    const next = { ...readManifest() }
    delete next[id]
    writeManifest(next)
}

/** bin folders of installed runtimes that still exist on disk. */
export function managedBinDirs(): string[] {
    return Object.values(readManifest()).flatMap(r => r.binDirs).filter(dir => fs.existsSync(dir))
}

/** Extra variables some runtimes need (e.g. CARGO_HOME for Rust). */
export function managedEnv(): Record<string, string> {
    return Object.assign({}, ...Object.values(readManifest()).map(r => r.env ?? {}))
}

/** PATH with Kalynt-managed runtimes first. */
export function withManagedPath(currentPath: string): string {
    const dirs = managedBinDirs()
    if (!dirs.length) return currentPath
    return [...dirs, currentPath].filter(Boolean).join(path.delimiter)
}

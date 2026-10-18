/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Unpacking runtime archives and finding the folder their programs live in.
 */
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import extractZip from 'extract-zip'

const isWin = process.platform === 'win32'

type ArchiveKind = 'zip' | 'tar' | 'program'

/** Archive type from the file's first bytes; download URLs often hide the extension. */
export function archiveKind(file: string): ArchiveKind {
    const fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(6)
    fs.readSync(fd, head, 0, 6, 0)
    fs.closeSync(fd)
    if (head[0] === 0x50 && head[1] === 0x4b) return 'zip'
    if (head[0] === 0x1f && head[1] === 0x8b) return 'tar'
    if (head.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return 'tar'
    return 'program'
}

const run = (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }, onLog?: (line: string) => void) =>
    new Promise<void>((resolve, reject) => {
        const child = execFile(file, args, { ...options, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, err => (err ? reject(err) : resolve()))
        const forward = (data: Buffer) => data.toString().split(/\r?\n/).filter(Boolean).forEach(line => onLog?.(line))
        child.stdout?.on('data', forward)
        child.stderr?.on('data', forward)
    })

export async function extractArchive(archive: string, dest: string, onLog?: (line: string) => void): Promise<void> {
    fs.mkdirSync(dest, { recursive: true })
    if (archiveKind(archive) === 'zip') {
        await extractZip(archive, { dir: path.resolve(dest) })
        return
    }
    // tar detects gzip and xz by itself (GNU tar, bsdtar on macOS and Windows 10+).
    await run('tar', ['-xf', archive, '-C', dest], { timeout: 10 * 60_000 }, onLog)
}

/** The folder holding `exe`, searched a few levels deep (archives usually wrap everything in one folder). */
export function findBinDir(root: string, exe: string, depth = 4): string | null {
    const names = isWin ? [`${exe}.exe`, `${exe}.cmd`, exe] : [exe]
    const queue: { dir: string; level: number }[] = [{ dir: root, level: 0 }]
    while (queue.length) {
        const { dir, level } = queue.shift()!
        let entries: fs.Dirent[]
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
        if (entries.some(e => (e.isFile() || e.isSymbolicLink()) && names.includes(e.name))) return dir
        if (level >= depth) continue
        // Prefer bin folders, then everything else.
        entries.filter(e => e.isDirectory()).sort((a, b) => Number(b.name === 'bin') - Number(a.name === 'bin'))
            .forEach(e => queue.push({ dir: path.join(dir, e.name), level: level + 1 }))
    }
    return null
}

export function makeExecutable(file: string): void {
    if (!isWin) {
        try { fs.chmodSync(file, 0o755) } catch { /* not ours to change */ }
    }
}

/** Runs rustup-init so Rust lands inside `installPath` and nothing outside it changes. */
export async function runRustup(installer: string, installPath: string, onLog?: (line: string) => void): Promise<Record<string, string>> {
    const env = { CARGO_HOME: path.join(installPath, 'cargo'), RUSTUP_HOME: path.join(installPath, 'rustup') }
    makeExecutable(installer)
    await run(installer, ['-y', '--no-modify-path', '--profile', 'minimal', '--default-toolchain', 'stable'],
        { env: { ...process.env, ...env }, timeout: 20 * 60_000 }, onLog)
    return env
}

/** Asks a freshly installed runtime for its version. */
export function versionOf(exePath: string, runtimeId: string): Promise<string | null> {
    const args = runtimeId === 'go' || runtimeId === 'zig' ? ['version'] : runtimeId === 'java' ? ['-version'] : ['--version']
    return new Promise(resolve => {
        execFile(exePath, args, { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
            resolve(err ? null : /(\d+\.\d+(?:\.\d+)?)/.exec(`${stdout}${stderr}`)?.[1] ?? null)
        })
    })
}

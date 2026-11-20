/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Detects language runtimes and installs the ones Kalynt can manage into its
 * own folder (see ./runtimes). Nothing outside that folder is changed: no
 * system PATH edits, no shell profile edits.
 */
import path from 'path'
import fs from 'fs'
import { execFile } from 'child_process'
import { validatePath } from '../utils/pathValidator'
import { downloadFile, type DownloadProgress } from './runtimes/http'
import { installableRuntimes, resolveSource, type RuntimeSource } from './runtimes/sources'
import { extractArchive, findBinDir, makeExecutable, runRustup, versionOf } from './runtimes/installer'
import { forgetRuntime, readManifest, recordRuntime, setRuntimesDir } from './runtimes/manifest'

type Log = (message: string) => void

const SAFE_RUNTIME_ID = /^[a-z0-9_-]+$/i

// How to ask an installed tool for its version.
const VERSION_COMMANDS: Record<string, string[]> = {
    node: ['node', '--version'], python: process.platform === 'win32' ? ['python', '--version'] : ['python3', '--version'],
    rust: ['rustc', '--version'], go: ['go', 'version'], java: ['java', '-version'], dotnet: ['dotnet', '--version'],
    ruby: ['ruby', '--version'], php: ['php', '--version'], gcc: ['gcc', '--version'], kotlin: ['kotlinc', '-version'],
    swift: ['swift', '--version'], scala: ['scala', '-version'], perl: ['perl', '--version'], lua: ['lua', '-v'],
    haskell: ['ghc', '--version'], elixir: ['elixir', '--version'], r: ['R', '--version'], julia: ['julia', '--version'],
    dart: ['dart', '--version'], zig: ['zig', 'version'], clojure: ['clojure', '--version'], deno: ['deno', '--version'],
    bun: ['bun', '--version'], nasm: ['nasm', '-v'], sass: ['sass', '--version'], emscripten: ['emcc', '--version'],
    wabt: ['wasm2wat', '--version'], groovy: ['groovy', '--version'], ocaml: ['ocaml', '-version'],
    erlang: ['erl', '-noshell', '-eval', 'io:format("~s", [erlang:system_info(otp_release)]), halt().'],
    fsharp: ['dotnet', 'fsi', '--version'], v: ['v', 'version'], nim: ['nim', '--version'], csharp: ['dotnet', '--version'],
    c: ['gcc', '--version'], cpp: ['g++', '--version']
}

export class RuntimeManager {
    private readonly runtimesDir: string
    private readonly pending = new Map<string, RuntimeSource>()

    constructor(runtimesDir: string) {
        this.runtimesDir = runtimesDir
        setRuntimesDir(runtimesDir)
    }

    installable(): string[] {
        return installableRuntimes()
    }

    private assertValidRuntimeId(runtimeId: string): string {
        if (typeof runtimeId !== 'string' || !SAFE_RUNTIME_ID.test(runtimeId)) {
            throw new Error(`Invalid runtime identifier: ${String(runtimeId)}`)
        }
        return runtimeId
    }

    getDownloadsDir(): string {
        return path.join(this.runtimesDir, 'downloads')
    }

    async downloadRuntime(runtimeId: string, onProgress: (p: DownloadProgress) => void, onLog?: Log): Promise<{ success: boolean; path?: string; error?: string }> {
        try {
            const safeId = this.assertValidRuntimeId(runtimeId)
            const source = await resolveSource(safeId)
            this.pending.set(safeId, source)
            onLog?.(`Downloading ${safeId} ${source.version}`)
            const downloads = this.getDownloadsDir()
            fs.mkdirSync(downloads, { recursive: true })
            const dest = validatePath(downloads, `${safeId}.download`)
            await downloadFile(source.url, dest, onProgress)
            return { success: true, path: dest }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            onLog?.(`Download failed: ${message}`)
            return { success: false, error: message }
        }
    }

    async installRuntime(runtimeId: string, archivePath: string, onLog?: Log): Promise<{ success: boolean; installPath?: string; error?: string }> {
        let safeId: string
        let safeArchivePath: string
        let installPath: string
        try {
            safeId = this.assertValidRuntimeId(runtimeId)
            if (!this.installable().includes(safeId)) {
                return { success: false, error: `Unsupported runtime: ${safeId}` }
            }
            if (typeof archivePath !== 'string' || !archivePath.trim() || archivePath.includes('\0')) {
                return { success: false, error: 'Invalid runtime archive path' }
            }
            const downloadsDir = this.getDownloadsDir()
            fs.mkdirSync(downloadsDir, { recursive: true })
            safeArchivePath = validatePath(downloadsDir, archivePath)
            if (path.resolve(safeArchivePath) === path.resolve(downloadsDir)) {
                return { success: false, error: 'Invalid runtime archive path' }
            }
            const stat = fs.lstatSync(safeArchivePath)
            if (!stat.isFile() || stat.isSymbolicLink()) {
                return { success: false, error: 'Runtime archive must be a downloaded file inside the runtime cache directory' }
            }
            installPath = validatePath(this.runtimesDir, safeId)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            onLog?.(`Installation failed: ${message}`)
            return { success: false, error: `Invalid runtime archive path: ${message}` }
        }

        try {
            const source = this.pending.get(safeId) ?? await resolveSource(safeId)
            fs.rmSync(installPath, { recursive: true, force: true })
            fs.mkdirSync(installPath, { recursive: true })

            let env: Record<string, string> | undefined
            if (source.installer) {
                onLog?.('Running the installer; this can take a few minutes')
                env = await runRustup(safeArchivePath, installPath, onLog)
            } else {
                onLog?.('Unpacking')
                await extractArchive(safeArchivePath, installPath, onLog)
            }

            const binDir = findBinDir(installPath, source.exe)
            if (!binDir) throw new Error(`Couldn't find ${source.exe} in the downloaded files`)
            const exe = fs.readdirSync(binDir).find(f => f === source.exe || f.startsWith(`${source.exe}.`)) ?? source.exe
            makeExecutable(path.join(binDir, exe))
            if (safeId === 'java') env = { JAVA_HOME: path.dirname(binDir) }

            const version = (await versionOf(path.join(binDir, exe), safeId)) ?? source.version
            recordRuntime(safeId, { version, installPath, binDirs: [binDir], env })
            onLog?.(`Installed ${safeId} ${version}. Kalynt's terminals and Run use it now.`)
            return { success: true, installPath }
        } catch (error) {
            fs.rmSync(installPath, { recursive: true, force: true })
            const message = error instanceof Error ? error.message : String(error)
            onLog?.(`Installation failed: ${message}`)
            return { success: false, error: message }
        } finally {
            this.pending.delete(safeId)
            fs.rmSync(safeArchivePath, { force: true })
        }
    }

    async uninstallRuntime(runtimeId: string): Promise<{ success: boolean; error?: string }> {
        let safeId: string
        try {
            safeId = this.assertValidRuntimeId(runtimeId)
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
        const managed = readManifest()[safeId]
        if (!managed) return { success: false, error: 'This runtime was not installed by Kalynt' }
        try {
            const safeInstallPath = validatePath(this.runtimesDir, managed.installPath)
            fs.rmSync(safeInstallPath, { recursive: true, force: true })
            forgetRuntime(safeId)
            return { success: true }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    }

    async checkInstallation(runtimeId: string): Promise<{ isInstalled: boolean; version?: string; path?: string; managedByKalynt?: boolean }> {
        const managed = readManifest()[runtimeId]
        if (managed && managed.binDirs.every(dir => fs.existsSync(dir))) {
            return { isInstalled: true, version: managed.version, path: managed.installPath, managedByKalynt: true }
        }
        if (runtimeId === 'html') return { isInstalled: true, version: 'HTML5' }
        const command = VERSION_COMMANDS[runtimeId]
        if (!command) return { isInstalled: false }
        return new Promise(resolve => {
            // Windows tools are often .cmd shims, which only start through the shell. The command is from the table above.
            execFile(command[0], command.slice(1), { timeout: 8000, windowsHide: true, shell: process.platform === 'win32' }, (error, stdout, stderr) => {
                if (error) return resolve({ isInstalled: false })
                const version = /(\d+\.\d+(?:\.\d+)?)/.exec(`${stdout}${stderr}`)?.[1]
                resolve({ isInstalled: true, version: version ?? 'installed', managedByKalynt: false })
            })
        })
    }
}

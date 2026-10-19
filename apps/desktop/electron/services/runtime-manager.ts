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
import { downloadFile, type DownloadProgress } from './runtimes/http'
import { installableRuntimes, resolveSource, type RuntimeSource } from './runtimes/sources'
import { extractArchive, findBinDir, makeExecutable, runRustup, versionOf } from './runtimes/installer'
import { forgetRuntime, readManifest, recordRuntime, setRuntimesDir } from './runtimes/manifest'

type Log = (message: string) => void

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

    async downloadRuntime(runtimeId: string, onProgress: (p: DownloadProgress) => void, onLog?: Log): Promise<{ success: boolean; path?: string; error?: string }> {
        try {
            const source = await resolveSource(runtimeId)
            this.pending.set(runtimeId, source)
            onLog?.(`Downloading ${runtimeId} ${source.version}`)
            const downloads = path.join(this.runtimesDir, 'downloads')
            fs.mkdirSync(downloads, { recursive: true })
            const dest = path.join(downloads, `${runtimeId}.download`)
            await downloadFile(source.url, dest, onProgress)
            return { success: true, path: dest }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            onLog?.(`Download failed: ${message}`)
            return { success: false, error: message }
        }
    }

    async installRuntime(runtimeId: string, archivePath: string, onLog?: Log): Promise<{ success: boolean; installPath?: string; error?: string }> {
        const installPath = path.join(this.runtimesDir, runtimeId)
        try {
            const source = this.pending.get(runtimeId) ?? await resolveSource(runtimeId)
            fs.rmSync(installPath, { recursive: true, force: true })
            fs.mkdirSync(installPath, { recursive: true })

            let env: Record<string, string> | undefined
            if (source.installer) {
                onLog?.('Running the installer; this can take a few minutes')
                env = await runRustup(archivePath, installPath, onLog)
            } else {
                onLog?.('Unpacking')
                await extractArchive(archivePath, installPath, onLog)
            }

            const binDir = findBinDir(installPath, source.exe)
            if (!binDir) throw new Error(`Couldn't find ${source.exe} in the downloaded files`)
            const exe = fs.readdirSync(binDir).find(f => f === source.exe || f.startsWith(`${source.exe}.`)) ?? source.exe
            makeExecutable(path.join(binDir, exe))
            if (runtimeId === 'java') env = { JAVA_HOME: path.dirname(binDir) }

            const version = (await versionOf(path.join(binDir, exe), runtimeId)) ?? source.version
            recordRuntime(runtimeId, { version, installPath, binDirs: [binDir], env })
            onLog?.(`Installed ${runtimeId} ${version}. Kalynt's terminals and Run use it now.`)
            return { success: true, installPath }
        } catch (error) {
            fs.rmSync(installPath, { recursive: true, force: true })
            const message = error instanceof Error ? error.message : String(error)
            onLog?.(`Installation failed: ${message}`)
            return { success: false, error: message }
        } finally {
            this.pending.delete(runtimeId)
            fs.rmSync(archivePath, { force: true })
        }
    }

    async uninstallRuntime(runtimeId: string): Promise<{ success: boolean; error?: string }> {
        const managed = readManifest()[runtimeId]
        if (!managed) return { success: false, error: 'This runtime was not installed by Kalynt' }
        try {
            fs.rmSync(managed.installPath, { recursive: true, force: true })
            forgetRuntime(runtimeId)
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

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Finding tool binaries, building a safe environment for user programs, and
 * stopping process trees.
 */
import path from 'node:path'
import fs from 'node:fs'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import treeKill from 'tree-kill'
import { binaryManager } from '../../services/binary-manager'
import { managedBinDirs, managedEnv, withManagedPath } from '../../services/runtimes/manifest'
import { cmdCommandLine } from './cmd-escape'

const isWindows = process.platform === 'win32'

// Variables passed to programs started from the editor. Anything else (API
// keys, tokens) stays out of user code.
const SAFE_ENV_VARS = [
    'PATH', 'PATHEXT', 'COMSPEC', 'SHELL',
    'HOME', 'USERPROFILE', 'USERNAME', 'USER', 'LOGNAME',
    'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'LANGUAGE', 'TZ',
    'NODE_ENV', 'NODE_OPTIONS', 'NODE_PATH', 'NVM_DIR', 'NVM_BIN',
    'RUSTUP_HOME', 'CARGO_HOME', 'GOPATH', 'GOROOT', 'GOMODCACHE',
    'JAVA_HOME', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'PYENV_ROOT',
    'GEM_HOME', 'GEM_PATH', 'BUNDLE_PATH',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
    'APPDATA', 'LOCALAPPDATA', 'CommonProgramFiles',
    'SystemRoot', 'SystemDrive', 'windir',
    'TERM', 'COLORTERM', 'TERM_PROGRAM', 'FORCE_COLOR',
    'EDITOR', 'VISUAL', 'GIT_EDITOR',
    // GUI programs (tkinter, pygame, Electron apps) need the display session.
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE',
    'XDG_DATA_DIRS', 'XDG_CONFIG_HOME', 'DBUS_SESSION_BUS_ADDRESS',
    // Networking behind a proxy or a custom CA.
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS'
]

const WINDOWS_TOOL_DIRS = (): string[] => {
    const userProfile = process.env.USERPROFILE || String.raw`C:\Users\Default`
    const programFiles = process.env.ProgramFiles || String.raw`C:\Program Files`
    const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming')
    const localPrograms = path.join(userProfile, 'AppData', 'Local', 'Programs', 'Python')
    return [
        ...['Python313', 'Python312', 'Python311'].flatMap(v => [path.join(localPrograms, v), path.join(localPrograms, v, 'Scripts')]),
        path.join(userProfile, '.cargo', 'bin'),
        path.join(programFiles, 'nodejs'),
        path.join(appData, 'npm'),
        path.join(programFiles, 'Java', 'jdk-21', 'bin'),
        path.join(programFiles, 'Eclipse Adoptium', 'jdk-21', 'bin'),
        path.join(userProfile, 'go', 'bin'),
        path.join(programFiles, 'Go', 'bin'),
        path.join(programFiles, 'Git', 'cmd'),
        path.join(programFiles, 'Git', 'bin')
    ]
}

function enhancedPath(): string {
    let current = withManagedPath(process.env.PATH || '')
    if (!isWindows) return current
    for (const dir of WINDOWS_TOOL_DIRS()) {
        if (fs.existsSync(dir) && !current.toLowerCase().includes(dir.toLowerCase())) current = `${dir};${current}`
    }
    return current
}

export function safeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const key of SAFE_ENV_VARS) {
        if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    env.PATH = enhancedPath()
    return { ...env, ...managedEnv(), ...extra }
}

const cache = new Map<string, string | null>()

export function clearBinaryCache(): void {
    cache.clear()
}

// The Microsoft Store "python" stubs open the Store instead of running code.
const isStoreStub = (p: string) => isWindows && /\\WindowsApps\\/i.test(p)

const COMMON_UNIX_DIRS = () => {
    const home = process.env.HOME || ''
    return ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'),
        path.join(home, '.npm-global', 'bin'), path.join(home, '.pyenv', 'shims'), path.join(home, 'go', 'bin'), path.join(home, '.deno', 'bin'), path.join(home, '.bun', 'bin')]
}

/** Resolves a tool from the bundled bin folder, the project's node_modules/.bin, PATH, then common install folders. */
export async function findBinary(name: string, workspacePath?: string | null): Promise<string | null> {
    if (!/^[a-zA-Z0-9._+-]+$/.test(name)) return null
    const bundled = binaryManager.getBinaryPath(name)
    if (bundled) return bundled

    const key = `${name}:${workspacePath ?? ''}`
    if (cache.has(key)) return cache.get(key)!

    const remember = (value: string | null) => { cache.set(key, value); return value }
    const executable = async (p: string) => fs.promises.access(p, fs.constants.X_OK).then(() => true, () => false)

    if (workspacePath) {
        const local = path.join(workspacePath, 'node_modules', '.bin', name + (isWindows ? '.cmd' : ''))
        if (await executable(local)) return remember(local)
    }

    // Runtimes Kalynt installed.
    for (const dir of managedBinDirs()) {
        for (const candidate of isWindows ? [`${name}.exe`, `${name}.cmd`] : [name]) {
            if (await executable(path.join(dir, candidate))) return remember(path.join(dir, candidate))
        }
    }

    try {
        const all = execFileSync(isWindows ? 'where' : 'which', [name], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
            .split(/\r?\n/).map(l => l.trim()).filter(p => p && !isStoreStub(p))
        // On Windows `where npm` also lists the extensionless shell script, which can't be spawned.
        const found = isWindows ? all.find(p => /\.(exe|cmd|bat|com)$/i.test(p)) : all[0]
        if (found) return remember(found)
    } catch {
        // Not on PATH.
    }

    const candidates = isWindows
        ? [path.join(process.env.APPDATA || '', 'npm', `${name}.cmd`), ...WINDOWS_TOOL_DIRS().flatMap(dir => [path.join(dir, `${name}.exe`), path.join(dir, `${name}.cmd`)])]
        : COMMON_UNIX_DIRS().map(dir => path.join(dir, name))
    for (const candidate of candidates) {
        if (await executable(candidate)) return remember(candidate)
    }
    return remember(null)
}

/**
 * Windows runs .cmd/.bat files through cmd.exe when spawning without a shell.
 * The arguments are escaped for cmd.exe, so pass windowsVerbatimArguments on to spawn.
 */
export function wrapWindowsCommand(command: string, args: string[]): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
    if (isWindows && /\.(cmd|bat)$/i.test(command)) {
        const comspec = process.env.COMSPEC && /cmd(\.exe)?$/i.test(process.env.COMSPEC) ? process.env.COMSPEC : 'cmd.exe'
        const line = cmdCommandLine(path.normalize(command), args)
        return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
    }
    return { command, args }
}

/** Kills a process and everything it started. */
export function killProcessTree(proc: ChildProcess): Promise<void> {
    if (!proc.pid || proc.exitCode !== null) return Promise.resolve()
    return new Promise(resolve => {
        treeKill(proc.pid!, 'SIGKILL', err => {
            if (err) {
                try {
                    if (isWindows) spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'])
                    else proc.kill('SIGKILL')
                } catch {
                    // Already gone.
                }
            }
            resolve()
        })
    })
}

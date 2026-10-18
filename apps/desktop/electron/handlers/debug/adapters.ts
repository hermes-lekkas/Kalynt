/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Starting the right debug adapter for a launch configuration.
 */
import * as fs from 'fs'
import * as path from 'path'
import { spawn, execFile } from 'child_process'
import type { DebugConfiguration } from '../../../src/types/debug'
import { binaryManager } from '../../services/binary-manager'
import { findBinary, safeEnv } from '../code-exec/binaries'
import { DapConnection, connectWithRetry, freePort } from './transport'

export class AdapterMissingError extends Error {
    constructor(readonly type: string, readonly requiredBinary: string, readonly installInstructions: string) {
        super(`${requiredBinary} is needed to debug this. ${installInstructions.split('\n')[0]}`)
    }
}

// Variables a debug configuration may not set: they inject code into every process.
const BLOCKED_ENV = ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']

export function debugEnv(userEnv?: Record<string, unknown>): NodeJS.ProcessEnv {
    const env = safeEnv({ PYDEVD_DISABLE_FILE_VALIDATION: '1', PYTHONUNBUFFERED: '1' })
    for (const key of ['DEBUG', 'NODE_DEBUG', 'RUST_BACKTRACE', 'RUST_LOG', 'GOCACHE', 'GOFLAGS']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    for (const [key, value] of Object.entries(userEnv ?? {})) {
        if (typeof value !== 'string') continue
        if (BLOCKED_ENV.some(blocked => key.toUpperCase().includes(blocked))) {
            console.warn(`[Debug] Ignored env var from the launch configuration: ${key}`)
            continue
        }
        env[key] = value
    }
    return env
}

const exists = (p: string | null | undefined): p is string => !!p && fs.existsSync(p)

/** First match of "<dir>/<prefix>*<rest>" style VS Code extension folders. */
function findInExtensions(prefix: string, rest: string[]): string | null {
    const dir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.vscode', 'extensions')
    try {
        const match = fs.readdirSync(dir).filter(d => d.startsWith(prefix)).sort().pop()
        const candidate = match ? path.join(dir, match, ...rest) : null
        return exists(candidate) ? candidate : null
    } catch {
        return null
    }
}

const run = (file: string, args: string[]) => new Promise<{ ok: boolean; out: string }>(resolve => {
    execFile(file, args, { timeout: 8000 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}` }))
})

async function socketAdapter(command: string, args: string[], port: number, cwd: string, env: NodeJS.ProcessEnv): Promise<DapConnection> {
    const proc = spawn(command, args, { cwd, env, windowsHide: true })
    let early = ''
    proc.stderr?.on('data', d => { early += d.toString() })
    const socket = await connectWithRetry(port, 12, 500, () => proc.exitCode === null).catch(err => {
        proc.kill()
        throw new Error(`${err.message}${early ? `\n${early.trim()}` : ''}`)
    })
    const conn = new DapConnection()
    conn.attach(proc, socket)
    return conn
}

function stdioAdapter(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): DapConnection {
    const conn = new DapConnection()
    conn.attach(spawn(command, args, { cwd, env, windowsHide: true }))
    return conn
}

async function launchNode(config: DebugConfiguration, cwd: string, env: NodeJS.ProcessEnv) {
    const relative = ['@vscode', 'js-debug-dap', 'out', 'src', 'dapDebugServer.js']
    const globalRoots = [
        process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'npm', 'node_modules') : '/usr/local/lib/node_modules',
        path.join(process.env.HOME || '', '.npm-global', 'lib', 'node_modules')
    ]
    let server = binaryManager.getBinaryPath('js-debug-dap') || globalRoots.map(r => path.join(r, ...relative)).find(exists) || null
    if (!server) {
        const npm = await findBinary('npm')
        const root = npm ? (await run(npm, ['root', '-g'])).out.trim() : ''
        const candidate = root ? path.join(root, ...relative) : null
        if (exists(candidate)) server = candidate
    }
    if (!server) {
        throw new AdapterMissingError(config.type, '@vscode/js-debug-dap', 'Install the Node.js debugger with: npm install -g @vscode/js-debug-dap')
    }
    const port = await freePort()
    const node = (await findBinary('node')) || 'node'
    return socketAdapter(node, [server, String(port), '127.0.0.1'], port, cwd, env)
}

async function launchPython(config: DebugConfiguration, cwd: string, env: NodeJS.ProcessEnv) {
    // The configuration's interpreter wins, then the one on PATH (a virtualenv's, when active).
    const configured = (config.python ?? config.pythonPath) as string | undefined
    const python = configured || (await findBinary(process.platform === 'win32' ? 'python' : 'python3')) || (await findBinary('python'))
    if (!python) throw new AdapterMissingError(config.type, 'python', 'Install Python 3 from https://www.python.org/downloads/')
    const check = await run(python, ['-c', 'import debugpy'])
    if (!check.ok) {
        throw new AdapterMissingError(config.type, 'debugpy', `Install the Python debugger with: ${path.basename(python)} -m pip install debugpy`)
    }
    return stdioAdapter(python, ['-Xfrozen_modules=off', '-m', 'debugpy.adapter'], cwd, env)
}

async function launchGo(config: DebugConfiguration, cwd: string, env: NodeJS.ProcessEnv) {
    const dlv = binaryManager.getBinaryPath('dlv') || (await findBinary('dlv'))
        || [path.join(process.env.GOPATH || path.join(process.env.HOME || process.env.USERPROFILE || '', 'go'), 'bin', process.platform === 'win32' ? 'dlv.exe' : 'dlv')].find(exists)
    if (!dlv) throw new AdapterMissingError(config.type, 'dlv', 'Install Delve with: go install github.com/go-delve/delve/cmd/dlv@latest')
    const port = await freePort()
    return socketAdapter(dlv, ['dap', '--listen', `127.0.0.1:${port}`], port, cwd, env)
}

/** C, C++ and Rust: CodeLLDB, then lldb-dap, then GDB's built-in DAP (GDB 14+). */
async function launchNative(config: DebugConfiguration, cwd: string, env: NodeJS.ProcessEnv) {
    const exe = process.platform === 'win32' ? '.exe' : ''
    const codelldb = findInExtensions('vadimcn.vscode-lldb-', ['adapter', `codelldb${exe}`]) || (await findBinary('codelldb'))
    if (codelldb) {
        const port = await freePort()
        return socketAdapter(codelldb, ['--port', String(port)], port, cwd, env)
    }
    const lldbDap = (await findBinary('lldb-dap')) || (await findBinary('lldb-vscode'))
    if (lldbDap) return stdioAdapter(lldbDap, [], cwd, env)

    const gdb = await findBinary('gdb')
    if (gdb) {
        const version = Number(/GNU gdb[^\d]*(\d+)/.exec((await run(gdb, ['--version'])).out)?.[1] ?? 0)
        if (version >= 14) return stdioAdapter(gdb, ['--quiet', '--interpreter=dap'], cwd, env)
    }
    throw new AdapterMissingError(config.type, 'a native debugger',
        'Install GDB 14 or newer, lldb-dap (from LLVM) or CodeLLDB (https://github.com/vadimcn/codelldb/releases).')
}

export async function launchAdapter(config: DebugConfiguration, workspacePath: string): Promise<DapConnection> {
    const cwd = typeof config.cwd === 'string' && fs.existsSync(config.cwd) ? config.cwd : workspacePath
    const env = debugEnv(config.env as Record<string, unknown> | undefined)

    switch (config.type) {
        case 'node':
        case 'pwa-node':
        case 'node-terminal':
            return launchNode(config, cwd, env)
        case 'debugpy':
        case 'python':
            return launchPython(config, cwd, env)
        case 'delve':
        case 'go':
            return launchGo(config, cwd, env)
        case 'lldb':
        case 'rust-lldb':
        case 'codelldb':
        case 'cppdbg':
        case 'gdb':
            return launchNative(config, cwd, env)
        case 'coreclr': {
            const vsdbg = await findBinary('vsdbg')
            if (!vsdbg) throw new AdapterMissingError(config.type, 'vsdbg', 'Install the .NET debugger (vsdbg) from Microsoft.')
            return stdioAdapter(vsdbg, ['--interpreter=vscode'], cwd, env)
        }
        case 'java':
            throw new AdapterMissingError(config.type, 'a Java debug server',
                'Java debugging needs the Java language server with its debug plugin, which Kalynt does not bundle yet.')
        default:
            throw new AdapterMissingError(config.type, `${config.type} debug adapter`, `Install a Debug Adapter Protocol server for '${config.type}'.`)
    }
}

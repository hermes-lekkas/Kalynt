/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Launch configurations: .vscode/launch.json, ones inferred from the folder,
 * variable substitution, and building native programs for debugging.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFile } from 'child_process'
import type { DebugConfiguration, LaunchConfiguration } from '../../../src/types/debug'
import { parseJsonc } from '../build-tasks'
import { findBinary } from '../code-exec/binaries'

function loadLaunchJson(workspacePath: string): DebugConfiguration[] {
    const file = path.join(workspacePath, '.vscode', 'launch.json')
    if (!fs.existsSync(file)) return []
    try {
        const config = parseJsonc(fs.readFileSync(file, 'utf-8')) as LaunchConfiguration
        return Array.isArray(config?.configurations) ? config.configurations : []
    } catch (error) {
        console.error('[Debug] Could not read launch.json:', error)
        return []
    }
}

// package.json "main" goes into a path; keep it a plain relative file name.
function safeEntry(value: unknown): string {
    if (typeof value !== 'string') return 'index.js'
    const cleaned = value.replace(/[;&|`$(){}[\]\\'"!<>\0]/g, '').split('/').filter(part => part && part !== '..').join('/')
    return cleaned || 'index.js'
}

function detectConfigurations(workspacePath: string): DebugConfiguration[] {
    const has = (file: string) => fs.existsSync(path.join(workspacePath, file))
    let files: string[] = []
    try { files = fs.readdirSync(workspacePath) } catch { /* unreadable folder */ }
    const configs: DebugConfiguration[] = []

    if (has('package.json')) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(workspacePath, 'package.json'), 'utf-8'))
            configs.push({ type: 'node', request: 'launch', name: 'Node.js: package entry', program: `\${workspaceFolder}/${safeEntry(pkg.main)}`, skipFiles: ['<node_internals>/**'] })
        } catch (error) {
            console.error('[Debug] Could not read package.json:', error)
        }
    }
    if (files.some(f => f.endsWith('.py'))) {
        configs.push({ type: 'debugpy', request: 'launch', name: 'Python: current file', program: '${file}', console: 'internalConsole' })
    }
    if (has('Cargo.toml')) {
        configs.push({ type: 'lldb', request: 'launch', name: 'Rust: debug build', program: '${workspaceFolder}/target/debug/${workspaceFolderBasename}', args: [], cwd: '${workspaceFolder}' })
    }
    if (has('go.mod')) {
        configs.push({ type: 'delve', request: 'launch', name: 'Go: package', mode: 'debug', program: '${workspaceFolder}' })
    }
    return configs
}

/** launch.json configurations first, then inferred ones. */
export function getAllConfigurations(workspacePath: string): DebugConfiguration[] {
    return [...loadLaunchJson(workspacePath), ...detectConfigurations(workspacePath)]
}

/** Replaces ${workspaceFolder}, ${file}, ${env:NAME} and the like throughout a configuration. */
export function resolveVariables(config: DebugConfiguration, workspacePath: string, activeFile?: string): DebugConfiguration {
    const file = activeFile || ''
    const ext = path.extname(file)
    const values: Record<string, string> = {
        workspaceFolder: workspacePath,
        workspaceRoot: workspacePath,
        workspaceFolderBasename: path.basename(workspacePath),
        cwd: workspacePath,
        file,
        fileBasename: path.basename(file),
        fileBasenameNoExtension: path.basename(file, ext),
        fileDirname: file ? path.dirname(file) : '',
        fileExtname: ext,
        relativeFile: file ? path.relative(workspacePath, file) : '',
        pathSeparator: path.sep,
        userHome: os.homedir()
    }
    const replace = (value: unknown): unknown => {
        if (typeof value === 'string') {
            return value.replace(/\$\{([^}]+)\}/g, (match, name: string) =>
                name.startsWith('env:') ? process.env[name.slice(4)] ?? '' : values[name] ?? match)
        }
        if (Array.isArray(value)) return value.map(replace)
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]))
        return value
    }
    return replace(config) as DebugConfiguration
}

const NATIVE_TYPES = new Set(['lldb', 'rust-lldb', 'codelldb', 'cppdbg', 'gdb'])
const SOURCES: Record<string, 'c' | 'cpp' | 'rust'> = { '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.rs': 'rust' }

/**
 * When a native configuration points at a source file, compiles it with debug
 * information and points the configuration at the result.
 */
export async function prepareNativeProgram(config: DebugConfiguration, onOutput: (text: string) => void): Promise<DebugConfiguration> {
    const program = typeof config.program === 'string' ? config.program : ''
    const kind = SOURCES[path.extname(program).toLowerCase()]
    if (!NATIVE_TYPES.has(config.type) || !kind) return config

    const compiler = kind === 'rust' ? 'rustc' : kind === 'cpp' ? 'g++' : 'gcc'
    const tool = (await findBinary(compiler)) || (kind !== 'rust' ? await findBinary(kind === 'cpp' ? 'clang++' : 'clang') : null)
    if (!tool) throw new Error(`${compiler} is needed to build ${path.basename(program)} for debugging`)

    const outDir = path.join(os.tmpdir(), 'kalynt-debug')
    fs.mkdirSync(outDir, { recursive: true })
    const binary = path.join(outDir, `${path.basename(program, path.extname(program))}${process.platform === 'win32' ? '.exe' : ''}`)
    const args = kind === 'rust' ? ['-g', program, '-o', binary] : ['-g', '-O0', program, '-o', binary]
    onOutput(`Building ${path.basename(program)} with debug information…\n`)

    await new Promise<void>((resolve, reject) => {
        execFile(tool, args, { cwd: path.dirname(program), timeout: 120_000 }, (err, stdout, stderr) => {
            if (stdout || stderr) onOutput(`${stdout}${stderr}`)
            if (err) reject(new Error(`Couldn't build ${path.basename(program)}`))
            else resolve()
        })
    })
    return { ...config, program: binary, cwd: typeof config.cwd === 'string' ? config.cwd : path.dirname(program) }
}

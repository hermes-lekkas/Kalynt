/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * How to run a source file in each supported language.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { findBinary, resolvePythonExecutable, wrapWindowsCommand } from './binaries'

const isWindows = process.platform === 'win32'

export interface Step {
    command: string
    args: string[]
    /** Set when the arguments are already escaped for cmd.exe. */
    windowsVerbatimArguments?: boolean
}

export interface RunPlan {
    /** Compiles first when present; a failed compile skips the run. */
    compile?: Step
    run: Step
    env?: NodeJS.ProcessEnv
    /** Build outputs to delete after the run. */
    artifacts: string[]
}

export interface PlanRunDeps {
    findBinary?: (name: string, workspace?: string | null) => Promise<string | null>
    detectDotnetVersion?: (dotnetBin: string) => Promise<string | null>
    hasDotnetScript?: (workspace: string | null) => Promise<boolean>
    findCsprojInDir?: (dir: string) => string | null
}

/**
 * Produces a valid Nim module identifier stem for temporary `.nim` files:
 * leading ASCII letter, ASCII alphanumerics + single underscores only,
 * no hyphens, no consecutive underscores, and no trailing underscore.
 */
export function sanitizeNimModuleName(rawId: string): string {
    const cleaned = String(rawId ?? '')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
    const stem = cleaned ? `kalynt_${cleaned}` : 'kalynt_run'
    return stem.replace(/_+/g, '_').replace(/_+$/, '')
}

/** Extracts the major version number from `dotnet --version` output (e.g. "10.0.115" -> 10). */
export function parseDotnetMajorVersion(versionOutput: string): number | null {
    const match = /^\s*(\d+)\.\d+/.exec(String(versionOutput ?? ''))
    if (!match) return null
    const major = Number.parseInt(match[1], 10)
    return Number.isFinite(major) ? major : null
}

export function detectDotnetVersion(dotnetBin: string): Promise<string | null> {
    return new Promise(resolve => {
        execFile(dotnetBin, ['--version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
            if (err) return resolve(null)
            const firstToken = `${stdout}${stderr}`.trim().split(/\s+/)[0] || ''
            const match = /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?$/.exec(firstToken)
            resolve(match ? match[0] : null)
        })
    })
}

async function defaultHasDotnetScript(
    workspace: string | null,
    findBin: (name: string, ws?: string | null) => Promise<string | null>
): Promise<boolean> {
    if (await findBin('dotnet-script', workspace)) return true
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
    const exeName = isWindows ? 'dotnet-script.exe' : 'dotnet-script'
    const globalToolPath = path.join(home, '.dotnet', 'tools', exeName)
    return fs.existsSync(globalToolPath)
}

function defaultFindCsprojInDir(dir: string): string | null {
    try {
        const entries = fs.readdirSync(dir)
        const csproj = entries.find(name => name.toLowerCase().endsWith('.csproj'))
        return csproj ? path.join(dir, csproj) : null
    } catch {
        return null
    }
}

export async function planCsharpRun(
    script: string,
    buildDir: string,
    workspace: string | null,
    deps: PlanRunDeps = {}
): Promise<RunPlan> {
    const findBin = deps.findBinary ?? findBinary
    const getVersion = deps.detectDotnetVersion ?? detectDotnetVersion
    const checkDotnetScript = deps.hasDotnetScript ?? ((ws) => defaultHasDotnetScript(ws, findBin))
    const findCsproj = deps.findCsprojInDir ?? defaultFindCsprojInDir

    const dotnet = (await findBin('dotnet', workspace)) || 'dotnet'
    const ext = path.extname(script).toLowerCase()

    // 1. C# script (.csx) always requires dotnet-script
    if (ext === '.csx') {
        if (await checkDotnetScript(workspace)) {
            return { run: step(dotnet, ['script', script]), artifacts: [] }
        }
        throw new Error(
            "Running C# script (.csx) files requires the 'dotnet-script' tool. Install it with: dotnet tool install -g dotnet-script (or use a .cs file with .NET 10+ SDK)."
        )
    }

    // 2. Explicit .csproj or .cs file inside a project directory containing a .csproj (not a temp draft in buildDir)
    if (ext === '.csproj') {
        return { run: step(dotnet, ['run', '--project', script]), artifacts: [] }
    }
    const scriptDir = path.resolve(path.dirname(script))
    const resolvedBuildDir = path.resolve(buildDir)
    if (scriptDir !== resolvedBuildDir) {
        const csproj = findCsproj(scriptDir)
        if (csproj) {
            return { run: step(dotnet, ['run', '--project', csproj]), artifacts: [] }
        }
    }

    // 3. Standalone .cs file: use .NET 10+ file-based run mode when available
    const version = await getVersion(dotnet)
    const major = version ? parseDotnetMajorVersion(version) : null
    if (major !== null && major >= 10) {
        return { run: step(dotnet, ['run', '--file', script]), artifacts: [] }
    }

    // 4. Older .NET SDK (< 10): fall back to dotnet-script if installed, else explain requirements clearly
    if (await checkDotnetScript(workspace)) {
        return { run: step(dotnet, ['script', script]), artifacts: [] }
    }

    const versionLabel = version ? `.NET SDK ${version}` : 'the installed .NET SDK'
    throw new Error(
        `Standalone .cs execution on ${versionLabel} requires either .NET 10+ SDK (for 'dotnet run --file'), the 'dotnet-script' tool (install with: dotnet tool install -g dotnet-script), or a .csproj project file.`
    )
}

export const EXTENSIONS: Record<string, string> = {
    javascript: '.js', node: '.js', typescript: '.ts', python: '.py', deno: '.ts', bun: '.js',
    rust: '.rs', go: '.go', java: '.java', dotnet: '.cs', csharp: '.cs', fsharp: '.fsx',
    ruby: '.rb', php: '.php', c: '.c', gcc: '.c', cpp: '.cpp', kotlin: '.kts', swift: '.swift',
    scala: '.scala', perl: '.pl', lua: '.lua', haskell: '.hs', elixir: '.exs', r: '.r',
    julia: '.jl', dart: '.dart', zig: '.zig', clojure: '.clj', groovy: '.groovy', ocaml: '.ml',
    erlang: '.erl', v: '.v', nim: '.nim', html: '.html', bash: '.sh', shell: '.sh', powershell: '.ps1'
}

const step = (command: string, args: string[]): Step => wrapWindowsCommand(command, args)

/** One interpreter invocation: `<tool> [...before] <script>`. */
const SCRIPT_TOOLS: Record<string, { tool: string; before?: string[] }> = {
    ruby: { tool: 'ruby' }, php: { tool: 'php' }, perl: { tool: 'perl' }, lua: { tool: 'lua' },
    julia: { tool: 'julia' }, elixir: { tool: 'elixir' }, groovy: { tool: 'groovy' }, clojure: { tool: 'clojure' },
    ocaml: { tool: 'ocaml' }, swift: { tool: 'swift' }, scala: { tool: 'scala' }, haskell: { tool: 'runghc' },
    r: { tool: 'Rscript' }, erlang: { tool: 'escript' }, go: { tool: 'go', before: ['run'] },
    dart: { tool: 'dart', before: ['run'] }, zig: { tool: 'zig', before: ['run'] }, v: { tool: 'v', before: ['run'] },
    bun: { tool: 'bun', before: ['run'] }, fsharp: { tool: 'dotnet', before: ['fsi'] },
    // Source-file mode (JDK 11+) runs a single file whatever its class is called.
    java: { tool: 'java' },
    deno: { tool: 'deno', before: ['run', '--allow-read', '--allow-write'] }
}

export async function planRun(
    language: string,
    script: string,
    buildDir: string,
    workspace: string | null,
    runId: string,
    deps: PlanRunDeps = {}
): Promise<RunPlan | null> {
    const lang = language.toLowerCase()
    const findBin = deps.findBinary ?? findBinary
    const resolveTool = async (name: string, fallback = name) => (await findBin(name, workspace)) || fallback
    const binary = path.join(buildDir, `kalynt_${runId}${isWindows ? '.exe' : ''}`)

    switch (lang) {
        case 'javascript':
        case 'node': {
            const node = await findBin('node', workspace)
            // Without Node installed, Electron's own binary can run the script as Node.
            if (!node) return { run: { command: process.execPath, args: [script] }, env: { ELECTRON_RUN_AS_NODE: '1' }, artifacts: [] }
            return { run: step(node, [script]), artifacts: [] }
        }
        case 'typescript': {
            const tsx = await findBin('tsx', workspace)
            if (tsx) return { run: step(tsx, [script]), artifacts: [] }
            const tsNode = await findBin('ts-node', workspace)
            if (tsNode) return { run: step(tsNode, ['--transpile-only', script]), artifacts: [] }
            return { run: step(isWindows ? 'npx.cmd' : 'npx', ['--yes', 'tsx', script]), artifacts: [] }
        }
        case 'python': {
            const python = (await resolvePythonExecutable(workspace))
                || (isWindows ? 'python' : 'python3')
            return { run: step(python, [script]), env: { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, artifacts: [] }
        }
        case 'csharp':
        case 'dotnet':
            return planCsharpRun(script, buildDir, workspace, deps)
        case 'c':
        case 'gcc':
            return { compile: step(await resolveTool('gcc'), [script, '-o', binary]), run: { command: binary, args: [] }, artifacts: [binary] }
        case 'cpp':
            return { compile: step(await resolveTool('g++'), [script, '-o', binary]), run: { command: binary, args: [] }, artifacts: [binary] }
        case 'rust':
            return { compile: step(await resolveTool('rustc'), [script, '-o', binary]), run: { command: binary, args: [] }, artifacts: [binary, binary.replace(/\.exe$/, '.pdb')] }
        case 'kotlin': {
            const kotlinc = await resolveTool('kotlinc')
            if (script.endsWith('.kts')) return { run: step(kotlinc, ['-script', script]), artifacts: [] }
            const jar = path.join(buildDir, `kalynt_${runId}.jar`)
            return { compile: step(kotlinc, [script, '-include-runtime', '-d', jar]), run: step(await resolveTool('java'), ['-jar', jar]), artifacts: [jar] }
        }
        case 'nim': {
            const nimOutputBinary = path.join(
                buildDir,
                `${path.basename(script, path.extname(script))}${isWindows ? '.exe' : ''}`
            )
            return {
                run: step(await resolveTool('nim'), ['compile', '--run', '--hints:off', `--outdir:${buildDir}`, script]),
                artifacts: [nimOutputBinary]
            }
        }
        case 'bash':
        case 'shell':
            return { run: step(await resolveTool('bash'), [script]), artifacts: [] }
        case 'powershell': {
            const pwsh = (await findBin('pwsh', workspace)) || (isWindows ? 'powershell.exe' : 'pwsh')
            return { run: step(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]), artifacts: [] }
        }
    }

    const spec = SCRIPT_TOOLS[lang]
    if (!spec) return null
    return { run: step(await resolveTool(spec.tool), [...(spec.before ?? []), script]), artifacts: [] }
}

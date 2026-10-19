/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * How to run a source file in each supported language.
 */
import path from 'node:path'
import { findBinary, wrapWindowsCommand } from './binaries'

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

export const EXTENSIONS: Record<string, string> = {
    javascript: '.js', node: '.js', typescript: '.ts', python: '.py', deno: '.ts', bun: '.js',
    rust: '.rs', go: '.go', java: '.java', dotnet: '.cs', csharp: '.cs', fsharp: '.fsx',
    ruby: '.rb', php: '.php', c: '.c', gcc: '.c', cpp: '.cpp', kotlin: '.kts', swift: '.swift',
    scala: '.scala', perl: '.pl', lua: '.lua', haskell: '.hs', elixir: '.exs', r: '.r',
    julia: '.jl', dart: '.dart', zig: '.zig', clojure: '.clj', groovy: '.groovy', ocaml: '.ml',
    erlang: '.erl', v: '.v', nim: '.nim', html: '.html', bash: '.sh', shell: '.sh', powershell: '.ps1'
}

const step = (command: string, args: string[]): Step => wrapWindowsCommand(command, args)
const tool = async (name: string, workspace: string | null, fallback = name) => (await findBinary(name, workspace)) || fallback

/** One interpreter invocation: `<tool> [...before] <script>`. */
const SCRIPT_TOOLS: Record<string, { tool: string; before?: string[] }> = {
    ruby: { tool: 'ruby' }, php: { tool: 'php' }, perl: { tool: 'perl' }, lua: { tool: 'lua' },
    julia: { tool: 'julia' }, elixir: { tool: 'elixir' }, groovy: { tool: 'groovy' }, clojure: { tool: 'clojure' },
    ocaml: { tool: 'ocaml' }, swift: { tool: 'swift' }, scala: { tool: 'scala' }, haskell: { tool: 'runghc' },
    r: { tool: 'Rscript' }, erlang: { tool: 'escript' }, go: { tool: 'go', before: ['run'] },
    dart: { tool: 'dart', before: ['run'] }, zig: { tool: 'zig', before: ['run'] }, v: { tool: 'v', before: ['run'] },
    bun: { tool: 'bun', before: ['run'] }, fsharp: { tool: 'dotnet', before: ['fsi'] },
    dotnet: { tool: 'dotnet', before: ['script'] }, csharp: { tool: 'dotnet', before: ['script'] },
    // Source-file mode (JDK 11+) runs a single file whatever its class is called.
    java: { tool: 'java' },
    deno: { tool: 'deno', before: ['run', '--allow-read', '--allow-write'] }
}

export async function planRun(language: string, script: string, buildDir: string, workspace: string | null, runId: string): Promise<RunPlan | null> {
    const lang = language.toLowerCase()
    const binary = path.join(buildDir, `kalynt_${runId}${isWindows ? '.exe' : ''}`)

    switch (lang) {
        case 'javascript':
        case 'node': {
            const node = await findBinary('node', workspace)
            // Without Node installed, Electron's own binary can run the script as Node.
            if (!node) return { run: { command: process.execPath, args: [script] }, env: { ELECTRON_RUN_AS_NODE: '1' }, artifacts: [] }
            return { run: step(node, [script]), artifacts: [] }
        }
        case 'typescript': {
            const tsx = await findBinary('tsx', workspace)
            if (tsx) return { run: step(tsx, [script]), artifacts: [] }
            const tsNode = await findBinary('ts-node', workspace)
            if (tsNode) return { run: step(tsNode, ['--transpile-only', script]), artifacts: [] }
            return { run: step(isWindows ? 'npx.cmd' : 'npx', ['--yes', 'tsx', script]), artifacts: [] }
        }
        case 'python': {
            const python = (await findBinary(isWindows ? 'python' : 'python3', workspace))
                || (await findBinary(isWindows ? 'py' : 'python', workspace))
                || (isWindows ? 'python' : 'python3')
            return { run: step(python, [script]), env: { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, artifacts: [] }
        }
        case 'c':
        case 'gcc':
            return { compile: step(await tool('gcc', workspace), [script, '-o', binary]), run: { command: binary, args: [] }, artifacts: [binary] }
        case 'cpp':
            return { compile: step(await tool('g++', workspace), [script, '-o', binary]), run: { command: binary, args: [] }, artifacts: [binary] }
        case 'rust':
            return { compile: step(await tool('rustc', workspace), [script, '-o', binary]), run: { command: binary, args: [] }, artifacts: [binary, binary.replace(/\.exe$/, '.pdb')] }
        case 'kotlin': {
            const kotlinc = await tool('kotlinc', workspace)
            if (script.endsWith('.kts')) return { run: step(kotlinc, ['-script', script]), artifacts: [] }
            const jar = path.join(buildDir, `kalynt_${runId}.jar`)
            return { compile: step(kotlinc, [script, '-include-runtime', '-d', jar]), run: step(await tool('java', workspace), ['-jar', jar]), artifacts: [jar] }
        }
        case 'nim':
            return { run: step(await tool('nim', workspace), ['compile', '--run', '--hints:off', `--outdir:${buildDir}`, script]), artifacts: [] }
        case 'bash':
        case 'shell':
            return { run: step(await tool('bash', workspace), [script]), artifacts: [] }
        case 'powershell': {
            const pwsh = (await findBinary('pwsh', workspace)) || (isWindows ? 'powershell.exe' : 'pwsh')
            return { run: step(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]), artifacts: [] }
        }
    }

    const spec = SCRIPT_TOOLS[lang]
    if (!spec) return null
    return { run: step(await tool(spec.tool, workspace), [...(spec.before ?? []), script]), artifacts: [] }
}

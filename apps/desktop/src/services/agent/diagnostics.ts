/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Checks a file with its language's own tools. Quick single-file checks
 * (Python, JavaScript, JSON, shell scripts) also run after every agent edit,
 * so a syntax error comes back with the edit result. Project-wide checks
 * (TypeScript, Go, Rust) take longer and run only through get_diagnostics.
 * Nothing here writes to the workspace.
 */

export interface CheckResult {
    ok: boolean
    /** What ran, e.g. "python3 compile" or "tsc". */
    checker: string
    /** Problems found, ready for the model. Empty when ok. */
    output: string
}

interface Checker {
    name: string
    command: string
    cwd: string
    timeoutMs: number
    /** Reduce raw output to the problems worth showing. */
    filter?: (output: string) => string
}

const isWindows = () => (window.electronAPI?.platform ?? '').startsWith('win')
const quote = (p: string) => (isWindows() ? `"${p}"` : `'${p.replace(/'/g, `'\\''`)}'`)
const extension = (path: string) => /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''
const parentDir = (p: string) => p.replace(/[\\/][^\\/]*$/, '') || p
const separator = (p: string) => (p.includes('\\') && !p.includes('/') ? '\\' : '/')
const MAX_OUTPUT = 6000

async function exists(path: string): Promise<boolean> {
    try { return !!(await window.electronAPI?.fs?.stat(path))?.success } catch { return false }
}

/** The nearest folder from the file up to the workspace root that contains `name`. */
async function findUp(file: string, workspace: string, name: string): Promise<string | null> {
    let dir = parentDir(file)
    for (let depth = 0; depth < 40; depth++) {
        if (await exists(`${dir}${separator(file)}${name}`)) return dir
        const parent = parentDir(dir)
        if (dir.length <= workspace.length || parent === dir) return null
        dir = parent
    }
    return null
}

const PYTHON_COMPILE = 'import sys; compile(open(sys.argv[1], encoding=\'utf-8\').read(), sys.argv[1], \'exec\', dont_inherit=True)'

/** Python's traceback starts inside the checker; the error is from the file's own frame on. */
function syntaxErrorOnly(output: string): string {
    const lines = output.trim().split('\n')
    const start = lines.findIndex(line => /^\s*File "/.test(line) && !line.includes('"<string>"'))
    return (start >= 0 ? lines.slice(start) : lines.slice(-6)).join('\n')
}

function quickChecker(path: string): Checker | null {
    const cwd = parentDir(path)
    switch (extension(path)) {
        case 'py': {
            const python = isWindows() ? 'python' : 'python3'
            return { name: `${python} compile`, command: `${python} -c "${PYTHON_COMPILE}" ${quote(path)}`, cwd, timeoutMs: 10_000, filter: syntaxErrorOnly }
        }
        case 'js': case 'mjs': case 'cjs':
            return { name: 'node --check', command: `node --check ${quote(path)}`, cwd, timeoutMs: 10_000 }
        case 'sh': case 'bash':
            return isWindows() ? null : { name: 'bash -n', command: `bash -n ${quote(path)}`, cwd, timeoutMs: 10_000 }
        default:
            return null
    }
}

/** Errors in this file first, then a count of the rest. */
function focusOn(file: string, pattern: RegExp) {
    const name = file.split(/[\\/]/).pop() ?? file
    return (output: string) => {
        const problems = output.split('\n').filter(line => pattern.test(line))
        if (!problems.length) return output
        const mine = problems.filter(line => line.includes(name))
        const others = problems.length - mine.length
        return [...mine.slice(0, 30), others ? `(${others} more in other files)` : ''].filter(Boolean).join('\n')
    }
}

async function projectChecker(path: string, workspace: string): Promise<Checker | null> {
    switch (extension(path)) {
        case 'ts': case 'tsx': case 'mts': case 'cts': {
            const dir = await findUp(path, workspace, 'tsconfig.json')
            // The project's own compiler, never one npx would download.
            const root = dir && await findUp(`${dir}${separator(dir)}x`, workspace, 'node_modules/typescript/bin/tsc')
            if (!dir || !root) return null
            const tsc = quote(`${root}/node_modules/typescript/bin/tsc`)
            return { name: 'tsc', command: `node ${tsc} --noEmit --pretty false -p .`, cwd: dir, timeoutMs: 180_000, filter: focusOn(path, /error TS\d+/) }
        }
        case 'go':
            return (await findUp(path, workspace, 'go.mod')) ? { name: 'go vet', command: 'go vet .', cwd: parentDir(path), timeoutMs: 180_000 } : null
        case 'rs': {
            const dir = await findUp(path, workspace, 'Cargo.toml')
            return dir ? { name: 'cargo check', command: 'cargo check --quiet --message-format short', cwd: dir, timeoutMs: 300_000, filter: focusOn(path, /(error|warning)(\[\w+\])?:/) } : null
        }
        default:
            return quickChecker(path)
    }
}

/** JSON is checked in-process. Files with comments (tsconfig, VS Code settings) are JSONC and skipped. */
async function checkJson(path: string): Promise<CheckResult | null> {
    const file = await window.electronAPI?.fs?.readFile(path)
    if (!file?.success || typeof file.content !== 'string' || !file.content.trim()) return null
    try {
        JSON.parse(file.content)
        return { ok: true, checker: 'JSON', output: '' }
    } catch (error) {
        if (/(^|\s)\/\/|\/\*/.test(file.content)) return null
        return { ok: false, checker: 'JSON', output: error instanceof Error ? error.message : String(error) }
    }
}

async function run(checker: Checker): Promise<CheckResult | null> {
    const agent = window.electronAPI?.agent
    if (!agent) return null
    const id = `check-${crypto.randomUUID()}`
    const result = await agent.exec({ id, command: checker.command, cwd: checker.cwd, timeoutMs: checker.timeoutMs })
    if (!result.ok || result.timedOut) return null
    // The checker isn't installed: say nothing rather than report a fake problem.
    if (result.exitCode === 127 || result.exitCode === 9009 || /command not found|is not recognized|could not determine executable/i.test(result.output)) return null
    if (result.exitCode === 0) return { ok: true, checker: checker.name, output: '' }
    const output = (checker.filter ? checker.filter(result.output) : result.output).trim().slice(0, MAX_OUTPUT)
    return { ok: false, checker: checker.name, output: output || `${checker.name} exited with code ${result.exitCode}.` }
}

/** The fast check run after edits. Null when there's no quick checker for the file type. */
export async function quickCheck(path: string): Promise<CheckResult | null> {
    try {
        if (extension(path) === 'json') return await checkJson(path)
        const checker = quickChecker(path)
        return checker ? await run(checker) : null
    } catch {
        return null
    }
}

/** The full check behind get_diagnostics. Null when no checker applies. */
export async function checkFile(path: string, workspace: string): Promise<CheckResult | null> {
    if (extension(path) === 'json') return checkJson(path)
    const checker = await projectChecker(path, workspace)
    return checker ? run(checker) : null
}

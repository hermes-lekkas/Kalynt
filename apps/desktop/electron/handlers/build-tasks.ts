/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Finding build tasks (.vscode/tasks.json plus common build files) and
 * reading compiler problems out of their output.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { Task, TasksConfiguration, Problem, ProblemMatcher } from '../../src/types/tasks'

type ConfigTask = Task & { script?: string }

/** JSON with comments and trailing commas, as VS Code writes tasks.json. */
export function parseJsonc(text: string): unknown {
    let out = ''
    let inString = false
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        const next = text[i + 1]
        if (inString) {
            out += ch
            if (ch === '\\') { out += next ?? ''; i++ } else if (ch === '"') inString = false
        } else if (ch === '"') {
            inString = true
            out += ch
        } else if (ch === '/' && next === '/') {
            while (i < text.length && text[i] !== '\n') i++
            out += '\n'
        } else if (ch === '/' && next === '*') {
            i += 2
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
            i++
        } else {
            out += ch
        }
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** Replaces ${workspaceFolder}, ${env:NAME} and friends. */
export function substituteVariables(value: string, workspacePath: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
        if (name === 'workspaceFolder' || name === 'workspaceRoot' || name === 'cwd') return workspacePath
        if (name === 'workspaceFolderBasename') return path.basename(workspacePath)
        if (name === 'pathSeparator') return path.sep
        if (name.startsWith('env:')) return process.env[name.slice(4)] ?? ''
        return match
    })
}

function loadConfiguredTasks(workspacePath: string): ConfigTask[] {
    const file = path.join(workspacePath, '.vscode', 'tasks.json')
    if (!fs.existsSync(file)) return []
    try {
        const config = parseJsonc(fs.readFileSync(file, 'utf-8')) as TasksConfiguration
        return Array.isArray(config?.tasks) ? config.tasks as ConfigTask[] : []
    } catch (error) {
        console.error('[Build] Could not read tasks.json:', error)
        return []
    }
}

const inferGroup = (name: string) => {
    const lower = name.toLowerCase()
    if (lower.includes('build') || lower === 'compile') return 'build'
    if (lower.includes('test')) return 'test'
    if (lower.includes('clean')) return 'clean'
    return undefined
}

const inferMatcher = (name: string, script: string) => {
    const text = `${name} ${script}`.toLowerCase()
    if (text.includes('tsc')) return '$tsc'
    if (text.includes('eslint')) return '$eslint-compact'
    return undefined
}

const shellTask = (label: string, command: string, args: string[], group?: Task['group'], problemMatcher?: string): Task =>
    ({ label, type: 'shell', command, args, group, problemMatcher } as Task)

function detectTasks(workspacePath: string): Task[] {
    const has = (file: string) => fs.existsSync(path.join(workspacePath, file))
    const tasks: Task[] = []

    if (has('package.json')) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(workspacePath, 'package.json'), 'utf-8'))
            for (const [name, script] of Object.entries<string>(pkg.scripts ?? {})) {
                tasks.push({ label: `npm: ${name}`, type: 'npm', command: name, detail: script, group: inferGroup(name), problemMatcher: inferMatcher(name, script) } as Task)
            }
        } catch (error) {
            console.error('[Build] Could not read package.json:', error)
        }
    }
    if (has('Cargo.toml')) {
        tasks.push(
            shellTask('cargo: build', 'cargo', ['build'], { kind: 'build', isDefault: true }, '$rustc'),
            shellTask('cargo: test', 'cargo', ['test'], 'test', '$rustc'),
            shellTask('cargo: run', 'cargo', ['run'])
        )
    }
    if (has('go.mod')) {
        tasks.push(
            shellTask('go: build', 'go', ['build', '-v', './...'], { kind: 'build', isDefault: true }, '$go'),
            shellTask('go: test', 'go', ['test', '-v', './...'], 'test')
        )
    }
    if (has('pom.xml')) {
        tasks.push(
            shellTask('maven: clean install', 'mvn', ['clean', 'install'], { kind: 'build', isDefault: true }),
            shellTask('maven: test', 'mvn', ['test'], 'test')
        )
    }
    if (has('build.gradle') || has('build.gradle.kts')) {
        const gradle = process.platform === 'win32' ? 'gradlew.bat' : (has('gradlew') ? './gradlew' : 'gradle')
        tasks.push(
            shellTask('gradle: build', gradle, ['build'], { kind: 'build', isDefault: true }),
            shellTask('gradle: test', gradle, ['test'], 'test')
        )
    }
    if (has('Makefile') || has('makefile')) {
        tasks.push(
            shellTask('make: build', 'make', [], { kind: 'build', isDefault: true }, '$gcc'),
            shellTask('make: clean', 'make', ['clean'], 'clean')
        )
    }
    if (has('CMakeLists.txt')) {
        tasks.push(
            shellTask('cmake: configure', 'cmake', ['-B', 'build', '-S', '.']),
            shellTask('cmake: build', 'cmake', ['--build', 'build'], { kind: 'build', isDefault: true }, '$gcc')
        )
    }
    return tasks
}

/** Configured tasks first; detected ones fill in labels tasks.json doesn't define. */
export function getAllTasks(workspacePath: string): Task[] {
    const configured = loadConfiguredTasks(workspacePath).map(task =>
        task.type === 'npm' && !task.command && task.script ? { ...task, command: task.script } : task
    )
    const labels = new Set(configured.map(t => t.label))
    return [...configured, ...detectTasks(workspacePath).filter(t => !labels.has(t.label))]
}

const BUILT_IN_MATCHERS: Record<string, ProblemMatcher> = {
    '$tsc': { owner: 'typescript', pattern: { regexp: '^([^\\s].*?)\\((\\d+),(\\d+)\\):\\s+(error|warning|info)\\s+(TS\\d+)\\s*:\\s*(.*)$', file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6 } },
    '$eslint-compact': { owner: 'eslint', pattern: { regexp: '^(.+?):\\s+line\\s+(\\d+),\\s+col\\s+(\\d+),\\s+(Error|Warning)\\s+-\\s+(.+?)\\s+\\((.+?)\\)$', file: 1, line: 2, column: 3, severity: 4, message: 5, code: 6 } },
    '$rustc': { owner: 'rustc', pattern: [
        { regexp: '^(error|warning)(?:\\[(.+?)\\])?:\\s+(.+)$', severity: 1, code: 2, message: 3 },
        { regexp: '^\\s*-->\\s+(.+?):(\\d+):(\\d+)$', file: 1, line: 2, column: 3 }
    ] },
    '$gcc': { owner: 'gcc', pattern: { regexp: '^(.+?):(\\d+):(\\d+):\\s+(?:fatal\\s+)?(error|warning|note):\\s+(.+)$', file: 1, line: 2, column: 3, severity: 4, message: 5 } },
    '$go': { owner: 'go', pattern: { regexp: '^(.+?\\.go):(\\d+):(?:(\\d+):)?\\s+(.+)$', file: 1, line: 2, column: 3, message: 4 } }
} as Record<string, ProblemMatcher>
BUILT_IN_MATCHERS['$cargo'] = BUILT_IN_MATCHERS['$rustc']

export function resolveMatcher(matcher: Task['problemMatcher']): ProblemMatcher | null {
    const first = Array.isArray(matcher) ? matcher[0] : matcher
    if (!first) return null
    return typeof first === 'string' ? BUILT_IN_MATCHERS[first] ?? null : first
}

const severityOf = (text = ''): Problem['severity'] => {
    const lower = text.toLowerCase()
    return lower.includes('error') ? 'error' : lower.includes('warn') ? 'warning' : 'info'
}

/** Reads problems from output lines; multi-line patterns are matched in sequence. */
export function parseProblems(output: string, matcher: ProblemMatcher, workspacePath: string): Problem[] {
    const patterns = Array.isArray(matcher.pattern) ? matcher.pattern : matcher.pattern ? [matcher.pattern] : []
    const problems: Problem[] = []
    let index = 0
    let captured: Partial<Problem> & { severityText?: string } = {}

    for (const line of output.split(/\r?\n/)) {
        const pattern = patterns[index]
        if (!pattern) break
        let match: RegExpExecArray | null = null
        try { match = new RegExp(pattern.regexp).exec(line) } catch { return problems }
        if (!match) {
            if (index > 0) { index = 0; captured = {} }
            continue
        }
        if (pattern.file) captured.file = match[pattern.file]
        if (pattern.line) captured.line = parseInt(match[pattern.line], 10)
        if (pattern.column && match[pattern.column]) captured.column = parseInt(match[pattern.column], 10)
        if (pattern.message) captured.message = match[pattern.message]
        if (pattern.severity) captured.severityText = match[pattern.severity]
        if (pattern.code) captured.code = match[pattern.code]
        if (++index < patterns.length) continue

        if (captured.file && captured.message) {
            problems.push({
                file: path.isAbsolute(captured.file) ? captured.file : path.join(workspacePath, captured.file),
                line: captured.line || 1,
                column: captured.column || 1,
                severity: severityOf(captured.severityText),
                message: captured.message,
                code: captured.code,
                source: matcher.owner
            } as Problem)
        }
        index = 0
        captured = {}
    }
    return problems
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json', md: 'markdown', mdx: 'markdown',
    css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', vue: 'html', svelte: 'html',
    py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp', fs: 'fsharp',
    rb: 'ruby', php: 'php', swift: 'swift', dart: 'dart', lua: 'lua', r: 'r', pl: 'perl',
    yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', xml: 'xml', svg: 'xml', sql: 'sql',
    sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', dockerfile: 'dockerfile',
    graphql: 'graphql', gql: 'graphql', ex: 'elixir', exs: 'elixir', clj: 'clojure', jl: 'julia'
}

const DISPLAY_NAME: Record<string, string> = {
    typescript: 'TypeScript', javascript: 'JavaScript', json: 'JSON', markdown: 'Markdown', css: 'CSS',
    scss: 'SCSS', less: 'Less', html: 'HTML', python: 'Python', rust: 'Rust', go: 'Go', java: 'Java',
    kotlin: 'Kotlin', scala: 'Scala', c: 'C', cpp: 'C++', csharp: 'C#', fsharp: 'F#', ruby: 'Ruby',
    php: 'PHP', swift: 'Swift', dart: 'Dart', lua: 'Lua', r: 'R', perl: 'Perl', yaml: 'YAML', ini: 'INI',
    xml: 'XML', sql: 'SQL', shell: 'Shell', powershell: 'PowerShell', dockerfile: 'Dockerfile',
    graphql: 'GraphQL', elixir: 'Elixir', clojure: 'Clojure', julia: 'Julia', plaintext: 'Plain text'
}

/** Languages the code runner backend can execute. */
export const RUNNABLE_LANGUAGES = new Set([
    'javascript', 'typescript', 'python', 'rust', 'go', 'java', 'csharp', 'fsharp', 'ruby', 'php',
    'c', 'cpp', 'kotlin', 'swift', 'scala', 'perl', 'lua', 'r', 'dart', 'clojure', 'elixir',
    'julia', 'html', 'shell', 'powershell'
])

export function languageFromFileName(fileName: string): string {
    const lower = fileName.toLowerCase()
    if (lower === 'dockerfile') return 'dockerfile'
    const ext = lower.includes('.') ? lower.split('.').pop()! : ''
    return LANGUAGE_BY_EXTENSION[ext] ?? 'plaintext'
}

export function languageLabel(language: string | null | undefined): string {
    if (!language) return ''
    return DISPLAY_NAME[language] ?? language
}

export function baseName(path: string): string {
    return path.split(/[/\\]/).pop() || path
}

export function dirName(path: string): string {
    const parts = path.split(/[/\\]/)
    parts.pop()
    return parts.join('/')
}

/** Path relative to the workspace root, using forward slashes. */
export function relativePath(path: string, root: string | null): string {
    const normalized = path.replace(/\\/g, '/')
    if (!root) return normalized
    const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
    return normalized.startsWith(normalizedRoot + '/') ? normalized.slice(normalizedRoot.length + 1) : normalized
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false
    return a.replace(/\\/g, '/') === b.replace(/\\/g, '/')
}

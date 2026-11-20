/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Package manager definitions and helpers used by the dependency manager.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface PackageManagerConfig {
    name: string                    // Display name (npm, pip, cargo, etc.)
    command: string                 // Binary command
    installArgs: string[]           // Args for install (e.g., ['install'])
    installDevArgs?: string[]       // Args for dev dependency install
    globalInstallArgs?: string[]    // Full args prefix for global install when flag order differs (e.g. yarn global add)
    uninstallArgs: string[]         // Args for uninstall
    updateArgs: string[]            // Args for update
    listArgs: string[]              // Args for listing installed packages
    manifestFile: string            // Config file (package.json, requirements.txt, etc.)
    lockFile?: string               // Lock file if applicable
    languageId: string              // Associated language ID
    globalFlag?: string             // Flag for global install (-g, --user, etc.)
    devFlag?: string                // Flag for dev dependencies (--save-dev, --dev)
    initCommand?: string[]          // Command to initialize new project
}

// Install options
export interface InstallOptions {
    global?: boolean
    dev?: boolean
    version?: string
    workspacePath: string
}

// Package info
export interface PackageInfo {
    name: string
    version: string
    isDev?: boolean
    description?: string
}

// Operation result
export interface DependencyResult {
    success: boolean
    operationId?: string
    output?: string
    error?: string
    exitCode?: number
}

// Supported package managers
export const PACKAGE_MANAGERS: Record<string, PackageManagerConfig> = {
    // JavaScript/TypeScript
    npm: {
        name: 'npm',
        command: 'npm',
        installArgs: ['install'],
        installDevArgs: ['install', '--save-dev'],
        uninstallArgs: ['uninstall'],
        updateArgs: ['update'],
        listArgs: ['list', '--json', '--depth=0'],
        manifestFile: 'package.json',
        lockFile: 'package-lock.json',
        languageId: 'javascript',
        globalFlag: '-g',
        devFlag: '--save-dev',
        initCommand: ['init', '-y']
    },
    yarn: {
        name: 'yarn',
        command: 'yarn',
        installArgs: ['add'],
        installDevArgs: ['add', '--dev'],
        globalInstallArgs: ['global', 'add'],
        uninstallArgs: ['remove'],
        updateArgs: ['upgrade'],
        listArgs: ['list', '--json', '--depth=0'],
        manifestFile: 'package.json',
        lockFile: 'yarn.lock',
        languageId: 'javascript',
        globalFlag: 'global',
        devFlag: '--dev',
        initCommand: ['init', '-y']
    },
    pnpm: {
        name: 'pnpm',
        command: 'pnpm',
        installArgs: ['add'],
        installDevArgs: ['add', '--save-dev'],
        uninstallArgs: ['remove'],
        updateArgs: ['update'],
        listArgs: ['list', '--json', '--depth=0'],
        manifestFile: 'package.json',
        lockFile: 'pnpm-lock.yaml',
        languageId: 'javascript',
        globalFlag: '-g',
        devFlag: '--save-dev',
        initCommand: ['init']
    },
    bun: {
        name: 'bun',
        command: 'bun',
        installArgs: ['add'],
        installDevArgs: ['add', '--dev'],
        uninstallArgs: ['remove'],
        updateArgs: ['update'],
        listArgs: ['pm', 'ls'],
        manifestFile: 'package.json',
        lockFile: 'bun.lockb',
        languageId: 'javascript',
        globalFlag: '-g',
        devFlag: '--dev',
        initCommand: ['init', '-y']
    },

    // Python
    pip: {
        name: 'pip',
        command: 'pip',
        installArgs: ['install'],
        uninstallArgs: ['uninstall', '-y'],
        updateArgs: ['install', '--upgrade'],
        listArgs: ['list', '--format=json'],
        manifestFile: 'requirements.txt',
        languageId: 'python',
        globalFlag: '--user'
    },
    pip3: {
        name: 'pip3',
        command: 'pip3',
        installArgs: ['install'],
        uninstallArgs: ['uninstall', '-y'],
        updateArgs: ['install', '--upgrade'],
        listArgs: ['list', '--format=json'],
        manifestFile: 'requirements.txt',
        languageId: 'python',
        globalFlag: '--user'
    },

    // Rust
    cargo: {
        name: 'cargo',
        command: 'cargo',
        installArgs: ['add'],
        uninstallArgs: ['remove'],
        updateArgs: ['update'],
        listArgs: ['metadata', '--format-version=1'],
        manifestFile: 'Cargo.toml',
        lockFile: 'Cargo.lock',
        languageId: 'rust',
        initCommand: ['init']
    },

    // Go
    go: {
        name: 'go',
        command: 'go',
        installArgs: ['get'],
        uninstallArgs: ['mod', 'edit', '-droprequire'],
        updateArgs: ['get', '-u'],
        listArgs: ['list', '-m', '-json', 'all'],
        manifestFile: 'go.mod',
        lockFile: 'go.sum',
        languageId: 'go',
        initCommand: ['mod', 'init']
    },

    // Ruby
    gem: {
        name: 'gem',
        command: 'gem',
        installArgs: ['install'],
        uninstallArgs: ['uninstall'],
        updateArgs: ['update'],
        listArgs: ['list', '--local'],
        manifestFile: 'Gemfile',
        languageId: 'ruby'
    },
    bundler: {
        name: 'bundler',
        command: 'bundle',
        installArgs: ['add'],
        uninstallArgs: ['remove'],
        updateArgs: ['update'],
        listArgs: ['list'],
        manifestFile: 'Gemfile',
        lockFile: 'Gemfile.lock',
        languageId: 'ruby',
        initCommand: ['init']
    },

    // PHP
    composer: {
        name: 'composer',
        command: 'composer',
        installArgs: ['require'],
        installDevArgs: ['require', '--dev'],
        uninstallArgs: ['remove'],
        updateArgs: ['update'],
        listArgs: ['show', '--format=json'],
        manifestFile: 'composer.json',
        lockFile: 'composer.lock',
        languageId: 'php',
        devFlag: '--dev',
        initCommand: ['init', '--no-interaction']
    },

    // Java
    maven: {
        name: 'maven',
        command: 'mvn',
        installArgs: ['dependency:resolve'],
        uninstallArgs: ['dependency:purge-local-repository'],
        updateArgs: ['versions:use-latest-versions'],
        listArgs: ['dependency:list'],
        manifestFile: 'pom.xml',
        languageId: 'java',
        initCommand: ['archetype:generate', '-DgroupId=com.example', '-DartifactId=app', '-DarchetypeArtifactId=maven-archetype-quickstart']
    },
    gradle: {
        name: 'gradle',
        command: 'gradle',
        installArgs: ['dependencies'],
        uninstallArgs: [],
        updateArgs: ['dependencies', '--refresh-dependencies'],
        listArgs: ['dependencies', '--console=plain'],
        manifestFile: 'build.gradle',
        languageId: 'java'
    },

    // .NET
    dotnet: {
        name: 'dotnet',
        command: 'dotnet',
        installArgs: ['add', 'package'],
        uninstallArgs: ['remove', 'package'],
        updateArgs: ['add', 'package'],
        listArgs: ['list', 'package'],
        manifestFile: '*.csproj',
        languageId: 'csharp',
        initCommand: ['new', 'console']
    },

    // Dart/Flutter
    pub: {
        name: 'pub',
        command: 'dart',
        installArgs: ['pub', 'add'],
        installDevArgs: ['pub', 'add', '--dev'],
        uninstallArgs: ['pub', 'remove'],
        updateArgs: ['pub', 'upgrade'],
        listArgs: ['pub', 'deps', '--json'],
        manifestFile: 'pubspec.yaml',
        lockFile: 'pubspec.lock',
        languageId: 'dart',
        devFlag: '--dev',
        initCommand: ['create', '.']
    }
}

// Map language to preferred package manager
export const LANGUAGE_TO_MANAGER: Record<string, string> = {
    javascript: 'npm',
    typescript: 'npm',
    python: 'pip',
    rust: 'cargo',
    go: 'go',
    ruby: 'bundler',
    php: 'composer',
    java: 'maven',
    kotlin: 'gradle',
    csharp: 'dotnet',
    fsharp: 'dotnet',
    dart: 'pub'
}

/**
 * Get enhanced PATH with common development tool locations
 */
export function getEnhancedPATH(): string {
    const currentPath = process.env.PATH || ''

    if (process.platform !== 'win32') {
        return currentPath
    }

    const userProfile = process.env.USERPROFILE || 'C:\\Users\\Default'
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
    const appData = process.env.APPDATA || `${userProfile}\\AppData\\Roaming`

    const additionalPaths = [
        `${userProfile}\\AppData\\Local\\Programs\\Python\\Python313`,
        `${userProfile}\\AppData\\Local\\Programs\\Python\\Python313\\Scripts`,
        `${userProfile}\\AppData\\Local\\Programs\\Python\\Python312`,
        `${userProfile}\\AppData\\Local\\Programs\\Python\\Python312\\Scripts`,
        `${userProfile}\\.cargo\\bin`,
        `${programFiles}\\nodejs`,
        `${appData}\\npm`,
        `${userProfile}\\go\\bin`,
        `${programFiles}\\Go\\bin`,
        `${programFiles}\\Ruby32-x64\\bin`,
        `${programFiles}\\dotnet`,
        `${userProfile}\\.dotnet\\tools`,
        `${programFiles}\\Git\\cmd`
    ]

    let enhancedPath = currentPath
    for (const p of additionalPaths) {
        if (fs.existsSync(p) && !enhancedPath.toLowerCase().includes(p.toLowerCase())) {
            enhancedPath = `${p};${enhancedPath}`
        }
    }

    return enhancedPath
}

/**
 * Get Python pip command, preferring virtual environment if available
 */
export function getPythonCommand(cwd: string): string {
    const venvPaths = [
        path.join(cwd, 'venv', 'Scripts', 'pip.exe'),
        path.join(cwd, 'venv', 'bin', 'pip'),
        path.join(cwd, '.venv', 'Scripts', 'pip.exe'),
        path.join(cwd, '.venv', 'bin', 'pip'),
        path.join(cwd, 'env', 'Scripts', 'pip.exe'),
        path.join(cwd, 'env', 'bin', 'pip')
    ]

    for (const p of venvPaths) {
        if (fs.existsSync(p)) {
            console.log(`[DependencyManager] Found virtual environment at: ${p}`)
            return p
        }
    }

    return 'pip'
}

/**
 * Get installation instructions for a package manager
 */
export function getInstallInstructions(command: string): string {
    const instructions: Record<string, string> = {
        npm: 'Download Node.js from https://nodejs.org',
        yarn: 'Install via npm: npm install -g yarn',
        pnpm: 'Install via npm: npm install -g pnpm',
        bun: 'Download from https://bun.sh',
        pip: 'Download Python from https://python.org',
        pip3: 'Download Python 3 from https://python.org',
        cargo: 'Install Rust from https://rustup.rs',
        go: 'Download Go from https://go.dev/dl',
        gem: 'Download Ruby from https://www.ruby-lang.org',
        bundle: 'Install via gem: gem install bundler',
        composer: 'Download from https://getcomposer.org',
        mvn: 'Download Maven from https://maven.apache.org',
        gradle: 'Download Gradle from https://gradle.org',
        dotnet: 'Download .NET SDK from https://dot.net',
        dart: 'Download Dart SDK from https://dart.dev'
    }
    return instructions[command] || `Please install ${command} to continue`
}

/**
 * Build install arguments for a package manager, respecting global/dev flag ordering.
 */
export function buildInstallArgs(
    manager: PackageManagerConfig,
    options: { global?: boolean; dev?: boolean }
): string[] {
    if (options.global && manager.globalInstallArgs) {
        return [...manager.globalInstallArgs]
    }
    const args = [...(options.dev && manager.installDevArgs ? manager.installDevArgs : manager.installArgs)]
    if (options.global && manager.globalFlag) {
        args.push(manager.globalFlag)
    }
    return args
}

/**
 * Parse package list output based on manager
 */
export function parsePackageList(managerName: string, output: string): PackageInfo[] {
    try {
        switch (managerName) {
            case 'npm': {
                const data = JSON.parse(output)
                const deps = data.dependencies || {}
                return Object.entries(deps).map(([name, info]: [string, any]) => ({
                    name,
                    version: typeof info === 'string' ? info : (info?.version || '')
                }))
            }
            case 'pnpm': {
                const parsed = JSON.parse(output)
                const root = Array.isArray(parsed) ? parsed[0] : parsed
                if (!root) return []
                const result: PackageInfo[] = []
                for (const [name, info] of Object.entries<any>(root.dependencies || {})) {
                    result.push({ name, version: typeof info === 'string' ? info : (info?.version || ''), isDev: false })
                }
                for (const [name, info] of Object.entries<any>(root.devDependencies || {})) {
                    result.push({ name, version: typeof info === 'string' ? info : (info?.version || ''), isDev: true })
                }
                return result
            }
            case 'yarn': {
                // Yarn v1 emits NDJSON lines where one entry has { type: 'tree', data: { trees: [...] } }
                const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line)
                        if (msg.type === 'tree' && Array.isArray(msg.data?.trees)) {
                            return msg.data.trees.map((t: any) => {
                                const raw = String(t.name || '')
                                const at = raw.lastIndexOf('@')
                                if (at > 0) {
                                    return { name: raw.slice(0, at), version: raw.slice(at + 1) }
                                }
                                return { name: raw, version: '' }
                            })
                        }
                        if (msg.dependencies) {
                            return Object.entries(msg.dependencies).map(([name, info]: [string, any]) => ({
                                name,
                                version: typeof info === 'string' ? info : (info?.version || '')
                            }))
                        }
                    } catch {
                        // Try next line
                    }
                }
                return []
            }
            case 'pip':
            case 'pip3': {
                const packages = JSON.parse(output)
                return packages.map((pkg: any) => ({
                    name: pkg.name,
                    version: pkg.version
                }))
            }
            case 'cargo': {
                const data = JSON.parse(output)
                const allPackages: any[] = Array.isArray(data.packages) ? data.packages : []
                const workspaceIds = new Set<string>(Array.isArray(data.workspace_members) ? data.workspace_members : [])

                // Build version lookup for all resolved external packages
                const resolvedByName = new Map<string, { version: string; description?: string }>()
                for (const pkg of allPackages) {
                    if (!workspaceIds.has(pkg.id)) {
                        resolvedByName.set(pkg.name, { version: pkg.version, description: pkg.description })
                    }
                }

                // Collect declared dependencies of workspace members (works for both full metadata and --no-deps)
                const workspacePkgs = workspaceIds.size > 0
                    ? allPackages.filter(pkg => workspaceIds.has(pkg.id))
                    : allPackages
                const seen = new Map<string, PackageInfo>()
                for (const wsPkg of workspacePkgs) {
                    const deps: any[] = Array.isArray(wsPkg.dependencies) ? wsPkg.dependencies : []
                    for (const dep of deps) {
                        if (!dep?.name) continue
                        const resolved = resolvedByName.get(dep.name)
                        const existing = seen.get(dep.name)
                        const isDev = dep.kind === 'dev'
                        if (!existing || (existing.isDev && !isDev)) {
                            seen.set(dep.name, {
                                name: dep.name,
                                version: resolved?.version || dep.req || '',
                                isDev,
                                description: resolved?.description
                            })
                        }
                    }
                }

                if (seen.size > 0) {
                    return Array.from(seen.values())
                }

                // Fallback: non-workspace packages if dependencies arrays were empty
                return allPackages
                    .filter(pkg => !workspaceIds.has(pkg.id))
                    .map(pkg => ({
                        name: pkg.name,
                        version: pkg.version,
                        description: pkg.description
                    }))
            }
            case 'composer': {
                const data = JSON.parse(output)
                const installed = Array.isArray(data.installed) ? data.installed : []
                return installed.map((pkg: any) => ({
                    name: pkg.name,
                    version: pkg.version,
                    description: pkg.description
                }))
            }
            default:
                return []
        }
    } catch {
        return []
    }
}

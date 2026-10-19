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
        listArgs: ['metadata', '--format-version=1', '--no-deps'],
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
        // Python
        `${userProfile}\\AppData\\Local\\Programs\\Python\\Python313`,
        `${userProfile}\\AppData\\Local\\Programs\\Python\\Python313\\Scripts`,
        `${userProfile}\\AppData\\Local\\Programs\\Python\\Python312`,
        `${userProfile}\\AppData\\Local\\Programs\\Python\\Python312\\Scripts`,
        // Rust/Cargo
        `${userProfile}\\.cargo\\bin`,
        // Node.js / npm
        `${programFiles}\\nodejs`,
        `${appData}\\npm`,
        // Go
        `${userProfile}\\go\\bin`,
        `${programFiles}\\Go\\bin`,
        // Ruby
        `${programFiles}\\Ruby32-x64\\bin`,
        // .NET
        `${programFiles}\\dotnet`,
        `${userProfile}\\.dotnet\\tools`,
        // Git
        `${programFiles}\\Git\\cmd`,
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
 * Get Python command, preferring virtual environment if available
 */
export function getPythonCommand(cwd: string): string {
    const venvPaths = [
        path.join(cwd, 'venv', 'Scripts', 'pip.exe'),    // Windows
        path.join(cwd, 'venv', 'bin', 'pip'),             // Unix
        path.join(cwd, '.venv', 'Scripts', 'pip.exe'),
        path.join(cwd, '.venv', 'bin', 'pip'),
        path.join(cwd, 'env', 'Scripts', 'pip.exe'),      // Alternative names
        path.join(cwd, 'env', 'bin', 'pip')
    ]

    for (const p of venvPaths) {
        if (fs.existsSync(p)) {
            console.log(`[DependencyManager] Found virtual environment at: ${p}`)
            return p
        }
    }

    return 'pip' // fallback to system pip
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
 * Parse package list output based on manager
 */
export function parsePackageList(managerName: string, output: string): PackageInfo[] {
    try {
        switch (managerName) {
            case 'npm':
            case 'yarn':
            case 'pnpm': {
                const data = JSON.parse(output)
                const deps = data.dependencies || {}
                return Object.entries(deps).map(([name, info]: [string, any]) => ({
                    name,
                    version: info.version || info
                }))
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
                return (data.packages || []).map((pkg: any) => ({
                    name: pkg.name,
                    version: pkg.version
                }))
            }
            default:
                // For managers without JSON output, return empty
                return []
        }
    } catch {
        return []
    }
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
/**
 * DependencyManager - Unified package manager integration for all supported languages
 * 
 * Handles dependency installation, removal, listing, and detection for:
 * - JavaScript/TypeScript: npm, yarn, pnpm, bun
 * - Python: pip, pip3
 * - Rust: cargo
 * - Go: go mod
 * - Ruby: gem, bundler
 * - PHP: composer
 * - Java: maven, gradle
 * - .NET: dotnet
 * - Dart/Flutter: pub
 */

import { spawn, ChildProcess } from 'node:child_process'
import { sendToWindow } from '../utils/window'
import { findBinary, killProcessTree, wrapWindowsCommand } from '../handlers/code-exec/binaries'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import {
    PACKAGE_MANAGERS, LANGUAGE_TO_MANAGER, getEnhancedPATH, getPythonCommand, getInstallInstructions, parsePackageList,
    type PackageManagerConfig, type InstallOptions, type PackageInfo, type DependencyResult
} from './packageManagers'

export type { PackageManagerConfig, InstallOptions, PackageInfo, DependencyResult }

// Package manager configuration

// Package names and versions as package managers accept them; never an option or shell syntax.
const PACKAGE_SPEC = /^(?!-)[\w@./:~^<>=!+*-]{1,214}$/

export class DependencyManager extends EventEmitter {
    private getWindow: () => BrowserWindow | null = () => null
    private runningProcesses = new Map<string, ChildProcess>()

    constructor() {
        super()
    }

    /** The window is created after the handlers are registered, so it is looked up on each send. */
    setWindowGetter(getter: () => BrowserWindow | null): void {
        this.getWindow = getter
    }

    private send(channel: string, payload: unknown) {
        sendToWindow(this.getWindow(), channel, payload)
    }

    /** Stops every running package manager command. */
    async killAll(): Promise<number> {
        const procs = [...this.runningProcesses.values()]
        this.runningProcesses.clear()
        await Promise.all(procs.map(killProcessTree))
        return procs.length
    }

    // SECURITY: Allowlist of safe package manager commands
    private static readonly SAFE_COMMANDS = new Set([
        'npm', 'yarn', 'pnpm', 'bun',           // JavaScript
        'pip', 'pip3', 'pipx',                   // Python
        'cargo',                                  // Rust
        'go',                                     // Go
        'gem', 'bundle', 'bundler',              // Ruby
        'composer',                               // PHP
        'mvn', 'gradle',                          // Java
        'dotnet',                                 // .NET
        'pub', 'flutter',                         // Dart/Flutter
    ])

    /**
     * Validate that a command is in our allowlist
     * SECURITY FIX: Prevents command injection by only allowing known-safe commands
     */
    private isCommandSafe(command: string): boolean {
        // Extract base command (handle paths like /usr/bin/npm)
        const baseCommand = command.split(/[/\\]/).pop() || command
        // Remove .exe/.cmd suffix for Windows
        const cleanCommand = baseCommand.replace(/\.(exe|cmd|bat)$/i, '')
        return DependencyManager.SAFE_COMMANDS.has(cleanCommand.toLowerCase())
    }

    /**
     * Check if a binary is available in PATH
     */
    private async isBinaryAvailable(command: string): Promise<boolean> {
        // SECURITY: Validate command against allowlist before spawning
        if (!this.isCommandSafe(command)) {
            console.warn(`[DependencyManager] Blocked unsafe command: ${command}`)
            return false
        }

        return (await findBinary(command)) !== null
    }


    /**
     * Detect which package manager to use based on workspace files
     */
    async detectPackageManager(workspacePath: string): Promise<PackageManagerConfig | null> {
        try {
            const files = await fs.promises.readdir(workspacePath)

            // Check package.json for packageManager field (Corepack standard)
            if (files.includes('package.json')) {
                try {
                    const packageJsonPath = path.join(workspacePath, 'package.json')
                    const packageJsonContent = await fs.promises.readFile(packageJsonPath, 'utf-8')
                    const packageJson = JSON.parse(packageJsonContent)

                    if (packageJson.packageManager) {
                        const managerName = packageJson.packageManager.split('@')[0]
                        console.log(`[DependencyManager] Detected package manager from package.json: ${managerName}`)

                        if (managerName === 'yarn' && PACKAGE_MANAGERS.yarn) return PACKAGE_MANAGERS.yarn
                        if (managerName === 'pnpm' && PACKAGE_MANAGERS.pnpm) return PACKAGE_MANAGERS.pnpm
                        if (managerName === 'npm' && PACKAGE_MANAGERS.npm) return PACKAGE_MANAGERS.npm
                        if (managerName === 'bun' && PACKAGE_MANAGERS.bun) return PACKAGE_MANAGERS.bun
                    }
                } catch (error) {
                    // If package.json can't be parsed, continue with lock file detection
                    console.log('[DependencyManager] Could not read packageManager field from package.json:', error)
                }
            }

            // Check for lock files (more specific than just manifest files)
            if (files.includes('yarn.lock')) return PACKAGE_MANAGERS.yarn
            if (files.includes('pnpm-lock.yaml')) return PACKAGE_MANAGERS.pnpm
            if (files.includes('bun.lockb')) return PACKAGE_MANAGERS.bun
            if (files.includes('package-lock.json')) return PACKAGE_MANAGERS.npm
            if (files.includes('Cargo.lock')) return PACKAGE_MANAGERS.cargo
            if (files.includes('Gemfile.lock')) return PACKAGE_MANAGERS.bundler
            if (files.includes('composer.lock')) return PACKAGE_MANAGERS.composer
            if (files.includes('pubspec.lock')) return PACKAGE_MANAGERS.pub
            if (files.includes('go.sum')) return PACKAGE_MANAGERS.go

            // Check for manifest files
            if (files.includes('package.json')) return PACKAGE_MANAGERS.npm
            if (files.includes('Cargo.toml')) return PACKAGE_MANAGERS.cargo
            if (files.includes('requirements.txt')) return PACKAGE_MANAGERS.pip
            if (files.includes('pyproject.toml')) return PACKAGE_MANAGERS.pip
            if (files.includes('Gemfile')) return PACKAGE_MANAGERS.bundler
            if (files.includes('composer.json')) return PACKAGE_MANAGERS.composer
            if (files.includes('go.mod')) return PACKAGE_MANAGERS.go
            if (files.includes('pom.xml')) return PACKAGE_MANAGERS.maven
            if (files.includes('build.gradle')) return PACKAGE_MANAGERS.gradle
            if (files.includes('pubspec.yaml')) return PACKAGE_MANAGERS.pub
            if (files.some(f => f.endsWith('.csproj'))) return PACKAGE_MANAGERS.dotnet

            return null
        } catch (error) {
            console.error('[DependencyManager] Error detecting package manager:', error)
            return null
        }
    }

    /**
     * Get package manager for a specific language
     */
    getPackageManagerForLanguage(languageId: string): PackageManagerConfig | null {
        const managerName = LANGUAGE_TO_MANAGER[languageId]
        return managerName ? PACKAGE_MANAGERS[managerName] : null
    }

    /**
     * Install a package
     */
    async installPackage(
        packageName: string,
        options: InstallOptions
    ): Promise<DependencyResult> {
        const manager = await this.detectPackageManager(options.workspacePath)
        if (!manager) {
            return { success: false, error: 'No package manager detected in workspace' }
        }

        // For Python, use virtual environment if available
        let commandToUse = manager.command
        if (manager.name === 'pip' || manager.name === 'pip3') {
            const venvCommand = getPythonCommand(options.workspacePath)
            if (venvCommand !== 'pip') {
                commandToUse = venvCommand
                console.log(`[DependencyManager] Using virtual environment: ${venvCommand}`)
            }
        }

        // Check if binary exists
        if (!(await this.isBinaryAvailable(manager.command))) {
            return {
                success: false,
                error: `${manager.name} is not installed.\n\nInstall instructions:\n${getInstallInstructions(manager.command)}`
            }
        }

        const args = [...(options.dev && manager.installDevArgs ? manager.installDevArgs : manager.installArgs)]

        // Add global flag if requested
        if (options.global && manager.globalFlag) {
            args.push(manager.globalFlag)
        }

        // Add package name with optional version
        const pkgSpec = options.version ? `${packageName}@${options.version}` : packageName
        if (!PACKAGE_SPEC.test(pkgSpec)) return { success: false, error: `"${pkgSpec}" is not a valid package name` }
        args.push(pkgSpec)

        return this.runCommand(commandToUse, args, options.workspacePath)
    }

    /**
     * Install all dependencies from manifest file
     */
    async installAllDependencies(workspacePath: string): Promise<DependencyResult> {
        const manager = await this.detectPackageManager(workspacePath)
        if (!manager) {
            return { success: false, error: 'No package manager detected. Create a package.json, Cargo.toml, or requirements.txt first.' }
        }

        // For Python, use virtual environment if available
        let commandToUse = manager.command
        if (manager.name === 'pip' || manager.name === 'pip3') {
            const venvCommand = getPythonCommand(workspacePath)
            if (venvCommand !== 'pip') {
                commandToUse = venvCommand
                console.log(`[DependencyManager] Using virtual environment: ${venvCommand}`)
            }
        }

        // Check if binary exists
        if (!(await this.isBinaryAvailable(manager.command))) {
            return {
                success: false,
                error: `${manager.name} is not installed.\n\nInstall instructions:\n${getInstallInstructions(manager.command)}`
            }
        }

        // Special handling - most managers use 'install' with no package for all deps
        let args: string[]
        switch (manager.name) {
            case 'npm':
            case 'yarn':
            case 'pnpm':
            case 'bun':
                args = ['install']
                break
            case 'pip':
            case 'pip3':
                args = ['install', '-r', 'requirements.txt']
                break
            case 'cargo':
                args = ['build']
                break
            case 'go':
                args = ['mod', 'download']
                break
            case 'bundler':
                args = ['install']
                break
            case 'composer':
                args = ['install']
                break
            case 'maven':
                args = ['install', '-DskipTests']
                break
            case 'gradle':
                args = ['build', '-x', 'test']
                break
            case 'dotnet':
                args = ['restore']
                break
            case 'pub':
                args = ['pub', 'get']
                break
            default:
                args = manager.installArgs
        }

        return this.runCommand(commandToUse, args, workspacePath)
    }

    /**
     * Uninstall a package
     */
    async uninstallPackage(packageName: string, workspacePath: string): Promise<DependencyResult> {
        const manager = await this.detectPackageManager(workspacePath)
        if (!manager) {
            return { success: false, error: 'No package manager detected in workspace' }
        }

        if (!PACKAGE_SPEC.test(packageName)) return { success: false, error: `"${packageName}" is not a valid package name` }
        const args = [...manager.uninstallArgs, packageName]
        return this.runCommand(manager.command, args, workspacePath)
    }

    /**
     * Update a package (or all packages if no name specified)
     */
    async updatePackage(packageName: string | null, workspacePath: string): Promise<DependencyResult> {
        const manager = await this.detectPackageManager(workspacePath)
        if (!manager) {
            return { success: false, error: 'No package manager detected in workspace' }
        }

        const args = [...manager.updateArgs]
        if (packageName) {
            if (!PACKAGE_SPEC.test(packageName)) return { success: false, error: `"${packageName}" is not a valid package name` }
            args.push(packageName)
        }
        return this.runCommand(manager.command, args, workspacePath)
    }

    /**
     * List installed packages
     */
    async listPackages(workspacePath: string): Promise<{ success: boolean; packages?: PackageInfo[]; error?: string }> {
        const manager = await this.detectPackageManager(workspacePath)
        if (!manager) {
            return { success: false, error: 'No package manager detected in workspace' }
        }

        const result = await this.runCommand(manager.command, manager.listArgs, workspacePath, true)

        if (!result.success) {
            return { success: false, error: result.error }
        }

        // Parse output based on manager
        try {
            const packages = parsePackageList(manager.name, result.output || '')
            return { success: true, packages }
        } catch (error) {
            return { success: false, error: `Failed to parse package list: ${error}` }
        }
    }

    /**
     * Initialize a new project with the specified package manager
     */
    async initProject(managerName: string, workspacePath: string): Promise<DependencyResult> {
        const manager = PACKAGE_MANAGERS[managerName]
        if (!manager || !manager.initCommand) {
            return { success: false, error: `Cannot initialize project with ${managerName}` }
        }

        return this.runCommand(manager.command, manager.initCommand, workspacePath)
    }

    /**
     * Get all supported package managers
     */
    getSupportedManagers(): PackageManagerConfig[] {
        return Object.values(PACKAGE_MANAGERS)
    }

    /**
     * Kill a running operation
     */
    killOperation(operationId: string): boolean {
        const proc = this.runningProcesses.get(operationId)
        if (!proc) return false
        this.runningProcesses.delete(operationId)
        void killProcessTree(proc)
        return true
    }

    /**
     * Run a package manager command
     */
    private runCommand(
        command: string,
        args: string[],
        cwd: string,
        silent = false
    ): Promise<DependencyResult> {
        return new Promise((resolve) => {
            void (async () => {
            const operationId = `deps_${Date.now()}`
            let stdout = ''
            let stderr = ''

            // No shell: package names reach the package manager as plain arguments.
            const executable = path.isAbsolute(command) ? command : (await findBinary(command, cwd)) || command
            const wrapped = wrapWindowsCommand(executable, args)
            console.log(`[DependencyManager] Running: ${command} ${args.join(' ')} in ${cwd}`)

            const proc = spawn(wrapped.command, wrapped.args, {
                cwd,
                shell: false,
                windowsHide: true,
                windowsVerbatimArguments: wrapped.windowsVerbatimArguments,
                env: {
                    ...process.env,
                    PATH: getEnhancedPATH()
                }
            })

            this.runningProcesses.set(operationId, proc)

            proc.stdout?.on('data', (data: Buffer) => {
                const output = data.toString()
                stdout += output
                if (!silent) {
                    this.send('deps:output', {
                        operationId,
                        type: 'stdout',
                        data: output
                    })
                }
            })

            proc.stderr?.on('data', (data: Buffer) => {
                const output = data.toString()
                stderr += output
                if (!silent) {
                    this.send('deps:output', {
                        operationId,
                        type: 'stderr',
                        data: output
                    })
                }
            })

            proc.on('close', (exitCode: number | null) => {
                this.runningProcesses.delete(operationId)
                const success = exitCode === 0

                this.send('deps:complete', {
                    operationId,
                    success,
                    exitCode
                })

                resolve({
                    success,
                    output: stdout,
                    error: success ? undefined : stderr || `Process exited with code ${exitCode}`,
                    exitCode: exitCode ?? undefined
                })
            })

            proc.on('error', (error: Error) => {
                this.runningProcesses.delete(operationId)

                this.send('deps:complete', {
                    operationId,
                    success: false,
                    error: error.message
                })

                resolve({
                    success: false,
                    error: error.message
                })
            })
            })()
        })
    }

}

// Singleton instance
let dependencyManagerInstance: DependencyManager | null = null

export function getDependencyManager(): DependencyManager {
    if (!dependencyManagerInstance) {
        dependencyManagerInstance = new DependencyManager()
    }
    return dependencyManagerInstance
}

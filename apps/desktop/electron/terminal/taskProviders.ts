/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Default task providers: derive build/test/run tasks from the files a
 * workspace contains (package.json, pom.xml, Makefile, ...).
 */
import path from 'node:path'
import fs from 'node:fs'
import type { TaskDefinition, TaskProvider } from './taskTypes'

/** Guesses a task group from conventional script/target names. */
function determineTaskGroup(taskName: string): 'build' | 'test' | 'run' | 'clean' {
    const lowerName = taskName.toLowerCase()

    if (lowerName.includes('test') || lowerName.includes('spec')) {
        return 'test'
    } else if (lowerName.includes('build') || lowerName.includes('compile')) {
        return 'build'
    } else if (lowerName.includes('run') || lowerName.includes('start')) {
        return 'run'
    } else if (lowerName.includes('clean') || lowerName.includes('purge')) {
        return 'clean'
    }

    return 'build'
}

/** Finds files matching a simple glob (*.csproj) under dir, recursively. */
function findFiles(dir: string, pattern: string): string[] {
    const files: string[] = []

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)

            if (entry.isDirectory()) {
                files.push(...findFiles(fullPath, pattern))
            } else if (entry.isFile() && globToRegex(pattern).exec(entry.name)) {
                files.push(fullPath)
            }
        }
    } catch (error) {
        console.error(`[TaskRunner] Error finding files in ${dir}:`, error)
    }

    return files
}

function globToRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    return new RegExp(`^${escaped}$`)
}

/** The task providers registered by default, keyed by task type. */
export function createDefaultTaskProviders(): Map<string, TaskProvider> {
    const providers = new Map<string, TaskProvider>()

    // NPM/Node.js tasks
    providers.set('npm', {
        provideTasks: async (workspacePath: string) => {
            const tasks: TaskDefinition[] = []
            const packageJsonPath = path.join(workspacePath, 'package.json')

            if (fs.existsSync(packageJsonPath)) {
                try {
                    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

                    if (packageJson.scripts) {
                        Object.entries(packageJson.scripts).forEach(([name, _command]) => {
                            tasks.push({
                                id: `npm.${name}`,
                                label: `npm run ${name}`,
                                type: 'npm',
                                command: 'npm',
                                args: ['run', name],
                                cwd: workspacePath,
                                group: determineTaskGroup(name)
                            })
                        })
                    }
                } catch (error) {
                    console.error('[TaskRunner] Error reading package.json:', error)
                }
            }

            return tasks
        },
        resolveTask: async (task: TaskDefinition) => task
    })

    // Maven tasks
    providers.set('maven', {
        provideTasks: async (workspacePath: string) => {
            const tasks: TaskDefinition[] = []
            const pomPath = path.join(workspacePath, 'pom.xml')

            if (fs.existsSync(pomPath)) {
                // Common Maven tasks
                const mavenTasks = [
                    { name: 'compile', label: 'Maven: Compile' },
                    { name: 'test', label: 'Maven: Test' },
                    { name: 'package', label: 'Maven: Package' },
                    { name: 'clean', label: 'Maven: Clean' },
                    { name: 'install', label: 'Maven: Install' }
                ]

                mavenTasks.forEach(({ name, label }) => {
                    tasks.push({
                        id: `maven.${name}`,
                        label,
                        type: 'maven',
                        command: 'mvn',
                        args: [name],
                        cwd: workspacePath,
                        group: determineTaskGroup(name)
                    })
                })
            }

            return tasks
        },
        resolveTask: async (task: TaskDefinition) => task
    })

    // Python tasks
    providers.set('python', {
        provideTasks: async (workspacePath: string) => {
            const tasks: TaskDefinition[] = []

            // Check for requirements.txt
            const requirementsPath = path.join(workspacePath, 'requirements.txt')
            if (fs.existsSync(requirementsPath)) {
                tasks.push({
                    id: 'python.install',
                    label: 'Python: Install Dependencies',
                    type: 'python',
                    command: 'pip',
                    args: ['install', '-r', 'requirements.txt'],
                    cwd: workspacePath,
                    group: 'build'
                })
            }

            // Check for setup.py
            const setupPath = path.join(workspacePath, 'setup.py')
            if (fs.existsSync(setupPath)) {
                tasks.push({
                    id: 'python.setup',
                    label: 'Python: Setup Development',
                    type: 'python',
                    command: 'python',
                    args: ['setup.py', 'develop'],
                    cwd: workspacePath,
                    group: 'build'
                })
            }

            // Add common Python tasks
            tasks.push(
                {
                    id: 'python.run',
                    label: 'Python: Run',
                    type: 'python',
                    command: 'python',
                    args: ['.'],
                    cwd: workspacePath,
                    group: 'run'
                },
                {
                    id: 'python.test',
                    label: 'Python: Run Tests',
                    type: 'python',
                    command: 'pytest',
                    args: [],
                    cwd: workspacePath,
                    group: 'test'
                }
            )

            return tasks
        },
        resolveTask: async (task: TaskDefinition) => task
    })

    // Make tasks
    providers.set('make', {
        provideTasks: async (workspacePath: string) => {
            const tasks: TaskDefinition[] = []
            const makefilePath = path.join(workspacePath, 'Makefile')

            if (fs.existsSync(makefilePath)) {
                try {
                    // Read Makefile and extract targets
                    const makefileContent = fs.readFileSync(makefilePath, 'utf8')
                    const targetRegex = /^([a-zA-Z0-9_.-]+):/gm
                    let match

                    while ((match = targetRegex.exec(makefileContent)) !== null) {
                        const target = match[1]
                        if (!target.includes('.PHONY') && target !== 'all') {
                            tasks.push({
                                id: `make.${target}`,
                                label: `Make: ${target}`,
                                type: 'make',
                                command: 'make',
                                args: [target],
                                cwd: workspacePath,
                                group: determineTaskGroup(target)
                            })
                        }
                    }
                } catch (error) {
                    console.error('[TaskRunner] Error reading Makefile:', error)
                }
            }

            return tasks
        },
        resolveTask: async (task: TaskDefinition) => task
    })

    // .NET tasks
    providers.set('dotnet', {
        provideTasks: async (workspacePath: string) => {
            const tasks: TaskDefinition[] = []

            // Find .csproj files
            const csprojFiles = findFiles(workspacePath, '*.csproj')

            if (csprojFiles.length > 0) {
                const csprojPath = csprojFiles[0]
                const projectName = path.basename(csprojPath, '.csproj')

                tasks.push(
                    {
                        id: 'dotnet.build',
                        label: '.NET: Build',
                        type: 'dotnet',
                        command: 'dotnet',
                        args: ['build'],
                        cwd: workspacePath,
                        group: 'build'
                    },
                    {
                        id: 'dotnet.run',
                        label: `.NET: Run ${projectName}`,
                        type: 'dotnet',
                        command: 'dotnet',
                        args: ['run', '--project', csprojPath],
                        cwd: workspacePath,
                        group: 'run'
                    },
                    {
                        id: 'dotnet.test',
                        label: '.NET: Test',
                        type: 'dotnet',
                        command: 'dotnet',
                        args: ['test'],
                        cwd: workspacePath,
                        group: 'test'
                    },
                    {
                        id: 'dotnet.clean',
                        label: '.NET: Clean',
                        type: 'dotnet',
                        command: 'dotnet',
                        args: ['clean'],
                        cwd: workspacePath,
                        group: 'clean'
                    }
                )
            }

            return tasks
        },
        resolveTask: async (task: TaskDefinition) => task
    })

    // Gradle tasks
    providers.set('gradle', {
        provideTasks: async (workspacePath: string) => {
            const tasks: TaskDefinition[] = []
            const gradleBuildPath = path.join(workspacePath, 'build.gradle')
            const gradleBuildKtsPath = path.join(workspacePath, 'build.gradle.kts')

            if (fs.existsSync(gradleBuildPath) || fs.existsSync(gradleBuildKtsPath)) {
                tasks.push(
                    {
                        id: 'gradle.build',
                        label: 'Gradle: Build',
                        type: 'gradle',
                        command: './gradlew',
                        args: ['build'],
                        cwd: workspacePath,
                        group: 'build'
                    },
                    {
                        id: 'gradle.test',
                        label: 'Gradle: Test',
                        type: 'gradle',
                        command: './gradlew',
                        args: ['test'],
                        cwd: workspacePath,
                        group: 'test'
                    },
                    {
                        id: 'gradle.clean',
                        label: 'Gradle: Clean',
                        type: 'gradle',
                        command: './gradlew',
                        args: ['clean'],
                        cwd: workspacePath,
                        group: 'clean'
                    },
                    {
                        id: 'gradle.run',
                        label: 'Gradle: Run',
                        type: 'gradle',
                        command: './gradlew',
                        args: ['run'],
                        cwd: workspacePath,
                        group: 'run'
                    }
                )
            }

            return tasks
        },
        resolveTask: async (task: TaskDefinition) => task
    })

    return providers
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Default task providers: derive build/test/run tasks from the files a
 * workspace contains (package.json, pom.xml, Makefile, ...).
 */
import path from 'node:path'
import fs from 'node:fs'
import type { TaskDefinition, TaskProvider } from './taskTypes'

const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '.hg',
    '.svn',
    'dist',
    'build',
    'out',
    'target',
    'venv',
    '.venv',
    'env',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.next',
    '.nuxt',
    'coverage',
    'bin',
    'obj',
    '.gradle',
    '.idea',
    '.vscode'
])

const PYTHON_MARKERS = [
    'requirements.txt',
    'pyproject.toml',
    'setup.py',
    'setup.cfg',
    'Pipfile',
    'poetry.lock',
    'pytest.ini',
    'tox.ini',
    'manage.py'
]

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

async function fileExists(targetPath: string): Promise<boolean> {
    try {
        await fs.promises.access(targetPath)
        return true
    } catch {
        return false
    }
}

function globToRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    return new RegExp(`^${escaped}$`)
}

/**
 * Bounded async directory scan for files matching a simple glob (e.g. `*.csproj`),
 * skipping heavy/VCS directories such as `node_modules` and `.git`.
 */
export async function findFiles(
    dir: string,
    pattern: string,
    options: { maxDepth?: number; maxMatches?: number } = {}
): Promise<string[]> {
    const maxDepth = options.maxDepth ?? 4
    const maxMatches = options.maxMatches ?? 20
    const regex = globToRegex(pattern)
    const files: string[] = []

    const walk = async (currentDir: string, depth: number): Promise<void> => {
        if (depth > maxDepth || files.length >= maxMatches) return

        let entries: fs.Dirent[]
        try {
            entries = await fs.promises.readdir(currentDir, { withFileTypes: true })
        } catch {
            return
        }

        for (const entry of entries) {
            if (files.length >= maxMatches) return
            if (entry.isSymbolicLink()) continue

            const fullPath = path.join(currentDir, entry.name)
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue
                await walk(fullPath, depth + 1)
            } else if (entry.isFile() && regex.test(entry.name)) {
                files.push(fullPath)
            }
        }
    }

    await walk(dir, 0)
    return files
}

/** The task providers registered by default, keyed by task type. */
export function createDefaultTaskProviders(): Map<string, TaskProvider> {
    const providers = new Map<string, TaskProvider>()

    // NPM/Node.js tasks
    providers.set('npm', {
        provideTasks: async (workspacePath: string) => {
            const tasks: TaskDefinition[] = []
            const packageJsonPath = path.join(workspacePath, 'package.json')

            if (await fileExists(packageJsonPath)) {
                try {
                    const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'))

                    if (packageJson.scripts && typeof packageJson.scripts === 'object') {
                        Object.entries(packageJson.scripts).forEach(([name]) => {
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

            if (await fileExists(pomPath)) {
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

    // Python tasks — gated on actual Python project markers or Python source files
    providers.set('python', {
        provideTasks: async (workspacePath: string) => {
            const tasks: TaskDefinition[] = []

            const requirementsPath = path.join(workspacePath, 'requirements.txt')
            const setupPath = path.join(workspacePath, 'setup.py')
            const hasRequirements = await fileExists(requirementsPath)
            const hasSetup = await fileExists(setupPath)

            let hasPythonMarker = hasRequirements || hasSetup
            if (!hasPythonMarker) {
                for (const marker of PYTHON_MARKERS) {
                    if (await fileExists(path.join(workspacePath, marker))) {
                        hasPythonMarker = true
                        break
                    }
                }
            }

            let pyFiles: string[] = []
            if (!hasPythonMarker) {
                pyFiles = await findFiles(workspacePath, '*.py', { maxDepth: 2, maxMatches: 1 })
                hasPythonMarker = pyFiles.length > 0
            }

            if (!hasPythonMarker) {
                return tasks
            }

            if (hasRequirements) {
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

            if (hasSetup) {
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

            const entryCandidate = (await fileExists(path.join(workspacePath, 'main.py')))
                ? 'main.py'
                : (await fileExists(path.join(workspacePath, 'app.py')))
                    ? 'app.py'
                    : '.'

            tasks.push(
                {
                    id: 'python.run',
                    label: 'Python: Run',
                    type: 'python',
                    command: 'python',
                    args: [entryCandidate],
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

            if (await fileExists(makefilePath)) {
                try {
                    const makefileContent = await fs.promises.readFile(makefilePath, 'utf8')
                    const targetRegex = /^([a-zA-Z0-9_.-]+):/gm
                    let match: RegExpExecArray | null

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
            const csprojFiles = await findFiles(workspacePath, '*.csproj')

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

            if ((await fileExists(gradleBuildPath)) || (await fileExists(gradleBuildKtsPath))) {
                const hasWrapper = await fileExists(
                    path.join(workspacePath, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
                )
                const gradleCmd = hasWrapper
                    ? (process.platform === 'win32' ? 'gradlew.bat' : './gradlew')
                    : 'gradle'

                tasks.push(
                    {
                        id: 'gradle.build',
                        label: 'Gradle: Build',
                        type: 'gradle',
                        command: gradleCmd,
                        args: ['build'],
                        cwd: workspacePath,
                        group: 'build'
                    },
                    {
                        id: 'gradle.test',
                        label: 'Gradle: Test',
                        type: 'gradle',
                        command: gradleCmd,
                        args: ['test'],
                        cwd: workspacePath,
                        group: 'test'
                    },
                    {
                        id: 'gradle.clean',
                        label: 'Gradle: Clean',
                        type: 'gradle',
                        command: gradleCmd,
                        args: ['clean'],
                        cwd: workspacePath,
                        group: 'clean'
                    },
                    {
                        id: 'gradle.run',
                        label: 'Gradle: Run',
                        type: 'gradle',
                        command: gradleCmd,
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

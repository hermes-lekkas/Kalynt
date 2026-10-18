/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Git operations for the open workspace. A saved GitHub token is passed to
 * network commands with `-c http.extraheader` for that one call; it is never
 * written to the repository's config or to a remote URL.
 */
import path from 'node:path'
import fs from 'node:fs'
import simpleGit, { type SimpleGit } from 'simple-git'
import { readSecret } from './safeStorage'

const TOKEN_KEY = 'github-update-token'
const GITHUB_HEADER_KEY = 'http.https://github.com/.extraheader'
const MAX_DIFF_BYTES = 5 * 1024 * 1024

type Result = { success: boolean; error?: string; [key: string]: unknown }

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

function isInside(base: string, target: string): boolean {
    const relative = path.relative(path.resolve(base), path.resolve(target))
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

// Accepts https/http/ssh/git URLs and scp-style "git@host:owner/repo". Rejects
// local paths, other transports, and anything that could be read as an option.
function isCloneUrl(url: string): boolean {
    if (!url || url.startsWith('-') || /\s/.test(url)) return false
    if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(url)) return true
    try {
        return ['https:', 'http:', 'ssh:', 'git:'].includes(new URL(url).protocol)
    } catch {
        return false
    }
}

export function registerGitHandlers(ipcMain: Electron.IpcMain, getCurrentWorkspacePath: () => string | null, getUserDataPath: () => string) {
    const cleaned = new Set<string>()

    const authConfig = (): string[] => {
        const token = readSecret(getUserDataPath(), TOKEN_KEY)
        if (!token) return []
        const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
        return [`${GITHUB_HEADER_KEY}=AUTHORIZATION: basic ${basic}`]
    }

    const gitFor = (repoPath: string, withAuth = false): SimpleGit =>
        simpleGit({ baseDir: repoPath, config: withAuth ? authConfig() : [] })

    // Earlier versions stored the token in .git/config; take it out again.
    const removeStoredToken = async (repoPath: string) => {
        if (cleaned.has(repoPath)) return
        cleaned.add(repoPath)
        try {
            const value = await gitFor(repoPath).raw(['config', '--local', '--get-all', GITHUB_HEADER_KEY]).catch(() => '')
            if (value.trim()) await gitFor(repoPath).raw(['config', '--local', '--unset-all', GITHUB_HEADER_KEY])
        } catch (error) {
            console.warn('[Git] Could not remove a stored token header:', errorText(error))
        }
    }

    /** Runs `fn` for a repo inside the workspace, turning failures into { success: false }. */
    const withRepo = (
        channel: string,
        fn: (repoPath: string, args: any) => Promise<Result>,
        { needsRepo = true }: { needsRepo?: boolean } = {}
    ) => {
        ipcMain.handle(channel, async (_event, arg: any) => {
            try {
                const repoPath: string = typeof arg === 'string' ? arg : arg?.repoPath
                const workspace = getCurrentWorkspacePath()
                if (!workspace || !repoPath || !isInside(workspace, repoPath)) {
                    return { success: false, error: 'Invalid repo path' }
                }
                const hasRepo = fs.existsSync(path.join(repoPath, '.git'))
                if (needsRepo && !hasRepo) return { success: false, error: 'Not a git repository' }
                if (hasRepo) await removeStoredToken(repoPath)
                return await fn(repoPath, arg)
            } catch (error) {
                return { success: false, error: errorText(error) }
            }
        })
    }

    const hasHead = (repoPath: string) =>
        gitFor(repoPath).raw(['rev-parse', '--verify', '--quiet', 'HEAD']).then(out => out.trim().length > 0, () => false)

    withRepo('git:status', async repo => ({ success: true, status: plain(await gitFor(repo).status()) }))

    withRepo('git:log', async (repo, options: { maxCount?: number }) => {
        // A repository without commits has no log yet.
        if (!(await hasHead(repo))) return { success: true, log: { all: [], total: 0, latest: null } }
        return { success: true, log: plain(await gitFor(repo).log({ maxCount: options?.maxCount || 50 })) }
    })

    withRepo('git:diff', async (repo, options: { file?: string; staged?: boolean }) => {
        const args: string[] = []
        if (options?.staged) args.push('--cached')
        if (options?.file) args.push('--', options.file)
        const diff = await gitFor(repo).diff(args)
        if (diff.length > MAX_DIFF_BYTES) return { success: false, error: 'Diff too large to display' }
        return { success: true, diff }
    })

    withRepo('git:add', async (repo, options: { files: string[] }) => {
        await gitFor(repo).add(options.files)
        return { success: true }
    })

    withRepo('git:commit', async (repo, options: { message: string }) => {
        if (!options?.message?.trim()) return { success: false, error: 'A commit message is required' }
        return { success: true, result: plain(await gitFor(repo).commit(options.message)) }
    })

    withRepo('git:branch', async repo => ({ success: true, branches: plain(await gitFor(repo).branch()) }))

    withRepo('git:checkout', async (repo, options: { branch: string }) => {
        await gitFor(repo).checkout(options.branch)
        return { success: true }
    })

    // Unstage. Before the first commit there is no HEAD to reset to.
    withRepo('git:reset', async (repo, options: { files: string[] }) => {
        if (await hasHead(repo)) await gitFor(repo).reset(['HEAD', '--', ...options.files])
        else await gitFor(repo).raw(['rm', '--cached', '-r', '--quiet', '--', ...options.files])
        return { success: true }
    })

    // A branch without an upstream is pushed to origin and linked to it.
    withRepo('git:push', async repo => {
        const git = gitFor(repo, true)
        const status = await git.status()
        if (status.tracking) {
            await git.push()
        } else {
            const remotes = await git.getRemotes()
            const remote = remotes.find(r => r.name === 'origin') ?? remotes[0]
            if (!remote) return { success: false, error: 'This repository has no remote to push to' }
            if (!status.current) return { success: false, error: 'Check out a branch before pushing' }
            await git.push(['--set-upstream', remote.name, status.current])
        }
        return { success: true }
    })

    // Merges explicitly, so newer git versions don't stop to ask how to reconcile.
    withRepo('git:pull', async repo => {
        await gitFor(repo, true).pull(undefined, undefined, { '--no-rebase': null })
        return { success: true }
    })

    withRepo('git:init', async repo => {
        if (fs.existsSync(path.join(repo, '.git'))) return { success: false, error: 'Already a git repository' }
        await gitFor(repo).init()
        return { success: true }
    }, { needsRepo: false })

    // Tracked files go back to their committed version; untracked ones are removed.
    withRepo('git:discard', async (repo, options: { files: string[] }) => {
        const git = gitFor(repo)
        const status = await git.status()
        const untracked = new Set(status.not_added)
        const tracked = options.files.filter(f => !untracked.has(f))
        const fresh = options.files.filter(f => untracked.has(f))
        if (tracked.length) await git.checkout(['--', ...tracked])
        if (fresh.length) await git.clean('f', ['--', ...fresh])
        return { success: true }
    })

    withRepo('git:createBranch', async (repo, options: { branchName: string; checkout?: boolean }) => {
        const git = gitFor(repo)
        if (options.checkout) await git.checkoutLocalBranch(options.branchName)
        else await git.branch([options.branchName])
        return { success: true }
    })

    withRepo('git:fetch', async repo => {
        await gitFor(repo, true).fetch()
        return { success: true }
    })

    withRepo('git:remote', async repo => {
        const status = await gitFor(repo).status()
        return { success: true, ahead: status.ahead, behind: status.behind, tracking: status.tracking }
    })

    ipcMain.handle('git:clone', async (_event, options: { url: string; targetPath: string }) => {
        try {
            const url = options?.url?.trim()
            if (!isCloneUrl(url)) return { success: false, error: 'Enter an https, ssh or git URL for the repository' }
            const target = path.resolve(options.targetPath)
            if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
                return { success: false, error: 'The destination folder already exists and is not empty' }
            }
            await fs.promises.mkdir(path.dirname(target), { recursive: true })
            await simpleGit({ config: authConfig() }).clone(url, target)
            return { success: true, path: target }
        } catch (error) {
            console.error('[Git] Clone failed:', errorText(error))
            return { success: false, error: errorText(error) }
        }
    })
}

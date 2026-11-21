/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Git operations for the open workspace. A saved GitHub token is passed to
 * network commands via environment variables (GIT_CONFIG_COUNT / KEY / VALUE)
 * for that one call; it never appears in process CLI arguments, the
 * repository's config, or a remote URL.
 */
import path from 'node:path'
import fs from 'node:fs'
import { simpleGit, type SimpleGit } from 'simple-git'
import { isGuardedEnvKey } from '@simple-git/argv-parser'
import { readSecret } from './safeStorage'
import { validatePath } from '../utils/pathValidator'

const TOKEN_KEY = 'github-update-token'
const GITHUB_HEADER_KEY = 'http.https://github.com/.extraheader'
const MAX_DIFF_BYTES = 5 * 1024 * 1024

type Result = { success: boolean; error?: string; [key: string]: unknown }

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

function isSafeRefName(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.trim() === value && !value.startsWith('-') && !/[\s\0]/.test(value)
}

function stripRemotePrefix(ref: string): string {
    return ref.replace(/^refs\/remotes\//, '').replace(/^remotes\//, '')
}

async function refExists(git: SimpleGit, fullRef: string): Promise<boolean> {
    try {
        const out = await git.raw(['rev-parse', '--verify', '--quiet', fullRef])
        return out.trim().length > 0
    } catch {
        return false
    }
}

async function splitRemoteRef(git: SimpleGit, remoteRef: string): Promise<{ remote: string; shortName: string }> {
    const remotes = await git.getRemotes(false).catch(() => [])
    const sorted = [...remotes].sort((a, b) => b.name.length - a.name.length)
    for (const r of sorted) {
        if (remoteRef.startsWith(`${r.name}/`)) {
            return { remote: r.name, shortName: remoteRef.slice(r.name.length + 1) }
        }
    }
    const slash = remoteRef.indexOf('/')
    if (slash < 0) return { remote: '', shortName: remoteRef }
    return { remote: remoteRef.slice(0, slash), shortName: remoteRef.slice(slash + 1) }
}

async function listLocalBranchUpstreams(git: SimpleGit): Promise<Array<{ name: string; upstream: string }>> {
    const raw = await git.raw(['for-each-ref', '--format=%(refname:short)\t%(upstream:short)', 'refs/heads']).catch(() => '')
    return raw
        .split(/\r?\n/)
        .map(line => line.trimEnd())
        .filter(Boolean)
        .map(line => {
            const tab = line.indexOf('\t')
            if (tab < 0) return { name: line, upstream: '' }
            return { name: line.slice(0, tab), upstream: line.slice(tab + 1) }
        })
}

/**
 * Checks out a local or remote-tracking branch without detaching HEAD.
 * When checking out a remote ref (e.g. `origin/shared-name` or `second/shared-name`),
 * reuses an existing local branch that already tracks that exact remote ref, or
 * creates a non-colliding local branch (`<shortName>` if free, otherwise `<remote>-<shortName>`)
 * configured to track `refs/remotes/<remoteRef>`.
 */
export async function checkoutBranch(
    git: SimpleGit,
    options: { branch?: string; remoteRef?: string }
): Promise<Result> {
    const rawBranch = options?.branch
    const rawRemoteRef = options?.remoteRef

    if (rawRemoteRef !== undefined && !isSafeRefName(rawRemoteRef)) {
        return { success: false, error: 'Invalid remote branch name' }
    }
    if (rawBranch !== undefined && !isSafeRefName(rawBranch)) {
        return { success: false, error: 'Invalid branch name' }
    }
    if (!rawBranch && !rawRemoteRef) {
        return { success: false, error: 'Invalid branch name' }
    }

    let remoteRef: string | null = null
    if (rawRemoteRef) {
        const candidate = stripRemotePrefix(rawRemoteRef)
        if (!(await refExists(git, `refs/remotes/${candidate}`))) {
            return { success: false, error: `Remote branch '${candidate}' was not found` }
        }
        remoteRef = candidate
    } else if (rawBranch) {
        if (await refExists(git, `refs/heads/${rawBranch}`)) {
            await git.checkout([rawBranch])
            return { success: true, branch: rawBranch }
        }
        const candidate = stripRemotePrefix(rawBranch)
        if (await refExists(git, `refs/remotes/${candidate}`)) {
            remoteRef = candidate
        }
    }

    if (!remoteRef) {
        await git.checkout([rawBranch!])
        const current = (await git.raw(['branch', '--show-current']).catch(() => '')).trim()
        return { success: true, branch: current || rawBranch }
    }

    const { remote, shortName } = await splitRemoteRef(git, remoteRef)
    const locals = await listLocalBranchUpstreams(git)
    const localNames = new Set(locals.map(b => b.name))

    // Reuse an existing local branch that already tracks this exact remote ref.
    const exactTracking = locals.filter(b => b.upstream === remoteRef)
    if (exactTracking.length > 0) {
        const preferred = exactTracking.find(b => b.name === shortName)
            ?? exactTracking.find(b => b.name === `${remote}-${shortName}`)
            ?? exactTracking[0]
        await git.checkout([preferred.name])
        return { success: true, branch: preferred.name, tracking: remoteRef, created: false }
    }

    // Pick a clear, non-colliding local branch name tracking this exact remote ref.
    let localName = shortName
    if (!localName || localNames.has(localName)) {
        const base = remote ? `${remote}-${shortName || 'branch'}` : `remote-${shortName || 'branch'}`
        localName = base
        let suffix = 2
        while (localNames.has(localName)) {
            localName = `${base}-${suffix++}`
        }
    }

    await git.raw(['checkout', '-b', localName, '--track', `refs/remotes/${remoteRef}`])
    return { success: true, branch: localName, tracking: remoteRef, created: true }
}

/**
 * Pushes the active branch, handling renamed tracking branches (e.g. local
 * `second-shared-name` tracking `second/shared-name`) cleanly under `push.default=simple`.
 */
export async function pushBranch(git: SimpleGit): Promise<Result> {
    const status = await git.status()
    if (status.tracking) {
        if (status.current) {
            const upstreamRemote = (await git.raw(['config', '--get', `branch.${status.current}.remote`]).catch(() => '')).trim()
            const upstreamMerge = (await git.raw(['config', '--get', `branch.${status.current}.merge`]).catch(() => '')).trim()
            if (upstreamRemote && upstreamMerge) {
                const remoteBranch = upstreamMerge.replace(/^refs\/heads\//, '')
                if (remoteBranch !== status.current) {
                    await git.push([upstreamRemote, `HEAD:${upstreamMerge}`])
                    return { success: true }
                }
            }
        }
        await git.push()
        return { success: true }
    }
    const remotes = await git.getRemotes()
    const remote = remotes.find(r => r.name === 'origin') ?? remotes[0]
    if (!remote) return { success: false, error: 'This repository has no remote to push to' }
    if (!status.current) return { success: false, error: 'Check out a branch before pushing' }
    await git.push(['--set-upstream', remote.name, status.current])
    return { success: true }
}

function isSafeCommitHash(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-fA-F]{4,40}$/.test(value)
}

function sanitizeFiles(files: unknown): string[] | null {
    if (!Array.isArray(files) || files.length === 0) return null
    const clean: string[] = []
    for (const file of files) {
        if (typeof file !== 'string' || !file || file.includes('\0')) return null
        clean.push(file)
    }
    return clean
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

    // Pass GitHub token via Git's env-based config instead of CLI -c args so it
    // never appears in process listings (`ps` / `/proc/<pid>/cmdline`).
    const authenticatedGit = (baseDir = process.cwd()): SimpleGit => {
        const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !isGuardedEnvKey(key)))
        const auth: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' }
        const token = readSecret(getUserDataPath(), TOKEN_KEY)
        if (token) {
            const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
            auth.GIT_CONFIG_COUNT = '1'
            auth.GIT_CONFIG_KEY_0 = GITHUB_HEADER_KEY
            auth.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`
        }
        return simpleGit({ baseDir, allowEnvironment: Object.keys(auth) }).env({ ...inheritedEnv, ...auth })
    }

    const gitFor = (repoPath: string, withAuth = false): SimpleGit =>
        withAuth ? authenticatedGit(repoPath) : simpleGit({ baseDir: repoPath })

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
                const rawRepoPath: string = typeof arg === 'string' ? arg : arg?.repoPath
                const workspace = getCurrentWorkspacePath()
                if (!workspace || typeof rawRepoPath !== 'string' || !rawRepoPath) {
                    return { success: false, error: 'Invalid repo path' }
                }
                let repoPath: string
                try {
                    repoPath = validatePath(workspace, rawRepoPath)
                } catch {
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
        const rawCount = Number(options?.maxCount)
        const maxCount = Number.isFinite(rawCount) && rawCount > 0 ? Math.min(Math.floor(rawCount), 500) : 50
        return { success: true, log: plain(await gitFor(repo).log({ maxCount })) }
    })

    withRepo('git:diff', async (repo, options: { file?: string; staged?: boolean }) => {
        const args: string[] = []
        if (options?.staged) args.push('--cached')
        if (options?.file) {
            if (typeof options.file !== 'string' || options.file.includes('\0')) {
                return { success: false, error: 'Invalid file path' }
            }
            args.push('--', options.file)
        }
        const diff = await gitFor(repo).diff(args)
        if (diff.length > MAX_DIFF_BYTES) return { success: false, error: 'Diff too large to display' }
        return { success: true, diff }
    })

    withRepo('git:add', async (repo, options: { files: string[] }) => {
        const files = sanitizeFiles(options?.files)
        if (!files) return { success: false, error: 'Select at least one valid file to stage' }
        await gitFor(repo).add(['--', ...files])
        return { success: true }
    })

    withRepo('git:commit', async (repo, options: { message: string; amend?: boolean }) => {
        if (typeof options?.message !== 'string' || !options.message.trim()) {
            return { success: false, error: 'A commit message is required' }
        }
        const extra = options.amend ? { '--amend': null } : undefined
        return { success: true, result: plain(await gitFor(repo).commit(options.message, undefined, extra)) }
    })

    withRepo('git:amend', async (repo, options: { message?: string }) => {
        if (!(await hasHead(repo))) return { success: false, error: 'There is no commit to amend yet' }
        const message = typeof options?.message === 'string' ? options.message.trim() : ''
        if (message) {
            await gitFor(repo).raw(['commit', '--amend', '-m', message])
        } else {
            await gitFor(repo).raw(['commit', '--amend', '--no-edit'])
        }
        return { success: true }
    })

    withRepo('git:branch', async repo => ({ success: true, branches: plain(await gitFor(repo).branch()) }))

    withRepo('git:checkout', async (repo, options: { branch?: string; remoteRef?: string }) =>
        checkoutBranch(gitFor(repo), options ?? {})
    )

    // Unstage. Before the first commit there is no HEAD to reset to.
    withRepo('git:reset', async (repo, options: { files: string[] }) => {
        const files = sanitizeFiles(options?.files)
        if (!files) return { success: false, error: 'Select at least one valid file to unstage' }
        if (await hasHead(repo)) await gitFor(repo).reset(['HEAD', '--', ...files])
        else await gitFor(repo).raw(['rm', '--cached', '-r', '--quiet', '--', ...files])
        return { success: true }
    })

    // A branch without an upstream is pushed to origin and linked to it.
    withRepo('git:push', async repo => pushBranch(gitFor(repo, true)))

    // Explicitly publish the current (or requested) branch to a remote with -u.
    withRepo('git:publish', async (repo, options: string | { repoPath: string; remote?: string; branch?: string }) => {
        const git = gitFor(repo, true)
        const status = await git.status()
        const remotes = await git.getRemotes()
        const requestedRemote = typeof options === 'object' ? options.remote : undefined
        const requestedBranch = typeof options === 'object' ? options.branch : undefined
        const remoteName = requestedRemote
            ? (isSafeRefName(requestedRemote) ? requestedRemote : '')
            : (remotes.find(r => r.name === 'origin') ?? remotes[0])?.name ?? ''
        const branchName = requestedBranch ?? status.current ?? ''
        if (!remoteName) return { success: false, error: 'This repository has no remote to publish to' }
        if (!isSafeRefName(branchName)) return { success: false, error: 'Check out a valid branch before publishing' }
        await git.push(['--set-upstream', remoteName, branchName])
        return { success: true, remote: remoteName, branch: branchName }
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
        const files = sanitizeFiles(options?.files)
        if (!files) return { success: false, error: 'Select at least one valid file to discard' }
        const git = gitFor(repo)
        const status = await git.status()
        const untracked = new Set(status.not_added)
        const tracked = files.filter(f => !untracked.has(f))
        const fresh = files.filter(f => untracked.has(f))
        if (tracked.length) await git.checkout(['--', ...tracked])
        if (fresh.length) await git.clean('f', ['--', ...fresh])
        return { success: true }
    })

    withRepo('git:createBranch', async (repo, options: { branchName: string; checkout?: boolean }) => {
        if (!isSafeRefName(options?.branchName)) return { success: false, error: 'Invalid branch name' }
        const git = gitFor(repo)
        if (options.checkout) await git.raw(['checkout', '-b', options.branchName])
        else await git.raw(['branch', '--', options.branchName])
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

    withRepo('git:stash', async (repo, options: string | { repoPath: string; message?: string }) => {
        const message = typeof options === 'object' && typeof options.message === 'string' ? options.message.trim() : ''
        const args = message ? ['push', '-m', message] : ['push']
        await gitFor(repo).stash(args)
        return { success: true }
    })

    withRepo('git:stashPop', async repo => {
        await gitFor(repo).stash(['pop'])
        return { success: true }
    })

    withRepo('git:stashList', async repo => {
        const list = await gitFor(repo).stashList()
        return { success: true, stashes: plain(list) }
    })

    withRepo('git:commitFiles', async (repo, options: { hash: string }) => {
        if (!isSafeCommitHash(options?.hash)) return { success: false, error: 'Invalid commit hash' }
        const raw = await gitFor(repo).raw(['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', options.hash])
        const files = raw
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                const parts = line.split('\t')
                const status = parts[0] || 'M'
                if (parts.length >= 3) {
                    return { status, oldPath: parts[1], path: parts[2] }
                }
                return { status, path: parts[1] || '' }
            })
            .filter(entry => entry.path.length > 0)
        return { success: true, files }
    })

    withRepo('git:commitDiff', async (repo, options: { hash: string; file?: string }) => {
        if (!isSafeCommitHash(options?.hash)) return { success: false, error: 'Invalid commit hash' }
        const args = ['show', '--format=', options.hash]
        if (options?.file) {
            if (typeof options.file !== 'string' || options.file.includes('\0')) {
                return { success: false, error: 'Invalid file path' }
            }
            args.push('--', options.file)
        }
        const diff = await gitFor(repo).raw(args)
        if (diff.length > MAX_DIFF_BYTES) return { success: false, error: 'Diff too large to display' }
        return { success: true, diff }
    })

    ipcMain.handle('git:clone', async (_event, options: { url: string; targetPath: string }) => {
        try {
            const url = options?.url?.trim()
            if (!isCloneUrl(url)) return { success: false, error: 'Enter an https, ssh or git URL for the repository' }
            if (typeof options?.targetPath !== 'string' || !options.targetPath.trim() || options.targetPath.includes('\0')) {
                return { success: false, error: 'Choose a valid destination folder inside workspaces' }
            }
            const workspacesRoot = path.resolve(getUserDataPath(), 'workspaces')
            await fs.promises.mkdir(workspacesRoot, { recursive: true })
            let target: string
            try {
                target = validatePath(workspacesRoot, options.targetPath)
            } catch {
                return { success: false, error: 'Repositories can only be cloned inside Kalynt workspaces' }
            }
            if (target === workspacesRoot) {
                return { success: false, error: 'Choose a folder name inside the workspaces directory' }
            }
            if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
                return { success: false, error: 'The destination folder already exists and is not empty' }
            }
            await fs.promises.mkdir(path.dirname(target), { recursive: true })
            await authenticatedGit().raw(['clone', '--', url, target])
            return { success: true, path: target }
        } catch (error) {
            console.error('[Git] Clone failed:', errorText(error))
            return { success: false, error: errorText(error) }
        }
    })
}

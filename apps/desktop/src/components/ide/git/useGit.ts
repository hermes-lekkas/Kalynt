/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Source control state for the workspace folder: branch, changes, stashes,
 * history and the actions on them. Publishes live change snapshots so the File
 * Explorer can show Git status markers without running duplicate git queries.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { useNotificationStore } from '../../../stores/notificationStore'
import { readEditorState } from '../../../services/editorRecovery'
import { confirmAction } from '../../ui'
import { useFolderChanges } from '../hooks/folderWatcher'
import { baseName, samePath } from '../languages'

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

export interface GitChange {
    path: string
    kind: ChangeKind
    staged: boolean
}

export interface GitCommit {
    hash: string
    shortHash: string
    date: string
    message: string
    author: string
}

export interface CommitFile {
    status: string
    path: string
    oldPath?: string
}

export interface GitStash {
    hash: string
    date: string
    message: string
}

interface StatusFile { path: string; index: string; working_dir: string }

const KIND: Record<string, ChangeKind> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'added', U: 'conflicted', '?': 'untracked' }

// Lightweight pub/sub bus so FileExplorer reflects live Git markers for the active folder.
const normFolder = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const statusCache = new Map<string, GitChange[]>()
const statusListeners = new Map<string, Set<(changes: GitChange[]) => void>>()

function publishGitChanges(folder: string | null, changes: GitChange[]) {
    if (!folder) return
    const key = normFolder(folder)
    statusCache.set(key, changes)
    statusListeners.get(key)?.forEach(fn => fn(changes))
}

export function useGitStatusForFolder(folder: string | null): GitChange[] {
    const key = folder ? normFolder(folder) : null
    const [changes, setChanges] = useState<GitChange[]>(() => (key ? statusCache.get(key) ?? [] : []))

    useEffect(() => {
        if (!key) {
            setChanges([])
            return
        }
        setChanges(statusCache.get(key) ?? [])
        let set = statusListeners.get(key)
        if (!set) {
            set = new Set()
            statusListeners.set(key, set)
        }
        const listener = (next: GitChange[]) => setChanges(next)
        set.add(listener)
        return () => {
            set?.delete(listener)
            if (set?.size === 0) statusListeners.delete(key)
        }
    }, [key])

    return changes
}

function toChanges(status: { files?: StatusFile[]; not_added?: string[]; modified?: string[]; staged?: string[]; created?: string[]; deleted?: string[] }): GitChange[] {
    if (Array.isArray(status.files)) {
        const out: GitChange[] = []
        for (const f of status.files) {
            if (f.index === '?' || f.working_dir === '?') {
                out.push({ path: f.path, kind: 'untracked', staged: false })
                continue
            }
            if (f.index === 'U' || f.working_dir === 'U') {
                out.push({ path: f.path, kind: 'conflicted', staged: false })
                continue
            }
            if (f.index && f.index.trim()) out.push({ path: f.path, kind: KIND[f.index] ?? 'modified', staged: true })
            if (f.working_dir && f.working_dir.trim()) out.push({ path: f.path, kind: KIND[f.working_dir] ?? 'modified', staged: false })
        }
        return out
    }
    // Older payloads without per-file detail.
    const out: GitChange[] = []
    status.staged?.forEach(path => out.push({ path, kind: 'modified', staged: true }))
    status.created?.forEach(path => out.push({ path, kind: 'added', staged: true }))
    status.modified?.forEach(path => out.push({ path, kind: 'modified', staged: false }))
    status.deleted?.forEach(path => out.push({ path, kind: 'deleted', staged: false }))
    status.not_added?.forEach(path => out.push({ path, kind: 'untracked', staged: false }))
    return out
}

const authProblem = (message: string) => /401|403|authentication failed|could not read username/i.test(message)

/** Plain-language versions of the git errors people hit most. */
function explain(message: string): string {
    if (/Author identity unknown|Please tell me who you are/i.test(message)) {
        return 'Git needs your name and email before it can commit. Run git config --global user.name "Your Name" and git config --global user.email "you@example.com" in the terminal, then commit again.'
    }
    if (/non-fast-forward|fetch first|rejected/i.test(message)) return 'The remote has commits you don’t have yet. Pull first, then push again.'
    if (/no upstream branch|has no upstream/i.test(message)) return 'This branch isn’t linked to a remote branch yet. Click Publish branch to push and set upstream.'
    if (/not a git repository/i.test(message)) return 'This folder isn’t a Git repository.'
    if (/conflict/i.test(message)) return 'There are merge conflicts. Resolve the files marked with ! and stage them.'
    return message
}

export interface DiscardOptions {
    untracked?: boolean
    dirtyPaths?: string[]
}

export function useGit(folder: string | null, visible: boolean) {
    const addNotification = useNotificationStore(s => s.addNotification)
    const [isRepo, setIsRepo] = useState<boolean | null>(null)
    const [branch, setBranch] = useState('')
    const [branches, setBranches] = useState<string[]>([])
    const [ahead, setAhead] = useState(0)
    const [behind, setBehind] = useState(0)
    const [tracking, setTracking] = useState<string | null>(null)
    const [changes, setChanges] = useState<GitChange[]>([])
    const [commits, setCommits] = useState<GitCommit[]>([])
    const [stashes, setStashes] = useState<GitStash[]>([])
    const [busy, setBusy] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const git = () => window.electronAPI?.git
    const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
    const generation = useRef(0)
    const visibleRef = useRef(visible)
    visibleRef.current = visible

    const refresh = useCallback(async (opts?: { statusOnly?: boolean }) => {
        if (!folder) return
        const gen = ++generation.current
        setLoading(true)
        try {
            const status = await git()?.status(folder)
            if (gen !== generation.current) return
            if (!status?.success) {
                setIsRepo(false)
                setChanges([])
                setStashes([])
                publishGitChanges(folder, [])
                return
            }
            const nextChanges = toChanges(status.status)
            setIsRepo(true)
            setBranch(status.status.current || 'HEAD')
            setAhead(status.status.ahead || 0)
            setBehind(status.status.behind || 0)
            setTracking(status.status.tracking || null)
            setChanges(nextChanges)
            publishGitChanges(folder, nextChanges)

            if (opts?.statusOnly) return

            const [branchResult, log, stashResult] = await Promise.all([
                git()?.branch(folder),
                git()?.log({ repoPath: folder, maxCount: 50 }),
                git()?.stashList?.(folder).catch(() => undefined)
            ])
            if (gen !== generation.current) return
            if (branchResult?.success) setBranches((branchResult.branches.all || []) as string[])
            if (log?.success && log.log?.all) {
                setCommits(log.log.all.map((c: { hash?: string; date?: string; message?: string; author_name?: string }) => ({
                    hash: c.hash || '', shortHash: (c.hash || '').slice(0, 7), date: c.date || '', message: c.message || '', author: c.author_name || ''
                })))
            }
            if (stashResult?.success && Array.isArray(stashResult.stashes?.all)) {
                setStashes(stashResult.stashes.all.map((s: { hash?: string; date?: string; message?: string }) => ({
                    hash: s.hash || '', date: s.date || '', message: s.message || 'WIP'
                })))
            }
        } catch (e) {
            if (gen === generation.current) setError(e instanceof Error ? e.message : String(e))
        } finally {
            if (gen === generation.current) setLoading(false)
        }
    }, [folder])

    useEffect(() => {
        generation.current++
        if (debounce.current) {
            clearTimeout(debounce.current)
            debounce.current = null
        }
        setIsRepo(null)
        setBranch('')
        setBranches([])
        setAhead(0)
        setBehind(0)
        setTracking(null)
        setChanges([])
        setCommits([])
        setStashes([])
        setError(null)
        if (folder) void refresh()
        return () => {
            generation.current++
            if (debounce.current) {
                clearTimeout(debounce.current)
                debounce.current = null
            }
        }
    }, [folder, refresh])

    useEffect(() => {
        if (visible && folder) void refresh()
    }, [visible, folder, refresh])

    // Refresh git status on workspace saves/changes even when the Git panel is hidden,
    // so ActivityBar/StatusBar counts and FileExplorer Git markers stay live.
    useFolderChanges(folder, change => {
        if (debounce.current) clearTimeout(debounce.current)
        const isGitMeta = change.path.includes('.git')
        const delay = visibleRef.current || isGitMeta ? 500 : 900
        debounce.current = setTimeout(() => {
            debounce.current = null
            void refresh({ statusOnly: !visibleRef.current && !isGitMeta })
        }, delay)
    })

    /** Runs a git action, reports failures in plain terms, and refreshes. */
    const act = useCallback(async <T extends { success: boolean; error?: string }>(
        label: string,
        fn: () => Promise<T | undefined>,
        success?: string | ((result: T) => string)
    ) => {
        if (!folder) return false
        setBusy(label)
        setError(null)
        try {
            const result = await fn()
            if (!result?.success) {
                const message = result?.error || `${label} failed`
                if (authProblem(message)) addNotification('GitHub rejected the credentials. Add a token in Settings → Security.', 'error')
                else setError(explain(message))
                return false
            }
            const message = typeof success === 'function' ? success(result) : success
            if (message) addNotification(message, 'success')
            return true
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
            return false
        } finally {
            setBusy(null)
            void refresh()
        }
    }, [folder, refresh, addNotification])

    const findDirtyMatches = useCallback(async (paths: string[], explicitDirty?: string[]): Promise<string[]> => {
        if (!folder) return []
        const dirtySet: string[] = [...(explicitDirty ?? [])]
        const spaceId = useAppStore.getState().currentSpace?.id
        if (spaceId) {
            try {
                const recovery = await readEditorState(spaceId, folder)
                if (recovery?.files) {
                    for (const f of recovery.files) {
                        if (f.isDirty) dirtySet.push(f.path)
                    }
                }
            } catch {
                // Recovery state unavailable; proceed with explicit list only.
            }
        }
        if (dirtySet.length === 0) return []
        const rootClean = folder.replace(/[\\/]+$/, '')
        return paths.filter(rel => {
            const full = `${rootClean}/${rel.replace(/^\/+/, '')}`
            return dirtySet.some(d => samePath(d, full) || samePath(d, rel))
        })
    }, [folder])

    const repo = folder ?? ''
    return {
        isRepo, branch, branches, ahead, behind, tracking, changes, commits, stashes, busy, loading, error,
        clearError: () => setError(null),
        refresh,
        init: () => act('Initialize', () => git()?.init(repo), 'Repository initialized'),
        stage: (paths: string[]) => act('Stage', () => git()?.add({ repoPath: repo, files: paths })),
        unstage: (paths: string[]) => act('Unstage', () => git()?.reset({ repoPath: repo, files: paths })),
        discard: async (paths: string[], options?: DiscardOptions) => {
            const dirtyHits = await findDirtyMatches(paths, options?.dirtyPaths)
            const dirtyNotice = dirtyHits.length > 0
                ? `\n\nWarning: ${dirtyHits.map(baseName).join(', ')} ${dirtyHits.length === 1 ? 'has' : 'have'} unsaved edits in the editor.`
                : ''
            const ok = await confirmAction(
                options?.untracked
                    ? {
                        title: paths.length === 1 ? `Delete untracked file ${baseName(paths[0])}?` : `Delete ${paths.length} untracked files?`,
                        message: `This permanently deletes the untracked file${paths.length === 1 ? '' : 's'} from disk.${dirtyNotice}`,
                        confirmLabel: 'Delete file',
                        danger: true
                    }
                    : {
                        title: paths.length === 1 ? `Discard changes to ${baseName(paths[0])}?` : `Discard changes to ${paths.length} files?`,
                        message: `This restores the last committed version. Your changes cannot be recovered.${dirtyNotice}`,
                        confirmLabel: 'Discard changes',
                        danger: true
                    }
            )
            return ok ? act(options?.untracked ? 'Delete' : 'Discard', () => git()?.discard({ repoPath: repo, files: paths }), options?.untracked ? 'Untracked file deleted' : 'Changes discarded') : false
        },
        commit: (message: string) => act('Commit', () => git()?.commit({ repoPath: repo, message }), 'Committed'),
        amend: (message?: string) => act('Amend', () => git()?.amend?.({ repoPath: repo, message }), 'Commit amended'),
        stageAllAndCommit: async (message: string, paths: string[], amend = false) => {
            if (paths.length > 0) {
                const stagedOk = await act('Stage', () => git()?.add({ repoPath: repo, files: paths }))
                if (!stagedOk) return false
            }
            return amend
                ? act('Amend', () => git()?.amend?.({ repoPath: repo, message }), 'Commit amended')
                : act('Commit', () => git()?.commit({ repoPath: repo, message }), 'Committed')
        },
        push: () => act('Push', () => git()?.push(repo), 'Pushed'),
        publish: (options?: { remote?: string; branch?: string }) =>
            act('Publish', () => git()?.publish?.(options ? { repoPath: repo, ...options } : repo), 'Branch published'),
        pull: () => act('Pull', () => git()?.pull(repo), 'Pulled'),
        fetch: () => act('Fetch', () => git()?.fetch?.(repo), 'Fetched from remote'),
        stash: (message?: string) => act('Stash', () => git()?.stash?.(message ? { repoPath: repo, message } : repo), 'Changes stashed'),
        stashPop: () => act('Pop stash', () => git()?.stashPop?.(repo), 'Stash popped'),
        checkout: (name: string, options?: { remoteRef?: string }) =>
            act(
                'Switch branch',
                () => git()?.checkout({
                    repoPath: repo,
                    branch: name,
                    ...(options?.remoteRef ? { remoteRef: options.remoteRef } : {})
                }),
                result => {
                    const resolved = (result as { branch?: string; tracking?: string })
                    if (resolved.branch && resolved.tracking) {
                        return `Switched to ${resolved.branch} (tracking ${resolved.tracking})`
                    }
                    return `Switched to ${resolved.branch || name}`
                }
            ),
        createBranch: (name: string) => act('Create branch', () => git()?.createBranch({ repoPath: repo, branchName: name, checkout: true }), `Created and switched to ${name}`),
        diff: async (path: string, staged: boolean): Promise<{ diff?: string; error?: string }> => {
            const result = await git()?.diff({ repoPath: repo, file: path, staged })
            return result?.success ? { diff: result.diff as string } : { error: result?.error || 'The diff could not be loaded.' }
        },
        commitFiles: async (hash: string): Promise<{ files?: CommitFile[]; error?: string }> => {
            const result = await git()?.commitFiles?.({ repoPath: repo, hash })
            return result?.success ? { files: (result.files ?? []) as CommitFile[] } : { error: result?.error || 'Could not load changed files.' }
        },
        commitDiff: async (hash: string, file?: string): Promise<{ diff?: string; error?: string }> => {
            const result = await git()?.commitDiff?.({ repoPath: repo, hash, file })
            return result?.success ? { diff: result.diff as string } : { error: result?.error || 'The commit diff could not be loaded.' }
        }
    }
}

export type GitApi = ReturnType<typeof useGit>

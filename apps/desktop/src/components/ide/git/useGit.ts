/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Source control state for the workspace folder: branch, changes, history
 * and the actions on them.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNotificationStore } from '../../../stores/notificationStore'
import { confirmAction } from '../../ui'
import { useFolderChanges } from '../hooks/folderWatcher'

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

interface StatusFile { path: string; index: string; working_dir: string }

const KIND: Record<string, ChangeKind> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'added', U: 'conflicted', '?': 'untracked' }

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
    if (/no upstream branch|has no upstream/i.test(message)) return 'This branch isn’t linked to a remote branch yet. Push it once from the terminal with git push -u origin <branch>.'
    if (/not a git repository/i.test(message)) return 'This folder isn’t a Git repository.'
    if (/conflict/i.test(message)) return 'There are merge conflicts. Resolve the files marked with ! and stage them.'
    return message
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
    const [busy, setBusy] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const git = () => window.electronAPI?.git
    const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

    const refresh = useCallback(async () => {
        if (!folder) return
        setLoading(true)
        try {
            const status = await git()?.status(folder)
            if (!status?.success) {
                setIsRepo(false)
                setChanges([])
                return
            }
            setIsRepo(true)
            setBranch(status.status.current || 'HEAD')
            setAhead(status.status.ahead || 0)
            setBehind(status.status.behind || 0)
            setTracking(status.status.tracking || null)
            setChanges(toChanges(status.status))
            const [branchResult, log] = await Promise.all([git()?.branch(folder), git()?.log({ repoPath: folder, maxCount: 50 })])
            if (branchResult?.success) setBranches((branchResult.branches.all || []) as string[])
            if (log?.success && log.log?.all) {
                setCommits(log.log.all.map((c: { hash?: string; date?: string; message?: string; author_name?: string }) => ({
                    hash: c.hash || '', shortHash: (c.hash || '').slice(0, 7), date: c.date || '', message: c.message || '', author: c.author_name || ''
                })))
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setLoading(false)
        }
    }, [folder])

    useEffect(() => {
        setIsRepo(null)
        setChanges([])
        setCommits([])
        setError(null)
        if (folder) refresh()
    }, [folder, refresh])

    useEffect(() => { if (visible && folder) refresh() }, [visible, folder, refresh])

    useFolderChanges(folder, change => {
        if (!visible && !change.path.includes('.git')) return
        if (debounce.current) clearTimeout(debounce.current)
        debounce.current = setTimeout(refresh, 700)
    })

    useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current) }, [])

    /** Runs a git action, reports failures in plain terms, and refreshes. */
    const act = useCallback(async (label: string, fn: () => Promise<{ success: boolean; error?: string } | undefined>, success?: string) => {
        if (!folder) return false
        setBusy(label)
        setError(null)
        try {
            const result = await fn()
            if (!result?.success) {
                const message = result?.error || `${label} failed`
                if (authProblem(message)) addNotification('GitHub rejected the credentials. Add a token in Settings → Workspace.', 'error')
                else setError(explain(message))
                return false
            }
            if (success) addNotification(success, 'success')
            return true
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
            return false
        } finally {
            setBusy(null)
            refresh()
        }
    }, [folder, refresh, addNotification])

    const repo = folder ?? ''
    return {
        isRepo, branch, branches, ahead, behind, tracking, changes, commits, busy, loading, error,
        clearError: () => setError(null),
        refresh,
        init: () => act('Initialize', () => git()?.init(repo), 'Repository initialized'),
        stage: (paths: string[]) => act('Stage', () => git()?.add({ repoPath: repo, files: paths })),
        unstage: (paths: string[]) => act('Unstage', () => git()?.reset({ repoPath: repo, files: paths })),
        discard: async (paths: string[]) => {
            const ok = await confirmAction({
                title: paths.length === 1 ? `Discard changes to ${paths[0]}?` : `Discard changes to ${paths.length} files?`,
                message: 'This restores the last committed version. Your changes cannot be recovered.',
                confirmLabel: 'Discard changes',
                danger: true
            })
            return ok ? act('Discard', () => git()?.discard({ repoPath: repo, files: paths }), 'Changes discarded') : false
        },
        commit: (message: string) => act('Commit', () => git()?.commit({ repoPath: repo, message }), 'Committed'),
        push: () => act('Push', () => git()?.push(repo), 'Pushed'),
        pull: () => act('Pull', () => git()?.pull(repo), 'Pulled'),
        fetch: () => act('Fetch', () => git()?.fetch?.(repo)),
        checkout: (name: string) => act('Switch branch', () => git()?.checkout({ repoPath: repo, branch: name }), `Switched to ${name}`),
        createBranch: (name: string) => act('Create branch', () => git()?.createBranch({ repoPath: repo, branchName: name, checkout: true }), `Created and switched to ${name}`),
        diff: async (path: string, staged: boolean): Promise<{ diff?: string; error?: string }> => {
            const result = await git()?.diff({ repoPath: repo, file: path, staged })
            return result?.success ? { diff: result.diff as string } : { error: result?.error || 'The diff could not be loaded.' }
        }
    }
}

export type GitApi = ReturnType<typeof useGit>

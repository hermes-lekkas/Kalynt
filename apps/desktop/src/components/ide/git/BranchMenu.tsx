/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, GitBranch, Plus } from 'lucide-react'
import { Popover, SearchInput, promptText } from '../../ui'
import { usePermissions } from '../../../hooks/usePermissions'
import type { GitApi } from './useGit'

interface RemoteEntry {
    raw: string
    remote: string
    shortName: string
    ref: string
}

function parseRemoteBranch(raw: string): RemoteEntry {
    const stripped = raw.replace(/^remotes\//, '')
    const slash = stripped.indexOf('/')
    if (slash < 0) return { raw, remote: '', shortName: stripped, ref: stripped }
    return {
        raw,
        remote: stripped.slice(0, slash),
        shortName: stripped.slice(slash + 1),
        ref: stripped
    }
}

export function BranchMenu({ git, canEdit: canEditProp }: { git: GitApi; canEdit?: boolean }) {
    const permissions = usePermissions()
    const canEdit = canEditProp ?? permissions.canEdit
    const triggerRef = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')

    const { local, remote, localSet, remoteShortCounts } = useMemo(() => {
        const allLocal: string[] = []
        const allRemote: RemoteEntry[] = []
        const shortCounts = new Map<string, number>()

        for (const b of git.branches) {
            if (b.startsWith('remotes/')) {
                if (b.endsWith('/HEAD')) continue
                const parsed = parseRemoteBranch(b)
                allRemote.push(parsed)
                shortCounts.set(parsed.shortName, (shortCounts.get(parsed.shortName) ?? 0) + 1)
            } else {
                allLocal.push(b)
            }
        }

        const q = query.trim().toLowerCase()
        return {
            local: q ? allLocal.filter(b => b.toLowerCase().includes(q)) : allLocal,
            remote: q ? allRemote.filter(r => r.ref.toLowerCase().includes(q)) : allRemote,
            localSet: new Set(allLocal),
            remoteShortCounts: shortCounts
        }
    }, [git.branches, query])

    const close = () => { setOpen(false); setQuery('') }

    const create = async () => {
        if (!canEdit) return
        close()
        const name = await promptText({
            title: 'New branch',
            label: 'Branch name',
            placeholder: 'e.g. fix/login-timeout',
            confirmLabel: 'Create and switch',
            mono: true,
            validate: v => (/\s|\.\.|[~^:?*[\\]/.test(v) ? 'Branch names can’t contain spaces or ~ ^ : ? * [ \\ ..' : null)
        })
        if (name) git.createBranch(name)
    }

    const checkoutLocal = (name: string) => {
        close()
        if (!canEdit || name === git.branch) return
        git.checkout(name)
    }

    const checkoutRemote = (entry: RemoteEntry) => {
        close()
        if (!canEdit) return
        // Avoid redundant checkout if the active local branch already tracks this exact remote ref.
        if (git.branch === entry.shortName && git.tracking === entry.ref) return
        const isAmbiguous = (remoteShortCounts.get(entry.shortName) ?? 0) > 1
        const hasLocal = localSet.has(entry.shortName)
        // Use DWIM short name only when unambiguous and no conflicting local branch exists;
        // otherwise preserve the full `<remote>/<branch>` ref so multi-remote branches never collide.
        const target = !isAmbiguous && !hasLocal ? entry.shortName : entry.ref
        git.checkout(target)
    }

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                className="branch-trigger"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="dialog"
                aria-expanded={open}
                title="Switch branch"
            >
                <GitBranch size={14} aria-hidden />
                <span className="mono truncate">{git.branch || 'No branch'}</span>
                <ChevronDown size={13} aria-hidden />
            </button>
            <Popover open={open} onClose={close} anchor={triggerRef.current} width={280} ariaLabel="Branches">
                <div className="branch-menu">
                    <div className="branch-menu__search">
                        <SearchInput size="sm" value={query} onChange={setQuery} placeholder="Find a branch" autoFocus />
                    </div>
                    {canEdit && (
                        <button type="button" className="branch-menu__create" onClick={create}>
                            <Plus size={14} aria-hidden /> Create branch…
                        </button>
                    )}
                    <ul className="branch-menu__list" aria-label="Local branches">
                        {local.map(b => (
                            <li key={`local:${b}`}>
                                <button
                                    type="button"
                                    className={`branch-menu__item ${b === git.branch ? 'is-current' : ''}`}
                                    disabled={!canEdit && b !== git.branch}
                                    onClick={() => checkoutLocal(b)}
                                >
                                    <span className="mono truncate">{b}</span>
                                    {b === git.branch && <Check size={14} aria-hidden />}
                                </button>
                            </li>
                        ))}
                    </ul>
                    {remote.length > 0 && (
                        <>
                            <p className="branch-menu__heading">Remote</p>
                            <ul className="branch-menu__list" aria-label="Remote branches">
                                {remote.map(entry => {
                                    const isTracking = git.tracking === entry.ref && git.branch === entry.shortName
                                    return (
                                        <li key={entry.raw}>
                                            <button
                                                type="button"
                                                className={`branch-menu__item ${isTracking ? 'is-current' : ''}`}
                                                disabled={!canEdit && !isTracking}
                                                title={entry.ref}
                                                onClick={() => checkoutRemote(entry)}
                                            >
                                                <span className="mono truncate">
                                                    {entry.remote && <span className="branch-menu__remote">{entry.remote}/</span>}
                                                    {entry.shortName}
                                                </span>
                                                {isTracking && <Check size={14} aria-hidden />}
                                            </button>
                                        </li>
                                    )
                                })}
                            </ul>
                        </>
                    )}
                    {local.length + remote.length === 0 && <p className="branch-menu__empty">No branch matches “{query}”.</p>}
                </div>
            </Popover>
        </>
    )
}

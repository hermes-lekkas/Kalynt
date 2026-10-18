/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, GitBranch, Plus } from 'lucide-react'
import { Popover, SearchInput, promptText } from '../../ui'
import type { GitApi } from './useGit'

export function BranchMenu({ git }: { git: GitApi }) {
    const triggerRef = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')

    const { local, remote } = useMemo(() => {
        const q = query.trim().toLowerCase()
        const all = git.branches.filter(b => !q || b.toLowerCase().includes(q))
        return {
            local: all.filter(b => !b.startsWith('remotes/')),
            remote: all.filter(b => b.startsWith('remotes/') && !b.endsWith('/HEAD'))
        }
    }, [git.branches, query])

    const close = () => { setOpen(false); setQuery('') }

    const create = async () => {
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

    const item = (name: string, label = name) => (
        <li key={name}>
            <button type="button" className={`branch-menu__item ${name === git.branch ? 'is-current' : ''}`} onClick={() => { close(); if (name !== git.branch) git.checkout(label) }}>
                <span className="mono truncate">{label}</span>
                {name === git.branch && <Check size={14} aria-hidden />}
            </button>
        </li>
    )

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
                    <button type="button" className="branch-menu__create" onClick={create}>
                        <Plus size={14} aria-hidden /> Create branch…
                    </button>
                    <ul className="branch-menu__list" aria-label="Local branches">
                        {local.map(b => item(b))}
                    </ul>
                    {remote.length > 0 && (
                        <>
                            <p className="branch-menu__heading">Remote</p>
                            <ul className="branch-menu__list" aria-label="Remote branches">
                                {remote.map(b => item(b, b.replace(/^remotes\/[^/]+\//, '')))}
                            </ul>
                        </>
                    )}
                    {local.length + remote.length === 0 && <p className="branch-menu__empty">No branch matches “{query}”.</p>}
                </div>
            </Popover>
        </>
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Workspace Problems panel: aggregates Monaco markers, build problems, and
 * LSP diagnostics into a filterable, collapsible file tree with click-to-jump.
 */
import { useMemo, useState } from 'react'
import {
    AlertCircle,
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    ChevronsDownUp,
    ChevronsUpDown,
    Info,
    Search,
    X
} from 'lucide-react'
import { useDiagnosticsStore, type DiagnosticItem, type DiagnosticSeverity } from '../../../stores/diagnosticsStore'
import { IconButton } from '../../ui'
import { baseName, dirName, relativePath } from '../languages'
import './problems.css'

type SeverityFilter = 'all' | 'error' | 'warning'

interface ProblemsPanelProps {
    folder: string | null
}

interface FileDiagnosticGroup {
    file: string
    name: string
    dir: string
    items: DiagnosticItem[]
    errors: number
    warnings: number
    infos: number
}

function severityIcon(severity: DiagnosticSeverity) {
    if (severity === 'error') {
        return <AlertCircle size={13} className="problems-row__icon problems-row__icon--error" aria-hidden />
    }
    if (severity === 'warning') {
        return <AlertTriangle size={13} className="problems-row__icon problems-row__icon--warning" aria-hidden />
    }
    return <Info size={13} className="problems-row__icon problems-row__icon--info" aria-hidden />
}

export function ProblemsPanel({ folder }: ProblemsPanelProps) {
    const items = useDiagnosticsStore(s => s.items)
    const counts = useDiagnosticsStore(s => s.counts)

    const [filter, setFilter] = useState<SeverityFilter>('all')
    const [query, setQuery] = useState('')
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        return items.filter(item => {
            if (filter === 'error' && item.severity !== 'error') return false
            if (filter === 'warning' && item.severity !== 'warning') return false
            if (!needle) return true
            return (
                item.message.toLowerCase().includes(needle) ||
                item.file.toLowerCase().includes(needle) ||
                (item.source?.toLowerCase().includes(needle) ?? false) ||
                (item.code?.toLowerCase().includes(needle) ?? false)
            )
        })
    }, [items, filter, query])

    const groups = useMemo<FileDiagnosticGroup[]>(() => {
        const byFile = new Map<string, FileDiagnosticGroup>()
        for (const item of filtered) {
            let group = byFile.get(item.file)
            if (!group) {
                const rel = relativePath(item.file, folder)
                const relDir = dirName(rel)
                group = {
                    file: item.file,
                    name: baseName(item.file),
                    dir: relDir === '.' ? '' : relDir,
                    items: [],
                    errors: 0,
                    warnings: 0,
                    infos: 0
                }
                byFile.set(item.file, group)
            }
            group.items.push(item)
            if (item.severity === 'error') group.errors++
            else if (item.severity === 'warning') group.warnings++
            else group.infos++
        }
        return Array.from(byFile.values())
    }, [filtered, folder])

    const allCollapsed = groups.length > 0 && groups.every(g => collapsed.has(g.file))

    const toggleGroup = (file: string) => {
        setCollapsed(prev => {
            const next = new Set(prev)
            if (next.has(file)) next.delete(file)
            else next.add(file)
            return next
        })
    }

    const toggleAll = () => {
        if (allCollapsed) setCollapsed(new Set())
        else setCollapsed(new Set(groups.map(g => g.file)))
    }

    const jumpTo = (item: DiagnosticItem) => {
        window.dispatchEvent(
            new CustomEvent('kalynt-open-file', {
                detail: { path: item.file, line: item.line, column: item.column }
            })
        )
    }

    const hasActiveFilter = filter !== 'all' || query.trim().length > 0

    return (
        <div className="problems-panel">
            <div className="problems-panel__bar">
                <div className="problems-panel__filters" role="group" aria-label="Filter problems by severity">
                    <button
                        type="button"
                        className={`problems-filter ${filter === 'all' ? 'is-active' : ''}`}
                        onClick={() => setFilter('all')}
                        aria-pressed={filter === 'all'}
                    >
                        <span>All</span>
                        <span className="problems-filter__count">{counts.total}</span>
                    </button>
                    <button
                        type="button"
                        className={`problems-filter problems-filter--error ${filter === 'error' ? 'is-active' : ''}`}
                        onClick={() => setFilter('error')}
                        aria-pressed={filter === 'error'}
                    >
                        <AlertCircle size={12} className="problems-filter__icon" aria-hidden />
                        <span>Errors</span>
                        <span className="problems-filter__count">{counts.errors}</span>
                    </button>
                    <button
                        type="button"
                        className={`problems-filter problems-filter--warning ${filter === 'warning' ? 'is-active' : ''}`}
                        onClick={() => setFilter('warning')}
                        aria-pressed={filter === 'warning'}
                    >
                        <AlertTriangle size={12} className="problems-filter__icon" aria-hidden />
                        <span>Warnings</span>
                        <span className="problems-filter__count">{counts.warnings}</span>
                    </button>
                </div>

                <div className="problems-panel__search">
                    <div className="problems-panel__input-wrap">
                        <Search size={12} className="problems-panel__input-icon" aria-hidden />
                        <input
                            type="text"
                            className="problems-panel__input"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder="Filter problems…"
                            aria-label="Filter problems"
                        />
                        {query && (
                            <button
                                type="button"
                                className="problems-panel__clear"
                                onClick={() => setQuery('')}
                                aria-label="Clear filter"
                            >
                                <X size={11} />
                            </button>
                        )}
                    </div>
                    {groups.length > 0 && (
                        <IconButton
                            size="sm"
                            label={allCollapsed ? 'Expand all files' : 'Collapse all files'}
                            icon={allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
                            onClick={toggleAll}
                        />
                    )}
                </div>
            </div>

            <div className="problems-panel__body">
                {groups.length === 0 ? (
                    <div className="problems-empty">
                        <CheckCircle2 size={18} aria-hidden />
                        <span>
                            {counts.total === 0
                                ? 'No problems detected in the workspace.'
                                : 'No problems match the current filter.'}
                        </span>
                        {hasActiveFilter && (
                            <button
                                type="button"
                                className="problems-empty__clear"
                                onClick={() => { setFilter('all'); setQuery('') }}
                            >
                                Reset filters
                            </button>
                        )}
                    </div>
                ) : (
                    groups.map(group => {
                        const isOpen = !collapsed.has(group.file)
                        return (
                            <div key={group.file} className="problems-group">
                                <button
                                    type="button"
                                    className="problems-group__head"
                                    onClick={() => toggleGroup(group.file)}
                                    aria-expanded={isOpen}
                                >
                                    {isOpen
                                        ? <ChevronDown size={13} className="problems-group__chevron" aria-hidden />
                                        : <ChevronRight size={13} className="problems-group__chevron" aria-hidden />}
                                    <span className="problems-group__file">{group.name}</span>
                                    {group.dir && <span className="problems-group__dir">{group.dir}</span>}
                                    <span className="problems-group__counts">
                                        {group.errors > 0 && <span className="problems-group__count--error">{group.errors}E</span>}
                                        {group.warnings > 0 && <span className="problems-group__count--warning">{group.warnings}W</span>}
                                        {group.infos > 0 && <span className="problems-group__count--info">{group.infos}I</span>}
                                    </span>
                                </button>
                                {isOpen && (
                                    <ul className="problems-group__list">
                                        {group.items.map(item => (
                                            <li key={item.id}>
                                                <button
                                                    type="button"
                                                    className="problems-row"
                                                    onClick={() => jumpTo(item)}
                                                    title={`${item.message}${item.source ? ` [${item.source}${item.code ? ` ${item.code}` : ''}]` : ''}`}
                                                >
                                                    {severityIcon(item.severity)}
                                                    <span className="problems-row__message">{item.message}</span>
                                                    {(item.source || item.code) && (
                                                        <span className="problems-row__source">
                                                            {item.source ?? ''}{item.code ? `(${item.code})` : ''}
                                                        </span>
                                                    )}
                                                    <span className="problems-row__loc">[{item.line}, {item.column}]</span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        )
                    })
                )}
            </div>
        </div>
    )
}

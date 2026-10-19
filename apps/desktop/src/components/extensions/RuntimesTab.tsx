/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useMemo, useState } from 'react'
import { ChevronRight, ExternalLink, RefreshCw } from 'lucide-react'
import { Badge, Button, ProgressBar, SearchInput, Tabs } from '../ui'
import { RUNTIME_CATALOG, type RuntimeEntry } from './runtimeCatalog'
import { useRuntimes } from './useRuntimes'

type Filter = 'all' | 'installed' | 'missing'

function RuntimeRow({ rt, api }: { rt: RuntimeEntry; api: ReturnType<typeof useRuntimes> }) {
    const [showLog, setShowLog] = useState(false)
    const state = api.states[rt.id]
    const progress = api.progress[rt.id]
    const log = api.logs[rt.id] ?? []
    const busy = progress && (progress.phase === 'downloading' || progress.phase === 'installing')

    return (
        <li className="ext-row">
            <div className="ext-row__info">
                <div className="ext-row__name">
                    {rt.name}
                    {state?.installed && <Badge tone="success">{rt.builtIn ? 'Built in' : state.version ? `Installed ${state.version}` : 'Installed'}</Badge>}
                    {state?.managed && <Badge>Installed by Kalynt</Badge>}
                </div>
                <p className="ext-row__desc">{rt.description}{rt.runsCode ? '' : '. A build tool; it does not run files from the editor.'}</p>
                {busy && (
                    <div className="ext-row__progress">
                        <ProgressBar value={progress.fraction} tone="agent" label={`Installing ${rt.name}`} />
                        <span>{progress.phase === 'installing' ? 'Installing…' : progress.fraction !== undefined ? `Downloading ${Math.round(progress.fraction * 100)}%` : 'Downloading…'}</span>
                    </div>
                )}
                {progress?.phase === 'failed' && <p className="ext-row__error">The install failed{progress.message ? `: ${progress.message}` : '.'}</p>}
                {log.length > 0 && (
                    <>
                        <button type="button" className="ext-row__log-toggle" onClick={() => setShowLog(v => !v)} aria-expanded={showLog}>
                            <ChevronRight size={12} className={showLog ? 'is-open' : ''} aria-hidden /> Install log
                        </button>
                        {showLog && <pre className="ext-row__log selectable">{log.join('\n')}</pre>}
                    </>
                )}
            </div>
            <div className="ext-row__actions">
                {rt.builtIn ? null : state?.installed ? (
                    state.managed ? <Button size="sm" variant="ghost" onClick={() => api.uninstall(rt)}>Uninstall</Button> : null
                ) : api.canInstall(rt) ? (
                    <Button size="sm" loading={busy} onClick={() => api.install(rt)}>{busy ? 'Installing' : 'Install'}</Button>
                ) : (
                    <Button size="sm" iconRight={<ExternalLink size={12} />} onClick={() => api.install(rt)}>Get it</Button>
                )}
            </div>
        </li>
    )
}

export function RuntimesTab() {
    const api = useRuntimes()
    const [query, setQuery] = useState('')
    const [filter, setFilter] = useState<Filter>('all')

    const list = useMemo(() => {
        const q = query.trim().toLowerCase()
        return RUNTIME_CATALOG.filter(rt => {
            const installed = !!api.states[rt.id]?.installed
            if (filter === 'installed' && !installed) return false
            if (filter === 'missing' && installed) return false
            return !q || rt.name.toLowerCase().includes(q) || rt.description.toLowerCase().includes(q)
        })
    }, [query, filter, api.states])

    const installedCount = RUNTIME_CATALOG.filter(rt => api.states[rt.id]?.installed).length

    return (
        <div className="ext-tab">
            <div className="ext-tab__tools">
                <SearchInput size="sm" value={query} onChange={setQuery} placeholder="Find a language" aria-label="Find a language" />
                <Tabs
                    variant="segmented"
                    size="sm"
                    ariaLabel="Filter runtimes"
                    value={filter}
                    onChange={setFilter}
                    items={[{ id: 'all', label: 'All' }, { id: 'installed', label: 'Installed', badge: installedCount }, { id: 'missing', label: 'Not installed' }]}
                />
                <Button size="sm" variant="ghost" icon={<RefreshCw size={13} className={api.checking ? 'spin' : ''} />} onClick={api.check} disabled={api.checking}>
                    {api.checking ? 'Checking' : 'Check again'}
                </Button>
            </div>
            <ul className="ext-list">
                {list.map(rt => <RuntimeRow key={rt.id} rt={rt} api={api} />)}
                {list.length === 0 && <li className="ext-empty">No language matches.</li>}
            </ul>
        </div>
    )
}

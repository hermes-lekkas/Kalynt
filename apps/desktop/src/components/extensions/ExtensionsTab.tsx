/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useState } from 'react'
import { ExternalLink, Package, RefreshCw, X } from 'lucide-react'
import type { ExtensionGallery, ExtensionMetadata } from '../../types/extensions'
import { Badge, Button, EmptyState, IconButton, SearchInput, Spinner, Tabs } from '../ui'
import { useExtensions } from './useExtensions'

type View = 'installed' | 'marketplace' | 'recommended'

const publisherName = (p: ExtensionMetadata['publisher'] | ExtensionGallery['publisher']) =>
    !p ? '' : typeof p === 'string' ? p : p.displayName

function Contributions({ ext }: { ext: ExtensionMetadata }) {
    const c = ext.contributes
    if (!c) return null
    const parts: string[] = []
    if (c.commands?.length) parts.push(`${c.commands.length} command${c.commands.length === 1 ? '' : 's'}`)
    if (c.languages?.length) parts.push(`${c.languages.length} language${c.languages.length === 1 ? '' : 's'}`)
    if (c.themes?.length) parts.push(`${c.themes.length} theme${c.themes.length === 1 ? '' : 's'}`)
    if (c.views) parts.push('views')
    return parts.length ? <p className="ext-row__meta">Adds {parts.join(', ')}</p> : null
}

export function ExtensionsTab() {
    const api = useExtensions()
    const [view, setView] = useState<View>('installed')
    const [query, setQuery] = useState('')

    useEffect(() => {
        if (view !== 'marketplace') return
        const t = setTimeout(() => api.search(query), 300)
        return () => clearTimeout(t)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, view])

    const installedIds = new Set(api.installed.map(e => e.id))
    const q = query.trim().toLowerCase()

    const galleryRow = (ext: ExtensionGallery) => (
        <li key={ext.id} className="ext-row">
            <div className="ext-row__info">
                <div className="ext-row__name">{ext.displayName}{installedIds.has(ext.id) && <Badge tone="success">Installed</Badge>}</div>
                <p className="ext-row__desc">{ext.shortDescription}</p>
                <p className="ext-row__meta">{publisherName(ext.publisher)}{ext.versions?.[0]?.version ? `, version ${ext.versions[0].version}` : ''}</p>
            </div>
            <div className="ext-row__actions">
                <IconButton size="sm" label="Open in the marketplace" icon={<ExternalLink size={13} />}
                    onClick={() => window.electronAPI?.shell?.openExternal?.(`https://open-vsx.org/extension/${ext.id.replace('.', '/')}`)} />
                {!installedIds.has(ext.id) && <Button size="sm" loading={api.busy.has(ext.id)} onClick={() => api.install(ext)}>Install</Button>}
            </div>
        </li>
    )

    const installed = api.installed.filter(e => !q || (e.displayName || e.name).toLowerCase().includes(q) || e.id.toLowerCase().includes(q))
    const gallery = view === 'recommended' ? api.recommended : q ? api.results : api.popular

    return (
        <div className="ext-tab">
            <div className="ext-tab__tools">
                <SearchInput size="sm" value={query} onChange={setQuery} placeholder={view === 'marketplace' ? 'Search the marketplace' : 'Filter installed extensions'} aria-label="Search extensions" />
                <Tabs
                    variant="segmented"
                    size="sm"
                    ariaLabel="Extension views"
                    value={view}
                    onChange={setView}
                    items={[{ id: 'installed', label: 'Installed', badge: api.installed.length }, { id: 'marketplace', label: 'Marketplace' }, { id: 'recommended', label: 'Recommended' }]}
                />
                <Button size="sm" variant="ghost" icon={<Package size={13} />} onClick={api.installVsix}>Install from file</Button>
                <IconButton size="sm" label="Refresh" icon={<RefreshCw size={13} className={api.loading ? 'spin' : ''} />} onClick={api.refresh} />
            </div>

            {api.error && (
                <div className="ext-error" role="alert">
                    <p className="selectable">{api.error}</p>
                    <IconButton size="sm" label="Dismiss" icon={<X size={13} />} onClick={api.clearError} />
                </div>
            )}

            {view === 'installed' ? (
                api.loading && api.installed.length === 0 ? <div className="ext-empty"><Spinner label="Reading extensions" /></div>
                    : installed.length === 0 ? (
                        <EmptyState compact title={q ? 'No installed extension matches' : 'No extensions installed'} description="Kalynt runs VS Code extensions from the Open VSX marketplace."
                            actions={<Button size="sm" onClick={() => setView('marketplace')}>Browse the marketplace</Button>} />
                    ) : (
                        <ul className="ext-list">
                            {installed.map(ext => {
                                const isActive = api.active.has(ext.id)
                                return (
                                    <li key={ext.id} className="ext-row">
                                        <div className="ext-row__info">
                                            <div className="ext-row__name">
                                                {ext.displayName || ext.name}
                                                {isActive && <Badge tone="success">Running</Badge>}
                                                {ext.isBuiltin && <Badge>Built in</Badge>}
                                            </div>
                                            {ext.description && <p className="ext-row__desc">{ext.description}</p>}
                                            <p className="ext-row__meta mono">{ext.id} {ext.version}</p>
                                            <Contributions ext={ext} />
                                        </div>
                                        <div className="ext-row__actions">
                                            <Button size="sm" loading={api.busy.has(ext.id)} onClick={() => api.toggle(ext.id)}>{isActive ? 'Stop' : 'Start'}</Button>
                                            {!ext.isBuiltin && <Button size="sm" variant="ghost" onClick={() => api.uninstall(ext)}>Uninstall</Button>}
                                        </div>
                                    </li>
                                )
                            })}
                        </ul>
                    )
            ) : (
                <>
                    {view === 'marketplace' && !q && <p className="ext-heading">Popular</p>}
                    {api.searching ? <div className="ext-empty"><Spinner label="Searching" /></div>
                        : gallery.length === 0 ? (
                            <EmptyState compact title={view === 'recommended' ? 'No recommendations yet' : q ? `Nothing found for “${query.trim()}”` : 'The marketplace is unavailable'}
                                description={view === 'recommended' ? 'Recommendations appear as you install extensions.' : undefined} />
                        ) : <ul className="ext-list">{gallery.map(galleryRow)}</ul>}
                </>
            )}
        </div>
    )
}

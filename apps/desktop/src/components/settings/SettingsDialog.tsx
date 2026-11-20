/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Cpu, Gauge, Info, Network, Palette, ShieldCheck, TriangleAlert, Users } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { Dialog, RegionBoundary, SearchInput, Spinner } from '../ui'
import { GeneralSettings } from './GeneralSettings'
import { ModelsSettings } from './ModelsSettings'
import { SecuritySettings } from './SecuritySettings'
import { MembersSettings } from './MembersSettings'
import { NetworkSettings } from './NetworkSettings'
import { AdvancedSettings } from './AdvancedSettings'
import { AboutSettings } from './AboutSettings'
import './settings.css'

const PerformanceSettings = lazy(() => import('./PerformanceSettings'))

type PageId = 'general' | 'models' | 'security' | 'members' | 'network' | 'performance' | 'advanced' | 'about'

// Older code opens settings with these tab names.
const LEGACY: Record<string, PageId> = {
    agents: 'models',
    'models-local': 'models',
    'models-server': 'models',
    'models-cloud': 'models',
    credits: 'about',
    support: 'about'
}

interface Page {
    id: PageId
    label: string
    icon: ReactNode
    keywords: string[]
    needsWorkspace?: boolean
}

const PAGES: Page[] = [
    {
        id: 'general',
        label: 'General',
        icon: <Palette size={15} />,
        keywords: ['name', 'profile', 'appearance', 'theme', 'dark', 'light', 'system', 'editor', 'font', 'size', 'word wrap', 'minimap', 'sticky scroll', 'ai completions', 'ghost text']
    },
    {
        id: 'models',
        label: 'Models and keys',
        icon: <Cpu size={15} />,
        keywords: ['ai', 'llm', 'local model', 'download', 'ollama', 'lm studio', 'server', 'cloud', 'api key', 'openai', 'anthropic', 'claude', 'gemini']
    },
    {
        id: 'security',
        label: 'Security',
        icon: <ShieldCheck size={15} />,
        keywords: ['encryption', 'e2ee', 'room password', 'github', 'token', 'keychain', 'safe storage']
    },
    {
        id: 'members',
        label: 'Members',
        icon: <Users size={15} />,
        keywords: ['team', 'collaborators', 'roles', 'permissions', 'invite', 'kick', 'ban'],
        needsWorkspace: true
    },
    {
        id: 'network',
        label: 'Network',
        icon: <Network size={15} />,
        keywords: ['p2p', 'webrtc', 'turn', 'stun', 'signaling', 'relay', 'peers']
    },
    {
        id: 'performance',
        label: 'Performance',
        icon: <Gauge size={15} />,
        keywords: ['memory', 'ram', 'cpu', 'gpu', 'gc', 'benchmark', 'acceleration', 'diagnostics', 'aime']
    },
    {
        id: 'advanced',
        label: 'Advanced',
        icon: <TriangleAlert size={15} />,
        keywords: ['reset', 'storage', 'logs', 'developer', 'cache', 'danger']
    },
    {
        id: 'about',
        label: 'About',
        icon: <Info size={15} />,
        keywords: ['version', 'update', 'license', 'github', 'support', 'credits']
    }
]

function resolveRequestedPage(settingsTab: string | null, pages: Page[]): PageId | null {
    if (!settingsTab) return null
    const mapped = (LEGACY[settingsTab] ?? settingsTab) as PageId
    return pages.some(p => p.id === mapped) ? mapped : null
}

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
    const currentSpace = useAppStore(s => s.currentSpace)
    const settingsTab = useAppStore(s => s.settingsTab)
    const setSettingsTab = useAppStore(s => s.setSettingsTab)
    const pages = useMemo(() => PAGES.filter(p => !p.needsWorkspace || currentSpace), [currentSpace])

    const [page, setPage] = useState<PageId>(() => resolveRequestedPage(settingsTab, pages) ?? 'general')
    const [filter, setFilter] = useState('')

    // Sync active page whenever settingsTab updates while the dialog is already open.
    useEffect(() => {
        const next = resolveRequestedPage(settingsTab, pages)
        if (next) setPage(next)
    }, [settingsTab, pages])

    // Fall back to General if the active page requires a workspace that was closed.
    useEffect(() => {
        if (!pages.some(p => p.id === page)) setPage('general')
    }, [pages, page])

    const filteredPages = useMemo(() => {
        const q = filter.trim().toLowerCase()
        if (!q) return pages.map(p => ({ page: p, matchedKeyword: null as string | null }))
        return pages
            .map(p => {
                if (p.label.toLowerCase().includes(q)) return { page: p, matchedKeyword: null as string | null }
                const kw = p.keywords.find(k => k.includes(q))
                return kw ? { page: p, matchedKeyword: kw } : null
            })
            .filter((entry): entry is { page: Page; matchedKeyword: string | null } => entry !== null)
    }, [pages, filter])

    const close = () => {
        setSettingsTab(null)
        onClose()
    }

    return (
        <Dialog open size="xl" bare title="Settings" description={currentSpace ? `Workspace settings apply to ${currentSpace.name}.` : undefined} onClose={close}>
            <div className="settings">
                <nav className="settings__nav" aria-label="Settings sections">
                    <div className="settings__nav-search">
                        <SearchInput
                            size="sm"
                            value={filter}
                            onChange={setFilter}
                            placeholder="Filter settings…"
                            aria-label="Filter settings sections"
                            onKeyDown={e => {
                                if (e.key === 'Enter' && filteredPages.length > 0) {
                                    e.preventDefault()
                                    setPage(filteredPages[0].page.id)
                                }
                            }}
                        />
                    </div>
                    <div className="settings__nav-list">
                        {filteredPages.map(({ page: p, matchedKeyword }) => (
                            <button
                                key={p.id}
                                type="button"
                                className={`settings__nav-item ${page === p.id ? 'is-active' : ''}`}
                                aria-current={page === p.id ? 'page' : undefined}
                                title={p.label}
                                onClick={() => setPage(p.id)}
                            >
                                <span className="settings__nav-icon" aria-hidden>{p.icon}</span>
                                <span className="settings__nav-text">
                                    <span className="settings__nav-label">{p.label}</span>
                                    {matchedKeyword && <span className="settings__nav-hint">{matchedKeyword}</span>}
                                </span>
                            </button>
                        ))}
                        {filteredPages.length === 0 && (
                            <p className="settings__nav-empty">No settings match “{filter}”.</p>
                        )}
                    </div>
                </nav>
                <div className="settings__content">
                    <RegionBoundary name={pages.find(p => p.id === page)?.label ?? 'Settings'} key={page}>
                        {page === 'general' && <GeneralSettings />}
                        {page === 'models' && <ModelsSettings />}
                        {page === 'security' && <SecuritySettings />}
                        {page === 'members' && <MembersSettings onClose={close} />}
                        {page === 'network' && <NetworkSettings />}
                        {page === 'performance' && (
                            <Suspense fallback={<div className="settings__loading"><Spinner label="Loading" /></div>}>
                                <PerformanceSettings />
                            </Suspense>
                        )}
                        {page === 'advanced' && <AdvancedSettings />}
                        {page === 'about' && <AboutSettings />}
                    </RegionBoundary>
                </div>
            </div>
        </Dialog>
    )
}

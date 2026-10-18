/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { Cpu, Gauge, Info, Network, Palette, ShieldCheck, TriangleAlert, Users } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { Dialog, RegionBoundary, Spinner } from '../ui'
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
const LEGACY: Record<string, PageId> = { agents: 'models', credits: 'about', support: 'about' }

interface Page {
    id: PageId
    label: string
    icon: ReactNode
    needsWorkspace?: boolean
}

const PAGES: Page[] = [
    { id: 'general', label: 'General', icon: <Palette size={15} /> },
    { id: 'models', label: 'Models and keys', icon: <Cpu size={15} /> },
    { id: 'security', label: 'Security', icon: <ShieldCheck size={15} /> },
    { id: 'members', label: 'Members', icon: <Users size={15} />, needsWorkspace: true },
    { id: 'network', label: 'Network', icon: <Network size={15} /> },
    { id: 'performance', label: 'Performance', icon: <Gauge size={15} /> },
    { id: 'advanced', label: 'Advanced', icon: <TriangleAlert size={15} /> },
    { id: 'about', label: 'About', icon: <Info size={15} /> }
]

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
    const currentSpace = useAppStore(s => s.currentSpace)
    const settingsTab = useAppStore(s => s.settingsTab)
    const setSettingsTab = useAppStore(s => s.setSettingsTab)
    const pages = useMemo(() => PAGES.filter(p => !p.needsWorkspace || currentSpace), [currentSpace])

    const [page, setPage] = useState<PageId>(() => {
        const requested = (settingsTab && (LEGACY[settingsTab] ?? settingsTab)) as PageId | null
        return requested && pages.some(p => p.id === requested) ? requested : 'general'
    })

    const close = () => {
        setSettingsTab(null)
        onClose()
    }

    return (
        <Dialog open size="xl" bare title="Settings" description={currentSpace ? `Workspace settings apply to ${currentSpace.name}.` : undefined} onClose={close}>
            <div className="settings">
                <nav className="settings__nav" aria-label="Settings sections">
                    {pages.map(p => (
                        <button
                            key={p.id}
                            type="button"
                            className={`settings__nav-item ${page === p.id ? 'is-active' : ''}`}
                            aria-current={page === p.id ? 'page' : undefined}
                            onClick={() => setPage(p.id)}
                        >
                            <span aria-hidden>{p.icon}</span>
                            {p.label}
                        </button>
                    ))}
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

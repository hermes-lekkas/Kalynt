/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect } from 'react'
import { Bug, Files, GitBranch, ListTree, PanelBottom, PanelRight, Search } from 'lucide-react'
import { useLayoutStore, type SidePanel } from '../../stores/layoutStore'
import { formatShortcut } from '../../stores/commandStore'
import { IconButton } from '../ui'
import { useActiveRunnerStore } from './hooks/useRunner'

const PANELS: Array<{ id: SidePanel; label: string; shortcut: string; Icon: typeof Files }> = [
    { id: 'files', label: 'Explorer', shortcut: 'Ctrl+Shift+E', Icon: Files },
    { id: 'search', label: 'Search', shortcut: 'Ctrl+Shift+F', Icon: Search },
    { id: 'git', label: 'Source control', shortcut: 'Ctrl+Shift+G', Icon: GitBranch },
    { id: 'debug', label: 'Run & Debug', shortcut: 'Ctrl+Shift+D', Icon: Bug },
    { id: 'outline', label: 'Outline', shortcut: 'Ctrl+Shift+O', Icon: ListTree }
]

export interface ActivityBarProps {
    gitChanges: number
    debugActive?: boolean
}

export function ActivityBar({ gitChanges, debugActive }: ActivityBarProps) {
    const { sidebarOpen, sidePanel, toggleSidePanel, showSidePanel, bottomOpen, setBottomOpen, rightOpen, setRightOpen } = useLayoutStore()
    const runner = useActiveRunnerStore(s => s.runner)

    const isDebugging = debugActive ?? runner?.isDebugging ?? false
    let breakpointCount = 0
    if (runner) {
        runner.breakpoints.forEach(lines => { breakpointCount += lines.length })
    }

    useEffect(() => {
        const onOpenOutline = () => showSidePanel('outline')
        const onOpenDebug = () => showSidePanel('debug')
        window.addEventListener('kalynt-open-outline', onOpenOutline)
        window.addEventListener('kalynt-open-debug', onOpenDebug)
        return () => {
            window.removeEventListener('kalynt-open-outline', onOpenOutline)
            window.removeEventListener('kalynt-open-debug', onOpenDebug)
        }
    }, [showSidePanel])

    return (
        <nav className="activity-bar" aria-label="Side bar views">
            <div className="activity-bar__group">
                {PANELS.map(({ id, label, shortcut, Icon }) => (
                    <IconButton
                        key={id}
                        className="activity-bar__btn"
                        label={label}
                        shortcut={formatShortcut(shortcut)}
                        icon={<Icon size={18} strokeWidth={1.6} />}
                        active={sidebarOpen && sidePanel === id}
                        tone={id === 'debug' && isDebugging ? 'danger' : 'default'}
                        badge={id === 'git' ? gitChanges : id === 'debug' && breakpointCount > 0 ? breakpointCount : undefined}
                        onClick={() => toggleSidePanel(id)}
                    />
                ))}
            </div>
            <div className="activity-bar__group">
                <IconButton
                    className="activity-bar__btn"
                    label={bottomOpen ? 'Hide terminal panel' : 'Show terminal panel'}
                    shortcut={formatShortcut('Ctrl+`')}
                    icon={<PanelBottom size={18} strokeWidth={1.6} />}
                    active={bottomOpen}
                    onClick={() => setBottomOpen(!bottomOpen)}
                />
                <IconButton
                    className="activity-bar__btn"
                    label={rightOpen ? 'Hide agent panel' : 'Show agent panel'}
                    shortcut={formatShortcut('Ctrl+Shift+A')}
                    icon={<PanelRight size={18} strokeWidth={1.6} />}
                    active={rightOpen}
                    onClick={() => setRightOpen(!rightOpen)}
                />
            </div>
        </nav>
    )
}

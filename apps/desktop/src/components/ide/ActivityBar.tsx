/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Files, GitBranch, PanelBottom, PanelRight, Search } from 'lucide-react'
import { useLayoutStore, type SidePanel } from '../../stores/layoutStore'
import { formatShortcut } from '../../stores/commandStore'
import { IconButton } from '../ui'

const PANELS: Array<{ id: SidePanel; label: string; shortcut: string; Icon: typeof Files }> = [
    { id: 'files', label: 'Explorer', shortcut: 'Ctrl+Shift+E', Icon: Files },
    { id: 'search', label: 'Search', shortcut: 'Ctrl+Shift+F', Icon: Search },
    { id: 'git', label: 'Source control', shortcut: 'Ctrl+Shift+G', Icon: GitBranch }
]

export function ActivityBar({ gitChanges }: { gitChanges: number }) {
    const { sidebarOpen, sidePanel, toggleSidePanel, bottomOpen, setBottomOpen, rightOpen, setRightOpen } = useLayoutStore()

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
                        badge={id === 'git' ? gitChanges : undefined}
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

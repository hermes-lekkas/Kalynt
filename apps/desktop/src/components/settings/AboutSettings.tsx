/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useAppStore } from '../../stores/appStore'
import { useUpdateStore } from '../../stores/updateStore'
import { Button } from '../ui'
import { SettingRow, SettingsPage, SettingsSection } from './parts'

const REPO = 'https://github.com/trisle-app/Kalynt'
const SUPPORT = 'hermeslekkasdev@gmail.com'

const BUILT_WITH: Array<[string, string]> = [
    ['Electron', 'Desktop runtime'], ['React', 'Interface'], ['Monaco Editor', 'Code editor'], ['xterm.js', 'Terminal'],
    ['Yjs', 'Peer-to-peer sync'], ['node-llama-cpp', 'Local models'], ['Zustand', 'State'], ['Lucide', 'Icons'],
    ['Instrument Sans', 'Interface type'], ['JetBrains Mono', 'Code type']
]

const open = (url: string) => window.electronAPI?.shell?.openExternal?.(url)

export function AboutSettings() {
    const version = useAppStore(s => s.version)
    const { status, updateInfo, checkForUpdates, setShowUpdateModal, lastChecked } = useUpdateStore()

    const updateText = status === 'checking' ? 'Checking for updates…'
        : status === 'available' ? `Version ${updateInfo?.version} is available.`
            : status === 'downloading' ? 'Downloading the update…'
                : status === 'downloaded' ? 'An update is ready to install.'
                    : status === 'not-available' ? 'You have the latest version.'
                        : status === 'error' ? 'The last update check failed.'
                            : lastChecked ? `Last checked ${new Date(lastChecked).toLocaleString()}.` : 'Updates are checked automatically.'

    return (
        <SettingsPage title="About Kalynt" description="A local-first, AI-native code editor with peer-to-peer collaboration.">
            <SettingsSection title="Version">
                <SettingRow
                    label={version}
                    description={updateText}
                    control={['available', 'downloaded', 'downloading', 'error'].includes(status)
                        ? <Button size="sm" variant="primary" onClick={() => setShowUpdateModal(true)}>View update</Button>
                        : <Button size="sm" loading={status === 'checking'} onClick={() => checkForUpdates()}>Check for updates</Button>}
                />
            </SettingsSection>
            <SettingsSection title="Help">
                <SettingRow label="Report a problem or ask a question" description="Issues and discussions on GitHub." control={<Button size="sm" onClick={() => open(`${REPO}/issues`)}>Open GitHub</Button>} />
                <SettingRow label="Email support" description={SUPPORT} control={<Button size="sm" onClick={() => open(`mailto:${SUPPORT}`)}>Write an email</Button>} />
            </SettingsSection>
            <SettingsSection title="Built with" description="Kalynt stands on these open-source projects.">
                <dl className="credits">
                    {BUILT_WITH.map(([name, role]) => (
                        <div key={name}><dt>{name}</dt><dd>{role}</dd></div>
                    ))}
                </dl>
            </SettingsSection>
            <p className="set-note">Released under the GNU Affero General Public License v3.0. © 2026 Hermes Lekkas.</p>
        </SettingsPage>
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useUiStore } from '../../stores/uiStore'
import { Dialog, RegionBoundary, Tabs } from '../ui'
import { RuntimesTab } from './RuntimesTab'
import { ExtensionsTab } from './ExtensionsTab'
import './extensions.css'

export default function ExtensionsDialog() {
    const { extensionsTab, closeExtensions, openExtensions } = useUiStore()

    return (
        <Dialog
            open
            size="lg"
            bare
            title="Extensions and runtimes"
            description="Install languages so the editor can run your code, and add VS Code extensions."
            onClose={closeExtensions}
        >
            <div className="ext">
                <div className="ext__tabs">
                    <Tabs
                        ariaLabel="Extensions"
                        value={extensionsTab}
                        onChange={tab => openExtensions(tab)}
                        items={[{ id: 'runtimes', label: 'Language runtimes' }, { id: 'extensions', label: 'VS Code extensions' }]}
                    />
                </div>
                <RegionBoundary name="Extensions" key={extensionsTab}>
                    {extensionsTab === 'runtimes' ? <RuntimesTab /> : <ExtensionsTab />}
                </RegionBoundary>
            </div>
        </Dialog>
    )
}

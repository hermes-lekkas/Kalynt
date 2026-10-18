/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { FolderOpen } from 'lucide-react'
import { formatShortcut } from '../../../stores/commandStore'
import { useUiStore } from '../../../stores/uiStore'
import { Button, Kbd } from '../../ui'
import { LOGO_URL } from '../../shell/brand'

const SHORTCUTS: Array<[string, string]> = [
    ['Go to file', 'Ctrl+P'],
    ['Run a command', 'Ctrl+Shift+P'],
    ['Search in files', 'Ctrl+Shift+F'],
    ['Ask the agent', 'Ctrl+L'],
    ['Show terminal', 'Ctrl+`']
]

interface EditorEmptyProps {
    hasFolder: boolean
    onOpenFolder: () => void
}

export function EditorEmpty({ hasFolder, onOpenFolder }: EditorEmptyProps) {
    const openPalette = useUiStore(s => s.openPalette)

    if (!hasFolder) {
        return (
            <div className="editor-empty">
                <img src={LOGO_URL} alt="" width={44} height={44} className="editor-empty__mark" />
                <h2 className="editor-empty__title">Open a folder to start</h2>
                <p className="editor-empty__text">
                    The explorer, search, source control, terminal and agent all work inside the folder you choose.
                </p>
                <Button variant="primary" icon={<FolderOpen size={15} />} onClick={onOpenFolder}>Open folder</Button>
            </div>
        )
    }

    return (
        <div className="editor-empty">
            <img src={LOGO_URL} alt="" width={44} height={44} className="editor-empty__mark" />
            <h2 className="editor-empty__title">No file is open</h2>
            <p className="editor-empty__text">Pick a file in the explorer, or use one of these.</p>
            <dl className="editor-empty__keys">
                {SHORTCUTS.map(([label, keys]) => (
                    <div key={label}>
                        <dt>{label}</dt>
                        <dd><Kbd>{formatShortcut(keys)}</Kbd></dd>
                    </div>
                ))}
            </dl>
            <button type="button" className="editor-empty__link" onClick={() => openPalette('files')}>Find a file</button>
        </div>
    )
}

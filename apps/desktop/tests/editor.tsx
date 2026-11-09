/* SPDX-License-Identifier: AGPL-3.0-only
 * Dev-server-only fixture. Uses production editor components with disposable
 * virtual files; never reads the user's project or calls external AI services.
 */
import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/electronShim'
import '../src/styles/tokens.css'
import '../src/styles/base.css'
import '../src/components/ide/ide.css'
import { EditorArea } from '../src/components/ide/editor/EditorArea'
import { useOpenFiles } from '../src/components/ide/hooks/useOpenFiles'
import { useRunner } from '../src/components/ide/hooks/useRunner'
import { useIdeShortcuts } from '../src/components/ide/hooks/useIdeShortcuts'
import { useWorkspaceFolderStore } from '../src/stores/workspaceFolderStore'
import type { editor } from 'monaco-editor'

document.documentElement.dataset.theme = 'dark'
const STORAGE = 'kalynt-editor-fixture-files'
const initial: Record<string, string> = { '/fixture-a/app.ts': 'export const answer = 42;\n', '/fixture-b/app.ts': 'export const second = true;\n' }
let files: Record<string, string>
try { files = JSON.parse(localStorage.getItem(STORAGE) ?? 'null') ?? initial } catch { files = initial }
const api = window.electronAPI
api.fileExists = async path => Object.hasOwn(files, path)
api.fs = {
    readFile: async (path: string) => Object.hasOwn(files, path) ? { success: true, content: files[path] } : { success: false, error: 'ENOENT' },
    readDir: async () => ({ success: false }),
    stat: async (path: string) => ({ success: Object.hasOwn(files, path), isFile: true, isDirectory: false, size: files[path]?.length }),
    writeFile: async ({ path, content, expectedContent }: { path: string; content: string; expectedContent?: string }) => {
        if (expectedContent !== undefined && expectedContent !== files[path]) return { success: false, conflict: true }
        files[path] = content
        localStorage.setItem(STORAGE, JSON.stringify(files))
        return { success: true }
    },
    watchDir: async () => ({ success: true }), unwatchDir: async () => ({ success: true }), onChange: () => () => {}
}
for (const id of ['a', 'b']) {
    if (!useWorkspaceFolderStore.getState().records[`fixture-${id}`]) useWorkspaceFolderStore.getState().setFolder(`fixture-${id}`, `/fixture-${id}`)
}
function Fixture() {
    const [id, setId] = useState('a')
    const [saved, setSaved] = useState('')
    const folder = `/fixture-${id}`
    const model = useRef<editor.IStandaloneCodeEditor | null>(null)
    const open = useOpenFiles({ spaceId: `fixture-${id}`, folder, onRevealDirectory() {}, onDisposeModel() {} })
    const runner = useRunner({ folder, activeFile: open.activeFile, saveFile: open.saveFile })
    const runEditorAction = (action: string) => { model.current?.getAction(action)?.run() }
    useIdeShortcuts(true, { files: open, runner, folder, newFile() {}, openFolder() {}, closeFolder() {}, runEditorAction, gitPush() {}, gitPull() {} })
    return <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <header style={{ padding: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
            <strong>Editor integration fixture — virtual files only</strong>
            <button onClick={() => setId('a')}>Workspace A</button>
            <button onClick={() => setId('b')}>Workspace B</button>
            <button onClick={() => open.openFile(`${folder}/app.ts`)}>Open app.ts</button>
            <button onClick={async () => setSaved(await open.saveFile() ? 'Saved' : 'Not saved')}>Save file</button>
            <output aria-label="Save result">{saved}</output>
            <span>{open.activeFile?.isDirty ? 'Unsaved changes' : 'No unsaved changes'}</span>
        </header>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <EditorArea files={open} runner={runner} folder={folder} canEdit onOpenFolder={() => {}} onRevealDirectory={() => {}} onRevealFile={() => {}} onActivateEditor={ed => { model.current = ed }} runEditorAction={runEditorAction} />
        </div>
    </main>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>)

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import {
    ArrowDownToLine, ArrowUpFromLine, Bug, Columns2, Hammer, MoreHorizontal,
    Pause, Play, Square, StepForward
} from 'lucide-react'
import { useLayoutStore } from '../../../stores/layoutStore'
import { formatShortcut } from '../../../stores/commandStore'
import { IconButton, Menu, useMenuAnchor } from '../../ui'
import type { RunnerApi } from '../hooks/useRunner'
import { languageLabel } from '../languages'

interface EditorToolbarProps {
    runner: RunnerApi
    language: string | null
    hasFolder: boolean
    canSplit: boolean
    runEditorAction: (actionId: string) => void
}

export function EditorToolbar({ runner, language, hasFolder, canSplit, runEditorAction }: EditorToolbarProps) {
    const layout = useLayoutStore()
    const more = useMenuAnchor()
    const sc = formatShortcut

    return (
        <div className="editor-toolbar" role="toolbar" aria-label="Editor actions">
            {runner.isDebugging ? (
                <div className="editor-toolbar__debug" role="group" aria-label="Debugger">
                    <IconButton size="sm" label="Continue" shortcut="F5" icon={<Play size={14} />} onClick={() => runner.debugStep('continue')} />
                    <IconButton size="sm" label="Pause" shortcut="F6" icon={<Pause size={14} />} onClick={() => runner.debugStep('pause')} />
                    <IconButton size="sm" label="Step over" shortcut="F10" icon={<StepForward size={14} />} onClick={() => runner.debugStep('stepOver')} />
                    <IconButton size="sm" label="Step into" shortcut="F11" icon={<ArrowDownToLine size={14} />} onClick={() => runner.debugStep('stepInto')} />
                    <IconButton size="sm" label="Step out" shortcut="Shift+F11" icon={<ArrowUpFromLine size={14} />} onClick={() => runner.debugStep('stepOut')} />
                    <IconButton size="sm" tone="danger" label="Stop debugging" shortcut="Shift+F5" icon={<Square size={13} />} onClick={() => runner.stopDebug()} />
                </div>
            ) : (
                <>
                    {runner.isRunning ? (
                        <button type="button" className="editor-toolbar__run is-running" onClick={runner.stopRun} title={`Stop (${sc('F5')})`}>
                            <Square size={12} aria-hidden /> Stop
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="editor-toolbar__run"
                            onClick={() => runner.run()}
                            disabled={!runner.canRun}
                            title={runner.canRun ? `Run this file (${sc('F5')})` : `Running ${languageLabel(language) || 'this file'} isn't supported`}
                        >
                            <Play size={12} aria-hidden /> Run
                        </button>
                    )}
                    <IconButton size="sm" label="Debug this file" shortcut="F9" icon={<Bug size={14} />} onClick={() => runner.startDebug()} disabled={!language || !hasFolder} />
                </>
            )}
            <IconButton
                size="sm"
                label={runner.isBuilding ? 'Stop build' : 'Build project'}
                shortcut={sc('Ctrl+Shift+B')}
                icon={runner.isBuilding ? <Square size={13} /> : <Hammer size={14} />}
                tone={runner.isBuilding ? 'danger' : 'default'}
                onClick={() => (runner.isBuilding ? runner.stopBuild() : runner.build())}
                disabled={!hasFolder}
            />
            <span className="editor-toolbar__sep" aria-hidden />
            <IconButton
                size="sm"
                label={layout.splitEditor ? 'Close split' : 'Split editor'}
                shortcut={sc('Ctrl+\\')}
                icon={<Columns2 size={14} />}
                active={layout.splitEditor}
                disabled={!canSplit && !layout.splitEditor}
                onClick={() => layout.setEditorPref({ splitEditor: !layout.splitEditor })}
            />
            <IconButton size="sm" label="More editor options" icon={<MoreHorizontal size={15} />} onClick={more.toggle} aria-haspopup="menu" aria-expanded={more.open} />
            <Menu
                open={more.open}
                anchor={more.anchor}
                onClose={more.close}
                placement="bottom-end"
                width={240}
                items={[
                    { label: 'Format document', shortcut: sc('Shift+Alt+F'), onSelect: () => runEditorAction('editor.action.formatDocument') },
                    { label: 'Go to line…', shortcut: sc('Ctrl+G'), onSelect: () => runEditorAction('editor.action.gotoLine') },
                    { label: 'Find in file', shortcut: sc('Ctrl+F'), onSelect: () => runEditorAction('actions.find') },
                    'separator',
                    { label: 'Word wrap', shortcut: sc('Alt+Z'), checked: layout.wordWrap, onSelect: () => layout.setEditorPref({ wordWrap: !layout.wordWrap }) },
                    { label: 'Minimap', checked: layout.minimap, onSelect: () => layout.setEditorPref({ minimap: !layout.minimap }) },
                    { label: 'Sticky scroll', checked: layout.stickyScroll, onSelect: () => layout.setEditorPref({ stickyScroll: !layout.stickyScroll }) },
                    'separator',
                    { label: 'Larger text', onSelect: () => layout.setEditorPref({ editorFontSize: Math.min(24, layout.editorFontSize + 1) }) },
                    { label: 'Smaller text', onSelect: () => layout.setEditorPref({ editorFontSize: Math.max(10, layout.editorFontSize - 1) }) },
                    { label: 'Reset text size', hint: `${layout.editorFontSize}px now`, onSelect: () => layout.setEditorPref({ editorFontSize: 13 }) }
                ]}
            />
        </div>
    )
}

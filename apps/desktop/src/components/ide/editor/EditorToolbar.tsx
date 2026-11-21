/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import {
    ArrowDownToLine, ArrowUpFromLine, Bug, ChevronDown, Columns2, Hammer, MoreHorizontal,
    Pause, Play, Square, StepForward
} from 'lucide-react'
import { useLayoutStore } from '../../../stores/layoutStore'
import { formatShortcut } from '../../../stores/commandStore'
import { IconButton, Menu, useMenuAnchor } from '../../ui'
import type { RunnerApi } from '../hooks/useRunner'

interface EditorToolbarProps {
    runner: RunnerApi
    language: string | null
    hasFolder: boolean
    canSplit: boolean
    runEditorAction: (actionId: string) => void
}

export function EditorToolbar({ runner, language, hasFolder, canSplit, runEditorAction }: EditorToolbarProps) {
    const splitEditor = useLayoutStore(s => s.splitEditor)
    const wordWrap = useLayoutStore(s => s.wordWrap)
    const minimap = useLayoutStore(s => s.minimap)
    const stickyScroll = useLayoutStore(s => s.stickyScroll)
    const formatOnSave = useLayoutStore(s => s.formatOnSave)
    const editorFontSize = useLayoutStore(s => s.editorFontSize)
    const setEditorPref = useLayoutStore(s => s.setEditorPref)

    const more = useMenuAnchor()
    const runMenu = useMenuAnchor()
    const sc = formatShortcut

    const showFullRunControls = runner.canRun || runner.isRunning || runner.isBuilding

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
            ) : showFullRunControls ? (
                <>
                    {runner.isRunning ? (
                        <button type="button" className="editor-toolbar__run is-running" onClick={runner.stopRun} title={`Stop (${sc('Ctrl+F5')})`}>
                            <Square size={12} aria-hidden /> Stop
                        </button>
                    ) : runner.canRun ? (
                        <button
                            type="button"
                            className="editor-toolbar__run"
                            onClick={() => runner.run()}
                            title={`Run this file (${sc('Ctrl+F5')})`}
                        >
                            <Play size={12} aria-hidden /> Run
                        </button>
                    ) : null}
                    {runner.canRun && (
                        <IconButton
                            size="sm"
                            label="Debug this file"
                            shortcut="F5"
                            icon={<Bug size={14} />}
                            onClick={() => runner.startDebug()}
                            disabled={!language || !hasFolder}
                        />
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
                </>
            ) : hasFolder ? (
                <>
                    <button
                        type="button"
                        className="editor-toolbar__menu-btn"
                        onClick={runMenu.toggle}
                        aria-haspopup="menu"
                        aria-expanded={runMenu.open}
                        title="Run and build actions"
                    >
                        <Play size={12} aria-hidden />
                        <ChevronDown size={12} aria-hidden />
                    </button>
                    <Menu
                        open={runMenu.open}
                        anchor={runMenu.anchor}
                        onClose={runMenu.close}
                        placement="bottom-end"
                        width={220}
                        ariaLabel="Run and build"
                        items={[
                            { label: 'Build project', icon: <Hammer size={14} />, shortcut: sc('Ctrl+Shift+B'), onSelect: () => { void runner.build() } },
                            { label: 'Debug this file', icon: <Bug size={14} />, shortcut: 'F5', disabled: !language, onSelect: () => { void runner.startDebug() } }
                        ]}
                    />
                    <span className="editor-toolbar__sep" aria-hidden />
                </>
            ) : null}

            <IconButton
                size="sm"
                label={splitEditor ? 'Close split' : 'Split editor'}
                shortcut={sc('Ctrl+\\')}
                icon={<Columns2 size={14} />}
                active={splitEditor}
                disabled={!canSplit && !splitEditor}
                onClick={() => setEditorPref({ splitEditor: !splitEditor })}
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
                    { label: 'Word wrap', shortcut: sc('Alt+Z'), checked: wordWrap, onSelect: () => setEditorPref({ wordWrap: !wordWrap }) },
                    { label: 'Minimap', checked: minimap, onSelect: () => setEditorPref({ minimap: !minimap }) },
                    { label: 'Sticky scroll', checked: stickyScroll, onSelect: () => setEditorPref({ stickyScroll: !stickyScroll }) },
                    { label: 'Format on save', checked: formatOnSave, onSelect: () => setEditorPref({ formatOnSave: !formatOnSave }) },
                    'separator',
                    { label: 'Larger text', onSelect: () => setEditorPref({ editorFontSize: Math.min(24, editorFontSize + 1) }) },
                    { label: 'Smaller text', onSelect: () => setEditorPref({ editorFontSize: Math.max(10, editorFontSize - 1) }) },
                    { label: 'Reset text size', hint: `${editorFontSize}px now`, onSelect: () => setEditorPref({ editorFontSize: 13 }) }
                ]}
            />
        </div>
    )
}

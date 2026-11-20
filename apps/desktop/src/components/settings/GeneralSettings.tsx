/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useRef, useState } from 'react'
import { Monitor, Moon, RotateCcw, Sun } from 'lucide-react'
import { useAppStore, type ThemePreference } from '../../stores/appStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { Button, Select, Switch, TextInput } from '../ui'
import { inlineCompletionsEnabled, setInlineCompletionsEnabled } from '../ide/editor/inlineCompletionsPref'
import { SavedNote, SettingRow, SettingsPage, SettingsSection } from './parts'
import { pickProvider } from '../../services/aiService'
import { providerInfo } from '../../types/aiProviders'

const EDITOR_DEFAULTS = {
    editorFontSize: 13,
    wordWrap: true,
    minimap: false,
    stickyScroll: true
} as const

export function GeneralSettings() {
    const userName = useAppStore(s => s.userName)
    const setUserName = useAppStore(s => s.setUserName)
    const theme = useAppStore(s => s.theme)
    const resolvedTheme = useAppStore(s => s.resolvedTheme)
    const setTheme = useAppStore(s => s.setTheme)
    const apiKeys = useAppStore(s => s.apiKeys)

    const editorFontSize = useLayoutStore(s => s.editorFontSize)
    const wordWrap = useLayoutStore(s => s.wordWrap)
    const minimap = useLayoutStore(s => s.minimap)
    const stickyScroll = useLayoutStore(s => s.stickyScroll)
    const setEditorPref = useLayoutStore(s => s.setEditorPref)

    const [name, setName] = useState(userName === 'Local User' ? '' : userName)
    const [saved, setSaved] = useState(false)
    const [completions, setCompletions] = useState(inlineCompletionsEnabled)
    const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const completionProvider = pickProvider(apiKeys)
    const canComplete = !!completionProvider

    useEffect(() => {
        setName(userName === 'Local User' ? '' : userName)
    }, [userName])

    useEffect(() => () => {
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    }, [])

    const saveName = () => {
        const next = name.trim()
        if (!next || next === userName) return
        setUserName(next)
        setSaved(true)
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
        savedTimerRef.current = setTimeout(() => setSaved(false), 1800)
    }

    const editorCustomized = editorFontSize !== EDITOR_DEFAULTS.editorFontSize
        || wordWrap !== EDITOR_DEFAULTS.wordWrap
        || minimap !== EDITOR_DEFAULTS.minimap
        || stickyScroll !== EDITOR_DEFAULTS.stickyScroll

    const themeChoices: ReadonlyArray<{ id: ThemePreference; label: string; icon: JSX.Element }> = [
        { id: 'dark', label: 'Dark', icon: <Moon size={14} /> },
        { id: 'light', label: 'Light', icon: <Sun size={14} /> },
        { id: 'system', label: 'System', icon: <Monitor size={14} /> }
    ]

    return (
        <SettingsPage title="General">
            <SettingsSection title="Your name" description="Shown to people you collaborate with, in team chat and on their cursors.">
                <div className="set-inline">
                    <TextInput
                        value={name}
                        placeholder="e.g. Alex Morgan"
                        aria-label="Display name"
                        onChange={e => setName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveName() }}
                    />
                    <Button onClick={saveName} disabled={!name.trim() || name.trim() === userName}>Save name</Button>
                    <SavedNote show={saved} />
                </div>
            </SettingsSection>

            <SettingsSection
                title="Appearance"
                description={theme === 'system' ? `Following your operating system (${resolvedTheme === 'light' ? 'Light' : 'Dark'}).` : undefined}
            >
                <div className="theme-choice" role="radiogroup" aria-label="Theme">
                    {themeChoices.map(({ id, label, icon }) => (
                        <button
                            key={id}
                            type="button"
                            role="radio"
                            aria-checked={theme === id}
                            className={`theme-choice__card ${theme === id ? 'is-selected' : ''}`}
                            onClick={() => setTheme(id)}
                        >
                            <span className={`theme-choice__preview theme-choice__preview--${id}`} aria-hidden>
                                <span /><span /><span />
                            </span>
                            <span className="theme-choice__label">{icon}{label}</span>
                        </button>
                    ))}
                </div>
            </SettingsSection>

            <SettingsSection
                title="Editor"
                description="Applied immediately across open files."
                actions={editorCustomized ? (
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<RotateCcw size={13} />}
                        onClick={() => setEditorPref({ ...EDITOR_DEFAULTS })}
                    >
                        Reset defaults
                    </Button>
                ) : undefined}
            >
                <SettingRow
                    label="Font size"
                    description="Controls code font size and line height in the editor."
                    htmlFor="set-font-size"
                    control={
                        <Select id="set-font-size" size="sm" value={editorFontSize} onChange={e => setEditorPref({ editorFontSize: Number(e.target.value) })}>
                            {[11, 12, 13, 14, 15, 16, 18, 20].map(n => <option key={n} value={n}>{n} px</option>)}
                        </Select>
                    }
                />
                <SettingRow
                    label="Wrap long lines"
                    description="Soft-wrap lines that exceed the editor viewport width."
                    control={<Switch label="Wrap long lines" checked={wordWrap} onChange={v => setEditorPref({ wordWrap: v })} />}
                />
                <SettingRow
                    label="Show minimap"
                    description="Render a condensed overview of the file along the right edge."
                    control={<Switch label="Show minimap" checked={minimap} onChange={v => setEditorPref({ minimap: v })} />}
                />
                <SettingRow
                    label="Sticky scroll"
                    description="Keeps the enclosing function or class visible at the top while you scroll."
                    control={<Switch label="Sticky scroll" checked={stickyScroll} onChange={v => setEditorPref({ stickyScroll: v })} />}
                />
            </SettingsSection>

            <SettingsSection title="AI completions">
                <SettingRow
                    label="Suggest code as you type"
                    description={completionProvider
                        ? `Shows inline suggestions. Context around your cursor is sent to ${completionProvider === 'local-server' ? 'the local server selected for the agent' : providerInfo(completionProvider).label} when you pause.`
                        : 'Choose a cloud model or local server in the agent menu first. Built-in local model completions are not available.'}
                    control={
                        <Switch
                            label="Suggest code as you type"
                            checked={completions && canComplete}
                            disabled={!canComplete}
                            onChange={v => { setCompletions(v); setInlineCompletionsEnabled(v) }}
                        />
                    }
                />
            </SettingsSection>
        </SettingsPage>
    )
}

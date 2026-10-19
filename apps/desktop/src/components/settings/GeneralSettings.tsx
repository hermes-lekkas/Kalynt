/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { Button, Select, Switch, TextInput } from '../ui'
import { inlineCompletionsEnabled, setInlineCompletionsEnabled } from '../ide/editor/inlineCompletionsPref'
import { SavedNote, SettingRow, SettingsPage, SettingsSection } from './parts'

export function GeneralSettings() {
    const { userName, setUserName, theme, setTheme, apiKeys } = useAppStore()
    const layout = useLayoutStore()
    const [name, setName] = useState(userName === 'Local User' ? '' : userName)
    const [saved, setSaved] = useState(false)
    const [completions, setCompletions] = useState(inlineCompletionsEnabled)
    const hasCloudKey = Object.values(apiKeys).some(Boolean)

    const saveName = () => {
        const next = name.trim()
        if (!next || next === userName) return
        setUserName(next)
        setSaved(true)
        setTimeout(() => setSaved(false), 1800)
    }

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

            <SettingsSection title="Appearance">
                <div className="theme-choice" role="radiogroup" aria-label="Theme">
                    {([['dark', 'Dark', <Moon key="m" size={14} />], ['light', 'Light', <Sun key="s" size={14} />]] as const).map(([id, label, icon]) => (
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

            <SettingsSection title="Editor">
                <SettingRow
                    label="Text size"
                    htmlFor="set-font-size"
                    control={
                        <Select id="set-font-size" size="sm" value={layout.editorFontSize} onChange={e => layout.setEditorPref({ editorFontSize: Number(e.target.value) })}>
                            {[11, 12, 13, 14, 15, 16, 18, 20].map(n => <option key={n} value={n}>{n} px</option>)}
                        </Select>
                    }
                />
                <SettingRow label="Wrap long lines" control={<Switch label="Wrap long lines" checked={layout.wordWrap} onChange={v => layout.setEditorPref({ wordWrap: v })} />} />
                <SettingRow label="Show minimap" control={<Switch label="Show minimap" checked={layout.minimap} onChange={v => layout.setEditorPref({ minimap: v })} />} />
                <SettingRow
                    label="Sticky scroll"
                    description="Keeps the enclosing function or class visible at the top while you scroll."
                    control={<Switch label="Sticky scroll" checked={layout.stickyScroll} onChange={v => layout.setEditorPref({ stickyScroll: v })} />}
                />
            </SettingsSection>

            <SettingsSection title="AI completions">
                <SettingRow
                    label="Suggest code as you type"
                    description={hasCloudKey
                        ? 'Shows grey inline suggestions. The code above your cursor is sent to your first configured cloud provider each time you pause.'
                        : 'Needs a cloud API key. Add one under Models and keys.'}
                    control={
                        <Switch
                            label="Suggest code as you type"
                            checked={completions && hasCloudKey}
                            disabled={!hasCloudKey}
                            onChange={v => { setCompletions(v); setInlineCompletionsEnabled(v) }}
                        />
                    }
                />
            </SettingsSection>
        </SettingsPage>
    )
}

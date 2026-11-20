/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Lazy-loaded Monaco DiffEditor wrapper so DiffDialog does not pull Monaco into
 * the initial renderer bundle.
 */
import { useMemo } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { useAppStore } from '../../../stores/appStore'
import { useLayoutStore } from '../../../stores/layoutStore'
import { Spinner } from '../../ui'
import { EDITOR_THEMES } from '../editor/monacoSetup'

interface MonacoDiffViewProps {
    original: string
    modified: string
    language: string
    sideBySide: boolean
}

export default function MonacoDiffView({ original, modified, language, sideBySide }: MonacoDiffViewProps) {
    const theme = useAppStore(s => s.theme)
    const editorFontSize = useLayoutStore(s => s.editorFontSize)

    const options = useMemo(() => ({
        readOnly: true,
        originalEditable: false,
        renderSideBySide: sideBySide,
        automaticLayout: true,
        fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
        fontSize: editorFontSize,
        lineHeight: Math.round(editorFontSize * 1.55),
        fontLigatures: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderIndicators: true,
        ignoreTrimWhitespace: false,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        overviewRulerBorder: false
    }), [sideBySide, editorFontSize])

    return (
        <DiffEditor
            height="100%"
            width="100%"
            original={original}
            modified={modified}
            language={language}
            theme={theme === 'light' ? EDITOR_THEMES.light : EDITOR_THEMES.dark}
            options={options}
            keepCurrentOriginalModel={false}
            keepCurrentModifiedModel={false}
            loading={<div className="git-diff-view__note"><Spinner label="Loading diff editor" /></div>}
        />
    )
}

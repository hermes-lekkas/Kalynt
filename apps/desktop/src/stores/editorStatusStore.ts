/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * High-frequency editor state (cursor, selection, EOL) kept out of the IDE tree
 * so moving the cursor only re-renders the status bar.
 */
import { create } from 'zustand'

export type LineEnding = 'LF' | 'CRLF'

interface EditorStatusState {
    line: number
    column: number
    selectionLength: number
    language: string | null
    eol: LineEnding
    activePath: string | null
    setCursor: (line: number, column: number, selectionLength: number) => void
    setLanguage: (language: string | null) => void
    setEol: (eol: LineEnding) => void
    setActivePath: (activePath: string | null) => void
    reset: () => void
}

export const useEditorStatusStore = create<EditorStatusState>(set => ({
    line: 1,
    column: 1,
    selectionLength: 0,
    language: null,
    eol: 'LF',
    activePath: null,
    setCursor: (line, column, selectionLength) => set({ line, column, selectionLength }),
    setLanguage: language => set({ language }),
    setEol: eol => set({ eol }),
    setActivePath: activePath => set({ activePath }),
    reset: () => set({ line: 1, column: 1, selectionLength: 0, language: null, eol: 'LF', activePath: null })
}))

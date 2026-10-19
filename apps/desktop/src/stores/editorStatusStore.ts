/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * High-frequency editor state (cursor, selection) kept out of the IDE tree so
 * moving the cursor only re-renders the status bar.
 */
import { create } from 'zustand'

interface EditorStatusState {
    line: number
    column: number
    selectionLength: number
    language: string | null
    setCursor: (line: number, column: number, selectionLength: number) => void
    setLanguage: (language: string | null) => void
    reset: () => void
}

export const useEditorStatusStore = create<EditorStatusState>(set => ({
    line: 1,
    column: 1,
    selectionLength: 0,
    language: null,
    setCursor: (line, column, selectionLength) => set({ line, column, selectionLength }),
    setLanguage: language => set({ language }),
    reset: () => set({ line: 1, column: 1, selectionLength: 0, language: null })
}))

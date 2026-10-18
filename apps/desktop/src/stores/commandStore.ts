/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Commands and files that the command palette can reach. Regions register
 * what they offer while they are mounted (the IDE registers its commands and
 * the indexed workspace files) so the palette stays decoupled from them.
 */
import { create } from 'zustand'
import type { FileItem, IDECommand } from '../types/ide'

interface CommandState {
    sources: Record<string, IDECommand[]>
    files: FileItem[]
    workspaceRoot: string | null
    openFile: ((path: string) => void) | null

    register: (source: string, commands: IDECommand[]) => void
    unregister: (source: string) => void
    setFiles: (files: FileItem[], root: string | null, openFile: ((path: string) => void) | null) => void
    clearFiles: () => void
}

export const useCommandStore = create<CommandState>(set => ({
    sources: {},
    files: [],
    workspaceRoot: null,
    openFile: null,

    register: (source, commands) => set(state => ({ sources: { ...state.sources, [source]: commands } })),
    unregister: source => set(state => {
        const sources = { ...state.sources }
        delete sources[source]
        return { sources }
    }),
    setFiles: (files, workspaceRoot, openFile) => set({ files, workspaceRoot, openFile }),
    clearFiles: () => set({ files: [], workspaceRoot: null, openFile: null })
}))

export function allCommands(sources: Record<string, IDECommand[]>): IDECommand[] {
    const seen = new Set<string>()
    const result: IDECommand[] = []
    for (const list of Object.values(sources)) {
        for (const command of list) {
            if (seen.has(command.id)) continue
            seen.add(command.id)
            result.push(command)
        }
    }
    return result
}

/** Formats a shortcut for the current platform ("Ctrl+S" → "⌘S" on macOS). */
export function formatShortcut(shortcut: string | undefined): string | undefined {
    if (!shortcut) return undefined
    const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin'
    if (!isMac) return shortcut
    return shortcut.replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧')
}

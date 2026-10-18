/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Remembers which folder each workspace opened, which files were open, and
 * when it was last used. Previously a single global folder was shared by
 * every workspace; each workspace now keeps its own.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

const LEGACY_FOLDER_KEY = 'kalynt-workspace-path'

interface WorkspaceRecord {
    folder: string | null
    openFiles: string[]
    activeFile: string | null
    lastOpened: number
}

interface WorkspaceFolderState {
    records: Record<string, WorkspaceRecord>
    getRecord: (spaceId: string) => WorkspaceRecord
    /** Moves the pre-upgrade global folder onto the first workspace opened afterwards. */
    adoptLegacyFolder: (spaceId: string) => void
    setFolder: (spaceId: string, folder: string | null) => void
    setOpenFiles: (spaceId: string, openFiles: string[], activeFile: string | null) => void
    touch: (spaceId: string) => void
    forget: (spaceId: string) => void
}

const EMPTY: WorkspaceRecord = { folder: null, openFiles: [], activeFile: null, lastOpened: 0 }

function readLegacyFolder(): string | null {
    try {
        return localStorage.getItem(LEGACY_FOLDER_KEY)
    } catch {
        return null
    }
}

export const useWorkspaceFolderStore = create<WorkspaceFolderState>()(
    persist(
        (set, get) => ({
            records: {},

            getRecord: spaceId => get().records[spaceId] ?? EMPTY,

            adoptLegacyFolder: spaceId => {
                if (get().records[spaceId]) return
                const legacy = readLegacyFolder()
                if (!legacy) return
                try { localStorage.removeItem(LEGACY_FOLDER_KEY) } catch { /* storage unavailable */ }
                set(state => ({ records: { ...state.records, [spaceId]: { ...EMPTY, folder: legacy, lastOpened: Date.now() } } }))
            },

            setFolder: (spaceId, folder) => set(state => ({
                records: {
                    ...state.records,
                    [spaceId]: { ...(state.records[spaceId] ?? EMPTY), folder, openFiles: [], activeFile: null, lastOpened: Date.now() }
                }
            })),

            setOpenFiles: (spaceId, openFiles, activeFile) => set(state => ({
                records: {
                    ...state.records,
                    [spaceId]: { ...(state.records[spaceId] ?? EMPTY), openFiles, activeFile }
                }
            })),

            touch: spaceId => set(state => ({
                records: {
                    ...state.records,
                    [spaceId]: { ...(state.records[spaceId] ?? EMPTY), lastOpened: Date.now() }
                }
            })),

            forget: spaceId => set(state => {
                const records = { ...state.records }
                delete records[spaceId]
                return { records }
            })
        }),
        {
            name: 'kalynt-workspace-folders',
            version: 1,
            storage: createJSONStorage(() => localStorage),
            partialize: state => ({ records: state.records })
        }
    )
)

/** Last path segment of a folder, for display. */
export function folderName(path: string | null | undefined): string {
    if (!path) return ''
    return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}

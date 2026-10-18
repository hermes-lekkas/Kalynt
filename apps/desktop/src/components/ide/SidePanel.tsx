/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The side bar's three views stay mounted while hidden so the tree keeps its
 * expanded folders and search keeps its results.
 */
import type { SidePanel as SidePanelId } from '../../stores/layoutStore'
import type { FileItem } from '../../types/ide'
import { RegionBoundary } from '../ui'
import { FileExplorer } from './explorer/FileExplorer'
import { SearchPanel } from './search/SearchPanel'
import { GitPanel } from './git/GitPanel'
import type { GitApi } from './git/useGit'

interface SidePanelProps {
    panel: SidePanelId
    visible: boolean
    folder: string | null
    indexFiles: FileItem[]
    activePath: string | null
    reveal: { path: string; kind: 'file' | 'dir' } | null
    onRevealed: () => void
    git: GitApi
    onOpenFile: (path: string, line?: number) => void
    onOpenFolder: () => void
    onCloseFolder: () => void
    onRenamed: (from: string, to: string) => void
    onDeleted: (path: string) => void
}

export function SidePanel(props: SidePanelProps) {
    const { panel, visible, folder } = props
    return (
        <>
            <div className="side-view" hidden={panel !== 'files'}>
                <RegionBoundary name="Explorer">
                    <FileExplorer
                        folder={folder}
                        indexFiles={props.indexFiles}
                        selectedPath={props.activePath}
                        reveal={props.reveal}
                        onRevealed={props.onRevealed}
                        onOpenFile={path => props.onOpenFile(path)}
                        onOpenFolder={props.onOpenFolder}
                        onCloseFolder={props.onCloseFolder}
                        onRenamed={props.onRenamed}
                        onDeleted={props.onDeleted}
                    />
                </RegionBoundary>
            </div>
            <div className="side-view" hidden={panel !== 'search'}>
                <RegionBoundary name="Search">
                    <SearchPanel folder={folder} visible={visible && panel === 'search'} onOpenMatch={props.onOpenFile} />
                </RegionBoundary>
            </div>
            <div className="side-view" hidden={panel !== 'git'}>
                <RegionBoundary name="Source control">
                    <GitPanel folder={folder} git={props.git} onOpenFile={path => props.onOpenFile(path)} />
                </RegionBoundary>
            </div>
        </>
    )
}

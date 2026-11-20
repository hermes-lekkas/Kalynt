/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The side bar's views stay mounted while hidden so the tree keeps its
 * expanded folders, search keeps its results, and debug keeps its watches.
 */
import type { SidePanel as SidePanelId } from '../../stores/layoutStore'
import type { FileItem } from '../../types/ide'
import { RegionBoundary } from '../ui'
import { FileExplorer } from './explorer/FileExplorer'
import { SearchPanel } from './search/SearchPanel'
import { GitPanel } from './git/GitPanel'
import { OutlinePanel } from './outline/OutlinePanel'
import { DebugPanel } from './debug/DebugPanel'
import { useExtraSidePanelStore } from './ActivityBar'
import type { GitApi } from './git/useGit'
import type { OpenFilesApi } from './hooks/useOpenFiles'
import type { RunnerApi } from './hooks/useRunner'

interface SidePanelProps {
    panel: SidePanelId
    visible: boolean
    folder: string | null
    indexFiles: FileItem[]
    activePath: string | null
    reveal: { path: string; kind: 'file' | 'dir' } | null
    onRevealed: () => void
    git: GitApi
    buffers: OpenFilesApi
    runner?: RunnerApi
    onOpenFile: (path: string, line?: number) => void
    onOpenFolder: () => void
    onCloseFolder: () => void
    onRenamed: (from: string, to: string) => void
    onDeleted: (path: string) => void
}

export function SidePanel(props: SidePanelProps) {
    const { panel, visible, folder } = props
    const extraPanel = useExtraSidePanelStore(s => s.extraPanel)
    const activeView = extraPanel ?? panel

    return (
        <>
            <div className="side-view" hidden={activeView !== 'files'}>
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
            <div className="side-view" hidden={activeView !== 'search'}>
                <RegionBoundary name="Search">
                    <SearchPanel folder={folder} buffers={props.buffers} visible={visible && activeView === 'search'} onOpenMatch={props.onOpenFile} />
                </RegionBoundary>
            </div>
            <div className="side-view" hidden={activeView !== 'git'}>
                <RegionBoundary name="Source control">
                    <GitPanel folder={folder} git={props.git} onOpenFile={path => props.onOpenFile(path)} />
                </RegionBoundary>
            </div>
            <div className="side-view" hidden={activeView !== 'debug'}>
                <RegionBoundary name="Run and Debug">
                    <DebugPanel
                        folder={folder}
                        activePath={props.activePath}
                        runner={props.runner}
                        onOpenFile={props.onOpenFile}
                    />
                </RegionBoundary>
            </div>
            <div className="side-view" hidden={activeView !== 'outline'}>
                <RegionBoundary name="Outline">
                    <OutlinePanel
                        activePath={props.activePath}
                        buffers={props.buffers}
                        visible={visible && activeView === 'outline'}
                        onOpenFile={props.onOpenFile}
                    />
                </RegionBoundary>
            </div>
        </>
    )
}

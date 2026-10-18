/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * A workspace's main views. The code view stays mounted while another view
 * is showing, so open files, terminals and agent conversations survive a
 * trip to Tasks or History.
 */
import { lazy, Suspense } from 'react'
import type { Space } from '../../stores/appStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { RegionBoundary, Spinner } from '../ui'
import { IDEWorkspace } from '../ide/IDEWorkspace'
import './workspace.css'

const TaskBoard = lazy(() => import('../tasks/TaskBoard'))
const HistoryView = lazy(() => import('../history/HistoryView'))
const SharedFilesView = lazy(() => import('../files/SharedFilesView'))

export function WorkspaceView({ space }: { space: Space }) {
    const mainView = useLayoutStore(s => s.mainView)
    const fallback = <div className="workspace__loading"><Spinner label="Loading" /></div>

    return (
        <div className="workspace">
            <div className="workspace__view" hidden={mainView !== 'code'}>
                <RegionBoundary name="Code view">
                    <IDEWorkspace space={space} active={mainView === 'code'} />
                </RegionBoundary>
            </div>
            {mainView !== 'code' && (
                <div className="workspace__view">
                    <Suspense fallback={fallback}>
                        {mainView === 'tasks' && <RegionBoundary name="Tasks"><TaskBoard space={space} /></RegionBoundary>}
                        {mainView === 'history' && <RegionBoundary name="History"><HistoryView space={space} /></RegionBoundary>}
                        {mainView === 'files' && <RegionBoundary name="Shared files"><SharedFilesView space={space} /></RegionBoundary>}
                    </Suspense>
                </div>
            )}
        </div>
    )
}

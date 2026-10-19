/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The folder bound to the current workspace. The main process only allows
 * file and git access inside the folder it was last given, so `folder` is
 * reported only once that hand-over has completed.
 */
import { useCallback, useEffect, useState } from 'react'
import { useWorkspaceFolderStore } from '../../../stores/workspaceFolderStore'
import { useNotificationStore } from '../../../stores/notificationStore'
import { pickFolder } from '../../home/workspaceActions'
import { logger } from '../../../utils/logger'
import { aimeService } from '../../../services/aimeService'

export function useWorkspaceFolder(spaceId: string) {
    const savedFolder = useWorkspaceFolderStore(s => s.records[spaceId]?.folder ?? null)
    const setFolder = useWorkspaceFolderStore(s => s.setFolder)
    const adoptLegacyFolder = useWorkspaceFolderStore(s => s.adoptLegacyFolder)
    const touch = useWorkspaceFolderStore(s => s.touch)
    const addNotification = useNotificationStore(s => s.addNotification)
    const [readyFolder, setReadyFolder] = useState<string | null>(null)

    useEffect(() => {
        adoptLegacyFolder(spaceId)
        touch(spaceId)
    }, [spaceId, adoptLegacyFolder, touch])

    useEffect(() => {
        setReadyFolder(null)
        if (!savedFolder) return
        let cancelled = false
        Promise.resolve(window.electronAPI?.fs?.setWorkspace?.(savedFolder))
            .then(result => {
                if (cancelled) return
                const failed = result && result.success === false && window.electronAPI?.platform !== 'browser'
                if (failed) addNotification(`Couldn't open ${savedFolder}: ${result.error ?? 'the folder is unavailable'}`, 'error')
                setReadyFolder(savedFolder)
            })
            .catch(error => {
                logger.ide.error('Failed to set workspace folder', error)
                if (!cancelled) setReadyFolder(savedFolder)
            })
        return () => { cancelled = true }
    }, [savedFolder, addNotification])

    // AIME indexes the workspace in the background so the agent has codebase
    // context; failures never block opening the folder.
    useEffect(() => {
        if (!readyFolder) return
        void aimeService.indexWorkspace(readyFolder).catch(error => {
            logger.agent.warn('AIME indexing failed', { error })
        })
    }, [readyFolder])

    const openFolder = useCallback(async () => {
        const picked = await pickFolder()
        if (picked) setFolder(spaceId, picked)
        return picked
    }, [spaceId, setFolder])

    const closeFolder = useCallback(() => setFolder(spaceId, null), [spaceId, setFolder])

    return {
        /** The folder, once the main process has accepted it. */
        folder: readyFolder,
        /** True while switching to a newly chosen folder. */
        switching: !!savedFolder && readyFolder !== savedFolder,
        openFolder,
        closeFolder
    }
}

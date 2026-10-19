/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Files shared peer to peer inside a workspace.
 */
import { useCallback, useEffect, useState } from 'react'
import { fileTransferService, type SharedFile } from '../../services/fileTransferService'
import type { PeerInfo } from '../../services/p2pService'
import { useAppStore } from '../../stores/appStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { usePermissions } from '../../hooks/usePermissions'
import { confirmAction } from '../ui'

export const MAX_SHARE_MB = 200

export function useSharedFiles(spaceId: string) {
    const userName = useAppStore(s => s.userName)
    const addNotification = useNotificationStore(s => s.addNotification)
    const { isBanned, canManageFiles, isAdmin } = usePermissions()
    const [files, setFiles] = useState<SharedFile[]>([])
    const [peers, setPeers] = useState<PeerInfo[]>([])
    const [progress, setProgress] = useState<Record<string, number>>({})
    const [sharing, setSharing] = useState(false)
    const [downloading, setDownloading] = useState<string | null>(null)

    useEffect(() => {
        if (isBanned) return
        fileTransferService.init(spaceId, spaceId)
        fileTransferService.setCallbacks(
            list => setFiles([...list]),
            list => setPeers([...list]),
            (fileId, value) => setProgress(prev => ({ ...prev, [fileId]: value }))
        )
        setFiles(fileTransferService.getFiles())
        return () => fileTransferService.destroy()
    }, [spaceId, isBanned])

    const share = useCallback(async (list: FileList | File[]) => {
        const items = Array.from(list)
        if (items.length === 0) return
        setSharing(true)
        let ok = 0
        for (const file of items) {
            if (file.size > MAX_SHARE_MB * 1024 * 1024) {
                addNotification(`${file.name} is larger than ${MAX_SHARE_MB} MB and can't be shared.`, 'error')
                continue
            }
            const result = await fileTransferService.shareFile(file, userName, 'small')
            if (result.success) ok++
            else addNotification(`Couldn't share ${file.name}: ${result.error}`, 'error')
        }
        setSharing(false)
        setFiles(fileTransferService.getFiles())
        if (ok > 0) addNotification(`Shared ${ok} file${ok === 1 ? '' : 's'} with the workspace`, 'success')
    }, [userName, addNotification])

    const download = useCallback(async (file: SharedFile) => {
        setDownloading(file.id)
        const ok = await fileTransferService.downloadFile(file)
        setDownloading(null)
        addNotification(ok ? `Downloaded ${file.name}` : `Couldn't download ${file.name}. The person who shared it may be offline.`, ok ? 'success' : 'error')
    }, [addNotification])

    const remove = useCallback(async (file: SharedFile) => {
        const ok = await confirmAction({ title: `Remove ${file.name}?`, message: 'It is removed for everyone in the workspace.', confirmLabel: 'Remove', danger: true })
        if (!ok) return
        if (fileTransferService.removeFile(file.id, isAdmin)) setFiles(fileTransferService.getFiles())
        else addNotification('Only the person who shared a file, or an admin, can remove it.', 'warning')
    }, [isAdmin, addNotification])

    const clearAll = useCallback(async () => {
        const ok = await confirmAction({ title: 'Remove every shared file?', message: 'All files are removed for everyone in the workspace.', confirmLabel: 'Remove all', danger: true })
        if (ok && fileTransferService.clearAllFiles()) setFiles([])
    }, [])

    return {
        files, peers, progress, sharing, downloading, share, download, remove, clearAll,
        canShare: canManageFiles && !isBanned, isAdmin, isBanned,
        localUserId: fileTransferService.getLocalUserId()
    }
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Files shared peer to peer inside a workspace over the canonical room Y.Doc.
 */
import { useCallback, useEffect, useState } from 'react'
import { fileTransferService, type SharedFile } from '../../services/fileTransferService'
import { p2pService, type PeerInfo } from '../../services/p2pService'
import { useYDoc } from '../../hooks/useYjs'
import { useAppStore } from '../../stores/appStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { usePermissions } from '../../hooks/usePermissions'
import { confirmAction } from '../ui'

export const MAX_SHARE_MB = 200

export function useSharedFiles(spaceId: string) {
    const userName = useAppStore(s => s.userName)
    const addNotification = useNotificationStore(s => s.addNotification)
    const { isBanned, canManageFiles, isAdmin } = usePermissions()
    // Share the SINGLE live password-aware canonical Y.Doc & ref-counted WebrtcProvider
    const { doc, peerCount, encrypted, authInfo } = useYDoc(isBanned ? null : spaceId)
    const [files, setFiles] = useState<SharedFile[]>([])
    const [peers, setPeers] = useState<PeerInfo[]>(() => p2pService.getConnectedPeers(spaceId))
    const [progress, setProgress] = useState<Record<string, number>>({})
    const [sharing, setSharing] = useState(false)
    const [downloading, setDownloading] = useState<string | null>(null)

    useEffect(() => {
        if (isBanned || !doc) return
        fileTransferService.setCallbacks(
            list => setFiles([...list]),
            list => setPeers([...list]),
            (fileId, value) => setProgress(prev => ({ ...prev, [fileId]: value }))
        )
        fileTransferService.init(spaceId, doc)
        setPeers(fileTransferService.getPeers())
        setFiles(fileTransferService.getFiles())
        return () => fileTransferService.destroy()
    }, [spaceId, doc, isBanned])

    // Keep peer list & derived local-only/ready file states aligned whenever useYDoc sees a presence change
    useEffect(() => {
        if (isBanned || !doc) return
        setPeers(p2pService.getConnectedPeers(spaceId))
        setFiles(fileTransferService.getFiles())
    }, [peerCount, spaceId, doc, isBanned])

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
        if (ok > 0) {
            const connectedCount = p2pService.getPeerCount(spaceId)
            addNotification(
                connectedCount > 0
                    ? `Shared ${ok} file${ok === 1 ? '' : 's'} with ${connectedCount} connected ${connectedCount === 1 ? 'peer' : 'peers'}`
                    : `Saved ${ok} file${ok === 1 ? '' : 's'} locally — will sync when peers join`,
                connectedCount > 0 ? 'success' : 'info'
            )
        }
    }, [userName, addNotification, spaceId])

    const download = useCallback(async (file: SharedFile) => {
        setDownloading(file.id)
        const result = await fileTransferService.downloadFile(file)
        setDownloading(null)
        if (result.success) {
            addNotification(`Downloaded ${file.name}`, 'success')
        } else {
            addNotification(
                result.error || `Couldn't download ${file.name}. The sender may have closed before all chunks arrived.`,
                'error'
            )
        }
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
        files, peers, peerCount: Math.max(peerCount, peers.length), encrypted, authInfo,
        progress, sharing, downloading, share, download, remove, clearAll,
        canShare: canManageFiles && !isBanned, isAdmin, isBanned,
        localUserId: fileTransferService.getLocalUserId()
    }
}

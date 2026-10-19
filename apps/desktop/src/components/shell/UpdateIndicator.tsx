/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { AlertCircle, ArrowDownCircle, RotateCw } from 'lucide-react'
import { useUpdateStore } from '../../stores/updateStore'

/**
 * Appears only when an update needs attention. Checking for updates manually
 * lives in Settings → About and in the command palette.
 */
export function UpdateIndicator() {
    const { status, updateInfo, downloadProgress, setShowUpdateModal } = useUpdateStore()

    if (status === 'available') {
        return (
            <button type="button" className="update-pill" onClick={() => setShowUpdateModal(true)}>
                <ArrowDownCircle size={14} aria-hidden />
                Update to {updateInfo?.version ?? 'the latest version'}
            </button>
        )
    }

    if (status === 'downloading') {
        const pct = Math.round(downloadProgress?.percent ?? 0)
        return (
            <button type="button" className="update-pill" onClick={() => setShowUpdateModal(true)} aria-label={`Downloading update, ${pct} percent`}>
                <span className="update-pill__ring" style={{ ['--pct' as string]: `${pct}%` }} aria-hidden />
                Downloading {pct}%
            </button>
        )
    }

    if (status === 'downloaded') {
        return (
            <button type="button" className="update-pill is-ready" onClick={() => setShowUpdateModal(true)}>
                <RotateCw size={14} aria-hidden />
                Restart to update
            </button>
        )
    }

    if (status === 'error') {
        return (
            <button type="button" className="update-pill is-error" onClick={() => setShowUpdateModal(true)}>
                <AlertCircle size={14} aria-hidden />
                Update failed
            </button>
        )
    }

    return null
}

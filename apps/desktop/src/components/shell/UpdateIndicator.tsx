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
        const label = `Update to ${updateInfo?.version ?? 'the latest version'}`
        return (
            <button type="button" className="update-pill" onClick={() => setShowUpdateModal(true)} title={label} aria-label={label}>
                <ArrowDownCircle size={14} aria-hidden />
                <span className="update-pill__label">{label}</span>
            </button>
        )
    }

    if (status === 'downloading') {
        const pct = Math.round(downloadProgress?.percent ?? 0)
        const label = `Downloading ${pct}%`
        return (
            <button type="button" className="update-pill tabular-nums" onClick={() => setShowUpdateModal(true)} title={label} aria-label={`Downloading update, ${pct} percent`}>
                <span className="update-pill__ring" style={{ ['--pct' as string]: `${pct}%` }} aria-hidden />
                <span className="update-pill__label">{label}</span>
            </button>
        )
    }

    if (status === 'downloaded') {
        return (
            <button type="button" className="update-pill is-ready" onClick={() => setShowUpdateModal(true)} title="Restart to update" aria-label="Restart to update">
                <RotateCw size={14} aria-hidden />
                <span className="update-pill__label">Restart to update</span>
            </button>
        )
    }

    if (status === 'error') {
        return (
            <button type="button" className="update-pill is-error" onClick={() => setShowUpdateModal(true)} title="Update failed" aria-label="Update failed">
                <AlertCircle size={14} aria-hidden />
                <span className="update-pill__label">Update failed</span>
            </button>
        )
    }

    return null
}

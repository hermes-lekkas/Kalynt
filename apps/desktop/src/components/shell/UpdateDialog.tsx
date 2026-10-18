/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useUpdateStore } from '../../stores/updateStore'
import { Button, Dialog, ProgressBar } from '../ui'
import './startup.css'

function formatBytes(bytes: number): string {
    if (!bytes) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
    return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDate(value: string): string {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

export function UpdateDialog() {
    const {
        showUpdateModal, status, updateInfo, downloadProgress, error, currentVersion,
        downloadUpdate, installUpdate, dismissUpdate, checkForUpdates, setShowUpdateModal
    } = useUpdateStore()

    if (!showUpdateModal) return null
    const close = () => setShowUpdateModal(false)

    const title = status === 'downloaded' ? 'Update ready to install'
        : status === 'error' ? 'The update could not be completed'
            : status === 'downloading' ? 'Downloading update'
                : 'An update is available'

    const footer = status === 'error' ? (
        <>
            <Button variant="ghost" onClick={close}>Close</Button>
            <Button variant="primary" onClick={() => checkForUpdates()}>Check again</Button>
        </>
    ) : status === 'downloaded' ? (
        <>
            <Button variant="ghost" onClick={close}>Install later</Button>
            <Button variant="primary" onClick={() => installUpdate()}>Restart and install</Button>
        </>
    ) : status === 'downloading' ? (
        <Button variant="ghost" onClick={close}>Hide</Button>
    ) : (
        <>
            <Button variant="ghost" onClick={() => dismissUpdate()}>Skip this version</Button>
            <Button variant="primary" onClick={() => downloadUpdate()}>Download update</Button>
        </>
    )

    return (
        <Dialog open size="md" title={title} onClose={close} footer={footer}>
            {status === 'error' ? (
                <p className="update-dialog__error selectable">{error || 'Something interrupted the update. Check your connection and try again.'}</p>
            ) : (
                <>
                    <dl className="update-dialog__versions">
                        <div>
                            <dt>Installed</dt>
                            <dd>{currentVersion}</dd>
                        </div>
                        {updateInfo && (
                            <div>
                                <dt>New version</dt>
                                <dd>{updateInfo.version}{updateInfo.releaseDate ? `, released ${formatDate(updateInfo.releaseDate)}` : ''}</dd>
                            </div>
                        )}
                    </dl>

                    {status === 'downloading' && downloadProgress && (
                        <div className="update-dialog__progress">
                            <ProgressBar value={downloadProgress.percent / 100} label="Download progress" />
                            <p>
                                {formatBytes(downloadProgress.transferred)} of {formatBytes(downloadProgress.total)}
                                {downloadProgress.bytesPerSecond > 0 && ` at ${formatBytes(downloadProgress.bytesPerSecond)}/s`}
                            </p>
                        </div>
                    )}

                    {status === 'downloaded' && (
                        <p className="update-dialog__note">Kalynt will close, install the update, and reopen. Save your work first.</p>
                    )}

                    {updateInfo?.releaseNotes && (
                        <section className="update-dialog__notes">
                            <h3>What’s new</h3>
                            <div className="selectable">{updateInfo.releaseNotes.replace(/<[^>]+>/g, '')}</div>
                        </section>
                    )}
                </>
            )}
        </Dialog>
    )
}

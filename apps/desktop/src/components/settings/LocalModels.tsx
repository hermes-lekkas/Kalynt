/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useState } from 'react'
import { Download, Square, Trash2 } from 'lucide-react'
import { useModelStore } from '../../stores/modelStore'
import { offlineLLMService } from '../../services/offlineLLMService'
import { cancelDownload, deleteModel, downloadModel } from '../../services/modelDownloadService'
import { OFFLINE_MODELS, formatBytes, formatETA } from '../../types/offlineModels'
import { useNotificationStore } from '../../stores/notificationStore'
import { Badge, Button, IconButton, ProgressBar, confirmAction } from '../ui'

/** The catalogue of models that run on this machine, with their download and load state. */
export function LocalModels() {
    const { downloadedModels, activeDownloads, loadedModelId, isLoading, loadError } = useModelStore()
    const addNotification = useNotificationStore(s => s.addNotification)
    const [memory, setMemory] = useState<number | null>(null)
    const [failedModel, setFailedModel] = useState<string | null>(null)

    useEffect(() => { useModelStore.getState().setupListeners() }, [])
    useEffect(() => {
        let active = true
        window.electronAPI?.getHardwareInfo?.().then(info => {
            if (active && typeof info?.totalRAM === 'number' && info.totalRAM > 0) setMemory(info.totalRAM)
        }).catch(() => { /* Keep estimates visible when hardware detection is unavailable. */ })
        return () => { active = false }
    }, [])

    const candidates = memory === null ? [] : OFFLINE_MODELS.filter(m => m.ramRequiredMB + 2048 <= memory)
    const suggested = [...candidates].sort((a, b) => Number(b.capabilities.canWriteFiles) - Number(a.capabilities.canWriteFiles) || b.ramRequiredMB - a.ramRequiredMB)[0]?.id

    const load = async (id: string) => {
        setFailedModel(null)
        try {
            if (!await offlineLLMService.loadModel(id)) {
                setFailedModel(id)
                addNotification(useModelStore.getState().loadError || 'The model could not be loaded. Try a smaller model.', 'error')
            }
        } catch (e) {
            setFailedModel(id)
            addNotification(`Couldn't load the model: ${e instanceof Error ? e.message : String(e)}`, 'error')
        }
    }

    const remove = async (id: string, name: string) => {
        const ok = await confirmAction({ title: `Delete ${name}?`, message: 'The model file is removed from disk. You can download it again later.', confirmLabel: 'Delete model', danger: true })
        if (!ok) return
        if (loadedModelId === id) await offlineLLMService.unloadModel()
        if (await deleteModel(id)) addNotification(`Deleted ${name}`, 'info')
        else addNotification(`Couldn't delete ${name}`, 'error')
    }

    return (
        <>
        <p className="model-memory-note">{memory === null ? 'Memory requirements below are estimates.' : `Detected ${Math.round(memory / 1024)} GB RAM. Suggestions leave at least 2 GB for the rest of your system.`} Larger projects and longer conversations need more headroom. Small models are best for explanations; editing and tool use depend on the model.</p>
        <ul className="model-list">
            {OFFLINE_MODELS.map(model => {
                const downloaded = !!downloadedModels[model.id]
                const download = activeDownloads[model.id]
                const downloading = download && (download.status === 'downloading' || download.status === 'paused')
                const loaded = loadedModelId === model.id
                return (
                    <li key={model.id} className={`model-row ${loaded ? 'is-loaded' : ''}`}>
                        <div className="model-row__info">
                            <div className="model-row__name">
                                {model.name}
                                {model.id === suggested && <Badge tone="agent">Suggested start</Badge>}
                                <Badge>{model.capabilities.canWriteFiles ? 'Agent tasks' : 'Code chat'}</Badge>
                                {loaded && <Badge tone="agent">Loaded</Badge>}
                                {downloaded && !loaded && <Badge>Downloaded</Badge>}
                            </div>
                            <p className="model-row__desc">{model.description}</p>
                            <p className="model-row__specs">{model.size} download, needs about {model.ramRequired} of memory, {Math.round(model.contextLength / 1000)}k context</p>
                            {memory !== null && model.ramRequiredMB + 2048 > memory && <p className="model-row__specs">Memory may be tight on this machine. Try a smaller model or a local server.</p>}
                            {downloading && (
                                <div className="model-row__progress">
                                    <ProgressBar value={download.totalBytes ? download.bytesDownloaded / download.totalBytes : undefined} tone="agent" label={`Downloading ${model.name}`} />
                                    <span>
                                        {formatBytes(download.bytesDownloaded)} of {formatBytes(download.totalBytes)}
                                        {download.speed > 0 && `, ${formatBytes(download.speed)}/s, ${formatETA(download.eta)} left`}
                                    </span>
                                </div>
                            )}
                            {download?.status === 'error' && <p className="model-row__error">The download failed{download.error ? `: ${download.error}` : ''}.</p>}
                            {failedModel === model.id && loadError && <p className="model-row__error" role="alert">{loadError}</p>}
                        </div>
                        <div className="model-row__actions">
                            {downloading ? (
                                <Button size="sm" variant="ghost" icon={<Square size={11} />} onClick={() => cancelDownload(model.id)}>Cancel</Button>
                            ) : downloaded ? (
                                <>
                                    {loaded
                                        ? <Button size="sm" onClick={() => offlineLLMService.unloadModel()}>Unload</Button>
                                        : <Button size="sm" variant="primary" loading={isLoading} onClick={() => load(model.id)}>Load</Button>}
                                    <IconButton size="sm" tone="danger" label={`Delete ${model.name}`} icon={<Trash2 size={13} />} onClick={() => remove(model.id, model.name)} />
                                </>
                            ) : (
                                <Button size="sm" icon={<Download size={13} />} onClick={() => downloadModel(model.id)}>Download</Button>
                            )}
                        </div>
                    </li>
                )
            })}
        </ul>
        </>
    )
}

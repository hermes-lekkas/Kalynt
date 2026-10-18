/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Reviews every code file in the workspace with the selected model and lists
 * bugs, security problems and improvements it finds.
 */
import { useMemo, useState } from 'react'
import { ChevronRight, ScanSearch, Square } from 'lucide-react'
import {
    workspaceScanService, type IssueType, type ScanError, type ScanIssue, type ScanProgress, type ScanResult
} from '../../../services/workspaceScanService'
import { useAgentStatusStore } from '../../../stores/agentStatusStore'
import { useAppStore } from '../../../stores/appStore'
import { Button, EmptyState, ProgressBar, Tabs } from '../../ui'
import { relativePath } from '../../ide/languages'
import { ReviewIssue } from './ReviewIssue'
import type { ModelChoiceApi } from '../chat/useModelChoice'

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const

function duration(ms: number): string {
    if (ms < 1000) return `${ms} ms`
    const s = Math.round(ms / 1000)
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

export function WorkspaceReview({ folder, model }: { folder: string | null; model: ModelChoiceApi }) {
    const [running, setRunning] = useState(false)
    const [progress, setProgress] = useState<ScanProgress | null>(null)
    const [issues, setIssues] = useState<ScanIssue[]>([])
    const [errors, setErrors] = useState<ScanError[]>([])
    const [stats, setStats] = useState<ScanResult['stats'] | null>(null)
    const [filter, setFilter] = useState<IssueType | 'all'>('all')
    const [showErrors, setShowErrors] = useState(false)

    const counts = useMemo(() => ({
        all: issues.length,
        bug: issues.filter(i => i.type === 'bug').length,
        security: issues.filter(i => i.type === 'security').length,
        performance: issues.filter(i => i.type === 'performance').length,
        improvement: issues.filter(i => i.type === 'improvement').length
    }), [issues])

    const visible = useMemo(() => (filter === 'all' ? issues : issues.filter(i => i.type === filter))
        .slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]), [issues, filter])

    const start = async () => {
        if (!folder || !model.ready) return
        setRunning(true)
        setIssues([])
        setErrors([])
        setStats(null)
        setFilter('all')
        useAgentStatusStore.getState().setActivity('scanning')
        try {
            const result = await workspaceScanService.scanWorkspace(folder, {
                aiMode: model.choice.mode,
                provider: model.choice.provider,
                cloudModel: model.choice.cloudModel,
                loadedModelId: model.loadedModelId,
                onProgress: setProgress
            })
            setIssues(result.issues)
            setErrors(result.errors)
            setStats(result.stats)
        } catch (e) {
            setErrors([{ file: 'Review', path: '', reason: e instanceof Error ? e.message : String(e) }])
        } finally {
            setRunning(false)
            setProgress(null)
            useAgentStatusStore.getState().setActivity('idle')
        }
    }

    const stop = () => {
        workspaceScanService.stopScan()
        setRunning(false)
        setProgress(null)
        useAgentStatusStore.getState().setActivity('idle')
    }

    if (!folder) return <EmptyState title="No folder open" description="Open a folder to review its code." />

    if (running) {
        const fraction = progress && progress.total > 0 ? progress.current / progress.total : undefined
        return (
            <div className="review review--running">
                <p className="review__title">Reviewing {progress?.total ? `${progress.current} of ${progress.total} files` : 'files'}</p>
                <ProgressBar value={fraction} tone="agent" label="Review progress" />
                {progress?.currentFile && <p className="review__file mono truncate">{relativePath(progress.currentFile, folder)}</p>}
                <Button size="sm" icon={<Square size={11} />} onClick={stop}>Stop review</Button>
            </div>
        )
    }

    if (!stats && issues.length === 0 && errors.length === 0) {
        return (
            <EmptyState
                icon={<ScanSearch size={28} />}
                title="Review this workspace"
                description={`The selected model reads each code file and lists bugs, security problems and improvements. Large projects take a while${model.choice.mode === 'cloud' ? ' and use your API quota' : ''}.`}
                actions={model.ready
                    ? <Button variant="agent" onClick={start}>Start review</Button>
                    : <Button onClick={() => { useAppStore.getState().setSettingsTab('models'); useAppStore.getState().setShowSettings(true) }}>Connect a model</Button>}
            />
        )
    }

    return (
        <div className="review">
            <div className="review__summary">
                <p>
                    {issues.length === 0 ? 'No problems found' : `${issues.length} finding${issues.length === 1 ? '' : 's'}`}
                    {stats && <span className="review__muted"> in {stats.analyzedFiles} files, {duration(stats.duration)}</span>}
                </p>
                <Button size="sm" onClick={start}>Review again</Button>
            </div>
            {issues.length > 0 && (
                <div className="review__filters">
                    <Tabs
                        variant="segmented"
                        size="sm"
                        ariaLabel="Filter findings"
                        value={filter}
                        onChange={setFilter}
                        items={[
                            { id: 'all', label: 'All', badge: counts.all },
                            { id: 'bug', label: 'Bugs', badge: counts.bug, disabled: !counts.bug },
                            { id: 'security', label: 'Security', badge: counts.security, disabled: !counts.security },
                            { id: 'performance', label: 'Speed', badge: counts.performance, disabled: !counts.performance },
                            { id: 'improvement', label: 'Ideas', badge: counts.improvement, disabled: !counts.improvement }
                        ]}
                    />
                </div>
            )}
            <ul className="review__list">
                {visible.map((issue, i) => (
                    <ReviewIssue key={`${issue.path}-${issue.line}-${i}`} issue={issue} folder={folder} mode={model.choice.mode} provider={model.choice.provider} cloudModel={model.choice.cloudModel} />
                ))}
            </ul>
            {errors.length > 0 && (
                <div className="review__errors">
                    <button type="button" className="review__errors-head" onClick={() => setShowErrors(v => !v)} aria-expanded={showErrors}>
                        <ChevronRight size={13} className={showErrors ? 'is-open' : ''} aria-hidden />
                        {errors.length} file{errors.length === 1 ? '' : 's'} couldn’t be reviewed
                    </button>
                    {showErrors && (
                        <ul>
                            {errors.map((err, i) => (
                                <li key={i}><span className="mono">{err.path ? relativePath(err.path, folder) : err.file}</span> {err.reason}</li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    )
}

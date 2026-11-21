/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Reviews workspace code files with the selected model and lists bugs,
 * security problems and improvements with explicit scope and outcome reporting.
 */
import { useMemo, useRef, useState } from 'react'
import { ChevronRight, ScanSearch, Square } from 'lucide-react'
import {
    getScanLimits,
    workspaceScanService,
    type IssueType,
    type OmittedFile,
    type OmittedReason,
    type ScanError,
    type ScanIssue,
    type ScanOutcome,
    type ScanProgress,
    type ScanResult,
    type ScanScope
} from '../../../services/workspaceScanService'
import { useAgentStatusStore } from '../../../stores/agentStatusStore'
import { useAppStore } from '../../../stores/appStore'
import { Badge, Button, EmptyState, ProgressBar, Tabs } from '../../ui'
import { relativePath } from '../../ide/languages'
import { ReviewIssue } from './ReviewIssue'
import type { ModelChoiceApi } from '../chat/useModelChoice'

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const

const OMITTED_REASON_LABEL: Record<OmittedReason, string> = {
    file_cap: 'file cap',
    depth_limit: 'depth limit',
    short_file: 'short file',
    empty_file: 'empty file',
    unreadable: 'unreadable',
    canceled: 'canceled',
    error: 'error'
}

function duration(ms: number): string {
    if (ms < 1000) return `${ms} ms`
    const s = Math.round(ms / 1000)
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

function formatOmittedReasons(byReason: Partial<Record<OmittedReason, number>>): string {
    const parts = (Object.entries(byReason) as Array<[OmittedReason, number]>)
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => `${count} ${OMITTED_REASON_LABEL[reason]}`)
    return parts.join(', ')
}

export function WorkspaceReview({ folder, model }: { folder: string | null; model: ModelChoiceApi }) {
    const [scope, setScope] = useState<ScanScope>('sampled')
    const [running, setRunning] = useState(false)
    const [stopping, setStopping] = useState(false)
    const [progress, setProgress] = useState<ScanProgress | null>(null)
    const [outcome, setOutcome] = useState<ScanOutcome | null>(null)
    const [summaryMessage, setSummaryMessage] = useState<string | null>(null)
    const [issues, setIssues] = useState<ScanIssue[]>([])
    const [errors, setErrors] = useState<ScanError[]>([])
    const [omitted, setOmitted] = useState<OmittedFile[]>([])
    const [stats, setStats] = useState<ScanResult['stats'] | null>(null)
    const [filter, setFilter] = useState<IssueType | 'all'>('all')
    const [showErrors, setShowErrors] = useState(false)
    const [showOmitted, setShowOmitted] = useState(false)
    const scanGenRef = useRef(0)

    const activeLimits = useMemo(() => getScanLimits(scope, model.choice.mode), [scope, model.choice.mode])

    const counts = useMemo(() => ({
        all: issues.length,
        bug: issues.filter(i => i.type === 'bug').length,
        security: issues.filter(i => i.type === 'security').length,
        performance: issues.filter(i => i.type === 'performance').length,
        improvement: issues.filter(i => i.type === 'improvement').length
    }), [issues])

    const visible = useMemo(() => (filter === 'all' ? issues : issues.filter(i => i.type === filter))
        .slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]), [issues, filter])

    const start = async (chosenScope: ScanScope = scope) => {
        if (!folder || !model.ready || running) return
        const gen = ++scanGenRef.current
        setRunning(true)
        setStopping(false)
        setOutcome(null)
        setSummaryMessage(null)
        setIssues([])
        setErrors([])
        setOmitted([])
        setStats(null)
        setFilter('all')
        setShowErrors(false)
        setShowOmitted(false)
        useAgentStatusStore.getState().setActivity('scanning')
        try {
            const result = await workspaceScanService.scanWorkspace(folder, {
                aiMode: model.choice.mode,
                provider: model.choice.provider,
                cloudModel: model.choice.cloudModel,
                loadedModelId: model.loadedModelId,
                scope: chosenScope,
                onProgress: p => {
                    if (scanGenRef.current === gen) setProgress(p)
                }
            })
            if (scanGenRef.current === gen) {
                setOutcome(result.outcome)
                setSummaryMessage(result.message ?? null)
                setIssues(result.issues)
                setErrors(result.errors)
                setOmitted(result.omitted)
                setStats(result.stats)
            }
        } catch (e) {
            if (scanGenRef.current === gen) {
                const reason = e instanceof Error ? e.message : String(e)
                setOutcome('failed')
                setSummaryMessage(reason)
                setErrors([{ file: 'Review', path: '', reason }])
            }
        } finally {
            if (scanGenRef.current === gen) {
                setRunning(false)
                setStopping(false)
                setProgress(null)
                useAgentStatusStore.getState().setActivity('idle')
            }
        }
    }

    const stop = async () => {
        if (!running || stopping) return
        setStopping(true)
        await workspaceScanService.stopScan()
    }

    if (!folder) return <EmptyState title="No folder open" description="Open a folder to review its code." />

    if (running) {
        const fraction = progress && progress.total > 0 ? progress.current / progress.total : undefined
        return (
            <div className="review review--running">
                <p className="review__title">
                    {stopping
                        ? 'Stopping review…'
                        : progress?.status === 'indexing'
                            ? 'Indexing workspace files…'
                            : `Reviewing ${progress?.total ? `${progress.current} of ${progress.total} files` : 'files'}`}
                </p>
                <ProgressBar value={fraction} tone="agent" label="Review progress" />
                {progress?.currentFile && <p className="review__file mono truncate">{relativePath(progress.currentFile, folder)}</p>}
                <p className="review__limits">
                    {activeLimits.scope === 'full'
                        ? `Full coverage · all supported files · ${activeLimits.maxLinesPerFile}-line chunks`
                        : `Sampled coverage · up to ${activeLimits.maxFiles} files · depth ≤ ${activeLimits.maxDepth} · first ${activeLimits.maxLinesPerFile} lines/file`}
                </p>
                <Button size="sm" icon={<Square size={11} />} disabled={stopping} onClick={() => void stop()}>{stopping ? 'Stopping…' : 'Stop review'}</Button>
            </div>
        )
    }

    const limitsCaption = activeLimits.scope === 'full'
        ? `Full workspace: reads every supported code file at any depth (including short files). Files over ${activeLimits.maxLinesPerFile} lines are reviewed in ${activeLimits.maxLinesPerFile}-line chunks.`
        : `Sampled review: reads up to ${activeLimits.maxFiles} prioritized files, max depth ${activeLimits.maxDepth}, skips files under ${activeLimits.minLines} lines, and clips files at ${activeLimits.maxLinesPerFile} lines.`

    if (!outcome && !stats && issues.length === 0 && errors.length === 0) {
        return (
            <EmptyState
                icon={<ScanSearch size={28} />}
                title="Review this workspace"
                description={`Choose sampled or full coverage before starting. Large reviews take longer${model.choice.mode === 'cloud' ? ' and use your API quota' : ''}.`}
                actions={
                    <div className="review__start">
                        <div className="review__scope">
                            <Tabs
                                variant="segmented"
                                size="sm"
                                ariaLabel="Review coverage"
                                value={scope}
                                onChange={setScope}
                                items={[
                                    { id: 'sampled', label: 'Sampled (fast)' },
                                    { id: 'full', label: 'Full workspace' }
                                ]}
                            />
                            <p className="review__limits">{limitsCaption}</p>
                        </div>
                        {model.ready
                            ? <Button variant="agent" onClick={() => void start(scope)}>Start review</Button>
                            : <Button onClick={() => { useAppStore.getState().setSettingsTab('models'); useAppStore.getState().setShowSettings(true) }}>Connect a model</Button>}
                    </div>
                }
            />
        )
    }

    const effectiveOutcome: ScanOutcome = outcome ?? (errors.length > 0 && (stats?.analyzedFiles ?? 0) === 0 ? 'failed' : 'completed')
    const analyzed = stats?.analyzedFiles ?? 0
    const discovered = stats?.discoveredFiles ?? stats?.totalFiles ?? 0
    const omittedCount = stats?.omittedFiles ?? omitted.length
    const clippedCount = stats?.clippedFiles ?? 0
    const omittedReasonsText = stats ? formatOmittedReasons(stats.omittedByReason) : ''

    let headline: string
    if (effectiveOutcome === 'canceled') {
        headline = analyzed === 0
            ? 'Review canceled'
            : issues.length === 0
                ? 'Review canceled (0 findings so far)'
                : `Review canceled · ${issues.length} finding${issues.length === 1 ? '' : 's'} preserved`
    } else if (effectiveOutcome === 'failed') {
        headline = 'Review failed'
    } else if (discovered === 0) {
        headline = 'No supported code files found'
    } else if (effectiveOutcome === 'partial') {
        headline = issues.length === 0
            ? 'No problems found in analyzed files'
            : `${issues.length} finding${issues.length === 1 ? '' : 's'} (partial coverage)`
    } else {
        headline = issues.length === 0
            ? 'No problems found'
            : `${issues.length} finding${issues.length === 1 ? '' : 's'}`
    }

    const outcomeTone = effectiveOutcome === 'completed' ? 'success'
        : effectiveOutcome === 'partial' ? 'warning'
            : effectiveOutcome === 'canceled' ? 'neutral' : 'danger'
    const outcomeLabel = effectiveOutcome === 'completed' ? 'Completed'
        : effectiveOutcome === 'partial' ? 'Partial'
            : effectiveOutcome === 'canceled' ? 'Canceled' : 'Failed'

    return (
        <div className="review">
            <div className="review__summary">
                <div className="review__summary-text">
                    <div className="review__headline">
                        <Badge tone={outcomeTone}>{outcomeLabel}</Badge>
                        <p>{headline}</p>
                    </div>
                    {stats && (
                        <p className="review__coverage">
                            Discovered {discovered} · Analyzed {analyzed} · Omitted {omittedCount}
                            {omittedReasonsText ? ` (${omittedReasonsText})` : ''}
                            {clippedCount > 0 ? ` · ${clippedCount} clipped at ${stats.limits.maxLinesPerFile} lines` : ''}
                            {' · '}{duration(stats.duration)}
                        </p>
                    )}
                    {summaryMessage && (effectiveOutcome === 'canceled' || effectiveOutcome === 'failed' || discovered === 0) && (
                        <p className="review__muted">{summaryMessage}</p>
                    )}
                </div>
                <div className="review__summary-actions">
                    <Tabs
                        variant="segmented"
                        size="sm"
                        ariaLabel="Review coverage"
                        value={scope}
                        onChange={setScope}
                        items={[
                            { id: 'sampled', label: 'Sampled' },
                            { id: 'full', label: 'Full' }
                        ]}
                    />
                    <Button size="sm" onClick={() => void start(scope)}>Review again</Button>
                </div>
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
            {omitted.length > 0 && (
                <div className="review__errors">
                    <button type="button" className="review__errors-head" onClick={() => setShowOmitted(v => !v)} aria-expanded={showOmitted}>
                        <ChevronRight size={13} className={showOmitted ? 'is-open' : ''} aria-hidden />
                        {omitted.length} file{omitted.length === 1 ? '' : 's'} omitted from this review
                    </button>
                    {showOmitted && (
                        <ul>
                            {omitted.map((item, i) => (
                                <li key={`${item.path}-${i}`}>
                                    <span className="mono">{item.path ? relativePath(item.path, folder) : item.file}</span>{' '}
                                    ({OMITTED_REASON_LABEL[item.reason]}{item.detail ? `: ${item.detail}` : ''})
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
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

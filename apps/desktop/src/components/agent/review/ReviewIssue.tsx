/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState } from 'react'
import { Check, ChevronRight, Copy, FileCode2, Wand2 } from 'lucide-react'
import type { ScanIssue } from '../../../services/workspaceScanService'
import type { AIProvider } from '../../../services/aiService'
import { Badge, Button, type Tone } from '../../ui'
import { relativePath } from '../../ide/languages'
import { proposeFix } from './applyFix'

const TYPE_LABEL: Record<ScanIssue['type'], string> = { bug: 'Bug', security: 'Security', performance: 'Performance', improvement: 'Improvement' }
const SEVERITY_TONE: Record<ScanIssue['severity'], Tone> = { critical: 'danger', high: 'danger', medium: 'warning', low: 'neutral' }

interface ReviewIssueProps {
    issue: ScanIssue
    folder: string | null
    mode: 'cloud' | 'offline'
    provider: AIProvider
    cloudModel?: string
}

export function ReviewIssue({ issue, folder, mode, provider, cloudModel }: ReviewIssueProps) {
    const [open, setOpen] = useState(false)
    const [copied, setCopied] = useState(false)
    const [fixState, setFixState] = useState<{ status: 'idle' | 'working' | 'done' | 'error'; message?: string }>({ status: 'idle' })

    const openFile = () => window.dispatchEvent(new CustomEvent('kalynt-open-file', { detail: { path: issue.path, line: issue.line } }))

    const fix = async () => {
        setFixState({ status: 'working' })
        try {
            await proposeFix(issue, mode, provider, cloudModel)
            setFixState({ status: 'done' })
        } catch (e) {
            setFixState({ status: 'error', message: e instanceof Error ? e.message : 'The fix could not be generated.' })
        }
    }

    return (
        <li className={`review-issue review-issue--${issue.severity}`}>
            <button type="button" className="review-issue__head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
                <ChevronRight size={13} className={`review-issue__chev ${open ? 'is-open' : ''}`} aria-hidden />
                <span className="review-issue__desc">{issue.description}</span>
            </button>
            <div className="review-issue__meta">
                <Badge tone={SEVERITY_TONE[issue.severity]}>{issue.severity}</Badge>
                <span>{TYPE_LABEL[issue.type]}</span>
                <button type="button" className="review-issue__file mono truncate" onClick={openFile} title={issue.path}>
                    {relativePath(issue.path, folder)}{issue.line ? `:${issue.line}` : ''}
                </button>
            </div>
            {open && (
                <div className="review-issue__body">
                    <p className="review-issue__label">Suggested fix</p>
                    <p className="review-issue__suggestion selectable">{issue.suggestion}</p>
                    <div className="review-issue__actions">
                        <Button size="sm" variant="ghost" icon={<FileCode2 size={13} />} onClick={openFile}>Open</Button>
                        <Button size="sm" variant="ghost" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={() => {
                            navigator.clipboard.writeText(issue.suggestion)
                            setCopied(true)
                            setTimeout(() => setCopied(false), 1500)
                        }}>{copied ? 'Copied' : 'Copy'}</Button>
                        <Button size="sm" variant="agent" icon={<Wand2 size={13} />} loading={fixState.status === 'working'} onClick={fix}>
                            {fixState.status === 'done' ? 'Fix it again' : 'Propose a fix'}
                        </Button>
                    </div>
                    {fixState.status === 'done' && <p className="review-issue__note">The fix is open in the editor as unsaved changes. Review it, then save.</p>}
                    {fixState.status === 'error' && <p className="review-issue__note is-error">{fixState.message}</p>}
                </div>
            )}
        </li>
    )
}

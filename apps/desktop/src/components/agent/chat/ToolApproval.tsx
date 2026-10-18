/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useRef } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { ToolCallRequest } from '../../../services/ideAgentTools'
import { Button } from '../../ui'
import { describeTool, isRiskyTool } from './toolText'

interface ToolApprovalProps {
    request: ToolCallRequest
    onDecide: (result: { approved: boolean; alwaysAllow: boolean }) => void
}

function formatValue(value: unknown): string {
    if (typeof value === 'string') return value
    try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

/** Asks before the agent changes files or runs commands. */
export function ToolApproval({ request, onDecide }: ToolApprovalProps) {
    const allowRef = useRef<HTMLButtonElement>(null)
    const risky = isRiskyTool(request.toolName)

    useEffect(() => {
        allowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        allowRef.current?.focus({ preventScroll: true })
    }, [request.id])

    return (
        <section className={`tool-approval ${risky ? 'is-risky' : ''}`} aria-label="Approval needed">
            <header className="tool-approval__head">
                <ShieldAlert size={15} aria-hidden />
                <div>
                    <p className="tool-approval__title">The agent wants to {describeTool(request.toolName).toLowerCase()}</p>
                    <p className="tool-approval__hint">
                        {risky ? 'This changes files or runs code on your machine. Review it first.' : 'Review what it will do.'}
                    </p>
                </div>
            </header>
            <dl className="tool-approval__params">
                {Object.entries(request.params).map(([key, value]) => (
                    <div key={key}>
                        <dt>{key}</dt>
                        <dd><pre className="selectable">{formatValue(value).slice(0, 3000)}</pre></dd>
                    </div>
                ))}
            </dl>
            <footer className="tool-approval__actions">
                <Button size="sm" variant="ghost" onClick={() => onDecide({ approved: false, alwaysAllow: false })}>Deny</Button>
                <Button size="sm" onClick={() => onDecide({ approved: true, alwaysAllow: true })} title="Don't ask again for this tool until the panel closes">
                    Allow for this session
                </Button>
                <Button ref={allowRef} size="sm" variant="agent" onClick={() => onDecide({ approved: true, alwaysAllow: false })}>Allow once</Button>
            </footer>
        </section>
    )
}

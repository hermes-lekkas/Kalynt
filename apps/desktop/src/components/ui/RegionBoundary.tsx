/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { logger } from '../../utils/logger'
import './button.css'
import './misc.css'

interface Props {
    /** Name of the region, shown in the fallback ("The terminal stopped working"). */
    name: string
    children: ReactNode
    /** Render a compact single-line fallback for small regions like the status bar. */
    compact?: boolean
}

interface State {
    error: Error | null
}

/**
 * Contains a failure to one region of the interface so the rest of the app
 * keeps working, and offers a way to remount that region.
 */
export class RegionBoundary extends Component<Props, State> {
    state: State = { error: null }

    static getDerivedStateFromError(error: Error): State {
        return { error }
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        logger.general.error(`[${this.props.name}] render failed`, { error, stack: info.componentStack })
    }

    private reset = () => this.setState({ error: null })

    render() {
        const { error } = this.state
        if (!error) return this.props.children

        if (this.props.compact) {
            return (
                <button type="button" className="k-region-error k-region-error--compact" onClick={this.reset} title={error.message}>
                    <AlertTriangle size={12} />
                    <span>{this.props.name} unavailable. Retry</span>
                </button>
            )
        }

        return (
            <div className="k-region-error" role="alert">
                <AlertTriangle size={18} className="k-region-error__icon" />
                <p className="k-region-error__title">{this.props.name} stopped working</p>
                <p className="k-region-error__detail selectable">{error.message}</p>
                <button type="button" className="k-btn k-btn--secondary k-btn--sm" onClick={this.reset}>
                    <RotateCcw size={12} />
                    <span className="k-btn__label">Reload {this.props.name.toLowerCase()}</span>
                </button>
            </div>
        )
    }
}

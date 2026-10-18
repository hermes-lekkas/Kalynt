/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Last-resort boundary around the whole app. Regions use RegionBoundary so a
 * single failure rarely reaches this screen.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { LOGO_URL } from './shell/brand'

interface Props {
    children: ReactNode
}

interface State {
    error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null }

    static getDerivedStateFromError(error: Error): State {
        return { error }
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('[ErrorBoundary] Caught error:', error, errorInfo)
    }

    render() {
        const { error } = this.state
        if (!error) return this.props.children

        return (
            <div className="app-crash" role="alert">
                <img src={LOGO_URL} alt="" width={40} height={40} />
                <h1>Kalynt hit an unexpected error</h1>
                <p>Your files are safe on disk. Reload the window to continue; unsaved editor changes since the last save may be lost.</p>
                <pre className="selectable">{error.message}</pre>
                <button type="button" onClick={() => window.location.reload()}>Reload window</button>
                <style>{`
                    .app-crash {
                        height: 100%;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        gap: 12px;
                        padding: 32px;
                        text-align: center;
                        background: var(--surface, #1a1920);
                        color: var(--text, #eceaf2);
                        font-family: var(--font-ui, system-ui, sans-serif);
                    }
                    .app-crash h1 { font-size: 18px; font-weight: 600; }
                    .app-crash p { max-width: 52ch; color: var(--text-2, #b0adbd); line-height: 1.6; }
                    .app-crash pre {
                        max-width: 640px;
                        max-height: 160px;
                        overflow: auto;
                        padding: 12px 16px;
                        border-radius: 8px;
                        background: var(--bg, #15141a);
                        border: 1px solid var(--line, #2b2a33);
                        color: var(--text-3, #8a8699);
                        font-size: 12px;
                        text-align: left;
                    }
                    .app-crash button {
                        height: 30px;
                        padding: 0 14px;
                        border-radius: 6px;
                        background: var(--primary, #eceaf2);
                        color: var(--on-primary, #15141a);
                        font-weight: 500;
                    }
                `}</style>
            </div>
        )
    }
}

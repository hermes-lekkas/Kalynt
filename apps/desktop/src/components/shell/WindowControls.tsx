/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Window buttons for frameless Windows builds. macOS keeps its native traffic
 * lights and Linux keeps its native frame, so neither renders these.
 */
import { Minus, Square, X } from 'lucide-react'

export function WindowControls() {
    const api = window.electronAPI
    return (
        <div className="window-controls" role="group" aria-label="Window">
            <button type="button" className="window-controls__btn" aria-label="Minimize" title="Minimize" onClick={() => api?.minimizeWindow?.()}>
                <Minus size={14} strokeWidth={1.5} />
            </button>
            <button type="button" className="window-controls__btn" aria-label="Maximize or restore" title="Maximize" onClick={() => api?.maximizeWindow?.()}>
                <Square size={11} strokeWidth={1.5} />
            </button>
            <button type="button" className="window-controls__btn is-close" aria-label="Close window" title="Close" onClick={() => api?.closeWindow?.()}>
                <X size={15} strokeWidth={1.5} />
            </button>
        </div>
    )
}

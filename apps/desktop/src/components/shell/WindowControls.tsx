/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Window buttons for frameless Windows builds. macOS keeps its native traffic
 * lights and Linux keeps its native frame, so neither renders these.
 */
import { useEffect, useState } from 'react'
import { Minus, Square, X } from 'lucide-react'

interface WindowControlBridge {
    window?: {
        isMaximized?: () => Promise<boolean>
        onMaximizedChange?: (cb: (maximized: boolean) => void) => () => void
        minimize?: () => Promise<void>
        maximize?: () => Promise<void>
        close?: () => Promise<void>
    }
    isMaximized?: () => Promise<boolean>
    onMaximizedChange?: (cb: (maximized: boolean) => void) => () => void
    minimizeWindow?: () => Promise<void>
    maximizeWindow?: () => Promise<void>
    closeWindow?: () => Promise<void>
}

function RestoreGlyph() {
    return (
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
            <path d="M3.25 3.25V1.75H9.25V7.75H7.75" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
            <rect x="1.75" y="3.25" width="6" height="6" rx="0.75" stroke="currentColor" strokeWidth="1.25" />
        </svg>
    )
}

function inferMaximized(): boolean {
    if (typeof window === 'undefined' || !window.screen) return false
    return window.outerWidth >= window.screen.availWidth - 2 && window.outerHeight >= window.screen.availHeight - 2
}

export function WindowControls() {
    const api = window.electronAPI as unknown as WindowControlBridge | undefined
    const [maximized, setMaximized] = useState(inferMaximized)

    useEffect(() => {
        let active = true
        const query = api?.window?.isMaximized ?? api?.isMaximized
        const subscribe = api?.window?.onMaximizedChange ?? api?.onMaximizedChange

        if (query) {
            void Promise.resolve(query()).then(v => {
                if (active && typeof v === 'boolean') setMaximized(v)
            }).catch(() => undefined)
        }

        const unsub = typeof subscribe === 'function' ? subscribe(v => {
            if (active) setMaximized(Boolean(v))
        }) : undefined

        const onResize = () => {
            if (!subscribe && active) setMaximized(inferMaximized())
        }
        window.addEventListener('resize', onResize)

        return () => {
            active = false
            window.removeEventListener('resize', onResize)
            if (typeof unsub === 'function') unsub()
        }
    }, [api])

    const handleMinimize = () => {
        void (api?.window?.minimize ?? api?.minimizeWindow)?.()
    }

    const handleMaximize = () => {
        const invoke = api?.window?.maximize ?? api?.maximizeWindow
        const query = api?.window?.isMaximized ?? api?.isMaximized
        void Promise.resolve(invoke?.()).then(() => {
            if (query) {
                return Promise.resolve(query()).then(v => {
                    if (typeof v === 'boolean') setMaximized(v)
                })
            }
            setMaximized(v => !v)
            return undefined
        }).catch(() => undefined)
    }

    const handleClose = () => {
        void (api?.window?.close ?? api?.closeWindow)?.()
    }

    return (
        <div className="window-controls" role="group" aria-label="Window">
            <button type="button" className="window-controls__btn" aria-label="Minimize" title="Minimize" onClick={handleMinimize}>
                <Minus size={14} strokeWidth={1.5} />
            </button>
            <button
                type="button"
                className="window-controls__btn"
                aria-label={maximized ? 'Restore window' : 'Maximize window'}
                title={maximized ? 'Restore' : 'Maximize'}
                onClick={handleMaximize}
            >
                {maximized ? <RestoreGlyph /> : <Square size={10.5} strokeWidth={1.5} />}
            </button>
            <button type="button" className="window-controls__btn is-close" aria-label="Close window" title="Close" onClick={handleClose}>
                <X size={15} strokeWidth={1.5} />
            </button>
        </div>
    )
}

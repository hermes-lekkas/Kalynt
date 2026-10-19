/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Read-only stream for run, build and debug output. When a program is
 * running, keystrokes are echoed and forwarded to its standard input.
 */
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useAppStore } from '../../../stores/appStore'
import { TERMINAL_DARK, TERMINAL_FONT, TERMINAL_LIGHT } from './xtermThemes'
import '@xterm/xterm/css/xterm.css'

interface OutputViewProps {
    content: string
    running: boolean
    visible: boolean
    emptyText: string
    onInput?: (data: string) => void
}

export function OutputView({ content, running, visible, emptyText, onInput }: OutputViewProps) {
    const theme = useAppStore(s => s.theme)
    const hostRef = useRef<HTMLDivElement>(null)
    const termRef = useRef<Terminal | null>(null)
    const fitRef = useRef<FitAddon | null>(null)
    const written = useRef('')
    const live = useRef({ running, onInput })
    live.current = { running, onInput }

    // Create once; later changes reach the instance through refs.
    useEffect(() => {
        const host = hostRef.current
        if (!host) return
        const term = new Terminal({
            fontFamily: TERMINAL_FONT,
            fontSize: 13,
            lineHeight: 1.25,
            convertEol: true,
            disableStdin: false,
            cursorBlink: false,
            cursorStyle: 'bar',
            scrollback: 10000,
            theme: useAppStore.getState().theme === 'light' ? TERMINAL_LIGHT : TERMINAL_DARK
        })
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.loadAddon(new WebLinksAddon((_e, uri) => window.electronAPI?.shell?.openExternal?.(uri)))
        term.open(host)
        term.onData(data => {
            const { running: isRunning, onInput: send } = live.current
            if (!isRunning || !send) return
            term.write(data === '\r' ? '\r\n' : data)
            send(data)
        })
        termRef.current = term
        fitRef.current = fit
        const observer = new ResizeObserver(() => {
            if (host.clientWidth > 0 && host.clientHeight > 0) {
                try { fit.fit() } catch { /* not measurable yet */ }
            }
        })
        observer.observe(host)
        return () => {
            observer.disconnect()
            term.dispose()
            termRef.current = null
            written.current = ''
        }
    }, [])

    useEffect(() => {
        if (termRef.current) termRef.current.options.theme = { ...(theme === 'light' ? TERMINAL_LIGHT : TERMINAL_DARK) }
    }, [theme])

    // Append only what's new; rewrite when the buffer was cleared or replaced.
    useEffect(() => {
        const term = termRef.current
        if (!term) return
        if (content.startsWith(written.current)) {
            const next = content.slice(written.current.length)
            if (next) term.write(next)
        } else {
            term.reset()
            term.write(content)
        }
        written.current = content
    }, [content])

    useEffect(() => {
        if (visible && running) requestAnimationFrame(() => termRef.current?.focus())
    }, [visible, running])

    return (
        <div className="output-view">
            <div className="output-view__host" ref={hostRef} />
            {!content && <p className="output-view__empty">{emptyText}</p>}
        </div>
    )
}

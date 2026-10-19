/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Integrated terminals: one xterm instance and one shell process per tab.
 * Shells are started when the terminal is first shown and stopped when the
 * workspace closes, so no shell processes are left behind.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { v4 as uuidv4 } from 'uuid'
import { useAppStore } from '../../../stores/appStore'
import { TERMINAL_DARK, TERMINAL_FONT, TERMINAL_LIGHT } from './xtermThemes'
import '@xterm/xterm/css/xterm.css'

export interface TerminalTab {
    id: string
    title: string
    shell: string
    cwd: string
    pid?: number
    exited?: boolean
}

interface Instance {
    xterm: Terminal
    fit: FitAddon
    search: SearchAddon
    element: HTMLDivElement
}

const api = () => window.electronAPI?.terminal
const shellName = (shell: string) => shell.split(/[/\\]/).pop()?.replace(/\.exe$/i, '') || 'shell'

export interface TerminalKeyHandlers {
    onSearch: () => void
}

export function useTerminals(folder: string | null, visible: boolean, keys: TerminalKeyHandlers) {
    const theme = useAppStore(s => s.theme)
    const [tabs, setTabs] = useState<TerminalTab[]>([])
    const [activeId, setActiveId] = useState<string | null>(null)
    const instances = useRef(new Map<string, Instance>())
    const hostRef = useRef<HTMLDivElement | null>(null)
    const defaultShell = useRef<string>(window.electronAPI?.platform === 'win32' ? 'powershell.exe' : 'bash')
    const keysRef = useRef(keys)
    keysRef.current = keys
    const themeRef = useRef(theme)
    themeRef.current = theme
    const tabsRef = useRef(tabs)
    tabsRef.current = tabs
    const started = useRef(false)

    useEffect(() => {
        api()?.getDefaultShell?.().then(r => { if (r?.success && r.shell) defaultShell.current = r.shell }).catch(() => undefined)
        api()?.onData?.((data: { id: string; data: string }) => instances.current.get(data.id)?.xterm.write(data.data))
        api()?.onExit?.((data: { id: string; exitCode: number }) => {
            instances.current.get(data.id)?.xterm.write(`\r\n\x1b[2mProcess exited with code ${data.exitCode}. Press any key to close.\x1b[0m\r\n`)
            setTabs(prev => prev.map(t => (t.id === data.id ? { ...t, exited: true } : t)))
        })
        const all = instances.current
        return () => {
            all.forEach((instance, id) => {
                instance.xterm.dispose()
                api()?.kill(id)?.catch?.(() => undefined)
            })
            all.clear()
            api()?.removeListeners?.()
        }
    }, [])

    useEffect(() => {
        const palette = theme === 'light' ? TERMINAL_LIGHT : TERMINAL_DARK
        instances.current.forEach(i => { i.xterm.options.theme = { ...palette } })
    }, [theme])

    const add = useCallback(() => {
        const id = uuidv4()
        const shell = defaultShell.current
        setTabs(prev => {
            const n = prev.filter(t => t.shell === shell).length + 1
            return [...prev, { id, title: n > 1 ? `${shellName(shell)} ${n}` : shellName(shell), shell, cwd: folder ?? '' }]
        })
        setActiveId(id)
        return id
    }, [folder])

    const close = useCallback((id: string) => {
        const instance = instances.current.get(id)
        instance?.xterm.dispose()
        instance?.element.remove()
        instances.current.delete(id)
        api()?.kill(id)?.catch?.(() => undefined)
        setTabs(prev => {
            const index = prev.findIndex(t => t.id === id)
            const next = prev.filter(t => t.id !== id)
            setActiveId(current => (current === id ? next[Math.min(index, next.length - 1)]?.id ?? null : current))
            return next
        })
    }, [])

    // The first time the terminal is shown, start a shell.
    useEffect(() => {
        if (!visible || started.current) return
        started.current = true
        if (tabsRef.current.length === 0) add()
    }, [visible, add])

    const create = useCallback((tab: TerminalTab): Instance => {
        const xterm = new Terminal({
            fontFamily: TERMINAL_FONT,
            fontSize: 13,
            lineHeight: 1.25,
            cursorBlink: true,
            cursorStyle: 'bar',
            allowProposedApi: true,
            scrollback: 5000,
            theme: themeRef.current === 'light' ? TERMINAL_LIGHT : TERMINAL_DARK
        })
        const fit = new FitAddon()
        const search = new SearchAddon()
        xterm.loadAddon(fit)
        xterm.loadAddon(search)
        xterm.loadAddon(new WebLinksAddon((_e, uri) => window.electronAPI?.shell?.openExternal?.(uri)))
        xterm.loadAddon(new Unicode11Addon())
        xterm.unicode.activeVersion = '11'

        const element = document.createElement('div')
        element.className = 'terminal-instance'
        xterm.open(element)

        // Clipboard and search shortcuts that a shell would otherwise swallow.
        xterm.attachCustomKeyEventHandler(e => {
            if (e.type !== 'keydown') return true
            const mod = e.ctrlKey || e.metaKey
            if (mod && e.shiftKey && e.code === 'KeyC') { navigator.clipboard.writeText(xterm.getSelection()); return false }
            if (mod && e.shiftKey && e.code === 'KeyV') {
                navigator.clipboard.readText().then(text => api()?.write({ id: tab.id, data: text }))
                return false
            }
            if (mod && e.shiftKey && e.code === 'KeyF') { keysRef.current.onSearch(); return false }
            if (e.metaKey && e.code === 'KeyC' && xterm.hasSelection()) { navigator.clipboard.writeText(xterm.getSelection()); return false }
            return true
        })

        xterm.onData(data => {
            const current = tabsRef.current.find(t => t.id === tab.id)
            if (current?.exited) { close(tab.id); return }
            api()?.write({ id: tab.id, data })
        })
        xterm.onResize(({ cols, rows }) => api()?.resize({ id: tab.id, cols, rows }))

        const instance = { xterm, fit, search, element }
        instances.current.set(tab.id, instance)

        api()?.spawn({ id: tab.id, cwd: tab.cwd || undefined, shell: tab.shell, cols: xterm.cols, rows: xterm.rows })
            .then(result => {
                if (result?.success && result.pid) setTabs(prev => prev.map(t => (t.id === tab.id ? { ...t, pid: result.pid } : t)))
                else xterm.write(`\x1b[31mThe shell could not start${result?.error ? `: ${result.error}` : ''}.\x1b[0m\r\n`)
            })
            .catch(() => xterm.write('\x1b[31mThe shell could not start.\x1b[0m\r\n'))
        return instance
    }, [close])

    // Attach the active terminal to the host element and keep it sized.
    useEffect(() => {
        const host = hostRef.current
        const tab = tabs.find(t => t.id === activeId)
        if (!host || !tab) return
        const instance = instances.current.get(tab.id) ?? create(tab)
        if (instance.element.parentElement !== host) {
            host.replaceChildren(instance.element)
        }
        const fitNow = () => {
            if (host.clientWidth > 0 && host.clientHeight > 0) {
                try { instance.fit.fit() } catch { /* not measurable yet */ }
            }
        }
        fitNow()
        if (visible) requestAnimationFrame(() => instance.xterm.focus())
        const observer = new ResizeObserver(fitNow)
        observer.observe(host)
        return () => observer.disconnect()
    }, [activeId, tabs, visible, create])

    const active = activeId ? instances.current.get(activeId) ?? null : null

    return {
        tabs, activeId, setActiveId, add, close, hostRef,
        search: active?.search ?? null,
        clear: () => active?.xterm.clear(),
        focus: () => active?.xterm.focus(),
        copySelection: () => { if (active?.xterm.hasSelection()) navigator.clipboard.writeText(active.xterm.getSelection()) },
        paste: async () => {
            if (!activeId) return
            const text = await navigator.clipboard.readText()
            api()?.write({ id: activeId, data: text })
        },
        selectAll: () => active?.xterm.selectAll(),
        sendCommand: (command: string) => { if (activeId) api()?.write({ id: activeId, data: `${command}\r` }) }
    }
}

export type TerminalsApi = ReturnType<typeof useTerminals>

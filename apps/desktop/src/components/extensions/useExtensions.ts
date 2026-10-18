/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * VS Code extensions: installed ones, the marketplace, and their lifecycle.
 */
import { useCallback, useEffect, useState } from 'react'
import { extensionService } from '../../services/extensions/extensionService'
import { marketplaceService } from '../../services/extensions/marketplaceService'
import type { ExtensionGallery, ExtensionMetadata } from '../../types/extensions'
import { confirmAction } from '../ui'

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

export function useExtensions() {
    const [installed, setInstalled] = useState<ExtensionMetadata[]>([])
    const [active, setActive] = useState<Set<string>>(new Set())
    const [popular, setPopular] = useState<ExtensionGallery[]>([])
    const [recommended, setRecommended] = useState<ExtensionGallery[]>([])
    const [results, setResults] = useState<ExtensionGallery[]>([])
    const [loading, setLoading] = useState(false)
    const [searching, setSearching] = useState(false)
    const [busy, setBusy] = useState<Set<string>>(new Set())
    const [error, setError] = useState<string | null>(null)

    const mark = (id: string, on: boolean) => setBusy(prev => {
        const next = new Set(prev)
        if (on) next.add(id)
        else next.delete(id)
        return next
    })

    const loadInstalled = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            setInstalled(await extensionService.scanExtensions())
            setActive(new Set((await extensionService.getActiveExtensions()).map(e => e.id)))
            setRecommended(await extensionService.getRecommendedExtensions())
        } catch (e) {
            setError(errorText(e, "Installed extensions couldn't be read."))
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        loadInstalled()
        marketplaceService.getPopularExtensions(12).then(setPopular).catch(() => undefined)
        const offActivated = extensionService.onActivated(id => { setActive(prev => new Set(prev).add(id)); mark(id, false) })
        const offDeactivated = extensionService.onDeactivated(id => setActive(prev => { const next = new Set(prev); next.delete(id); return next }))
        return () => { offActivated(); offDeactivated() }
    }, [loadInstalled])

    const search = useCallback(async (query: string) => {
        if (!query.trim()) { setResults([]); return }
        setSearching(true)
        try {
            setResults(await extensionService.searchMarketplace({ searchText: query, pageSize: 24 }))
        } catch (e) {
            setError(errorText(e, 'The marketplace search failed.'))
        } finally {
            setSearching(false)
        }
    }, [])

    const install = useCallback(async (ext: ExtensionGallery) => {
        mark(ext.id, true)
        try {
            await extensionService.installFromMarketplace(ext.id)
            await loadInstalled()
        } catch (e) {
            setError(errorText(e, `${ext.displayName} couldn't be installed.`))
        } finally {
            mark(ext.id, false)
        }
    }, [loadInstalled])

    const uninstall = useCallback(async (ext: ExtensionMetadata) => {
        const ok = await confirmAction({ title: `Uninstall ${ext.displayName || ext.name}?`, confirmLabel: 'Uninstall', danger: true })
        if (!ok) return
        try {
            await extensionService.uninstallExtension(ext.id)
            await loadInstalled()
        } catch (e) {
            setError(errorText(e, "The extension couldn't be uninstalled."))
        }
    }, [loadInstalled])

    const toggle = useCallback(async (id: string) => {
        try {
            if (active.has(id)) {
                await extensionService.deactivateExtension(id)
            } else {
                mark(id, true)
                await extensionService.activateExtension(id)
            }
        } catch (e) {
            mark(id, false)
            setError(errorText(e, "The extension couldn't be started."))
        }
    }, [active])

    const installVsix = useCallback(async () => {
        try {
            const result = await window.electronAPI?.ipcRenderer?.invoke('dialog:showOpenDialog', {
                properties: ['openFile'],
                filters: [{ name: 'VS Code extensions', extensions: ['vsix'] }]
            })
            if (result && !result.canceled && result.filePaths?.length) {
                await extensionService.installFromVSIX(result.filePaths[0])
                await loadInstalled()
            }
        } catch (e) {
            setError(errorText(e, "That file couldn't be installed."))
        }
    }, [loadInstalled])

    return {
        installed, active, popular, recommended, results, loading, searching, busy, error,
        clearError: () => setError(null), refresh: loadInstalled, search, install, uninstall, toggle, installVsix
    }
}

export type ExtensionsApi = ReturnType<typeof useExtensions>

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState } from 'react'
import { useLayoutStore, LAYOUT_LIMITS } from '../../stores/layoutStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { Button, confirmAction } from '../ui'
import { SettingRow, SettingsPage, SettingsSection } from './parts'

export function AdvancedSettings() {
    const addNotification = useNotificationStore(s => s.addNotification)
    const [stopping, setStopping] = useState(false)

    const resetLayout = () => {
        const layout = useLayoutStore.getState()
        layout.setSidebarOpen(true)
        layout.setSidebarWidth(LAYOUT_LIMITS.sidebar.default)
        layout.setRightOpen(true)
        layout.setRightWidth(LAYOUT_LIMITS.right.default)
        layout.setBottomOpen(true)
        layout.setBottomHeight(LAYOUT_LIMITS.bottom.default)
        addNotification('Layout reset', 'success')
    }

    const clearCache = async () => {
        const result = await window.electronAPI?.code?.clearCache?.()
        addNotification(result?.success === false ? `Couldn't clear the cache: ${result.error ?? 'unknown error'}` : 'Run cache cleared', result?.success === false ? 'error' : 'success')
    }

    const stopAll = async () => {
        const ok = await confirmAction({
            title: 'Stop every process Kalynt started?',
            message: 'Terminals and everything running in them, programs, builds, debug sessions and package installs are stopped immediately. Programs Kalynt didn’t start are left alone.',
            confirmLabel: 'Stop all processes',
            danger: true
        })
        if (!ok) return
        setStopping(true)
        try {
            const result = await window.electronAPI?.nukeProcesses?.('hard') as { success?: boolean; message?: string } | undefined
            if (result?.success === false) addNotification(`Couldn't stop everything: ${result.message ?? 'unknown error'}`, 'error')
            else addNotification(result?.message ?? 'All processes stopped', 'success')
        } catch (e) {
            addNotification(`Couldn't stop processes: ${e instanceof Error ? e.message : String(e)}`, 'error')
        } finally {
            setStopping(false)
        }
    }

    return (
        <SettingsPage title="Advanced">
            <SettingsSection title="Maintenance">
                <SettingRow label="Reset layout" description="Restores panel sizes and shows the side bar, terminal and agent panel." control={<Button size="sm" onClick={resetLayout}>Reset</Button>} />
                <SettingRow label="Clear run cache" description="Removes compiled output kept to make re-running files faster." control={<Button size="sm" onClick={clearCache}>Clear</Button>} />
            </SettingsSection>
            <SettingsSection title="Stop everything" description="Use this when a program won't stop or a port is stuck.">
                <SettingRow
                    label="Stop all processes"
                    description="Force-quits every terminal, program and server started from Kalynt."
                    control={<Button size="sm" variant="danger" loading={stopping} onClick={stopAll}>Stop all</Button>}
                />
            </SettingsSection>
        </SettingsPage>
    )
}

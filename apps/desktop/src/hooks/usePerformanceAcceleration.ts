/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect } from 'react'
import { logger } from '../utils/logger'

/**
 * usePerformanceAcceleration
 *
 * Hook to handle performance acceleration events from the main process.
 */
export function usePerformanceAcceleration() {
    useEffect(() => {
        // Clear any legacy persisted Monaco override so user editor preferences
        // are never permanently clobbered across restarts.
        try {
            localStorage.removeItem('kalynt-monaco-optimization')
        } catch { /* storage unavailable */ }

        const perfApi = window.electronAPI?.performance
        const fallbackOn = window.electronAPI?.on
        if (!perfApi && !fallbackOn) return

        // Handle Garbage Collection Request
        const onGc = () => {
            logger.general.info('[Performance] GC requested by main process')
            if (typeof (window as any).gc === 'function') {
                try {
                    (window as any).gc()
                } catch (e) {
                    console.error('GC failed', e)
                }
            }
        }
        const removeGcListener = perfApi?.onRequestGc
            ? perfApi.onRequestGc(onGc)
            : fallbackOn!('performance:request-gc', onGc)

        // Handle Suspend Background Tasks
        const onSuspend = () => {
            logger.general.warn('[Performance] Suspending background tasks due to memory pressure')
            window.dispatchEvent(new CustomEvent('kalynt-suspend-background'))
        }
        const removeSuspendListener = perfApi?.onSuspendBackgroundTasks
            ? perfApi.onSuspendBackgroundTasks(onSuspend)
            : fallbackOn!('performance:suspend-background-tasks', onSuspend)

        // Handle Monaco Optimization (session-only; never persisted to localStorage)
        const onOptimize = (options: Record<string, unknown>) => {
            logger.general.info('[Performance] Applying Monaco optimizations', options)
            window.dispatchEvent(new CustomEvent('kalynt-monaco-optimize', { detail: options }))
        }
        const removeMonacoListener = perfApi?.onOptimizeMonaco
            ? perfApi.onOptimizeMonaco(onOptimize)
            : fallbackOn!('performance:optimize-monaco', onOptimize)

        // Handle Worker Disposal
        const onDisposeWorkers = () => {
            logger.general.info('[Performance] Disposing idle workers')
            window.dispatchEvent(new CustomEvent('kalynt-dispose-workers'))
        }
        const removeWorkerListener = perfApi?.onDisposeWorkers
            ? perfApi.onDisposeWorkers(onDisposeWorkers)
            : fallbackOn!('performance:dispose-workers', onDisposeWorkers)

        // RAM Optimization: Proactive idle-time GC loop
        // Runs renderer GC via requestIdleCallback every 10s when the browser is idle,
        // cancelling both the idle callback and the reschedule timer on unmount.
        let disposed = false
        let idleGcHandle: number | null = null
        let idleTimerHandle: ReturnType<typeof setTimeout> | null = null

        const scheduleIdleGc = () => {
            if (disposed) return
            const runGc = () => {
                idleGcHandle = null
                if (disposed) return
                if (typeof (window as any).gc === 'function') {
                    try { (window as any).gc() } catch { /* ignore */ }
                }
                if (!disposed) {
                    idleTimerHandle = setTimeout(() => {
                        idleTimerHandle = null
                        scheduleIdleGc()
                    }, 10_000)
                }
            }
            if (typeof requestIdleCallback === 'function') {
                idleGcHandle = requestIdleCallback(runGc, { timeout: 5_000 })
            } else {
                idleTimerHandle = setTimeout(runGc, 10_000)
            }
        }
        scheduleIdleGc()

        return () => {
            disposed = true
            removeGcListener()
            removeSuspendListener()
            removeMonacoListener()
            removeWorkerListener()
            if (idleGcHandle !== null && typeof cancelIdleCallback === 'function') {
                cancelIdleCallback(idleGcHandle)
                idleGcHandle = null
            }
            if (idleTimerHandle !== null) {
                clearTimeout(idleTimerHandle)
                idleTimerHandle = null
            }
        }
    }, [])

    const setPerformanceMode = async (mode: 'balanced' | 'high_performance' | 'power_saver') => {
        if (window.electronAPI?.performance?.setMode) {
            return await window.electronAPI.performance.setMode(mode)
        }
    }

    const getPerformanceStatus = async () => {
        if (window.electronAPI?.performance?.getStatus) {
            return await window.electronAPI.performance.getStatus()
        }
    }

    return { setPerformanceMode, getPerformanceStatus }
}

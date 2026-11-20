/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'

export type NotificationType = 'info' | 'success' | 'warning' | 'error'

export interface Notification {
    id: string
    type: NotificationType
    message: string
    duration?: number
    closing?: boolean
}

interface TimerEntry {
    timer: ReturnType<typeof setTimeout> | null
    exitTimer: ReturnType<typeof setTimeout> | null
    remaining: number
    startedAt: number
    paused: boolean
}

const EXIT_MS = 180
const MAX_QUEUED = 20
const timers = new Map<string, TimerEntry>()

function clearEntry(id: string) {
    const entry = timers.get(id)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.exitTimer) clearTimeout(entry.exitTimer)
    timers.delete(id)
}

interface NotificationStore {
    notifications: Notification[]
    addNotification: (message: string, type?: NotificationType, duration?: number) => void
    removeNotification: (id: string) => void
    dismissNotification: (id: string) => void
    pauseNotification: (id: string) => void
    resumeNotification: (id: string) => void
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
    notifications: [],

    addNotification: (message, type = 'info', duration = 5000) => {
        const id = uuidv4()
        set((state) => {
            const next = [...state.notifications, { id, type, message, duration }]
            if (next.length > MAX_QUEUED) {
                const dropped = next.splice(0, next.length - MAX_QUEUED)
                dropped.forEach(n => clearEntry(n.id))
            }
            return { notifications: next }
        })

        if (duration > 0) {
            const entry: TimerEntry = {
                timer: setTimeout(() => get().dismissNotification(id), duration),
                exitTimer: null,
                remaining: duration,
                startedAt: Date.now(),
                paused: false
            }
            timers.set(id, entry)
        }
    },

    dismissNotification: (id) => {
        const current = get().notifications.find(n => n.id === id)
        if (!current || current.closing) return

        const entry = timers.get(id)
        if (entry?.timer) {
            clearTimeout(entry.timer)
            entry.timer = null
        }

        set((state) => ({
            notifications: state.notifications.map(n => (n.id === id ? { ...n, closing: true } : n))
        }))

        const exitTimer = setTimeout(() => {
            clearEntry(id)
            set((state) => ({
                notifications: state.notifications.filter(n => n.id !== id)
            }))
        }, EXIT_MS)

        if (entry) {
            entry.exitTimer = exitTimer
        } else {
            timers.set(id, { timer: null, exitTimer, remaining: 0, startedAt: Date.now(), paused: false })
        }
    },

    pauseNotification: (id) => {
        const entry = timers.get(id)
        if (!entry || entry.paused || !entry.timer) return
        clearTimeout(entry.timer)
        entry.timer = null
        entry.remaining = Math.max(400, entry.remaining - (Date.now() - entry.startedAt))
        entry.paused = true
    },

    resumeNotification: (id) => {
        const entry = timers.get(id)
        if (!entry || !entry.paused || entry.exitTimer) return
        entry.paused = false
        entry.startedAt = Date.now()
        entry.timer = setTimeout(() => get().dismissNotification(id), entry.remaining)
    },

    removeNotification: (id) => {
        clearEntry(id)
        set((state) => ({
            notifications: state.notifications.filter((n) => n.id !== id)
        }))
    }
}))

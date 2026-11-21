/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { useNotificationStore, type NotificationType } from '../../stores/notificationStore'

const ICONS: Record<NotificationType, typeof Info> = {
    info: Info,
    success: CheckCircle2,
    warning: AlertTriangle,
    error: AlertCircle
}

/** Transient messages with pause-on-hover and smooth exit transitions. */
export function Toasts() {
    const notifications = useNotificationStore(s => s.notifications)
    const dismissNotification = useNotificationStore(s => s.dismissNotification)
    const pauseNotification = useNotificationStore(s => s.pauseNotification)
    const resumeNotification = useNotificationStore(s => s.resumeNotification)
    const visible = notifications.slice(-4)

    return (
        <div className="toasts" aria-live="polite" aria-relevant="additions">
            {visible.map(n => {
                const Icon = ICONS[n.type]
                return (
                    <div
                        key={n.id}
                        className={`toast toast--${n.type} ${n.closing ? 'is-leaving' : ''}`}
                        role={n.type === 'error' ? 'alert' : 'status'}
                        onMouseEnter={() => pauseNotification(n.id)}
                        onMouseLeave={() => resumeNotification(n.id)}
                        onFocus={() => pauseNotification(n.id)}
                        onBlur={() => resumeNotification(n.id)}
                    >
                        <Icon size={16} className="toast__icon" aria-hidden />
                        <p className="toast__message selectable">{n.message}</p>
                        <button
                            type="button"
                            className="toast__close"
                            aria-label="Dismiss"
                            onClick={() => dismissNotification(n.id)}
                        >
                            <X size={14} />
                        </button>
                    </div>
                )
            })}
        </div>
    )
}

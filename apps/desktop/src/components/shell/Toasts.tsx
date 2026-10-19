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

/** Transient messages. Errors are announced assertively, the rest politely. */
export function Toasts() {
    const { notifications, removeNotification } = useNotificationStore()
    const visible = notifications.slice(-4)

    return (
        <div className="toasts" aria-live="polite" aria-relevant="additions">
            {visible.map(n => {
                const Icon = ICONS[n.type]
                return (
                    <div key={n.id} className={`toast toast--${n.type}`} role={n.type === 'error' ? 'alert' : 'status'}>
                        <Icon size={16} className="toast__icon" aria-hidden />
                        <p className="toast__message selectable">{n.message}</p>
                        <button type="button" className="toast__close" aria-label="Dismiss" onClick={() => removeNotification(n.id)}>
                            <X size={14} />
                        </button>
                    </div>
                )
            })}
        </div>
    )
}

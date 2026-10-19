/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import './button.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'agent'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant
    size?: ButtonSize
    icon?: ReactNode
    iconRight?: ReactNode
    loading?: boolean
    block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { variant = 'secondary', size = 'md', icon, iconRight, loading, block, className, children, disabled, type = 'button', ...rest },
    ref
) {
    const classes = ['k-btn', `k-btn--${variant}`, `k-btn--${size}`, block && 'k-btn--block', className]
        .filter(Boolean)
        .join(' ')

    return (
        <button ref={ref} type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
            {loading ? <Loader2 size={14} className="spin" aria-hidden /> : icon}
            {children !== undefined && children !== null && <span className="k-btn__label">{children}</span>}
            {iconRight}
        </button>
    )
})

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
    /** Accessible name; also shown as the native tooltip. */
    label: string
    icon: ReactNode
    size?: ButtonSize
    /** Renders the pressed state for toggles. */
    active?: boolean
    tone?: 'default' | 'danger' | 'agent'
    /** Small count shown on the corner of the icon. */
    badge?: number
    shortcut?: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
    { label, icon, size = 'md', active, tone = 'default', badge, shortcut, className, type = 'button', ...rest },
    ref
) {
    const classes = ['k-icon-btn', `k-icon-btn--${size}`, `k-icon-btn--${tone}`, active && 'is-active', className]
        .filter(Boolean)
        .join(' ')

    return (
        <button
            ref={ref}
            type={type}
            className={classes}
            aria-label={label}
            title={shortcut ? `${label} (${shortcut})` : label}
            aria-pressed={active === undefined ? undefined : active}
            {...rest}
        >
            {icon}
            {badge !== undefined && badge > 0 && <span className="k-icon-btn__badge">{badge > 99 ? '99+' : badge}</span>}
        </button>
    )
})

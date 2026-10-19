/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Small display primitives: badges, keys, empty states, progress, avatars.
 */
import type { CSSProperties, ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import './misc.css'

export type Tone = 'neutral' | 'agent' | 'success' | 'warning' | 'danger' | 'info'

export function Badge({ tone = 'neutral', children, icon, title }: { tone?: Tone; children: ReactNode; icon?: ReactNode; title?: string }) {
    return (
        <span className={`k-badge k-badge--${tone}`} title={title}>
            {icon}
            {children}
        </span>
    )
}

/** A coloured dot that states connection or activity. Always paired with text. */
export function StatusDot({ tone = 'neutral', pulse }: { tone?: Tone; pulse?: boolean }) {
    return <span className={`k-dot k-dot--${tone} ${pulse ? 'is-pulsing' : ''}`} aria-hidden />
}

export function Kbd({ children }: { children: ReactNode }) {
    return <kbd className="k-kbd">{children}</kbd>
}

export function Spinner({ size = 14, label }: { size?: number; label?: string }) {
    return (
        <span className="k-spinner" role={label ? 'status' : undefined}>
            <Loader2 size={size} className="spin" aria-hidden />
            {label && <span>{label}</span>}
        </span>
    )
}

interface EmptyStateProps {
    icon?: ReactNode
    title: string
    description?: ReactNode
    actions?: ReactNode
    compact?: boolean
}

export function EmptyState({ icon, title, description, actions, compact }: EmptyStateProps) {
    return (
        <div className={`k-empty ${compact ? 'k-empty--compact' : ''}`}>
            {icon && <div className="k-empty__icon" aria-hidden>{icon}</div>}
            <p className="k-empty__title">{title}</p>
            {description && <p className="k-empty__desc">{description}</p>}
            {actions && <div className="k-empty__actions">{actions}</div>}
        </div>
    )
}

interface ProgressProps {
    /** 0–1. Omit for an indeterminate bar. */
    value?: number
    tone?: 'neutral' | 'agent' | 'success' | 'danger'
    label?: string
}

export function ProgressBar({ value, tone = 'neutral', label }: ProgressProps) {
    const indeterminate = value === undefined || Number.isNaN(value)
    const pct = indeterminate ? undefined : Math.round(Math.min(1, Math.max(0, value!)) * 100)
    return (
        <div
            className={`k-progress k-progress--${tone} ${indeterminate ? 'is-indeterminate' : ''}`}
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
        >
            <div className="k-progress__fill" style={indeterminate ? undefined : { width: `${pct}%` }} />
        </div>
    )
}

const PEER_COLORS = 7

/** Stable colour slot for a person, derived from their id or name. */
export function peerColor(seed: string): string {
    let hash = 0
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
    return `var(--peer-${(Math.abs(hash) % PEER_COLORS) + 1})`
}

export function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return '?'
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

interface AvatarProps {
    name: string
    seed?: string
    size?: number
    online?: boolean
    title?: string
}

export function Avatar({ name, seed, size = 24, online, title }: AvatarProps) {
    const style = {
        '--avatar-color': peerColor(seed ?? name),
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.4))
    } as CSSProperties
    return (
        <span className="k-avatar" style={style} title={title ?? name} aria-label={title ?? name} role="img">
            {initials(name)}
            {online !== undefined && <span className={`k-avatar__presence ${online ? 'is-online' : ''}`} />}
        </span>
    )
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
    return (
        <div className="k-section-title">
            <h3>{children}</h3>
            {actions && <div className="k-section-title__actions">{actions}</div>}
        </div>
    )
}

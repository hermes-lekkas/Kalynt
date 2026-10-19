/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import './misc.css'

export interface TabItem<T extends string> {
    id: T
    label: string
    icon?: ReactNode
    /** Small count or status shown after the label. */
    badge?: ReactNode
    disabled?: boolean
}

interface TabsProps<T extends string> {
    items: TabItem<T>[]
    value: T
    onChange: (id: T) => void
    /** `underline` for panel headers, `segmented` for compact toggles. */
    variant?: 'underline' | 'segmented'
    size?: 'sm' | 'md'
    ariaLabel: string
    className?: string
    /** id prefix used to link tabs to their panels via aria-controls. */
    idPrefix?: string
}

export function Tabs<T extends string>({
    items, value, onChange, variant = 'underline', size = 'md', ariaLabel, className, idPrefix
}: TabsProps<T>) {
    const listRef = useRef<HTMLDivElement>(null)

    // Roving focus with arrow keys, as the WAI-ARIA tabs pattern describes.
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const enabled = items.filter(i => !i.disabled)
        const index = enabled.findIndex(i => i.id === value)
        let next = -1
        if (e.key === 'ArrowRight') next = (index + 1) % enabled.length
        else if (e.key === 'ArrowLeft') next = (index - 1 + enabled.length) % enabled.length
        else if (e.key === 'Home') next = 0
        else if (e.key === 'End') next = enabled.length - 1
        if (next === -1) return
        e.preventDefault()
        onChange(enabled[next].id)
        requestAnimationFrame(() => {
            listRef.current?.querySelector<HTMLButtonElement>(`[data-tab-id="${enabled[next].id}"]`)?.focus()
        })
    }

    return (
        <div
            ref={listRef}
            role="tablist"
            aria-label={ariaLabel}
            className={['k-tabs', `k-tabs--${variant}`, `k-tabs--${size}`, className].filter(Boolean).join(' ')}
            onKeyDown={onKeyDown}
        >
            {items.map(item => {
                const selected = item.id === value
                return (
                    <button
                        key={item.id}
                        type="button"
                        role="tab"
                        data-tab-id={item.id}
                        id={idPrefix ? `${idPrefix}-tab-${item.id}` : undefined}
                        aria-controls={idPrefix ? `${idPrefix}-panel-${item.id}` : undefined}
                        aria-selected={selected}
                        tabIndex={selected ? 0 : -1}
                        disabled={item.disabled}
                        className={`k-tab ${selected ? 'is-selected' : ''}`}
                        onClick={() => onChange(item.id)}
                    >
                        {item.icon}
                        <span>{item.label}</span>
                        {item.badge !== undefined && item.badge !== null && item.badge !== 0 && (
                            <span className="k-tab__badge">{item.badge}</span>
                        )}
                    </button>
                )
            })}
        </div>
    )
}

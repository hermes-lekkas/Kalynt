/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Popover, type Anchor, type Placement } from './Popover'

export interface MenuItem {
    label: string
    onSelect: () => void
    icon?: ReactNode
    shortcut?: string
    hint?: string
    danger?: boolean
    disabled?: boolean
    checked?: boolean
}

export type MenuEntry = MenuItem | 'separator' | { heading: string }

interface MenuProps {
    open: boolean
    onClose: () => void
    anchor: Anchor
    items: MenuEntry[]
    placement?: Placement
    width?: number
    ariaLabel?: string
}

function isItem(entry: MenuEntry): entry is MenuItem {
    return typeof entry === 'object' && 'label' in entry
}

export function Menu({ open, onClose, anchor, items, placement = 'bottom-start', width = 220, ariaLabel }: MenuProps) {
    const listRef = useRef<HTMLDivElement>(null)
    const [activeIndex, setActiveIndex] = useState(-1)
    const actionable = items.map((e, i) => (isItem(e) && !e.disabled ? i : -1)).filter(i => i !== -1)

    useEffect(() => {
        if (!open) {
            setActiveIndex(-1)
            return
        }
        // Focus the list so arrow keys work immediately.
        requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }))
    }, [open])

    const select = useCallback((item: MenuItem) => {
        if (item.disabled) return
        onClose()
        item.onSelect()
    }, [onClose])

    const move = (delta: number) => {
        if (actionable.length === 0) return
        const current = actionable.indexOf(activeIndex)
        const next = current === -1
            ? (delta > 0 ? 0 : actionable.length - 1)
            : (current + delta + actionable.length) % actionable.length
        setActiveIndex(actionable[next])
    }

    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
        else if (e.key === 'Home') { e.preventDefault(); setActiveIndex(actionable[0] ?? -1) }
        else if (e.key === 'End') { e.preventDefault(); setActiveIndex(actionable[actionable.length - 1] ?? -1) }
        else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            const entry = items[activeIndex]
            if (entry && isItem(entry)) select(entry)
        } else if (e.key === 'Tab') {
            e.preventDefault()
            onClose()
        }
    }

    return (
        <Popover open={open} onClose={onClose} anchor={anchor} placement={placement} width={width} role="presentation" className="k-menu-pop">
            <div
                ref={listRef}
                className="k-menu"
                role="menu"
                aria-label={ariaLabel}
                tabIndex={-1}
                onKeyDown={onKeyDown}
                aria-activedescendant={activeIndex >= 0 ? `k-menu-item-${activeIndex}` : undefined}
            >
                {items.map((entry, index) => {
                    if (entry === 'separator') return <div key={`sep-${index}`} className="k-menu__sep" role="separator" />
                    if (!isItem(entry)) return <div key={`h-${index}`} className="k-menu__heading">{entry.heading}</div>
                    const classes = ['k-menu__item', entry.danger && 'is-danger', index === activeIndex && 'is-active'].filter(Boolean).join(' ')
                    return (
                        <div
                            key={`${entry.label}-${index}`}
                            id={`k-menu-item-${index}`}
                            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                            aria-checked={entry.checked}
                            aria-disabled={entry.disabled || undefined}
                            className={classes}
                            onMouseEnter={() => !entry.disabled && setActiveIndex(index)}
                            onMouseLeave={() => setActiveIndex(-1)}
                            onClick={() => select(entry)}
                        >
                            <span className="k-menu__icon" aria-hidden>
                                {entry.checked ? <Check size={14} /> : entry.icon}
                            </span>
                            <span className="k-menu__label">
                                {entry.label}
                                {entry.hint && <span className="k-menu__hint">{entry.hint}</span>}
                            </span>
                            {entry.shortcut && <kbd className="k-menu__shortcut">{entry.shortcut}</kbd>}
                        </div>
                    )
                })}
            </div>
        </Popover>
    )
}

/** Convenience state for a menu anchored to the element that opened it. */
export function useMenuAnchor() {
    const [anchor, setAnchor] = useState<Anchor>(null)
    return {
        anchor,
        open: anchor !== null,
        openAt: (e: MouseEvent<HTMLElement>) => setAnchor(e.currentTarget),
        openAtPoint: (e: MouseEvent) => {
            e.preventDefault()
            setAnchor({ x: e.clientX, y: e.clientY })
        },
        toggle: (e: MouseEvent<HTMLElement>) => {
            const target = e.currentTarget
            setAnchor(prev => (prev === target ? null : target))
        },
        close: () => setAnchor(null)
    }
}

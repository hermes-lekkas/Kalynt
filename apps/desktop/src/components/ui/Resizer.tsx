/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import './misc.css'

interface ResizerProps {
    /** Current size in px of the panel this handle resizes. */
    value: number
    onChange: (value: number) => void
    min: number
    max: number
    /** `x` resizes width, `y` resizes height. */
    axis: 'x' | 'y'
    /**
     * 1 when dragging right/down grows the panel (panel is before the handle),
     * -1 when dragging left/up grows it (panel is after the handle).
     */
    direction: 1 | -1
    defaultValue?: number
    label: string
    className?: string
    /** The panel itself; drags start from its rendered size when layout has shrunk it. */
    panelRef?: RefObject<HTMLElement | null>
}

const KEY_STEP = 16

/** A draggable, keyboard-accessible separator between two regions. */
export function Resizer({ value, onChange, min, max, axis, direction, defaultValue, label, className, panelRef }: ResizerProps) {
    const start = useRef<{ pos: number; size: number } | null>(null)
    const clamp = (n: number) => Math.round(Math.min(max, Math.max(min, n)))

    const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        const rect = panelRef?.current?.getBoundingClientRect()
        const size = rect ? Math.round(axis === 'x' ? rect.width : rect.height) : value
        start.current = { pos: axis === 'x' ? e.clientX : e.clientY, size }
        document.body.classList.add(axis === 'x' ? 'is-resizing-x' : 'is-resizing-y')
    }

    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        if (!start.current) return
        const pos = axis === 'x' ? e.clientX : e.clientY
        onChange(clamp(start.current.size + (pos - start.current.pos) * direction))
    }

    const end = (e: PointerEvent<HTMLDivElement>) => {
        if (!start.current) return
        start.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
        document.body.classList.remove('is-resizing-x', 'is-resizing-y')
    }

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const grow = axis === 'x' ? (direction === 1 ? 'ArrowRight' : 'ArrowLeft') : (direction === 1 ? 'ArrowDown' : 'ArrowUp')
        const shrink = axis === 'x' ? (direction === 1 ? 'ArrowLeft' : 'ArrowRight') : (direction === 1 ? 'ArrowUp' : 'ArrowDown')
        if (e.key === grow) { e.preventDefault(); onChange(clamp(value + KEY_STEP)) }
        else if (e.key === shrink) { e.preventDefault(); onChange(clamp(value - KEY_STEP)) }
        else if (e.key === 'Home') { e.preventDefault(); onChange(min) }
        else if (e.key === 'End') { e.preventDefault(); onChange(max) }
    }

    return (
        <div
            role="separator"
            aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
            aria-label={label}
            aria-valuenow={value}
            aria-valuemin={min}
            aria-valuemax={max}
            tabIndex={0}
            className={['k-resizer', `k-resizer--${axis}`, className].filter(Boolean).join(' ')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={onKeyDown}
            onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
            title={defaultValue !== undefined ? `${label}. Double-click to reset.` : label}
        />
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import './misc.css'

export interface ResizerProps {
    /** Current size in px of the panel this handle resizes. */
    value: number
    onChange: (value: number) => void
    /** Optional rAF-throttled live drag callback; falls back to `onChange`. */
    onDrag?: (value: number) => void
    /** Optional callback invoked once with the final clamped value when a drag finishes. */
    onDragEnd?: (value: number) => void
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
export function Resizer({
    value, onChange, onDrag, onDragEnd, min, max, axis, direction, defaultValue, label, className, panelRef
}: ResizerProps) {
    const [dragging, setDragging] = useState(false)
    const start = useRef<{ pos: number; size: number } | null>(null)
    const rafRef = useRef<number | null>(null)
    const pendingRef = useRef<number | null>(null)
    const lastEmittedRef = useRef<number | null>(null)
    const callbacksRef = useRef({ onChange, onDrag, onDragEnd })
    callbacksRef.current = { onChange, onDrag, onDragEnd }

    const clamp = (n: number) => Math.round(Math.min(max, Math.max(min, n)))

    useEffect(() => () => {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
        if (start.current) {
            start.current = null
            document.body.classList.remove('is-resizing-x', 'is-resizing-y')
        }
    }, [])

    const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        const rect = panelRef?.current?.getBoundingClientRect()
        const size = rect ? Math.round(axis === 'x' ? rect.width : rect.height) : value
        start.current = { pos: axis === 'x' ? e.clientX : e.clientY, size }
        pendingRef.current = size
        lastEmittedRef.current = size
        setDragging(true)
        document.body.classList.add(axis === 'x' ? 'is-resizing-x' : 'is-resizing-y')
    }

    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        if (!start.current) return
        const pos = axis === 'x' ? e.clientX : e.clientY
        pendingRef.current = clamp(start.current.size + (pos - start.current.pos) * direction)
        if (rafRef.current !== null) return
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null
            const next = pendingRef.current
            if (next === null || next === lastEmittedRef.current) return
            lastEmittedRef.current = next
            const { onDrag: dragCb, onChange: changeCb } = callbacksRef.current
            ;(dragCb ?? changeCb)(next)
        })
    }

    const end = (e: PointerEvent<HTMLDivElement>) => {
        if (!start.current) return
        start.current = null
        setDragging(false)
        if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current)
            rafRef.current = null
        }
        if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId)
        }
        document.body.classList.remove('is-resizing-x', 'is-resizing-y')
        const finalValue = pendingRef.current
        pendingRef.current = null
        if (finalValue !== null) {
            const { onChange: changeCb, onDrag: dragCb, onDragEnd: dragEndCb } = callbacksRef.current
            if (dragCb || finalValue !== lastEmittedRef.current) {
                changeCb(finalValue)
            }
            dragEndCb?.(finalValue)
        }
        lastEmittedRef.current = null
    }

    const commitStep = (next: number) => {
        onChange(next)
        onDragEnd?.(next)
    }

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const grow = axis === 'x' ? (direction === 1 ? 'ArrowRight' : 'ArrowLeft') : (direction === 1 ? 'ArrowDown' : 'ArrowUp')
        const shrink = axis === 'x' ? (direction === 1 ? 'ArrowLeft' : 'ArrowRight') : (direction === 1 ? 'ArrowUp' : 'ArrowDown')
        if (e.key === grow) { e.preventDefault(); commitStep(clamp(value + KEY_STEP)) }
        else if (e.key === shrink) { e.preventDefault(); commitStep(clamp(value - KEY_STEP)) }
        else if (e.key === 'Home') { e.preventDefault(); commitStep(min) }
        else if (e.key === 'End') { e.preventDefault(); commitStep(max) }
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
            className={['k-resizer', `k-resizer--${axis}`, dragging && 'is-dragging', className].filter(Boolean).join(' ')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={onKeyDown}
            onDoubleClick={() => defaultValue !== undefined && commitStep(defaultValue)}
            title={defaultValue !== undefined ? `${label}. Double-click to reset.` : label}
        />
    )
}

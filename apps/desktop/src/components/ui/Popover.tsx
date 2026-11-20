/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isInsideDeeperLayer, layerZIndex, useLayer } from './layers'
import './overlay.css'

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'left-start'
export type Anchor = HTMLElement | { x: number; y: number } | null

export interface PopoverProps {
    open: boolean
    onClose: () => void
    anchor: Anchor
    placement?: Placement
    offset?: number
    width?: number | 'anchor'
    className?: string
    role?: string
    ariaLabel?: string
    children: ReactNode
    /** Restore focus to the anchor element when the popover closes. */
    restoreFocus?: boolean
}

const MARGIN = 8

function anchorRect(anchor: Anchor): DOMRect | null {
    if (!anchor) return null
    if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect()
    return new DOMRect(anchor.x, anchor.y, 0, 0)
}

function computePosition(rect: DOMRect, size: { w: number; h: number }, placement: Placement, offset: number) {
    const vw = window.innerWidth
    const vh = window.innerHeight
    let top = 0
    let left = 0

    switch (placement) {
        case 'bottom-start': top = rect.bottom + offset; left = rect.left; break
        case 'bottom-end': top = rect.bottom + offset; left = rect.right - size.w; break
        case 'top-start': top = rect.top - offset - size.h; left = rect.left; break
        case 'top-end': top = rect.top - offset - size.h; left = rect.right - size.w; break
        case 'right-start': top = rect.top; left = rect.right + offset; break
        case 'left-start': top = rect.top; left = rect.left - offset - size.w; break
    }

    // Flip horizontally when there is not enough room on the requested side.
    if (placement === 'right-start' && left + size.w > vw - MARGIN && rect.left - offset - size.w >= MARGIN) {
        left = rect.left - offset - size.w
    } else if (placement === 'left-start' && left < MARGIN && rect.right + offset + size.w <= vw - MARGIN) {
        left = rect.right + offset
    } else if ((placement === 'bottom-start' || placement === 'top-start') && left + size.w > vw - MARGIN && rect.right - size.w >= MARGIN) {
        left = rect.right - size.w
    } else if ((placement === 'bottom-end' || placement === 'top-end') && left < MARGIN && rect.left + size.w <= vw - MARGIN) {
        left = rect.left
    }

    // Flip vertically when there is no room on the requested edge.
    if (placement.startsWith('bottom') && top + size.h > vh - MARGIN && rect.top - offset - size.h >= MARGIN) {
        top = rect.top - offset - size.h
    } else if (placement.startsWith('top') && top < MARGIN && rect.bottom + offset + size.h <= vh - MARGIN) {
        top = rect.bottom + offset
    }

    // Clamp safely into the viewport (never producing negative coordinates on narrow viewports).
    const maxLeft = Math.max(MARGIN, vw - size.w - MARGIN)
    const maxTop = Math.max(MARGIN, vh - size.h - MARGIN)
    left = Math.max(MARGIN, Math.min(left, maxLeft))
    top = Math.max(MARGIN, Math.min(top, maxTop))
    return { top, left }
}

export function Popover({
    open, onClose, anchor, placement = 'bottom-start', offset = 6, width, className,
    role = 'dialog', ariaLabel, children, restoreFocus = true
}: PopoverProps) {
    const ref = useRef<HTMLDivElement>(null)
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
    const depth = useLayer(open, onClose)
    const onCloseRef = useRef(onClose)
    onCloseRef.current = onClose

    const reposition = useCallback(() => {
        const el = ref.current
        const rect = anchorRect(anchor)
        if (!el || !rect) return
        setPos(computePosition(rect, { w: el.offsetWidth, h: el.offsetHeight }, placement, offset))
    }, [anchor, placement, offset])

    useLayoutEffect(() => {
        if (!open) {
            setPos(null)
            return
        }
        reposition()
    }, [open, reposition])

    useEffect(() => {
        if (!open) return
        const el = ref.current
        const resizeObserver = new ResizeObserver(() => reposition())
        if (el) resizeObserver.observe(el)

        let scrollRaf: number | null = null

        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as Node
            if (ref.current?.contains(target)) return
            if (anchor instanceof HTMLElement && anchor.contains(target)) return
            if (isInsideDeeperLayer(e.target, depth)) return
            onCloseRef.current()
        }

        const onScroll = (e: Event) => {
            // Allow scrolling inside the popover itself (e.g. long menus).
            if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
            if (!(anchor instanceof HTMLElement)) {
                onCloseRef.current()
                return
            }
            if (!document.contains(anchor)) {
                onCloseRef.current()
                return
            }
            const rect = anchor.getBoundingClientRect()
            if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
                onCloseRef.current()
                return
            }
            if (scrollRaf === null) {
                scrollRaf = requestAnimationFrame(() => {
                    scrollRaf = null
                    reposition()
                })
            }
        }

        const onWindowChange = () => onCloseRef.current()

        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onWindowChange)
        window.addEventListener('blur', onWindowChange)
        return () => {
            if (scrollRaf !== null) cancelAnimationFrame(scrollRaf)
            resizeObserver.disconnect()
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('scroll', onScroll, true)
            window.removeEventListener('resize', onWindowChange)
            window.removeEventListener('blur', onWindowChange)
        }
    }, [open, anchor, depth, reposition])

    // Return focus to the trigger so keyboard users don't lose their place.
    useEffect(() => {
        if (!open || !restoreFocus) return
        const trigger = anchor instanceof HTMLElement ? anchor : null
        return () => {
            if (trigger && document.contains(trigger)) trigger.focus({ preventScroll: true })
        }
    }, [open, anchor, restoreFocus])

    if (!open) return null

    const anchorWidth = anchor instanceof HTMLElement ? anchor.offsetWidth : undefined
    const style: CSSProperties = {
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        zIndex: layerZIndex(depth),
        width: width === 'anchor' ? anchorWidth : width,
        visibility: pos ? 'visible' : 'hidden'
    }

    return createPortal(
        <div
            ref={ref}
            className={['k-popover', className].filter(Boolean).join(' ')}
            style={style}
            role={role}
            aria-label={ariaLabel}
            data-layer-depth={depth}
        >
            {children}
        </div>,
        document.body
    )
}

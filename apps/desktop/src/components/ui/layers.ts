/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * A single stack for every floating layer (menus, popovers, dialogs) so that
 * Escape, outside clicks, and z-index stacking always respect the real open order.
 */
import { useLayoutEffect, useRef } from 'react'

interface Layer {
    id: number
    onEscape: () => void
}

const stack: Layer[] = []
let seq = 0
let installed = false

export const LAYER_Z_BASE = 1000
const LAYER_Z_STEP = 10
const LAYER_Z_MAX_OFFSET = 1800

function handleKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    const top = stack[stack.length - 1]
    if (!top) return
    e.preventDefault()
    e.stopPropagation()
    top.onEscape()
}

function install() {
    if (installed || typeof document === 'undefined') return
    document.addEventListener('keydown', handleKeyDown, true)
    installed = true
}

export function hasOpenLayer(): boolean {
    return stack.length > 0
}

/**
 * Computes a z-index for a layer depth so any Popover/Menu opened from inside
 * a Dialog renders above the dialog scrim, while staying below toasts (3000).
 */
export function layerZIndex(depth: number): number {
    const offset = Math.min(Math.max(1, depth) * LAYER_Z_STEP, LAYER_Z_MAX_OFFSET)
    return LAYER_Z_BASE + offset
}

/**
 * Registers a layer while `active` is true. Returns a strictly monotonic layer
 * id synchronously on the first active frame (never 0 while active), so both
 * `data-layer-depth` and z-index work reliably even across non-LIFO closes.
 */
export function useLayer(active: boolean, onEscape: () => void): number {
    const escapeRef = useRef(onEscape)
    escapeRef.current = onEscape
    const idRef = useRef(0)

    if (active && idRef.current === 0) {
        idRef.current = ++seq
    } else if (!active && idRef.current !== 0) {
        idRef.current = 0
    }

    const depth = active ? idRef.current : 0

    useLayoutEffect(() => {
        if (!active) return
        install()
        const id = idRef.current
        if (id > seq) seq = id
        const layer: Layer = { id, onEscape: () => escapeRef.current() }
        if (!stack.some(l => l.id === id)) {
            stack.push(layer)
            stack.sort((a, b) => a.id - b.id)
        }
        return () => {
            const index = stack.findIndex(l => l.id === id)
            if (index !== -1) stack.splice(index, 1)
            seq = stack.length === 0 ? 0 : stack[stack.length - 1].id
        }
    }, [active])

    return depth
}

/** True when the event target sits inside a layer deeper than `depth`. */
export function isInsideDeeperLayer(target: EventTarget | null, depth: number): boolean {
    if (!(target instanceof Element)) return false
    const host = target.closest<HTMLElement>('[data-layer-depth]')
    if (!host) return false
    return Number(host.dataset.layerDepth) > depth
}

const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
    'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
].join(',')

export function focusableWithin(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter(el => !el.hasAttribute('data-focus-skip') && el.offsetParent !== null)
}

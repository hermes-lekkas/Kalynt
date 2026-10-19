/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * A single stack for every floating layer (menus, popovers, dialogs) so that
 * Escape and outside clicks always close the top-most layer first.
 */
import { useEffect, useRef, useState } from 'react'

interface Layer {
    id: number
    onEscape: () => void
}

const stack: Layer[] = []
let seq = 0
let installed = false

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
 * Registers a layer while `active` is true. Returns the layer's depth, which
 * popovers stamp onto their element to ignore clicks inside deeper layers.
 */
export function useLayer(active: boolean, onEscape: () => void): number {
    const escapeRef = useRef(onEscape)
    escapeRef.current = onEscape
    const [depth, setDepth] = useState(0)

    useEffect(() => {
        if (!active) return
        install()
        const layer: Layer = { id: ++seq, onEscape: () => escapeRef.current() }
        stack.push(layer)
        setDepth(stack.length)
        return () => {
            const index = stack.findIndex(l => l.id === layer.id)
            if (index !== -1) stack.splice(index, 1)
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

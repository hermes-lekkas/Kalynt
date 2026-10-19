/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { IconButton } from './Button'
import { focusableWithin, useLayer } from './layers'
import './overlay.css'

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl'

export interface DialogProps {
    open: boolean
    onClose: () => void
    title: ReactNode
    description?: ReactNode
    size?: DialogSize
    footer?: ReactNode
    children?: ReactNode
    /** Element to focus when the dialog opens; defaults to the first focusable element. */
    initialFocus?: RefObject<HTMLElement>
    /** When false, Escape and the scrim do not close the dialog. */
    dismissible?: boolean
    className?: string
    /** Removes body padding so the content can lay out its own regions. */
    bare?: boolean
    headerActions?: ReactNode
}

export function Dialog({
    open, onClose, title, description, size = 'md', footer, children, initialFocus,
    dismissible = true, className, bare, headerActions
}: DialogProps) {
    const panelRef = useRef<HTMLDivElement>(null)
    const pressStartedOnScrim = useRef(false)
    const titleId = useId()
    const descId = useId()
    const depth = useLayer(open, () => { if (dismissible) onClose() })

    useEffect(() => {
        if (!open) return
        const previous = document.activeElement as HTMLElement | null
        const frame = requestAnimationFrame(() => {
            const panel = panelRef.current
            if (!panel) return
            const target = initialFocus?.current ?? focusableWithin(panel).find(el => !el.classList.contains('k-dialog__close')) ?? panel
            target.focus({ preventScroll: true })
        })
        return () => {
            cancelAnimationFrame(frame)
            if (previous && document.contains(previous)) previous.focus({ preventScroll: true })
        }
    }, [open, initialFocus])

    if (!open) return null

    // Keep Tab inside the dialog.
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== 'Tab' || !panelRef.current) return
        const items = focusableWithin(panelRef.current)
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
        }
    }

    return createPortal(
        <div
            className="k-scrim"
            data-layer-depth={depth}
            onPointerDown={e => { pressStartedOnScrim.current = e.target === e.currentTarget }}
            onClick={e => {
                if (dismissible && pressStartedOnScrim.current && e.target === e.currentTarget) onClose()
            }}
        >
            <div
                ref={panelRef}
                className={['k-dialog', `k-dialog--${size}`, className].filter(Boolean).join(' ')}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={description ? descId : undefined}
                tabIndex={-1}
                onKeyDown={onKeyDown}
            >
                <header className="k-dialog__header">
                    <div className="k-dialog__titles">
                        <h2 id={titleId} className="k-dialog__title">{title}</h2>
                        {description && <p id={descId} className="k-dialog__desc">{description}</p>}
                    </div>
                    {headerActions}
                    {dismissible && (
                        <IconButton className="k-dialog__close" label="Close" icon={<X size={16} />} onClick={onClose} />
                    )}
                </header>
                <div className={bare ? 'k-dialog__bare' : 'k-dialog__body'}>{children}</div>
                {footer && <footer className="k-dialog__footer">{footer}</footer>}
            </div>
        </div>,
        document.body
    )
}

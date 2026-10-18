/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ForwardedRef, type HTMLAttributes, type ReactNode } from 'react'

export interface VirtualListHandle {
    /** Scrolls just enough to bring the row at `index` into view. */
    scrollToIndex: (index: number) => void
    element: HTMLDivElement | null
}

interface VirtualListProps<T> extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
    items: T[]
    rowHeight: number
    renderRow: (item: T, index: number) => ReactNode
    overscan?: number
}

/** Fixed-height windowed list: renders only the rows in view. */
function VirtualListInner<T>(
    { items, rowHeight, renderRow, overscan = 8, style, ...rest }: VirtualListProps<T>,
    ref: ForwardedRef<VirtualListHandle>
) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const [scrollTop, setScrollTop] = useState(0)
    const [height, setHeight] = useState(0)

    useEffect(() => {
        const el = scrollRef.current
        if (!el) return
        const observer = new ResizeObserver(entries => setHeight(entries[0].contentRect.height))
        observer.observe(el)
        return () => observer.disconnect()
    }, [])

    useImperativeHandle(ref, () => ({
        element: scrollRef.current,
        scrollToIndex: (index: number) => {
            const el = scrollRef.current
            if (!el || index < 0) return
            const top = index * rowHeight
            if (top < el.scrollTop) el.scrollTop = top
            else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight
        }
    }), [rowHeight])

    const total = items.length * rowHeight
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
    const end = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + overscan)

    return (
        <div
            ref={scrollRef}
            style={{ overflowY: 'auto', position: 'relative', ...style }}
            onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
            {...rest}
        >
            <div style={{ height: total, position: 'relative' }}>
                <div style={{ position: 'absolute', top: start * rowHeight, left: 0, right: 0 }}>
                    {items.slice(start, end).map((item, i) => renderRow(item, start + i))}
                </div>
            </div>
        </div>
    )
}

export const VirtualList = forwardRef(VirtualListInner) as <T>(
    props: VirtualListProps<T> & { ref?: ForwardedRef<VirtualListHandle> }
) => ReturnType<typeof VirtualListInner>

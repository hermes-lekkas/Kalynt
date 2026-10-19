/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Message box shared by the agent chat and team chat: grows with its
 * content, sends on Enter, and offers @-mentions for files and people.
 * File mentions read as "@name" while typing and expand to their full link
 * when the message is sent.
 */
import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUp, FileText, Square, User, X } from 'lucide-react'

export interface MentionOption {
    kind: 'file' | 'person'
    label: string
    /** Text sent in place of the "@query". */
    insert: string
    detail?: string
}

export interface ComposerHandle {
    focus: () => void
    mention: (option: MentionOption) => void
}

interface ComposerProps {
    value: string
    onChange: (value: string) => void
    /** Receives the message with mentions expanded. */
    onSubmit: (text: string) => void
    onStop?: () => void
    busy?: boolean
    disabled?: boolean
    placeholder: string
    mentionOptions: (query: string) => MentionOption[]
    footer?: ReactNode
    banner?: ReactNode
    onDismissBanner?: () => void
    sendLabel?: string
    onTyping?: () => void
}

const MAX_MENTIONS = 8

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
    { value, onChange, onSubmit, onStop, busy, disabled, placeholder, mentionOptions, footer, banner, onDismissBanner, sendLabel = 'Send', onTyping },
    ref
) {
    const areaRef = useRef<HTMLTextAreaElement | null>(null)
    const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
    const [index, setIndex] = useState(0)
    /** Short token shown in the box, mapped to the link that is sent. */
    const links = useRef(new Map<string, string>())

    const tokenFor = (option: MentionOption): string => {
        if (option.kind !== 'file') return option.insert
        const candidates = [`@${option.label}`, option.detail?.includes('/') ? `@${option.detail}` : null].filter(Boolean) as string[]
        let token = candidates.find(t => !links.current.has(t) || links.current.get(t) === option.insert)
        for (let n = 2; !token; n++) {
            const t = `@${option.label}~${n}`
            if (!links.current.has(t) || links.current.get(t) === option.insert) token = t
        }
        links.current.set(token, option.insert)
        return token
    }

    const expand = (text: string) => [...links.current.entries()]
        .sort((a, b) => b[0].length - a[0].length)
        .reduce((out, [token, link]) => out.replace(new RegExp(`${escapeRe(token)}(?=$|[\\s,;:!?)]|\\.(?:\\s|$))`, 'g'), () => link), text)

    const submit = () => {
        if (busy || disabled || !value.trim()) return
        onSubmit(expand(value))
        links.current.clear()
    }

    useImperativeHandle(ref, () => ({
        focus: () => areaRef.current?.focus(),
        mention: (option: MentionOption) => {
            const text = tokenFor(option)
            const el = areaRef.current
            const pos = el?.selectionStart ?? value.length
            const needsSpace = pos > 0 && !/\s$/.test(value.slice(0, pos))
            const next = `${value.slice(0, pos)}${needsSpace ? ' ' : ''}${text} ${value.slice(pos)}`
            onChange(next)
            requestAnimationFrame(() => {
                el?.focus()
                const caret = pos + (needsSpace ? 1 : 0) + text.length + 1
                el?.setSelectionRange(caret, caret)
            })
        }
    }), [value, onChange])

    const options = useMemo(() => (mention ? mentionOptions(mention.query).slice(0, MAX_MENTIONS) : []), [mention, mentionOptions])

    const detectMention = (text: string, caret: number) => {
        const before = text.slice(0, caret)
        const match = before.match(/(^|\s)@([\w./-]*)$/)
        if (match) {
            setMention({ query: match[2], start: caret - match[2].length - 1 })
            setIndex(0)
        } else {
            setMention(null)
        }
    }

    const choose = (option: MentionOption) => {
        if (!mention) return
        const el = areaRef.current
        const caret = el?.selectionStart ?? value.length
        const text = tokenFor(option)
        const next = `${value.slice(0, mention.start)}${text} ${value.slice(caret)}`
        onChange(next)
        setMention(null)
        requestAnimationFrame(() => {
            const pos = mention.start + text.length + 1
            el?.focus()
            el?.setSelectionRange(pos, pos)
        })
    }

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (mention && options.length > 0) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => (i + 1) % options.length); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => (i - 1 + options.length) % options.length); return }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(options[index]); return }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMention(null); return }
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
        }
    }

    // Grow with the content up to a limit, then scroll.
    const autosize = (el: HTMLTextAreaElement | null) => {
        if (!el) return
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, 220)}px`
    }

    return (
        <div className={`composer ${disabled ? 'is-disabled' : ''}`}>
            {mention && options.length > 0 && (
                <ul className="composer__mentions" role="listbox" aria-label="Mention suggestions">
                    {options.map((option, i) => (
                        <li key={`${option.kind}-${option.insert}`} role="option" aria-selected={i === index}>
                            <button
                                type="button"
                                className={`composer__mention ${i === index ? 'is-active' : ''}`}
                                onMouseDown={e => e.preventDefault()}
                                onMouseEnter={() => setIndex(i)}
                                onClick={() => choose(option)}
                            >
                                {option.kind === 'file' ? <FileText size={13} aria-hidden /> : <User size={13} aria-hidden />}
                                <span className="composer__mention-label">{option.label}</span>
                                {option.detail && <span className="composer__mention-detail truncate">{option.detail}</span>}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {banner && (
                <div className="composer__banner">
                    <div className="composer__banner-body">{banner}</div>
                    {onDismissBanner && (
                        <button type="button" className="composer__banner-close" aria-label="Cancel reply" onClick={onDismissBanner}><X size={13} /></button>
                    )}
                </div>
            )}
            <textarea
                ref={el => { areaRef.current = el; autosize(el) }}
                className="composer__input"
                rows={1}
                value={value}
                placeholder={placeholder}
                disabled={disabled}
                aria-label={placeholder}
                onChange={e => {
                    onChange(e.target.value)
                    detectMention(e.target.value, e.target.selectionStart)
                    autosize(e.target)
                    onTyping?.()
                }}
                onKeyDown={onKeyDown}
                onBlur={() => setTimeout(() => setMention(null), 120)}
            />
            <div className="composer__footer">
                <div className="composer__footer-start">{footer}</div>
                {busy && onStop ? (
                    <button type="button" className="composer__send is-stop" onClick={onStop} aria-label="Stop the agent" title="Stop">
                        <Square size={12} fill="currentColor" aria-hidden />
                    </button>
                ) : (
                    <button
                        type="button"
                        className="composer__send"
                        onClick={submit}
                        disabled={disabled || busy || !value.trim()}
                        aria-label={sendLabel}
                        title={`${sendLabel} (Enter)`}
                    >
                        <ArrowUp size={15} aria-hidden />
                    </button>
                )}
            </div>
        </div>
    )
})

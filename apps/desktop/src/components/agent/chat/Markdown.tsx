/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * A small Markdown renderer for chat. It builds React elements directly —
 * no HTML strings — so model output can never inject markup.
 */
import { useState, type ReactNode } from 'react'
import { Check, Copy, FileText } from 'lucide-react'

export const TAG_CLICK_EVENT = 'kalynt-tag-click'

type Block =
    | { kind: 'code'; lang: string; text: string }
    | { kind: 'heading'; level: number; text: string }
    | { kind: 'list'; ordered: boolean; items: string[] }
    | { kind: 'quote'; text: string }
    | { kind: 'rule' }
    | { kind: 'para'; text: string }

function parseBlocks(source: string): Block[] {
    const lines = source.replace(/\r\n/g, '\n').split('\n')
    const blocks: Block[] = []
    let i = 0
    while (i < lines.length) {
        const line = lines[i]
        const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/)
        if (fence) {
            const body: string[] = []
            i++
            while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
            i++
            blocks.push({ kind: 'code', lang: fence[1], text: body.join('\n') })
            continue
        }
        if (!line.trim()) { i++; continue }
        const heading = line.match(/^(#{1,4})\s+(.*)$/)
        if (heading) { blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] }); i++; continue }
        if (/^\s*(---|\*\*\*)\s*$/.test(line)) { blocks.push({ kind: 'rule' }); i++; continue }
        if (/^\s*>/.test(line)) {
            const body: string[] = []
            while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
            blocks.push({ kind: 'quote', text: body.join('\n') })
            continue
        }
        const listMatch = line.match(/^\s*([-*•]|\d+[.)])\s+/)
        if (listMatch) {
            const ordered = /\d/.test(listMatch[1])
            const items: string[] = []
            while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
                let item = lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, '')
                while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) item += ` ${lines[i++].trim()}`
                items.push(item)
            }
            blocks.push({ kind: 'list', ordered, items })
            continue
        }
        const body: string[] = []
        while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^(#{1,4})\s/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
            body.push(lines[i++])
        }
        blocks.push({ kind: 'para', text: body.join('\n') })
    }
    return blocks
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(@\[[^\]\n]+\]\([a-z0-9]+:\/\/[^)\n]+\))|(@[A-Za-z0-9_.-]+)|((?<![\w*])\*[^*\s][^*\n]*\*(?![\w*]))|((?<!\w)_[^_\s][^_\n]*_(?!\w))/g

function renderInline(text: string, keyPrefix: string): ReactNode[] {
    const out: ReactNode[] = []
    let last = 0
    let n = 0
    for (const m of text.matchAll(INLINE)) {
        const index = m.index ?? 0
        if (index > last) out.push(text.slice(last, index))
        const token = m[0]
        const key = `${keyPrefix}-${n++}`
        if (m[1]) out.push(<code key={key} className="md-code">{token.slice(1, -1)}</code>)
        else if (m[2]) out.push(<strong key={key}>{token.slice(2, -2)}</strong>)
        else if (m[3]) out.push(<del key={key}>{token.slice(2, -2)}</del>)
        else if (m[4]) {
            const label = token.slice(1, token.indexOf(']('))
            const href = m[5]
            out.push(
                <a key={key} href={href} onClick={e => { e.preventDefault(); window.electronAPI?.shell?.openExternal?.(href) }}>{label}</a>
            )
        } else if (m[6]) {
            const parsed = /^@\[([^\]]+)\]\(([a-z0-9]+):\/\/(.+)\)$/.exec(token)
            if (parsed) {
                const [, name, type, path] = parsed
                out.push(
                    <button
                        key={key}
                        type="button"
                        className="md-mention md-mention--file"
                        title={path}
                        onClick={() => window.dispatchEvent(new CustomEvent(TAG_CLICK_EVENT, { detail: { type, path } }))}
                    >
                        <FileText size={11} aria-hidden />{name}
                    </button>
                )
            } else out.push(token)
        } else if (m[7]) out.push(<span key={key} className="md-mention">{token}</span>)
        else if (m[8] || m[9]) out.push(<em key={key}>{token.slice(1, -1)}</em>)
        last = index + token.length
    }
    if (last < text.length) out.push(text.slice(last))
    return out
}

function withBreaks(text: string, key: string): ReactNode[] {
    return text.split('\n').flatMap((line, i, all) => {
        const parts = renderInline(line, `${key}-${i}`)
        return i < all.length - 1 ? [...parts, <br key={`${key}-br-${i}`} />] : parts
    })
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
    const [copied, setCopied] = useState(false)
    return (
        <figure className="md-pre">
            <figcaption className="md-pre__head">
                <span>{lang || 'code'}</span>
                <button
                    type="button"
                    className="md-pre__copy"
                    onClick={() => {
                        navigator.clipboard.writeText(text)
                        setCopied(true)
                        setTimeout(() => setCopied(false), 1500)
                    }}
                >
                    {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                    {copied ? 'Copied' : 'Copy'}
                </button>
            </figcaption>
            <pre><code>{text}</code></pre>
        </figure>
    )
}

export function Markdown({ text, className }: { text: string; className?: string }) {
    const blocks = parseBlocks(text)
    return (
        <div className={['md', className].filter(Boolean).join(' ')}>
            {blocks.map((block, i) => {
                const key = `b${i}`
                switch (block.kind) {
                    case 'code': return <CodeBlock key={key} lang={block.lang} text={block.text} />
                    case 'heading': {
                        const Tag = (block.level <= 2 ? 'h3' : 'h4') as 'h3' | 'h4'
                        return <Tag key={key} className="md-heading">{renderInline(block.text, key)}</Tag>
                    }
                    case 'list': {
                        const List = block.ordered ? 'ol' : 'ul'
                        return <List key={key}>{block.items.map((item, j) => <li key={j}>{renderInline(item, `${key}-${j}`)}</li>)}</List>
                    }
                    case 'quote': return <blockquote key={key}>{withBreaks(block.text, key)}</blockquote>
                    case 'rule': return <hr key={key} />
                    default: return <p key={key}>{withBreaks(block.text, key)}</p>
                }
            })}
        </div>
    )
}

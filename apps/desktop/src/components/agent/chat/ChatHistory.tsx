/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useRef, useState } from 'react'
import { History, Pencil, Plus, Trash2 } from 'lucide-react'
import { IconButton, Popover, SearchInput, confirmAction, promptText } from '../../ui'
import { sessionLabel, type AgentChatApi } from './useAgentChat'

function when(ts: number): string {
    const d = new Date(ts)
    const today = new Date()
    return d.toDateString() === today.toDateString()
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const messageCount = (n: number) => n === 0 ? 'Empty' : `${n} ${n === 1 ? 'message' : 'messages'}`

export function ChatHistory({ chat }: { chat: AgentChatApi }) {
    const triggerRef = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const q = query.trim().toLowerCase()
    const list = q ? chat.sessions.filter(s => s.title.toLowerCase().includes(q)) : chat.sessions

    return (
        <>
            <IconButton ref={triggerRef} size="sm" label="Conversations" icon={<History size={14} />} onClick={() => setOpen(o => !o)} aria-expanded={open} disabled={chat.running} />
            <Popover open={open} onClose={() => setOpen(false)} anchor={triggerRef.current} placement="bottom-end" width={300} ariaLabel="Conversations">
                <div className="chat-history">
                    <div className="chat-history__top">
                        <SearchInput size="sm" value={query} onChange={setQuery} placeholder="Find a conversation" autoFocus />
                        <IconButton size="sm" label="New conversation" icon={<Plus size={14} />} onClick={() => { chat.newChat(); setOpen(false) }} />
                    </div>
                    <ul className="chat-history__list">
                        {list.map(s => (
                            <li key={s.id} className={`chat-history__row ${s.id === chat.session?.id ? 'is-current' : ''}`}>
                                <button type="button" className="chat-history__open" onClick={() => { chat.selectSession(s.id); setOpen(false) }}>
                                    <span className="truncate">{sessionLabel(s.title)}</span>
                                    <span className="chat-history__meta">{messageCount(s.messages.length)}, {when(s.lastModified)}</span>
                                </button>
                                <IconButton size="sm" label="Rename" icon={<Pencil size={12} />} onClick={async () => {
                                    const title = await promptText({ title: 'Rename conversation', label: 'Title', initialValue: s.title, confirmLabel: 'Rename' })
                                    if (title) chat.renameSession(s.id, title)
                                }} />
                                <IconButton size="sm" tone="danger" label="Delete" icon={<Trash2 size={12} />} onClick={async () => {
                                    const ok = await confirmAction({ title: `Delete “${sessionLabel(s.title)}”?`, message: 'The conversation is removed from this machine.', confirmLabel: 'Delete', danger: true })
                                    if (ok) chat.deleteSession(s.id)
                                }} />
                            </li>
                        ))}
                        {list.length === 0 && <li className="chat-history__empty">{q ? 'No conversation matches.' : 'No conversations yet.'}</li>}
                    </ul>
                </div>
            </Popover>
        </>
    )
}

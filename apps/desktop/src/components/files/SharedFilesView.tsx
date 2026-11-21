/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useMemo, useRef, useState, type DragEvent } from 'react'
import { Download, FileArchive, FileCode2, FileImage, FileText, FileVideo, File as FileIcon, Trash2, Upload, Users } from 'lucide-react'
import type { Space } from '../../stores/appStore'
import type { SharedFile } from '../../services/fileTransferService'
import { useUiStore } from '../../stores/uiStore'
import { Avatar, Badge, Button, EmptyState, IconButton, ProgressBar, SearchInput, Select, Tabs } from '../ui'
import { MAX_SHARE_MB, useSharedFiles } from './useSharedFiles'
import '../workspace/workspace.css'
import './files.css'

type Category = 'all' | 'images' | 'documents' | 'code' | 'media' | 'archives'
type Sort = 'date' | 'name' | 'size'

function categorize(type: string, name: string): Exclude<Category, 'all'> | 'other' {
    const t = type.toLowerCase()
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    if (t.startsWith('image/')) return 'images'
    if (t.startsWith('video/') || t.startsWith('audio/')) return 'media'
    if (/zip|rar|tar|7z|gzip/.test(t) || ['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return 'archives'
    if (/json|javascript|typescript|python|x-sh|xml/.test(t) || ['ts', 'tsx', 'js', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'json', 'yml', 'yaml', 'sh'].includes(ext)) return 'code'
    if (/pdf|word|text|sheet|excel|presentation|markdown/.test(t) || ['md', 'txt', 'pdf', 'doc', 'docx'].includes(ext)) return 'documents'
    return 'other'
}

const ICON = { images: FileImage, media: FileVideo, archives: FileArchive, code: FileCode2, documents: FileText, other: FileIcon }

function size(bytes: number): string {
    if (!bytes) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
    return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`
}

function transferBadge(file: SharedFile, mine: boolean): { label: string; tone: 'neutral' | 'warning' | 'danger' | 'success'; detail?: string } {
    const received = file.receivedChunks ?? 0
    const total = file.totalChunks ?? file.chunkCount ?? 1
    switch (file.transferState) {
        case 'local-only':
            return { label: 'Local only', tone: 'neutral', detail: 'Waiting for peers to connect' }
        case 'sending':
            return { label: 'Sending', tone: 'warning', detail: `${received}/${total} chunks` }
        case 'receiving':
            return { label: 'Receiving', tone: 'warning', detail: `${received}/${total} chunks` }
        case 'incomplete':
            return { label: 'Incomplete', tone: 'danger', detail: `${received}/${total} chunks · sender offline before completion` }
        case 'ready':
        default:
            return { label: mine ? 'Synced' : 'Ready', tone: 'success' }
    }
}

export default function SharedFilesView({ space }: { space: Space }) {
    const s = useSharedFiles(space.id)
    const openCollaboration = useUiStore(st => st.openCollaboration)
    const inputRef = useRef<HTMLInputElement>(null)
    const [query, setQuery] = useState('')
    const [category, setCategory] = useState<Category>('all')
    const [sort, setSort] = useState<Sort>('date')
    const [dragging, setDragging] = useState(false)

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase()
        return s.files
            .filter(f => (!q || f.name.toLowerCase().includes(q)) && (category === 'all' || categorize(f.type, f.name) === category))
            .sort((a, b) => sort === 'date' ? b.uploadedAt - a.uploadedAt : sort === 'size' ? b.size - a.size : a.name.localeCompare(b.name))
    }, [s.files, query, category, sort])

    const onDrop = (e: DragEvent) => {
        e.preventDefault()
        setDragging(false)
        if (s.canShare && e.dataTransfer.files.length) s.share(e.dataTransfer.files)
    }

    if (s.isBanned) return <EmptyState title="You can’t access shared files" description="You were banned from this workspace." />

    const row = (file: SharedFile) => {
        const Icon = ICON[categorize(file.type, file.name)]
        const mine = file.ownerId === s.localUserId
        const status = transferBadge(file, mine)
        const total = file.totalChunks ?? file.chunkCount ?? 1
        const received = file.receivedChunks ?? 0
        const chunkPct = total > 1 ? Math.round((received / total) * 100) : undefined
        const pct = s.progress[file.id] ?? (file.transferState === 'receiving' || file.transferState === 'sending' ? chunkPct : undefined)
        const canDownload = file.transferState === 'ready' || file.transferState === 'local-only' || !file.transferState

        return (
            <li key={file.id} className="shared-row">
                <Icon size={18} className="shared-row__icon" strokeWidth={1.6} aria-hidden />
                <div className="shared-row__main">
                    <span className="shared-row__name truncate" title={file.name}>{file.name}</span>
                    <span className="shared-row__meta" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span>
                            {size(file.size)}, shared {new Date(file.uploadedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </span>
                        <Badge tone={status.tone}>{status.label}</Badge>
                        {status.detail && <span>{status.detail}</span>}
                    </span>
                    {(file.transferState === 'sending' || file.transferState === 'receiving') && pct !== undefined && pct < 100 && (
                        <ProgressBar value={pct / 100} tone="agent" label={`${status.label} ${file.name}`} />
                    )}
                </div>
                <span className="shared-row__owner">
                    <Avatar name={file.uploadedBy || 'Someone'} size={20} />
                    {mine ? 'You' : file.uploadedBy}
                </span>
                <div className="shared-row__actions">
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<Download size={13} />}
                        loading={s.downloading === file.id}
                        disabled={!canDownload}
                        title={canDownload ? `Download ${file.name}` : status.detail || status.label}
                        onClick={() => s.download(file)}
                    >
                        Download
                    </Button>
                    {(mine || s.isAdmin) && <IconButton size="sm" tone="danger" label={`Remove ${file.name}`} icon={<Trash2 size={13} />} onClick={() => s.remove(file)} />}
                </div>
            </li>
        )
    }

    return (
        <div
            className={`page shared ${dragging ? 'is-dragging' : ''}`}
            onDragOver={e => { if (s.canShare && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
            onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false) }}
            onDrop={onDrop}
        >
            <header className="page__header">
                <div className="page__titles">
                    <h1 className="page__title">Shared files</h1>
                    <p className="page__subtitle">
                        Files sent straight to the people in {space.name}, up to {MAX_SHARE_MB} MB each. {s.peerCount > 0 ? `${s.peerCount} ${s.peerCount === 1 ? 'person is' : 'people are'} connected.` : 'Nobody else is connected right now; files stay local until peers join.'}
                    </p>
                </div>
                <div className="page__actions">
                    {s.isAdmin && s.files.length > 0 && <Button variant="ghost" onClick={s.clearAll}>Remove all</Button>}
                    {s.canShare && <Button variant="primary" icon={<Upload size={14} />} loading={s.sharing} onClick={() => inputRef.current?.click()}>Share files</Button>}
                    <input ref={inputRef} type="file" multiple hidden onChange={e => { if (e.target.files) s.share(e.target.files); e.target.value = '' }} />
                </div>
            </header>

            {s.files.length > 0 && (
                <div className="page__toolbar">
                    <SearchInput size="sm" value={query} onChange={setQuery} placeholder="Find a file" aria-label="Find a file" />
                    <Tabs
                        variant="segmented"
                        size="sm"
                        ariaLabel="File type"
                        value={category}
                        onChange={setCategory}
                        items={[{ id: 'all', label: 'All' }, { id: 'documents', label: 'Documents' }, { id: 'images', label: 'Images' }, { id: 'code', label: 'Code' }, { id: 'media', label: 'Media' }, { id: 'archives', label: 'Archives' }]}
                    />
                    <span className="page__toolbar-spacer" />
                    <Select size="sm" value={sort} onChange={e => setSort(e.target.value as Sort)} aria-label="Sort by">
                        <option value="date">Newest first</option>
                        <option value="name">Name</option>
                        <option value="size">Largest first</option>
                    </Select>
                </div>
            )}

            <div className="page__body">
                {s.files.length === 0 ? (
                    <div className="shared__drop">
                        <EmptyState
                            icon={<Upload size={28} />}
                            title={s.canShare ? 'Drop files here to share them' : 'No shared files yet'}
                            description={s.canShare ? 'They are encrypted when the workspace has a room password, and never pass through a server.' : 'Your role can view and download shared files.'}
                            actions={<>
                                {s.canShare && <Button variant="primary" onClick={() => inputRef.current?.click()}>Choose files</Button>}
                                {s.peerCount === 0 && <Button icon={<Users size={14} />} onClick={() => openCollaboration('invite')}>Invite people</Button>}
                            </>}
                        />
                    </div>
                ) : visible.length === 0 ? (
                    <EmptyState compact title="No files match" />
                ) : (
                    <ul className="shared__list">{visible.map(row)}</ul>
                )}
            </div>
            {dragging && <div className="shared__overlay" aria-hidden><Upload size={28} /> Drop to share with the workspace</div>}
        </div>
    )
}

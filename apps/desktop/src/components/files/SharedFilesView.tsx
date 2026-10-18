/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useMemo, useRef, useState, type DragEvent } from 'react'
import { Download, FileArchive, FileCode2, FileImage, FileText, FileVideo, File as FileIcon, Trash2, Upload, Users } from 'lucide-react'
import type { Space } from '../../stores/appStore'
import type { SharedFile } from '../../services/fileTransferService'
import { useUiStore } from '../../stores/uiStore'
import { Avatar, Button, EmptyState, IconButton, ProgressBar, SearchInput, Select, Tabs } from '../ui'
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
        const pct = s.progress[file.id]
        const mine = file.ownerId === s.localUserId
        return (
            <li key={file.id} className="shared-row">
                <Icon size={18} className="shared-row__icon" strokeWidth={1.6} aria-hidden />
                <div className="shared-row__main">
                    <span className="shared-row__name truncate" title={file.name}>{file.name}</span>
                    <span className="shared-row__meta">
                        {size(file.size)}, shared {new Date(file.uploadedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                    {pct !== undefined && pct < 100 && <ProgressBar value={pct / 100} tone="agent" label={`Transferring ${file.name}`} />}
                </div>
                <span className="shared-row__owner">
                    <Avatar name={file.uploadedBy || 'Someone'} size={20} />
                    {mine ? 'You' : file.uploadedBy}
                </span>
                <div className="shared-row__actions">
                    <Button size="sm" variant="ghost" icon={<Download size={13} />} loading={s.downloading === file.id} onClick={() => s.download(file)}>Download</Button>
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
                        Files sent straight to the people in {space.name}, up to {MAX_SHARE_MB} MB each. {s.peers.length > 0 ? `${s.peers.length} ${s.peers.length === 1 ? 'person is' : 'people are'} connected.` : 'Nobody else is connected right now; files sync when they join.'}
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
                                {s.peers.length === 0 && <Button icon={<Users size={14} />} onClick={() => openCollaboration('invite')}>Invite people</Button>}
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

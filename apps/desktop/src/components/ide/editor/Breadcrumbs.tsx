/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { ChevronRight } from 'lucide-react'
import { folderName } from '../../../stores/workspaceFolderStore'
import { relativePath } from '../languages'

interface BreadcrumbsProps {
    path: string
    folder: string | null
    /** Reveals a directory in the explorer. */
    onRevealDirectory: (path: string) => void
}

function joinSegmentPath(root: string, isPosixAbsolute: boolean, segments: string[]): string {
    const joined = segments.join('/')
    if (root) return `${root}/${joined}`
    if (isPosixAbsolute) return `/${joined}`
    // Windows drive root (e.g. ['C:']) needs a trailing slash to stay valid.
    if (segments.length === 1 && /^[A-Za-z]:$/.test(segments[0])) return `${segments[0]}/`
    return joined
}

export function Breadcrumbs({ path, folder, onRevealDirectory }: BreadcrumbsProps) {
    const normalizedPath = path.replace(/\\/g, '/')
    const isPosixAbsolute = normalizedPath.startsWith('/')
    const parts = relativePath(path, folder).split('/').filter(Boolean)
    const root = folder?.replace(/\\/g, '/').replace(/\/+$/, '') ?? ''

    return (
        <nav className="breadcrumbs" aria-label="File location">
            {folder && (
                <>
                    <button type="button" className="breadcrumbs__item" onClick={() => onRevealDirectory(root || '/')}>
                        {folderName(folder)}
                    </button>
                    {parts.length > 0 && <ChevronRight size={12} className="breadcrumbs__sep" aria-hidden />}
                </>
            )}
            {parts.map((part, i) => {
                const last = i === parts.length - 1
                const target = joinSegmentPath(root, !folder && isPosixAbsolute, parts.slice(0, i + 1))
                return (
                    <span key={target} className="breadcrumbs__segment">
                        {last ? (
                            <span className="breadcrumbs__current" aria-current="page">{part}</span>
                        ) : (
                            <>
                                <button type="button" className="breadcrumbs__item" onClick={() => onRevealDirectory(target)}>{part}</button>
                                <ChevronRight size={12} className="breadcrumbs__sep" aria-hidden />
                            </>
                        )}
                    </span>
                )
            })}
        </nav>
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, Field, TextInput } from '../ui'
import { cloneIntoWorkspace } from './workspaceActions'

interface Props {
    open: boolean
    onClose: () => void
}

function repoName(url: string): string {
    const last = url.trim().replace(/\/+$/, '').split(/[/:]/).pop() ?? ''
    return last.replace(/\.git$/, '')
}

export function CloneDialog({ open, onClose }: Props) {
    const [url, setUrl] = useState('')
    const [name, setName] = useState('')
    const [nameTouched, setNameTouched] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const urlRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (!open) return
        setUrl('')
        setName('')
        setNameTouched(false)
        setError(null)
        setBusy(false)
    }, [open])

    const submit = async () => {
        if (!url.trim()) { setError('Paste the repository URL.'); return }
        if (!name.trim()) { setError('Give the workspace a name.'); return }
        setBusy(true)
        setError(null)
        const result = await cloneIntoWorkspace(url, name)
        setBusy(false)
        if (result.ok) onClose()
        else setError(result.error ?? 'The clone did not finish.')
    }

    return (
        <Dialog
            open={open}
            onClose={() => { if (!busy) onClose() }}
            dismissible={!busy}
            title="Clone a repository"
            description="Kalynt clones into its own workspaces folder and opens it. Private GitHub repositories use the token from Settings."
            size="md"
            initialFocus={urlRef}
            footer={
                <>
                    <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button variant="primary" onClick={submit} loading={busy}>{busy ? 'Cloning…' : 'Clone and open'}</Button>
                </>
            }
        >
            <Field label="Repository URL">
                {id => (
                    <TextInput
                        id={id}
                        ref={urlRef}
                        mono
                        value={url}
                        disabled={busy}
                        placeholder="https://github.com/owner/repo.git"
                        onChange={e => {
                            setUrl(e.target.value)
                            setError(null)
                            if (!nameTouched) setName(repoName(e.target.value))
                        }}
                    />
                )}
            </Field>
            <Field label="Workspace name" error={error}>
                {id => (
                    <TextInput
                        id={id}
                        value={name}
                        disabled={busy}
                        invalid={!!error}
                        onChange={e => { setName(e.target.value); setNameTouched(true); setError(null) }}
                        onKeyDown={e => { if (e.key === 'Enter') submit() }}
                    />
                )}
            </Field>
        </Dialog>
    )
}

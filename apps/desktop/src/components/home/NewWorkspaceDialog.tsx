/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button, Dialog, Field, TextInput } from '../ui'
import { folderName } from '../../stores/workspaceFolderStore'
import { createWorkspace, pickFolder } from './workspaceActions'

interface Props {
    open: boolean
    onClose: () => void
}

export function NewWorkspaceDialog({ open, onClose }: Props) {
    const [name, setName] = useState('')
    const [folder, setFolder] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const nameRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (!open) return
        setName('')
        setFolder(null)
        setError(null)
    }, [open])

    const choose = async () => {
        const picked = await pickFolder()
        if (!picked) return
        setFolder(picked)
        if (!name.trim()) setName(folderName(picked))
    }

    const submit = () => {
        if (!name.trim()) {
            setError('Give the workspace a name.')
            nameRef.current?.focus()
            return
        }
        createWorkspace(name, folder)
        onClose()
    }

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title="New workspace"
            description="You can choose a folder now or later from the explorer."
            size="md"
            initialFocus={nameRef}
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button variant="primary" onClick={submit}>Create workspace</Button>
                </>
            }
        >
            <Field label="Name" error={error}>
                {id => (
                    <TextInput
                        id={id}
                        ref={nameRef}
                        value={name}
                        invalid={!!error}
                        placeholder="e.g. Payments API"
                        onChange={e => { setName(e.target.value); setError(null) }}
                        onKeyDown={e => { if (e.key === 'Enter') submit() }}
                    />
                )}
            </Field>
            <Field label="Folder" hint={folder ? undefined : 'Optional. Kalynt opens files, runs code and indexes for the agent inside this folder.'}>
                {id => (
                    <div className="home-folder-pick">
                        <TextInput id={id} readOnly mono value={folder ?? ''} placeholder="No folder chosen" />
                        <Button icon={<FolderOpen size={15} />} onClick={choose}>{folder ? 'Change' : 'Choose…'}</Button>
                    </div>
                )}
            </Field>
        </Dialog>
    )
}

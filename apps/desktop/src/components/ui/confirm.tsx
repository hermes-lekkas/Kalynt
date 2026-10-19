/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Promise-based replacements for window.confirm / window.prompt that match the
 * rest of the interface. Mount <DialogHost /> once near the root.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { Field, TextInput } from './Form'

interface ConfirmOptions {
    title: string
    message?: ReactNode
    confirmLabel?: string
    cancelLabel?: string
    danger?: boolean
}

interface PromptOptions {
    title: string
    label: string
    placeholder?: string
    initialValue?: string
    confirmLabel?: string
    message?: ReactNode
    /** Returns an error message for invalid input, or null when valid. */
    validate?: (value: string) => string | null
    mono?: boolean
}

interface ChoiceOption {
    id: string
    label: string
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
}

interface ChooseOptions {
    title: string
    message?: ReactNode
    /** Rendered left to right; the last option receives focus. */
    choices: ChoiceOption[]
}

type Request =
    | { kind: 'confirm'; options: ConfirmOptions; resolve: (ok: boolean) => void }
    | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void }
    | { kind: 'choose'; options: ChooseOptions; resolve: (id: string | null) => void }

interface DialogQueue {
    queue: Request[]
    push: (request: Request) => void
    shift: () => void
}

const useDialogQueue = create<DialogQueue>(set => ({
    queue: [],
    push: request => set(s => ({ queue: [...s.queue, request] })),
    shift: () => set(s => ({ queue: s.queue.slice(1) }))
}))

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
    return new Promise(resolve => useDialogQueue.getState().push({ kind: 'confirm', options, resolve }))
}

export function promptText(options: PromptOptions): Promise<string | null> {
    return new Promise(resolve => useDialogQueue.getState().push({ kind: 'prompt', options, resolve }))
}

/** Resolves with the chosen option id, or null when dismissed. */
export function chooseAction(options: ChooseOptions): Promise<string | null> {
    return new Promise(resolve => useDialogQueue.getState().push({ kind: 'choose', options, resolve }))
}

export function DialogHost() {
    const current = useDialogQueue(s => s.queue[0])
    const shift = useDialogQueue(s => s.shift)
    if (!current) return null

    if (current.kind === 'confirm') {
        const finish = (ok: boolean) => { current.resolve(ok); shift() }
        return <ConfirmDialog options={current.options} onFinish={finish} />
    }
    if (current.kind === 'choose') {
        const finish = (id: string | null) => { current.resolve(id); shift() }
        return <ChooseDialog options={current.options} onFinish={finish} />
    }
    const finish = (value: string | null) => { current.resolve(value); shift() }
    return <PromptDialog key={current.options.title} options={current.options} onFinish={finish} />
}

function ConfirmDialog({ options, onFinish }: { options: ConfirmOptions; onFinish: (ok: boolean) => void }) {
    const confirmRef = useRef<HTMLButtonElement>(null)
    return (
        <Dialog
            open
            size="sm"
            title={options.title}
            onClose={() => onFinish(false)}
            initialFocus={confirmRef}
            footer={
                <>
                    <Button variant="ghost" onClick={() => onFinish(false)}>{options.cancelLabel ?? 'Cancel'}</Button>
                    <Button ref={confirmRef} variant={options.danger ? 'danger' : 'primary'} onClick={() => onFinish(true)}>
                        {options.confirmLabel ?? 'Continue'}
                    </Button>
                </>
            }
        >
            {options.message && <div className="k-dialog__message">{options.message}</div>}
        </Dialog>
    )
}

function ChooseDialog({ options, onFinish }: { options: ChooseOptions; onFinish: (id: string | null) => void }) {
    const lastRef = useRef<HTMLButtonElement>(null)
    return (
        <Dialog
            open
            size="sm"
            title={options.title}
            onClose={() => onFinish(null)}
            initialFocus={lastRef}
            footer={options.choices.map((choice, i) => (
                <Button
                    key={choice.id}
                    ref={i === options.choices.length - 1 ? lastRef : undefined}
                    variant={choice.variant ?? 'secondary'}
                    onClick={() => onFinish(choice.id)}
                >
                    {choice.label}
                </Button>
            ))}
        >
            {options.message && <div className="k-dialog__message">{options.message}</div>}
        </Dialog>
    )
}

function PromptDialog({ options, onFinish }: { options: PromptOptions; onFinish: (value: string | null) => void }) {
    const [value, setValue] = useState(options.initialValue ?? '')
    const [error, setError] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        // Select the name part (before the extension) so renames are quick.
        const input = inputRef.current
        if (!input || !options.initialValue) return
        const dot = options.initialValue.lastIndexOf('.')
        requestAnimationFrame(() => input.setSelectionRange(0, dot > 0 ? dot : options.initialValue!.length))
    }, [options.initialValue])

    const submit = () => {
        const trimmed = value.trim()
        if (!trimmed) {
            setError('Enter a value to continue.')
            return
        }
        const problem = options.validate?.(trimmed) ?? null
        if (problem) {
            setError(problem)
            return
        }
        onFinish(trimmed)
    }

    return (
        <Dialog
            open
            size="sm"
            title={options.title}
            onClose={() => onFinish(null)}
            initialFocus={inputRef}
            footer={
                <>
                    <Button variant="ghost" onClick={() => onFinish(null)}>Cancel</Button>
                    <Button variant="primary" onClick={submit}>{options.confirmLabel ?? 'Save'}</Button>
                </>
            }
        >
            {options.message && <div className="k-dialog__message">{options.message}</div>}
            <Field label={options.label} error={error}>
                {id => (
                    <TextInput
                        id={id}
                        ref={inputRef}
                        value={value}
                        mono={options.mono}
                        placeholder={options.placeholder}
                        invalid={!!error}
                        onChange={e => { setValue(e.target.value); setError(null) }}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
                    />
                )}
            </Field>
        </Dialog>
    )
}

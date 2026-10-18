/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useRef, useState } from 'react'
import { Sparkles, Trash2, X } from 'lucide-react'
import { Button, Checkbox, Dialog, Field, IconButton, Select, TextArea, TextInput, confirmAction } from '../ui'
import { COLUMNS, type Subtask, type Task, type TaskPriority, type TaskStatus } from './useTasks'

interface TaskDialogProps {
    task: Task
    isNew: boolean
    readOnly: boolean
    canBreakdown: boolean
    onBreakdown: (task: Task) => Promise<Subtask[]>
    onSave: (task: Task) => void
    onDelete: () => void
    onClose: () => void
}

const toDateInput = (ts?: number) => (ts ? new Date(ts).toISOString().slice(0, 10) : '')

export function TaskDialog({ task, isNew, readOnly, canBreakdown, onBreakdown, onSave, onDelete, onClose }: TaskDialogProps) {
    const [draft, setDraft] = useState<Task>(task)
    const [newStep, setNewStep] = useState('')
    const [tagText, setTagText] = useState(task.tags.join(', '))
    const [thinking, setThinking] = useState(false)
    const [aiError, setAiError] = useState<string | null>(null)
    const [titleError, setTitleError] = useState(false)
    const titleRef = useRef<HTMLInputElement>(null)
    const set = (patch: Partial<Task>) => setDraft(d => ({ ...d, ...patch }))
    const steps = draft.subtasks ?? []

    const save = () => {
        if (!draft.title.trim()) { setTitleError(true); titleRef.current?.focus(); return }
        onSave({ ...draft, title: draft.title.trim(), tags: tagText.split(',').map(t => t.trim()).filter(Boolean) })
    }

    const addStep = () => {
        if (!newStep.trim()) return
        set({ subtasks: [...steps, { id: crypto.randomUUID(), title: newStep.trim(), completed: false }] })
        setNewStep('')
    }

    const suggest = async () => {
        if (!draft.title.trim()) { setTitleError(true); return }
        setThinking(true)
        setAiError(null)
        try {
            const added = await onBreakdown(draft)
            set({ subtasks: [...steps, ...added] })
        } catch (e) {
            setAiError(e instanceof Error ? e.message : 'No steps came back.')
        } finally {
            setThinking(false)
        }
    }

    const remove = async () => {
        const ok = await confirmAction({ title: 'Delete this task?', message: 'It is removed for everyone in the workspace.', confirmLabel: 'Delete task', danger: true })
        if (ok) onDelete()
    }

    return (
        <Dialog
            open
            size="md"
            title={isNew ? 'New task' : readOnly ? draft.title : 'Edit task'}
            onClose={onClose}
            initialFocus={isNew ? titleRef : undefined}
            footer={readOnly ? <Button onClick={onClose}>Close</Button> : (
                <>
                    {!isNew && <Button variant="ghost" icon={<Trash2 size={14} />} onClick={remove} className="task-dialog__delete">Delete</Button>}
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button variant="primary" onClick={save}>{isNew ? 'Add task' : 'Save task'}</Button>
                </>
            )}
        >
            <fieldset className="task-dialog" disabled={readOnly}>
                <Field label="Title" error={titleError ? 'Give the task a title.' : null}>
                    {id => <TextInput id={id} ref={titleRef} value={draft.title} invalid={titleError} placeholder="What needs doing?" onChange={e => { set({ title: e.target.value }); setTitleError(false) }} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); save() } }} />}
                </Field>
                <Field label="Notes">
                    {id => <TextArea id={id} rows={3} value={draft.description ?? ''} placeholder="Context, links, acceptance criteria" onChange={e => set({ description: e.target.value })} />}
                </Field>
                <div className="task-dialog__grid">
                    <Field label="Status">
                        {id => (
                            <Select id={id} value={draft.status} onChange={e => set({ status: e.target.value as TaskStatus })}>
                                {COLUMNS.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
                            </Select>
                        )}
                    </Field>
                    <Field label="Priority">
                        {id => (
                            <Select id={id} value={draft.priority} onChange={e => set({ priority: e.target.value as TaskPriority })}>
                                <option value="high">High</option>
                                <option value="medium">Medium</option>
                                <option value="low">Low</option>
                            </Select>
                        )}
                    </Field>
                    <Field label="Due">
                        {id => <TextInput id={id} type="date" value={toDateInput(draft.dueDate)} onChange={e => set({ dueDate: e.target.value ? new Date(`${e.target.value}T12:00:00`).getTime() : undefined })} />}
                    </Field>
                </div>
                <Field label="Tags" hint="Separate with commas.">
                    {id => <TextInput id={id} value={tagText} placeholder="e.g. api, bug" onChange={e => setTagText(e.target.value)} />}
                </Field>

                <section className="task-steps" aria-label="Steps">
                    <div className="task-steps__head">
                        <h3>Steps{steps.length ? ` (${steps.filter(s => s.completed).length} of ${steps.length} done)` : ''}</h3>
                        {!readOnly && (
                            <Button size="sm" variant="ghost" icon={<Sparkles size={13} />} loading={thinking} disabled={!canBreakdown} onClick={suggest}
                                title={canBreakdown ? 'Ask a model to suggest steps' : 'Connect a model to suggest steps'}>
                                Suggest steps
                            </Button>
                        )}
                    </div>
                    {aiError && <p className="task-steps__error">{aiError}</p>}
                    <ul className="task-steps__list">
                        {steps.map(step => (
                            <li key={step.id}>
                                <Checkbox
                                    checked={step.completed}
                                    onChange={v => set({ subtasks: steps.map(s => (s.id === step.id ? { ...s, completed: v } : s)) })}
                                    label={<span className={step.completed ? 'is-done' : ''}>{step.title}</span>}
                                />
                                {!readOnly && <IconButton size="sm" label="Remove step" icon={<X size={12} />} onClick={() => set({ subtasks: steps.filter(s => s.id !== step.id) })} />}
                            </li>
                        ))}
                    </ul>
                    {!readOnly && (
                        <TextInput size="sm" value={newStep} placeholder="Add a step and press Enter" aria-label="New step"
                            onChange={e => setNewStep(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addStep() } }} />
                    )}
                </section>
            </fieldset>
        </Dialog>
    )
}

/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useMemo, useState, type DragEvent } from 'react'
import { CheckSquare, Plus } from 'lucide-react'
import type { Space } from '../../stores/appStore'
import { usePermissions } from '../../hooks/usePermissions'
import { Button, IconButton, SearchInput } from '../ui'
import { COLUMNS, emptyTask, useTasks, type Task, type TaskStatus } from './useTasks'
import { TaskDialog } from './TaskDialog'
import '../workspace/workspace.css'
import './tasks.css'

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const

function TaskCard({ task, onOpen, draggable }: { task: Task; onOpen: () => void; draggable: boolean }) {
    const done = task.subtasks?.filter(s => s.completed).length ?? 0
    const total = task.subtasks?.length ?? 0
    const overdue = task.dueDate && task.status !== 'done' && task.dueDate < Date.now() - 86_400_000
    return (
        <li>
            <button
                type="button"
                className={`task-card task-card--${task.priority}`}
                draggable={draggable}
                onDragStart={e => { e.dataTransfer.setData('application/x-kalynt-task', task.id); e.dataTransfer.effectAllowed = 'move' }}
                onClick={onOpen}
            >
                <span className="task-card__title">{task.title || 'Untitled task'}</span>
                {task.description && <span className="task-card__desc">{task.description}</span>}
                <span className="task-card__meta">
                    {task.priority !== 'medium' && <span className={`task-card__priority is-${task.priority}`}>{task.priority === 'high' ? 'High priority' : 'Low priority'}</span>}
                    {total > 0 && <span className="task-card__steps"><CheckSquare size={11} aria-hidden /> {done}/{total}</span>}
                    {task.dueDate && <span className={overdue ? 'task-card__due is-overdue' : 'task-card__due'}>Due {new Date(task.dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}
                    {task.tags.slice(0, 2).map(tag => <span key={tag} className="task-card__tag">{tag}</span>)}
                </span>
            </button>
        </li>
    )
}

export default function TaskBoard({ space }: { space: Space }) {
    const { tasks, peerCount, save, move, remove, breakdown, canBreakdown } = useTasks(space.id)
    const { canManageTasks } = usePermissions()
    const [editing, setEditing] = useState<{ task: Task; isNew: boolean } | null>(null)
    const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null)
    const [query, setQuery] = useState('')

    const byColumn = useMemo(() => {
        const q = query.trim().toLowerCase()
        const visible = q ? tasks.filter(t => t.title.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q) || t.tags.some(tag => tag.toLowerCase().includes(q))) : tasks
        return Object.fromEntries(COLUMNS.map(c => [c.id, visible
            .filter(t => t.status === c.id)
            .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.createdAt - a.createdAt)])) as Record<TaskStatus, Task[]>
    }, [tasks, query])

    const drop = (e: DragEvent, status: TaskStatus) => {
        e.preventDefault()
        setDropTarget(null)
        const id = e.dataTransfer.getData('application/x-kalynt-task')
        if (id && canManageTasks) move(id, status)
    }

    return (
        <div className="page">
            <header className="page__header">
                <div className="page__titles">
                    <h1 className="page__title">Tasks</h1>
                    <p className="page__subtitle">
                        Shared with everyone in {space.name}{peerCount > 0 ? `, ${peerCount} online now` : ''}. Drag cards between columns to update them.
                    </p>
                </div>
                <div className="page__actions">
                    {tasks.length > 6 && <SearchInput size="sm" value={query} onChange={setQuery} placeholder="Filter tasks" aria-label="Filter tasks" />}
                    {canManageTasks && <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing({ task: emptyTask(), isNew: true })}>New task</Button>}
                </div>
            </header>
            <div className="board">
                {COLUMNS.map(column => (
                    <section
                        key={column.id}
                        className={`board__column ${dropTarget === column.id ? 'is-drop-target' : ''}`}
                        aria-label={column.title}
                        onDragOver={e => { if (e.dataTransfer.types.includes('application/x-kalynt-task')) { e.preventDefault(); setDropTarget(column.id) } }}
                        onDragLeave={() => setDropTarget(null)}
                        onDrop={e => drop(e, column.id)}
                    >
                        <header className="board__head">
                            <h2>{column.title}</h2>
                            <span className="board__count">{byColumn[column.id].length}</span>
                            {canManageTasks && (
                                <IconButton size="sm" label={`Add to ${column.title}`} icon={<Plus size={14} />} onClick={() => setEditing({ task: emptyTask(column.id), isNew: true })} />
                            )}
                        </header>
                        <ul className="board__cards">
                            {byColumn[column.id].map(task => (
                                <TaskCard key={task.id} task={task} draggable={canManageTasks} onOpen={() => setEditing({ task, isNew: false })} />
                            ))}
                            {byColumn[column.id].length === 0 && (
                                <li className="board__empty">{column.id === 'todo' && tasks.length === 0 ? 'Nothing planned yet.' : 'No tasks here.'}</li>
                            )}
                        </ul>
                    </section>
                ))}
            </div>
            {editing && (
                <TaskDialog
                    task={editing.task}
                    isNew={editing.isNew}
                    readOnly={!canManageTasks}
                    canBreakdown={canBreakdown}
                    onBreakdown={breakdown}
                    onSave={task => { save(task); setEditing(null) }}
                    onDelete={() => { remove(editing.task.id); setEditing(null) }}
                    onClose={() => setEditing(null)}
                />
            )}
        </div>
    )
}

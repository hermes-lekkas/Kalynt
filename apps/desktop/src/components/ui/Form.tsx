/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import {
    forwardRef, useId, type InputHTMLAttributes, type ReactNode,
    type SelectHTMLAttributes, type TextareaHTMLAttributes
} from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import './form.css'

interface FieldProps {
    label: string
    hint?: ReactNode
    error?: string | null
    /** Receives the generated id so the control can be labelled. */
    children: (id: string) => ReactNode
    className?: string
}

export function Field({ label, hint, error, children, className }: FieldProps) {
    const id = useId()
    return (
        <div className={['k-field', className].filter(Boolean).join(' ')}>
            <label className="k-field__label" htmlFor={id}>{label}</label>
            {children(id)}
            {error ? (
                <p className="k-field__error" role="alert">{error}</p>
            ) : hint ? (
                <p className="k-field__hint">{hint}</p>
            ) : null}
        </div>
    )
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
    icon?: ReactNode
    trailing?: ReactNode
    size?: 'sm' | 'md'
    invalid?: boolean
    mono?: boolean
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
    { icon, trailing, size = 'md', invalid, mono, className, ...rest },
    ref
) {
    const classes = ['k-input', `k-input--${size}`, invalid && 'is-invalid', mono && 'is-mono', className]
        .filter(Boolean)
        .join(' ')
    return (
        <div className={classes}>
            {icon && <span className="k-input__icon" aria-hidden>{icon}</span>}
            <input ref={ref} className="k-input__control" aria-invalid={invalid || undefined} spellCheck={false} {...rest} />
            {trailing && <span className="k-input__trailing">{trailing}</span>}
        </div>
    )
})

interface SearchInputProps extends Omit<TextInputProps, 'icon' | 'trailing' | 'onChange' | 'value'> {
    value: string
    onChange: (value: string) => void
    onClear?: () => void
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
    { value, onChange, onClear, onKeyDown, ...rest },
    ref
) {
    return (
        <TextInput
            ref={ref}
            type="search"
            icon={<Search size={14} />}
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={e => {
                if (e.key === 'Escape' && value) {
                    e.stopPropagation()
                    onChange('')
                    onClear?.()
                }
                onKeyDown?.(e)
            }}
            trailing={value ? (
                <button type="button" className="k-input__clear" aria-label="Clear search" onClick={() => { onChange(''); onClear?.() }}>
                    <X size={12} />
                </button>
            ) : undefined}
            {...rest}
        />
    )
})

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
    invalid?: boolean
    mono?: boolean
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
    { invalid, mono, className, ...rest },
    ref
) {
    const classes = ['k-textarea', invalid && 'is-invalid', mono && 'is-mono', className].filter(Boolean).join(' ')
    return <textarea ref={ref} className={classes} aria-invalid={invalid || undefined} {...rest} />
})

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
    size?: 'sm' | 'md'
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
    { size = 'md', className, children, ...rest },
    ref
) {
    return (
        <div className={['k-select', `k-select--${size}`, className].filter(Boolean).join(' ')}>
            <select ref={ref} {...rest}>{children}</select>
            <ChevronDown size={14} className="k-select__chevron" aria-hidden />
        </div>
    )
})

interface SwitchProps {
    checked: boolean
    onChange: (checked: boolean) => void
    label: string
    disabled?: boolean
    id?: string
}

export function Switch({ checked, onChange, label, disabled, id }: SwitchProps) {
    return (
        <button
            id={id}
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            className={`k-switch ${checked ? 'is-on' : ''}`}
            onClick={() => onChange(!checked)}
        >
            <span className="k-switch__thumb" />
        </button>
    )
}

interface CheckboxProps {
    checked: boolean
    onChange: (checked: boolean) => void
    label: ReactNode
    disabled?: boolean
}

export function Checkbox({ checked, onChange, label, disabled }: CheckboxProps) {
    return (
        <label className={`k-checkbox ${disabled ? 'is-disabled' : ''}`}>
            <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
            <span className="k-checkbox__box" aria-hidden />
            <span className="k-checkbox__label">{label}</span>
        </label>
    )
}

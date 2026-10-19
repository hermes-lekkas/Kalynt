/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Layout pieces shared by every settings page.
 */
import type { ReactNode } from 'react'

export function SettingsPage({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
    return (
        <div className="set-page">
            <header className="set-page__head">
                <h2 className="set-page__title">{title}</h2>
                {description && <p className="set-page__desc">{description}</p>}
            </header>
            {children}
        </div>
    )
}

export function SettingsSection({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
    return (
        <section className="set-section">
            <div className="set-section__head">
                <div>
                    <h3 className="set-section__title">{title}</h3>
                    {description && <p className="set-section__desc">{description}</p>}
                </div>
                {actions && <div className="set-section__actions">{actions}</div>}
            </div>
            <div className="set-section__body">{children}</div>
        </section>
    )
}

/** One labelled setting with its control on the right. */
export function SettingRow({ label, description, control, htmlFor }: { label: string; description?: ReactNode; control: ReactNode; htmlFor?: string }) {
    return (
        <div className="set-row">
            <div className="set-row__text">
                {htmlFor ? <label className="set-row__label" htmlFor={htmlFor}>{label}</label> : <span className="set-row__label">{label}</span>}
                {description && <p className="set-row__desc">{description}</p>}
            </div>
            <div className="set-row__control">{control}</div>
        </div>
    )
}

export function SavedNote({ show, children = 'Saved' }: { show: boolean; children?: ReactNode }) {
    return <span className={`set-saved ${show ? 'is-visible' : ''}`} role="status">{show ? children : ''}</span>
}

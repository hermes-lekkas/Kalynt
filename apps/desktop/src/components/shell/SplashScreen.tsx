/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import './startup.css'
import { LOGO_URL } from './brand'

const MIN_VISIBLE_MS = 450
const EXIT_MS = 220

interface SplashScreenProps {
    ready: boolean
    onDone: () => void
}

/** Shown only while the app initialises; leaves as soon as it is ready. */
export function SplashScreen({ ready, onDone }: SplashScreenProps) {
    const status = useAppStore(s => s.startupStatus)
    const version = useAppStore(s => s.version)
    const [leaving, setLeaving] = useState(false)
    const shownAt = useRef(Date.now())

    useEffect(() => {
        if (!ready) return
        const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt.current))
        const leave = setTimeout(() => setLeaving(true), wait)
        const done = setTimeout(onDone, wait + EXIT_MS)
        return () => {
            clearTimeout(leave)
            clearTimeout(done)
        }
    }, [ready, onDone])

    return (
        <div className={`splash ${leaving ? 'is-leaving' : ''}`} role="status" aria-live="polite">
            <div className="splash__mark">
                <img src={LOGO_URL} alt="" width={72} height={72} />
            </div>
            <p className="splash__name">Kalynt</p>
            <div className="splash__wire" aria-hidden />
            <p className="splash__status">{ready ? 'Ready' : status}</p>
            <p className="splash__version">{version}</p>
        </div>
    )
}

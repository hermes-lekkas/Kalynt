/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Peer-to-peer team chat stored in the workspace's shared document,
 * end-to-end encrypted when the workspace has a room password.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { useNotificationStore } from '../../../stores/notificationStore'
import { useYDoc, useYArray, useAwareness } from '../../../hooks/useYjs'
import { usePermissions } from '../../../hooks/usePermissions'
import { encryptionService, type EncryptedPayload } from '../../../services/encryptionService'
import type { ChatMessage } from '../../../types/chat'

const USER_ID_KEY = 'unified-user-id'

function localUserId(): string {
    const saved = localStorage.getItem(USER_ID_KEY)
    if (saved) return saved
    const id = crypto.randomUUID()
    localStorage.setItem(USER_ID_KEY, id)
    return id
}

export interface TeamMessage extends ChatMessage {
    /** Readable text, or null while it is still being decrypted. */
    text: string | null
    decryptFailed?: boolean
    own: boolean
}

interface AwarenessState {
    user?: { id?: string; name?: string }
    isTyping?: boolean
}

export function useTeamChat(spaceId: string, visible: boolean) {
    const userName = useAppStore(s => s.userName)
    const addNotification = useNotificationStore(s => s.addNotification)
    const { canChat } = usePermissions()
    const { doc, provider, synced, peerCount } = useYDoc(spaceId)
    const { items, push } = useYArray<ChatMessage>(doc, 'messages')
    const { users, setLocalState, localClientId } = useAwareness(provider)
    const [encrypted, setEncrypted] = useState(false)
    const [decrypted, setDecrypted] = useState<Map<string, string>>(new Map())
    const [failed, setFailed] = useState<Set<string>>(new Set())
    const [unread, setUnread] = useState(0)
    const userId = useRef(localUserId()).current
    const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const seen = useRef<Set<string> | null>(null)
    const inFlight = useRef(new Set<string>())

    // Use the room password from workspace settings as the encryption key.
    useEffect(() => {
        try {
            const settings = JSON.parse(localStorage.getItem(`space-settings-${spaceId}`) || '{}')
            if (settings.encryptionEnabled && settings.roomPassword) {
                encryptionService.setRoomKey(spaceId, settings.roomPassword)
                    .then(() => setEncrypted(true))
                    .catch(() => setEncrypted(false))
            }
        } catch { /* no settings */ }
    }, [spaceId])

    useEffect(() => {
        if (!encrypted) return
        const key = encryptionService.getRoomKey(spaceId)
        if (!key) return
        items.forEach(async msg => {
            if (!msg.encrypted || decrypted.has(msg.id) || failed.has(msg.id) || inFlight.current.has(msg.id)) return
            inFlight.current.add(msg.id)
            try {
                const plain = await encryptionService.decryptToString(JSON.parse(msg.content) as EncryptedPayload, key)
                let text = plain
                try { text = JSON.parse(plain).text ?? plain } catch { /* plain text */ }
                setDecrypted(prev => new Map(prev).set(msg.id, text))
            } catch {
                setFailed(prev => new Set(prev).add(msg.id))
            } finally {
                inFlight.current.delete(msg.id)
            }
        })
    }, [items, encrypted, spaceId, decrypted, failed])

    const messages = useMemo<TeamMessage[]>(() => items.map(m => ({
        ...m,
        own: m.senderId === userId,
        text: m.encrypted ? decrypted.get(m.id) ?? null : m.content,
        decryptFailed: failed.has(m.id)
    })), [items, decrypted, failed, userId])

    // Notify about mentions and replies; count unread while the tab is hidden.
    useEffect(() => {
        if (seen.current === null) {
            seen.current = new Set(items.map(m => m.id))
            return
        }
        for (const m of messages) {
            if (seen.current.has(m.id) || m.own) continue
            if (m.encrypted && m.text === null && !m.decryptFailed) continue
            seen.current.add(m.id)
            if (!visible) setUnread(n => n + 1)
            const mentioned = userName && m.text && new RegExp(`@${userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(m.text)
            if (mentioned) addNotification(`${m.sender || 'Someone'} mentioned you in team chat`, 'info')
            else if (m.replyToSender === userName) addNotification(`${m.sender || 'Someone'} replied to you in team chat`, 'info')
        }
    }, [messages, items, visible, userName, addNotification])

    useEffect(() => { if (visible) setUnread(0) }, [visible])

    const typingPeople = useMemo(() => Array.from(users.entries())
        .filter(([id, state]) => id !== localClientId && (state as AwarenessState).isTyping)
        .map(([, state]) => (state as AwarenessState).user?.name || 'Someone'), [users, localClientId])

    const people = useMemo(() => {
        const names = new Map<string, string>()
        users.forEach((state, id) => {
            if (id === localClientId) return
            const name = (state as AwarenessState).user?.name
            if (name) names.set(name, (state as AwarenessState).user?.id ?? name)
        })
        return Array.from(names.entries()).map(([name, id]) => ({ name, id }))
    }, [users, localClientId])

    const typing = useCallback(() => {
        setLocalState('isTyping', true)
        if (typingTimer.current) clearTimeout(typingTimer.current)
        typingTimer.current = setTimeout(() => setLocalState('isTyping', false), 2000)
    }, [setLocalState])

    useEffect(() => () => { if (typingTimer.current) clearTimeout(typingTimer.current) }, [])

    const send = useCallback(async (text: string, replyTo?: TeamMessage | null) => {
        const body = text.trim()
        if (!body || !canChat) return
        const reply = replyTo ? {
            replyToId: replyTo.id,
            replyToContent: (replyTo.text ?? '').slice(0, 100),
            replyToSender: replyTo.own ? userName : (replyTo.sender || 'Someone')
        } : {}
        const id = crypto.randomUUID()
        const base = { id, sender: userName || 'You', senderId: userId, timestamp: Date.now(), ...reply }
        const key = encrypted ? encryptionService.getRoomKey(spaceId) : null
        if (key) {
            const payload = await encryptionService.encrypt(JSON.stringify({ text: body, ...reply }), key)
            setDecrypted(prev => new Map(prev).set(id, body))
            push({ ...base, content: JSON.stringify(payload), encrypted: true })
        } else {
            push({ ...base, content: body, encrypted: false })
        }
        setLocalState('isTyping', false)
    }, [canChat, userName, userId, encrypted, spaceId, push, setLocalState])

    return { messages, send, typing, typingPeople, people, encrypted, synced, peerCount, canChat, unread }
}

export type TeamChatApi = ReturnType<typeof useTeamChat>

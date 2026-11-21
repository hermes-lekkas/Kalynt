/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Peer-to-peer team chat stored in the workspace's shared document,
 * end-to-end encrypted when the workspace has a room password.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { useNotificationStore } from '../../../stores/notificationStore'
import { useYDoc, useYArray, useAwareness, getSpaceDocument } from '../../../hooks/useYjs'
import { usePermissions } from '../../../hooks/usePermissions'
import {
    encryptionService,
    ROOM_ENCRYPTION_PROTOCOL_VERSION,
    type EncryptedPayload
} from '../../../services/encryptionService'
import { disableRoomEncryption, initializeRoomEncryption } from '../../../services/encryptedProvider'
import { normalizeRoomId, p2pService } from '../../../services/p2pService'
import {
    clearRoomPassword,
    getRoomPassword,
    setRoomPassword,
    setVolatileRoomPassword
} from '../../../services/roomPasswordStore'
import type { ChatMessage } from '../../../types/chat'

const USER_ID_KEY = 'unified-user-id'

function localUserId(): string {
    const saved = localStorage.getItem(USER_ID_KEY)
    if (saved) return saved
    const id = crypto.randomUUID()
    localStorage.setItem(USER_ID_KEY, id)
    return id
}

interface DecryptedMessageData {
    text: string
    replyToContent?: string
    replyToSender?: string
}

export type DecryptFailureReason = 'incompatible-version' | 'wrong-password'

export interface TeamMessage extends ChatMessage {
    /** Readable text, or null while it is still being decrypted. */
    text: string | null
    decryptFailed?: boolean
    decryptFailureReason?: DecryptFailureReason | null
    own: boolean
}

interface AwarenessState {
    user?: { id?: string; name?: string }
    isTyping?: boolean
}

export function classifyDecryptFailure(
    message: Pick<ChatMessage, 'encryptionVersion'>,
    authStatus: string
): DecryptFailureReason {
    if (
        authStatus === 'protocol-mismatch' ||
        message.encryptionVersion !== ROOM_ENCRYPTION_PROTOCOL_VERSION
    ) {
        return 'incompatible-version'
    }
    return 'wrong-password'
}

export function useTeamChat(spaceId: string, visible: boolean) {
    const userName = useAppStore(s => s.userName)
    const addNotification = useNotificationStore(s => s.addNotification)
    const { canChat } = usePermissions()
    const { doc, provider, synced, peerCount, authInfo } = useYDoc(spaceId)
    const { items, push } = useYArray<ChatMessage>(doc, 'messages')
    const { users, setLocalState, localClientId } = useAwareness(provider)
    const [encrypted, setEncrypted] = useState(false)
    const [decrypted, setDecrypted] = useState<Map<string, DecryptedMessageData>>(new Map())
    const [failed, setFailed] = useState<Set<string>>(new Set())
    const [unread, setUnread] = useState(0)
    const userId = useRef(localUserId()).current
    const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const seen = useRef<Set<string> | null>(null)
    const inFlight = useRef(new Set<string>())
    const decryptedRef = useRef<Map<string, DecryptedMessageData>>(new Map())
    const failedRef = useRef<Set<string>>(new Set())

    // Reset all per-workspace chat state on spaceId switch and derive unified deterministic room key.
    useEffect(() => {
        let live = true
        const normalizedSpaceId = normalizeRoomId(spaceId)

        seen.current = null
        inFlight.current.clear()
        decryptedRef.current = new Map()
        failedRef.current = new Set()
        setDecrypted(new Map())
        setFailed(new Set())
        setUnread(0)
        setEncrypted(encryptionService.hasRoomKey(normalizedSpaceId))

        const unsubKeyChange = encryptionService.onKeyChange((changedRoomId, hasKey) => {
            if (!live || normalizeRoomId(changedRoomId) !== normalizedSpaceId) return
            setEncrypted(hasKey)
            if (hasKey) {
                // Retry previously failed messages when a new key is configured
                failedRef.current = new Set()
                setFailed(new Set())
            }
        })

        getRoomPassword(spaceId).then(async password => {
            if (!live) return
            if (!password) {
                setEncrypted(encryptionService.hasRoomKey(spaceId))
                return
            }
            if (!encryptionService.hasRoomKey(spaceId)) {
                await initializeRoomEncryption(spaceId, password)
            }
            if (live) setEncrypted(true)
        }).catch(() => {
            if (live) setEncrypted(false)
        })

        return () => {
            live = false
            unsubKeyChange()
        }
    }, [spaceId])

    // Incremental O(k) decryption: decrypt only newly arrived encrypted messages and batch state updates.
    useEffect(() => {
        if (!encrypted) return
        const key = encryptionService.getRoomKey(spaceId)
        if (!key) return

        const pending = items.filter(
            msg =>
                msg.encrypted &&
                !decryptedRef.current.has(msg.id) &&
                !failedRef.current.has(msg.id) &&
                !inFlight.current.has(msg.id)
        )
        if (pending.length === 0) return

        let live = true
        pending.forEach(msg => inFlight.current.add(msg.id))

        void Promise.all(
            pending.map(async msg => {
                try {
                    const plain = await encryptionService.decryptToString(
                        JSON.parse(msg.content) as EncryptedPayload,
                        key
                    )
                    let data: DecryptedMessageData = { text: plain }
                    try {
                        const parsed = JSON.parse(plain) as {
                            text?: string
                            replyToContent?: string
                            replyToSender?: string
                        }
                        if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
                            data = {
                                text: parsed.text,
                                replyToContent: typeof parsed.replyToContent === 'string' ? parsed.replyToContent : undefined,
                                replyToSender: typeof parsed.replyToSender === 'string' ? parsed.replyToSender : undefined
                            }
                        }
                    } catch {
                        // Plain string payload
                    }
                    return { id: msg.id, ok: true as const, data }
                } catch {
                    return { id: msg.id, ok: false as const }
                } finally {
                    inFlight.current.delete(msg.id)
                }
            })
        ).then(results => {
            if (!live) return

            let decryptedChanged = false
            let failedChanged = false

            for (const r of results) {
                if (r.ok) {
                    decryptedRef.current.set(r.id, r.data)
                    decryptedChanged = true
                } else {
                    failedRef.current.add(r.id)
                    failedChanged = true
                }
            }

            if (decryptedChanged) {
                setDecrypted(new Map(decryptedRef.current))
            }
            if (failedChanged) {
                setFailed(new Set(failedRef.current))
            }
        })

        return () => {
            live = false
        }
    }, [items, encrypted, spaceId])

    const messages = useMemo<TeamMessage[]>(() => items.map(m => {
        if (!m.encrypted) {
            return {
                ...m,
                own: m.senderId === userId,
                text: m.content,
                decryptFailed: false,
                decryptFailureReason: null
            }
        }

        const dec = decrypted.get(m.id)
        const didFail = failed.has(m.id) || (!encrypted && !dec)
        const decryptFailureReason = didFail ? classifyDecryptFailure(m, authInfo.status) : null

        return {
            ...m,
            own: m.senderId === userId,
            text: dec ? dec.text : null,
            replyToContent: dec ? (dec.replyToContent ?? m.replyToContent) : undefined,
            replyToSender: dec ? (dec.replyToSender ?? m.replyToSender) : undefined,
            decryptFailed: didFail,
            decryptFailureReason
        }
    }), [items, decrypted, failed, encrypted, authInfo.status, userId])

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

    const retryPassword = useCallback(async (candidatePassword: string): Promise<{ ok: boolean; error?: string }> => {
        const value = candidatePassword.trim()
        if (!value) {
            return { ok: false, error: 'Enter the room password to retry.' }
        }
        const normalizedId = normalizeRoomId(spaceId)
        try {
            await initializeRoomEncryption(normalizedId, value)
            const targetDoc = doc ?? getSpaceDocument(normalizedId)
            await p2pService.reconnect(normalizedId, value, targetDoc)
            const settled = await p2pService.waitForRoomAuth(normalizedId, 1500)
            if (settled.status === 'auth-failed' || settled.status === 'password-required') {
                disableRoomEncryption(normalizedId)
                await clearRoomPassword(normalizedId)
                return {
                    ok: false,
                    error: settled.reason || 'Incorrect room password. Check the password and try again.'
                }
            }
            try {
                await setRoomPassword(normalizedId, value)
            } catch {
                setVolatileRoomPassword(normalizedId, value)
            }
            failedRef.current = new Set()
            setFailed(new Set())
            setEncrypted(true)
            return { ok: true }
        } catch (err) {
            return {
                ok: false,
                error: err instanceof Error ? err.message : 'Failed to verify room password.'
            }
        }
    }, [spaceId, doc])

    const send = useCallback(async (text: string, replyTo?: TeamMessage | null) => {
        const body = text.trim()
        if (!body || !canChat) return
        const reply = replyTo ? {
            replyToId: replyTo.id,
            replyToContent: (replyTo.text ?? '').slice(0, 100),
            replyToSender: replyTo.own ? userName : (replyTo.sender || 'Someone')
        } : undefined
        const id = crypto.randomUUID()
        const key = encrypted ? encryptionService.getRoomKey(spaceId) : null

        if (key) {
            // Keep replyToContent and replyToSender strictly inside the AES-GCM ciphertext
            const payload = await encryptionService.encrypt(
                JSON.stringify({ text: body, ...(reply ?? {}) }),
                key
            )
            const decEntry: DecryptedMessageData = {
                text: body,
                replyToContent: reply?.replyToContent,
                replyToSender: reply?.replyToSender
            }
            decryptedRef.current.set(id, decEntry)
            setDecrypted(new Map(decryptedRef.current))

            push({
                id,
                sender: userName || 'You',
                senderId: userId,
                timestamp: Date.now(),
                ...(reply ? { replyToId: reply.replyToId } : {}),
                content: JSON.stringify(payload),
                encrypted: true,
                encryptionVersion: ROOM_ENCRYPTION_PROTOCOL_VERSION
            })
        } else {
            push({
                id,
                sender: userName || 'You',
                senderId: userId,
                timestamp: Date.now(),
                ...(reply ?? {}),
                content: body,
                encrypted: false
            })
        }
        setLocalState('isTyping', false)
    }, [canChat, userName, userId, encrypted, spaceId, push, setLocalState])

    return {
        messages, send, typing, typingPeople, people,
        encrypted, synced, peerCount, authInfo, retryPassword,
        canChat, unread
    }
}

export type TeamChatApi = ReturnType<typeof useTeamChat>

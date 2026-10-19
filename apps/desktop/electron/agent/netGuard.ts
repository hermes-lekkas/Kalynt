/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Keeps agent web requests on the public internet unless the user approved
 * a local address. The renderer asks before fetching URLs that name this
 * machine or the local network; this catches the rest: public names that
 * resolve to private addresses, and redirects that lead there.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class PrivateAddressError extends Error {
    constructor(readonly url: string) {
        super(`${url} is on this computer or the local network. Fetch that URL directly so the user can approve it.`)
    }
}

function privateV4(address: string): boolean {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
}

/** Loopback, private, link-local, carrier-grade NAT, multicast and unspecified addresses. */
export function isPrivateAddress(raw: string): boolean {
    const address = raw.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
    if (isIP(address) === 4) return privateV4(address)
    if (isIP(address) !== 6) return false
    // IPv4-mapped (::ffff:127.0.0.1 or ::ffff:7f00:1).
    const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(address)
    if (mapped) {
        if (mapped[1]) return privateV4(mapped[1])
        const hi = parseInt(mapped[2], 16), lo = parseInt(mapped[3], 16)
        return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    return address === '::' || address === '::1' || /^f[cd]/.test(address) || /^fe[89ab]/.test(address) || /^ff/.test(address)
}

/** Throws PrivateAddressError when the URL's host is, or resolves to, a private address. */
export async function assertPublicUrl(url: URL): Promise<void> {
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost')) throw new PrivateAddressError(url.href)
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map(r => r.address)
    if (addresses.some(isPrivateAddress)) throw new PrivateAddressError(url.href)
}

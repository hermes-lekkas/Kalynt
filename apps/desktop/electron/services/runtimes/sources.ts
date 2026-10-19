/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Where to download each installable runtime for this OS and CPU. Versions are
 * looked up at install time from each project's own release index.
 */
import { getJson } from './http'

export interface RuntimeSource {
    version: string
    url: string
    /** Executable whose folder becomes the bin folder. */
    exe: string
    /** rustup-style installers are run instead of unpacked. */
    installer?: boolean
}

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const arm = process.arch === 'arm64'

const triple = () => {
    const cpu = arm ? 'aarch64' : 'x86_64'
    if (isWin) return `${cpu}-pc-windows-msvc`
    if (isMac) return `${cpu}-apple-darwin`
    return `${cpu}-unknown-linux-gnu`
}

async function node(): Promise<RuntimeSource> {
    const releases = await getJson<{ version: string; lts: string | false }[]>('https://nodejs.org/dist/index.json')
    const version = releases.find(r => r.lts)?.version
    if (!version) throw new Error('Could not find the current Node.js LTS release')
    const os = isWin ? 'win' : isMac ? 'darwin' : 'linux'
    const ext = isWin ? 'zip' : isMac ? 'tar.gz' : 'tar.xz'
    return { version, url: `https://nodejs.org/dist/${version}/node-${version}-${os}-${arm ? 'arm64' : 'x64'}.${ext}`, exe: 'node' }
}

async function go(): Promise<RuntimeSource> {
    const releases = await getJson<{ version: string; stable: boolean; files: { filename: string; os: string; arch: string; kind: string }[] }[]>('https://go.dev/dl/?mode=json')
    const release = releases.find(r => r.stable)
    const file = release?.files.find(f => f.kind === 'archive' && f.os === (isWin ? 'windows' : isMac ? 'darwin' : 'linux') && f.arch === (arm ? 'arm64' : 'amd64'))
    if (!release || !file) throw new Error('No Go download for this system')
    return { version: release.version.replace(/^go/, ''), url: `https://go.dev/dl/${file.filename}`, exe: 'go' }
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Standalone CPython builds that run without being compiled or installed system-wide.
async function python(): Promise<RuntimeSource> {
    const release = await getJson<{ assets: { name: string; browser_download_url: string }[] }>('https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest')
    const pattern = new RegExp(`^cpython-(3\\.(\\d+)\\.\\d+)\\+\\d+-${escapeRegExp(triple())}-install_only\\.tar\\.gz$`)
    const candidates = release.assets
        .map(a => ({ a, m: pattern.exec(a.name) }))
        .filter((x): x is { a: typeof x.a; m: RegExpExecArray } => !!x.m && Number(x.m[2]) <= 13)
        .sort((x, y) => Number(y.m[2]) - Number(x.m[2]))
    if (!candidates.length) throw new Error('No Python build for this system')
    return { version: candidates[0].m[1], url: candidates[0].a.browser_download_url, exe: isWin ? 'python' : 'python3' }
}

async function java(): Promise<RuntimeSource> {
    const os = isWin ? 'windows' : isMac ? 'mac' : 'linux'
    return { version: '21 (Temurin)', url: `https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${arm ? 'aarch64' : 'x64'}/jdk/hotspot/normal/eclipse`, exe: 'java' }
}

async function zig(): Promise<RuntimeSource> {
    const index = await getJson<Record<string, Record<string, { tarball?: string }>>>('https://ziglang.org/download/index.json')
    const versions = Object.keys(index).filter(v => /^\d+\.\d+\.\d+$/.test(v))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    const key = `${arm ? 'aarch64' : 'x86_64'}-${isWin ? 'windows' : isMac ? 'macos' : 'linux'}`
    const version = versions.find(v => index[v][key]?.tarball)
    if (!version) throw new Error('No Zig download for this system')
    return { version, url: index[version][key].tarball!, exe: 'zig' }
}

const SOURCES: Record<string, () => Promise<RuntimeSource>> = {
    node,
    go,
    python,
    java,
    zig,
    deno: async () => ({ version: 'latest', url: `https://github.com/denoland/deno/releases/latest/download/deno-${triple()}.zip`, exe: 'deno' }),
    bun: async () => ({ version: 'latest', url: `https://github.com/oven-sh/bun/releases/latest/download/bun-${isWin ? 'windows' : isMac ? 'darwin' : 'linux'}-${arm ? 'aarch64' : 'x64'}.zip`, exe: 'bun' }),
    rust: async () => ({ version: 'stable', url: `https://static.rust-lang.org/rustup/dist/${triple()}/rustup-init${isWin ? '.exe' : ''}`, exe: 'cargo', installer: true })
}

/** Runtimes Kalynt can download and set up by itself on this system. */
export const installableRuntimes = (): string[] => Object.keys(SOURCES)

export async function resolveSource(runtimeId: string): Promise<RuntimeSource> {
    const resolve = SOURCES[runtimeId]
    if (!resolve) throw new Error(`Kalynt can't install ${runtimeId} automatically; use its download page instead`)
    return resolve()
}

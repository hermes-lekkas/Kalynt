/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import os from 'os'
import fs from 'fs'
import { exec } from 'child_process'
import { nativeHelperService } from './native-helper-service'
import { readMemorySnapshot } from './memoryGuard'

export interface HardwareInfo {
    cpuCores: number
    cpuThreads: number
    cpuModel: string
    totalRAM: number
    availableRAM: number
    usedRAM: number
    hasGPU: boolean
    gpuName?: string
    totalVRAM?: number
    availableVRAM?: number
    totalDiskSpace: number | null
    availableDiskSpace: number | null
}

export interface RealTimeStats {
    cpuUsage: number // 0-100
    ramUsage: number // Used MB
    ramTotal: number // Total MB
    diskUsage: number | null // Used MB
    diskTotal: number | null // Total MB
    diskIOSpeed: number | null // Combined read+write MB/s (null when unavailable)
    networkConnected: boolean
    networkLatency: number | null // ms (null when unavailable)
    gpuUsage: number | null // 0-100 (null when unavailable)
    vramUsage: number | null // Used MB (null when unavailable)
    vramTotal: number // Total MB
    ivramUsage: number | null // Integrated VRAM Used MB (null when unavailable)
    ivramTotal: number // Integrated VRAM Total MB
}

interface DiskSpaceSnapshot {
    totalMB: number | null
    availableMB: number | null
    usedMB: number | null
    checkedAt: number
}

let cachedDiskSpace: DiskSpaceSnapshot = {
    totalMB: null,
    availableMB: null,
    usedMB: null,
    checkedAt: 0
}
let diskRefreshInFlight = false

function diskProbePath(): string {
    if (process.platform === 'win32') {
        const drive = process.env.SystemDrive || 'C:'
        return drive.endsWith('\\') ? drive : `${drive}\\`
    }
    return '/'
}

async function readRealDiskSpace(): Promise<{ totalMB: number | null; availableMB: number | null; usedMB: number | null }> {
    try {
        const stat = await fs.promises.statfs(diskProbePath())
        const blockSize = Number(stat.bsize)
        const totalBytes = Number(stat.blocks) * blockSize
        const availableBytes = Number(stat.bavail) * blockSize
        const freeBytes = Number(stat.bfree) * blockSize
        if (Number.isFinite(totalBytes) && totalBytes > 0 && Number.isFinite(availableBytes) && availableBytes >= 0) {
            const totalMB = Math.round(totalBytes / 1024 / 1024)
            const availableMB = Math.round(availableBytes / 1024 / 1024)
            const usedMB = Math.max(0, Math.round((totalBytes - (Number.isFinite(freeBytes) ? freeBytes : availableBytes)) / 1024 / 1024))
            cachedDiskSpace = { totalMB, availableMB, usedMB, checkedAt: Date.now() }
            return { totalMB, availableMB, usedMB }
        }
    } catch {
        // statfs unavailable on this filesystem
    }
    return { totalMB: null, availableMB: null, usedMB: null }
}

function refreshDiskSpaceIfStale(): void {
    if (diskRefreshInFlight || Date.now() - cachedDiskSpace.checkedAt < 30_000) return
    diskRefreshInFlight = true
    void readRealDiskSpace().finally(() => { diskRefreshInFlight = false })
}

function hasActiveNetworkInterface(): boolean {
    try {
        const interfaces = os.networkInterfaces()
        for (const entries of Object.values(interfaces)) {
            if (!entries) continue
            for (const entry of entries) {
                if (!entry.internal && entry.address && entry.address !== '::1' && !entry.address.startsWith('169.254.')) {
                    return true
                }
            }
        }
        return false
    } catch {
        return false
    }
}

/**
 * Lightweight GPU detector that caches results to avoid heavy process spawning
 */
class CachedGPUDetector {
    private static gpuName: string = 'Unknown GPU'
    private static totalVRAM: number = 0
    private static lastUsage: number | null = null
    private static lastVramUsed: number | null = null

    private static igpuName: string = 'Integrated GPU'
    private static totalIVRAM: number = 0
    private static lastIUsage: number | null = null
    private static lastIvramUsed: number | null = null

    private static lastCheck: number = 0
    private static isNvidia: boolean = false
    private static linuxDrmCard: string | null = null
    private static hasChecked: boolean = false

    static async init() {
        if (this.hasChecked) return

        try {
            if (process.platform === 'win32') {
                // Try nvidia-smi first (most accurate for NVIDIA)
                const nvidia = await this.execCommand('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits')
                if (nvidia) {
                    const [name, total] = nvidia.split(',').map(s => s.trim())
                    this.gpuName = name
                    this.totalVRAM = parseInt(total) || 0
                    this.isNvidia = true
                }

                // Comprehensive detection via PowerShell (Works for AMD, Intel, and NVIDIA)
                const psCmd = 'powershell -Command "Get-CimInstance Win32_VideoController | Select-Object Caption, AdapterRAM | ConvertTo-Json"'
                const psOutput = await this.execCommand(psCmd)
                if (psOutput) {
                    try {
                        const data = JSON.parse(psOutput)
                        const controllers = Array.isArray(data) ? data : [data]

                        for (const ctrl of controllers) {
                            const name = ctrl.Caption || ''
                            let ram = Math.round(Math.abs(ctrl.AdapterRAM || 0) / 1024 / 1024)
                            if (ram < 128) ram = 128

                            const isAMD = name.toLowerCase().includes('amd') || name.toLowerCase().includes('radeon')
                            const isIntel = name.toLowerCase().includes('intel')
                            const isNvidiaCard = name.toLowerCase().includes('nvidia')

                            if (isNvidiaCard) {
                                if (this.totalVRAM === 0) {
                                    this.gpuName = name
                                    this.totalVRAM = ram
                                    this.isNvidia = true
                                }
                            } else if (isAMD || isIntel) {
                                this.igpuName = name
                                this.totalIVRAM = ram

                                if (this.totalVRAM === 0) {
                                    this.gpuName = name
                                    this.totalVRAM = ram
                                }
                            }
                        }
                    } catch (e) {
                        console.error('[HardwareService] GPU PS Parse Error:', e)
                    }
                }
            } else if (process.platform === 'darwin') {
                // macOS GPU Detection
                const output = await this.execCommand('system_profiler SPDisplaysDataType')
                if (output) {
                    const chipMatch = output.match(/Chipset Model: (.*)/)
                    if (chipMatch && chipMatch[1]) {
                        this.gpuName = chipMatch[1].trim()
                    }

                    const vramMatch = output.match(/VRAM \(Total\): (.*)/)
                    if (vramMatch && vramMatch[1]) {
                        const vramStr = vramMatch[1].trim()
                        if (vramStr.includes('GB')) {
                            this.totalVRAM = parseInt(vramStr) * 1024
                        } else if (vramStr.includes('MB')) {
                            this.totalVRAM = parseInt(vramStr)
                        }
                    }

                    if (this.totalVRAM === 0 || this.gpuName.includes('Apple')) {
                        const dynamicMatch = output.match(/VRAM \(Dynamic, Max\): (.*)/)
                        if (dynamicMatch && dynamicMatch[1]) {
                            const dynVramStr = dynamicMatch[1].trim()
                            if (dynVramStr.includes('GB')) {
                                this.totalVRAM = parseInt(dynVramStr) * 1024
                            }
                        } else {
                            // Heuristic: 2/3 of total RAM for Unified Memory systems
                            this.totalVRAM = Math.round((os.totalmem() / 1024 / 1024) * 0.66)
                        }
                    }
                } else {
                    this.gpuName = 'Apple Metal GPU'
                    this.totalVRAM = Math.round(os.totalmem() / 1024 / 1024 / 2)
                }
                this.igpuName = this.gpuName
                this.totalIVRAM = this.totalVRAM
            } else if (process.platform === 'linux') {
                // NVIDIA first — same query as Windows.
                const nvidia = await this.execCommand('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits')
                if (nvidia) {
                    const [name, total] = nvidia.split(',').map(s => s.trim())
                    this.gpuName = name
                    this.totalVRAM = parseInt(total) || 0
                    this.isNvidia = true
                } else {
                    // AMD discrete cards expose their dedicated VRAM and utilization in sysfs.
                    try {
                        const cards = fs.readdirSync('/sys/class/drm').filter(d => /^card\d+$/.test(d))
                        for (const card of cards) {
                            const vramPath = `/sys/class/drm/${card}/device/mem_info_vram_total`
                            if (fs.existsSync(vramPath)) {
                                const bytes = parseInt(fs.readFileSync(vramPath, 'utf8').trim())
                                if (bytes > 0) {
                                    this.gpuName = 'AMD GPU'
                                    this.totalVRAM = Math.round(bytes / 1024 / 1024)
                                    this.linuxDrmCard = card
                                    break
                                }
                            }
                        }
                    } catch { /* sysfs layout differs; fall through to lspci */ }

                    if (this.totalVRAM === 0) {
                        const lspci = await this.execCommand('lspci')
                        const line = lspci.split('\n').find(l => /VGA compatible controller|3D controller|Display controller/i.test(l))
                        if (line) {
                            this.igpuName = line.replace(/^[^\s]+\s/, '').trim() || 'Integrated GPU'
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[HardwareService] GPU Init Error:', e)
        }

        this.hasChecked = true
    }

    static async getStats(): Promise<{ usage: number | null; vramUsed: number | null; iusage: number | null; ivramUsed: number | null }> {
        const now = Date.now()
        if (now - this.lastCheck < 2000) { // Only check every 2 seconds
            return {
                usage: this.lastUsage,
                vramUsed: this.lastVramUsed,
                iusage: this.lastIUsage,
                ivramUsed: this.lastIvramUsed
            }
        }

        try {
            if (this.isNvidia) {
                const stats = await this.execCommand('nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits')
                if (stats) {
                    const [usage, used] = stats.split(',').map(s => parseInt(s.trim()))
                    this.lastUsage = Number.isFinite(usage) ? usage : null
                    this.lastVramUsed = Number.isFinite(used) ? used : null
                }
            } else if (process.platform === 'win32') {
                // Real-time GPU Usage via Performance Counters (Intel/AMD)
                const usageCmd = 'powershell -Command "(Get-Counter \'\\GPU Engine(*engtype_3D)\\Utilization Percentage\' -ErrorAction SilentlyContinue).CounterSamples | Select-Object -ExpandProperty CookedValue | Measure-Object -Sum | Select-Object -ExpandProperty Sum"'
                const usageOutput = await this.execCommand(usageCmd)
                if (usageOutput) {
                    const parsed = parseFloat(usageOutput)
                    this.lastUsage = Number.isFinite(parsed) ? Math.min(100, Math.max(0, Math.round(parsed))) : null
                } else {
                    this.lastUsage = null
                }

                const memCmd = 'powershell -Command "$s = (Get-Counter \'\\GPU Adapter Memory(*)\\Shared Usage\' -ErrorAction SilentlyContinue).CounterSamples | Measure-Object -Property CookedValue -Sum; $d = (Get-Counter \'\\GPU Adapter Memory(*)\\Dedicated Usage\' -ErrorAction SilentlyContinue).CounterSamples | Measure-Object -Property CookedValue -Sum; ($s.Sum + $d.Sum) / 1024 / 1024"'
                const memOutput = await this.execCommand(memCmd)
                if (memOutput) {
                    const parsedMB = parseFloat(memOutput)
                    if (Number.isFinite(parsedMB)) {
                        this.lastIvramUsed = Math.round(parsedMB)
                        this.lastVramUsed = this.lastIvramUsed
                        this.lastIUsage = this.lastUsage
                    }
                }
            } else if (process.platform === 'linux' && this.linuxDrmCard) {
                // Read real sysfs GPU utilization and VRAM usage when exposed by AMDGPU driver.
                try {
                    const busyPath = `/sys/class/drm/${this.linuxDrmCard}/device/gpu_busy_percent`
                    const busy = parseInt(fs.readFileSync(busyPath, 'utf8').trim(), 10)
                    this.lastUsage = Number.isFinite(busy) ? Math.min(100, Math.max(0, busy)) : null
                } catch {
                    this.lastUsage = null
                }
                try {
                    const usedPath = `/sys/class/drm/${this.linuxDrmCard}/device/mem_info_vram_used`
                    const usedBytes = parseInt(fs.readFileSync(usedPath, 'utf8').trim(), 10)
                    this.lastVramUsed = Number.isFinite(usedBytes) ? Math.round(usedBytes / 1024 / 1024) : null
                } catch {
                    this.lastVramUsed = null
                }
                this.lastIUsage = null
                this.lastIvramUsed = null
            } else {
                // No real GPU utilization counters available on this platform/driver — report null instead of fabricating values.
                this.lastUsage = null
                this.lastVramUsed = null
                this.lastIUsage = null
                this.lastIvramUsed = null
            }
        } catch (_e) {
            // Silence errors during periodic checks
        }

        this.lastCheck = now
        return {
            usage: this.lastUsage,
            vramUsed: this.lastVramUsed,
            iusage: this.lastIUsage,
            ivramUsed: this.lastIvramUsed
        }
    }

    static getStaticInfo() {
        return {
            gpuName: this.gpuName,
            totalVRAM: this.totalVRAM,
            hasGPU: this.totalVRAM > 0,
            igpuName: this.igpuName,
            totalIVRAM: this.totalIVRAM
        }
    }

    static getStatsSnapshot() {
        return {
            usage: this.lastUsage,
            vramUsed: this.lastVramUsed,
            iusage: this.lastIUsage,
            ivramUsed: this.lastIvramUsed
        }
    }

    private static execCommand(cmd: string): Promise<string> {
        return new Promise((resolve) => {
            exec(cmd, { timeout: 1000 }, (error, stdout) => {
                if (error) resolve('')
                else resolve(stdout.trim())
            })
        })
    }
}

// Start async init
CachedGPUDetector.init()

// CPU tracking for usage calculation
let previousCpuInfo: os.CpuInfo[] | null = null

/**
 * Get hardware info - uses Node.js os/fs APIs and platform probes where available.
 */
export async function detectHardwareInfo(): Promise<HardwareInfo> {
    await CachedGPUDetector.init()
    let gpuInfo = CachedGPUDetector.getStaticInfo()

    // macOS: Attempt deep stats from Swift Helper
    if (process.platform === 'darwin' && nativeHelperService.isAvailable()) {
        try {
            const nativeStats = await Promise.race([
                nativeHelperService.request('hardware-stats'),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
            ])

            if (nativeStats?.gpu?.SPDisplaysDataType?.[0]) {
                const nativeGpu = nativeStats.gpu.SPDisplaysDataType[0]
                // spdisplays_vram reads like "8 GB" or "4096 MB".
                const vramText = String(nativeGpu.spdisplays_vram || '')
                const vramValue = parseFloat(vramText) || 0
                const vramMB = /gb/i.test(vramText) ? vramValue * 1024 : vramValue
                gpuInfo = {
                    ...gpuInfo,
                    gpuName: nativeGpu.sppci_model || gpuInfo.gpuName,
                    totalVRAM: vramMB > 0 ? vramMB : gpuInfo.totalVRAM,
                    hasGPU: true
                }
            }
        } catch (e) {
            console.warn('[HardwareService] Failed to get native macOS stats:', e)
        }
    }

    const cpus = os.cpus()
    const cpuModel = cpus[0]?.model || 'Unknown CPU'
    const cpuCores = cpus.length
    const cpuThreads = cpuCores

    const mem = readMemorySnapshot()
    const totalRAM = Math.round(mem.total / 1024 / 1024)
    const availableRAM = Math.round(mem.available / 1024 / 1024)
    const usedRAM = Math.max(0, totalRAM - availableRAM)
    const disk = await readRealDiskSpace()

    return {
        cpuCores,
        cpuThreads,
        cpuModel,
        totalRAM,
        availableRAM,
        usedRAM,
        hasGPU: gpuInfo.hasGPU,
        gpuName: gpuInfo.gpuName,
        totalVRAM: gpuInfo.totalVRAM,
        availableVRAM: gpuInfo.totalVRAM > 0 ? Math.max(0, gpuInfo.totalVRAM - 512) : 0,
        totalDiskSpace: disk.totalMB,
        availableDiskSpace: disk.availableMB
    }
}

/**
 * Get real-time stats - returns genuine readings and null for metrics unavailable on this platform.
 */
export function getRealTimeStats(): RealTimeStats {
    // CPU Usage Calculation
    const currentCpus = os.cpus()
    let cpuUsage = 0

    if (previousCpuInfo) {
        let totalIdle = 0
        let totalTick = 0

        for (let i = 0; i < currentCpus.length; i++) {
            const current = currentCpus[i]
            const previous = previousCpuInfo[i]

            if (current && previous) {
                const currentTicks = current.times.user + current.times.nice + current.times.sys + current.times.idle + current.times.irq
                const previousTicks = previous.times.user + previous.times.nice + previous.times.sys + previous.times.idle + previous.times.irq

                totalTick += (currentTicks - previousTicks)
                totalIdle += (current.times.idle - previous.times.idle)
            }
        }

        const idle = totalIdle / currentCpus.length
        const total = totalTick / currentCpus.length
        cpuUsage = total > 0 ? Math.round(100 - (100 * idle / total)) : 0
    }

    previousCpuInfo = currentCpus

    // RAM Usage (uses MemAvailable on Linux so reclaimable page cache isn't counted as used)
    const mem = readMemorySnapshot()
    const totalRAM = Math.round(mem.total / 1024 / 1024)
    const availableRAM = Math.round(mem.available / 1024 / 1024)
    const usedRAM = Math.max(0, totalRAM - availableRAM)

    // Disk space (asynchronously refreshed every 30s)
    refreshDiskSpaceIfStale()

    // GPU Stats (Sync-ish access to cached values)
    const gpuInfo = CachedGPUDetector.getStaticInfo()

    // Trigger an async update for next time, return cached values now
    void CachedGPUDetector.getStats()
    const gpuStats = CachedGPUDetector.getStatsSnapshot()

    return {
        cpuUsage,
        ramUsage: usedRAM,
        ramTotal: totalRAM,
        diskUsage: cachedDiskSpace.usedMB,
        diskTotal: cachedDiskSpace.totalMB,
        diskIOSpeed: null,
        networkConnected: hasActiveNetworkInterface(),
        networkLatency: null,
        gpuUsage: gpuStats.usage,
        vramUsage: gpuStats.vramUsed,
        vramTotal: gpuInfo.totalVRAM || 0,
        ivramUsage: gpuStats.ivramUsed,
        ivramTotal: gpuInfo.totalIVRAM || 0
    }
}

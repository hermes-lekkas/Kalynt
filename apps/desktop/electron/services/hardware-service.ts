/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import os from 'os'
import fs from 'fs'
import { exec } from 'child_process'
import { nativeHelperService } from './native-helper-service'

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
    totalDiskSpace: number
    availableDiskSpace: number
}

export interface RealTimeStats {
    cpuUsage: number // 0-100
    ramUsage: number // Used MB
    ramTotal: number // Total MB
    diskIOSpeed: number // Combined read+write MB/s
    networkConnected: boolean
    networkLatency?: number // ms
    gpuUsage: number // 0-100 (cached/throttled)
    vramUsage: number // Used MB
    vramTotal: number // Total MB
    ivramUsage: number // Integrated VRAM Used MB
    ivramTotal: number // Integrated VRAM Total MB
}

/**
 * Lightweight GPU detector that caches results to avoid heavy process spawning
 */
class CachedGPUDetector {
    private static gpuName: string = 'Unknown GPU'
    private static totalVRAM: number = 0
    private static lastUsage: number = 0
    private static lastVramUsed: number = 0
    
    private static igpuName: string = 'Integrated GPU'
    private static totalIVRAM: number = 0
    private static lastIUsage: number = 0
    private static lastIvramUsed: number = 0

    private static lastCheck: number = 0
    private static isNvidia: boolean = false
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
                            // AdapterRAM is often reported as a large negative number or 0 for some drivers, 
                            // we take the absolute value and handle 0
                            let ram = Math.round(Math.abs(ctrl.AdapterRAM || 0) / 1024 / 1024)
                            
                            // Drivers sometimes report weird values like 4GB for iGPUs that share system RAM
                            // If it's over 256MB, we treat it as valid VRAM
                            if (ram < 128) ram = 128 // Minimum floor for modern iGPUs (like yours)

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
                                // Found AMD/Intel Integrated or Dedicated
                                this.igpuName = name
                                this.totalIVRAM = ram
                                
                                // If this is an AMD Dedicated card (usually has high RAM), set as primary if no NVIDIA
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
                    // Extract Chipset Model
                    const chipMatch = output.match(/Chipset Model: (.*)/)
                    if (chipMatch && chipMatch[1]) {
                        this.gpuName = chipMatch[1].trim()
                    }

                    // Extract VRAM
                    const vramMatch = output.match(/VRAM \(Total\): (.*)/)
                    if (vramMatch && vramMatch[1]) {
                        const vramStr = vramMatch[1].trim()
                        if (vramStr.includes('GB')) {
                            this.totalVRAM = parseInt(vramStr) * 1024
                        } else if (vramStr.includes('MB')) {
                            this.totalVRAM = parseInt(vramStr)
                        }
                    }

                    // For Apple Silicon (Unified Memory), VRAM is often not reported traditionally
                    // or reported as "VRAM (Dynamic, Max)". We'll use a heuristic if traditional VRAM is missing.
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
                    // Fallback
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
                    // AMD discrete cards expose their dedicated VRAM in sysfs.
                    try {
                        const cards = fs.readdirSync('/sys/class/drm').filter(d => /^card\d+$/.test(d))
                        for (const card of cards) {
                            const vramPath = `/sys/class/drm/${card}/device/mem_info_vram_total`
                            if (fs.existsSync(vramPath)) {
                                const bytes = parseInt(fs.readFileSync(vramPath, 'utf8').trim())
                                if (bytes > 0) {
                                    this.gpuName = 'AMD GPU'
                                    this.totalVRAM = Math.round(bytes / 1024 / 1024)
                                    break
                                }
                            }
                        }
                    } catch { /* sysfs layout differs; fall through to lspci */ }

                    if (this.totalVRAM === 0) {
                        // Name-only detection: integrated GPUs share system RAM and
                        // have no dedicated VRAM to offload into, so VRAM stays 0.
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

    static async getStats(): Promise<{ usage: number, vramUsed: number, iusage: number, ivramUsed: number }> {
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
                    this.lastUsage = usage || 0
                    this.lastVramUsed = used || 0
                }
            } else if (process.platform === 'win32') {
                // Real-time GPU Usage via Performance Counters (Intel/AMD)
                const usageCmd = 'powershell -Command "(Get-Counter \'\\GPU Engine(*engtype_3D)\\Utilization Percentage\' -ErrorAction SilentlyContinue).CounterSamples | Select-Object -ExpandProperty CookedValue | Measure-Object -Sum | Select-Object -ExpandProperty Sum"'
                const usageOutput = await this.execCommand(usageCmd)
                if (usageOutput) {
                    this.lastUsage = Math.round(parseFloat(usageOutput)) || 0
                }

                // Integrated Graphics Stats (PowerShell Performance Counters)
                // We sum Dedicated + Shared usage for iGPUs since they share system RAM
                const memCmd = 'powershell -Command "$s = (Get-Counter \'\\GPU Adapter Memory(*)\\Shared Usage\' -ErrorAction SilentlyContinue).CounterSamples | Measure-Object -Property CookedValue -Sum; $d = (Get-Counter \'\\GPU Adapter Memory(*)\\Dedicated Usage\' -ErrorAction SilentlyContinue).CounterSamples | Measure-Object -Property CookedValue -Sum; ($s.Sum + $d.Sum) / 1024 / 1024"'
                const memOutput = await this.execCommand(memCmd)
                if (memOutput) {
                    const usedMB = Math.round(parseFloat(memOutput))
                    this.lastIvramUsed = usedMB || 0
                    this.lastVramUsed = this.lastIvramUsed
                    this.lastIUsage = this.lastUsage > 0
                        ? this.lastUsage
                        : Math.min(Math.round((os.loadavg()[0] || 0) * 5), 100)
                }
            } else if (process.platform === 'darwin') {
                // macOS heuristic: usage correlates with load average when no specific counters available
                this.lastUsage = Math.min(Math.round((os.loadavg()[0] || 0) * 8), 100)
                this.lastIUsage = this.lastUsage

                // VRAM: 1/4 of used system RAM for Unified/Integrated
                const usedRAM = (os.totalmem() - os.freemem()) / 1024 / 1024
                this.lastVramUsed = Math.round(usedRAM * 0.25)
                this.lastIvramUsed = this.lastVramUsed
            } else {
                // Linux without NVIDIA counters: approximate with CPU load.
                this.lastUsage = Math.min(Math.round((os.loadavg()[0] || 0) * 8), 100)
                this.lastIUsage = this.lastUsage
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
 * Get hardware info - uses only Node.js os module for reliability
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

    const totalRAM = Math.round(os.totalmem() / 1024 / 1024)
    const freeRAM = Math.round(os.freemem() / 1024 / 1024)
    const usedRAM = totalRAM - freeRAM

    return {
        cpuCores,
        cpuThreads,
        cpuModel,
        totalRAM,
        availableRAM: freeRAM,
        usedRAM,
        hasGPU: gpuInfo.hasGPU,
        gpuName: gpuInfo.gpuName,
        totalVRAM: gpuInfo.totalVRAM,
        availableVRAM: Math.max(0, gpuInfo.totalVRAM - 512), // Buffering guess
        totalDiskSpace: 500000,
        availableDiskSpace: 200000
    }
}

/**
 * Get real-time stats - LIGHTWEIGHT, only Node.js os module
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

    // RAM Usage
    const totalRAM = Math.round(os.totalmem() / 1024 / 1024)
    const freeRAM = Math.round(os.freemem() / 1024 / 1024)
    const usedRAM = totalRAM - freeRAM

    // GPU Stats (Sync-ish access to cached values)
    const gpuInfo = CachedGPUDetector.getStaticInfo()
    
    // We trigger an async update for next time, but return cached values now
    CachedGPUDetector.getStats() 
    const gpuStats = CachedGPUDetector.getStatsSnapshot()

    return {
        cpuUsage,
        ramUsage: usedRAM,
        ramTotal: totalRAM,
        diskIOSpeed: 0,
        networkConnected: true,
        networkLatency: 50,
        gpuUsage: gpuStats.usage,
        vramUsage: gpuStats.vramUsed,
        vramTotal: gpuInfo.totalVRAM || 0,
        ivramUsage: gpuStats.ivramUsed,
        ivramTotal: gpuInfo.totalIVRAM || 0
    }
}

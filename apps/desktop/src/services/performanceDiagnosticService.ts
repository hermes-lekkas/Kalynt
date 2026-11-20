/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export interface DiagnosticResult {
    bootTime: number // ms
    ipcLatency: number // ms
    diskReadSpeed: number // MB/s
    diskWriteSpeed: number // MB/s
    cpuScore: number // relative score
    timestamp: number
}

const BENCHMARK_ITERATIONS = 500_000
const CHUNK_SIZE = 20_000

function runPrimeBenchmarkInWorker(iterations: number): Promise<number> {
    return new Promise((resolve, reject) => {
        if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') {
            reject(new Error('Web Worker unavailable'))
            return
        }
        const source = `
self.onmessage = function(event) {
    const iterations = event.data;
    const start = performance.now();
    let count = 0;
    for (let i = 2; i < iterations; i++) {
        let isPrime = true;
        const limit = Math.sqrt(i);
        for (let j = 2; j <= limit; j++) {
            if (i % j === 0) {
                isPrime = false;
                break;
            }
        }
        if (isPrime) count++;
    }
    const duration = Math.max(performance.now() - start, 1);
    self.postMessage({ duration, count });
};
`
        const blobUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
        let worker: Worker
        try {
            worker = new Worker(blobUrl)
        } catch (err) {
            URL.revokeObjectURL(blobUrl)
            reject(err)
            return
        }

        const cleanup = () => {
            worker.terminate()
            URL.revokeObjectURL(blobUrl)
        }

        worker.onmessage = (event: MessageEvent<{ duration: number }>) => {
            const duration = Math.max(Number(event.data?.duration) || 1, 1)
            cleanup()
            resolve(Math.round(100000 / duration))
        }
        worker.onerror = (event) => {
            cleanup()
            reject(new Error(event.message || 'Worker benchmark failed'))
        }
        worker.postMessage(iterations)
    })
}

async function runPrimeBenchmarkChunked(iterations: number): Promise<number> {
    let elapsedComputeMs = 0
    let _count = 0
    for (let start = 2; start < iterations; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE, iterations)
        const chunkStart = performance.now()
        for (let i = start; i < end; i++) {
            let isPrime = true
            const limit = Math.sqrt(i)
            for (let j = 2; j <= limit; j++) {
                if (i % j === 0) {
                    isPrime = false
                    break
                }
            }
            if (isPrime) _count++
        }
        elapsedComputeMs += performance.now() - chunkStart
        // Yield back to the event loop between chunks so UI stays responsive.
        await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    return Math.round(100000 / Math.max(elapsedComputeMs, 1))
}

class PerformanceDiagnosticService {
    /**
     * Measures IPC round-trip latency
     */
    public async measureIPCLatency(): Promise<number> {
        const start = performance.now()
        await window.electronAPI?.performance?.getStatus?.()
        return performance.now() - start
    }

    /**
     * Measures Disk I/O speed using temporary files
     */
    public async measureDiskSpeed(): Promise<{ read: number; write: number }> {
        try {
            const result = await window.electronAPI?.performance?.testDiskSpeed?.()
            return result ?? { read: 0, write: 0 }
        } catch (e) {
            console.error('[PerformanceDiagnostic] Disk test failed:', e)
            return { read: 0, write: 0 }
        }
    }

    /**
     * Off-main-thread CPU benchmark (calculating primes in a Web Worker,
     * falling back to time-sliced async chunks if Workers are unavailable).
     */
    public async runCPUBenchmark(): Promise<number> {
        try {
            return await runPrimeBenchmarkInWorker(BENCHMARK_ITERATIONS)
        } catch {
            return await runPrimeBenchmarkChunked(BENCHMARK_ITERATIONS)
        }
    }

    /**
     * Runs all diagnostics
     */
    public async runFullDiagnostic(): Promise<DiagnosticResult> {
        const cpu = await this.runCPUBenchmark()
        const ipc = await this.measureIPCLatency()
        const disk = await this.measureDiskSpeed()

        // Boot time from main process
        const bootTime = await window.electronAPI?.performance?.getBootTime?.()

        return {
            bootTime: bootTime || 0,
            ipcLatency: Math.round(ipc * 100) / 100,
            diskReadSpeed: Math.round(disk.read * 10) / 10,
            diskWriteSpeed: Math.round(disk.write * 10) / 10,
            cpuScore: cpu,
            timestamp: Date.now()
        }
    }
}

export const performanceDiagnosticService = new PerformanceDiagnosticService()

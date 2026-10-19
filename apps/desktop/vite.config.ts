/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import path from 'node:path'
import JavaScriptObfuscator from 'javascript-obfuscator'

const isProduction = process.env.NODE_ENV === 'production'
const shouldObfuscate = process.env.OBFUSCATE === 'true'

// ============================================================================
// PROPRIETARY FILES WHITELIST
// These are the ONLY files that will be obfuscated to prevent build failures
// ============================================================================
const PROPRIETARY_FILES = [
    // Backend Services (Node.js)
    'electron/handlers/llm-inference.ts',

    // Frontend Services (Browser)
    'src/services/agentService.ts',
    'src/services/offlineLLMService.ts',
    'src/services/aiService.ts',

    // Core Logic
    'src/types/aime.ts',
    'src/services/hardwareService.ts'
]

// Normalize paths for cross-platform comparison
const PROPRIETARY_PATHS = PROPRIETARY_FILES.map(p =>
    path.resolve(__dirname, p).replace(/\\/g, '/')
)

// ============================================================================
// HEAVY OBFUSCATION CONFIGURATION
// Optimized for stability and protection
// ============================================================================
function getObfuscationOptions(target: 'node' | 'browser') {
    return {
        compact: true,
        simplify: true,
        identifierNamesGenerator: 'hexadecimal' as const,

        // String Protection
        stringArray: true,
        stringArrayCallsTransform: true,
        stringArrayCallsTransformThreshold: 0.5, // Reduced for stability
        stringArrayEncoding: ['rc4' as const],
        stringArrayThreshold: 0.5, // Reduced for stability

        // Control Flow
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.5, // Reduced for stability
        deadCodeInjection: false, // Disabled as it frequently causes build crashes in large files

        // Safety
        numbersToExpressions: true,
        transformObjectKeys: true,
        unicodeEscapeSequence: false,
        splitStrings: true,
        splitStringsChunkLength: 50,

        // Environment
        target: target as any,
        sourceMap: false,
        selfDefending: false // Disabled to prevent runtime infinite loops in some environments
    }
}

function createObfuscatorPlugin(): Plugin {
    return {
        name: 'vite-plugin-selective-obfuscator',
        enforce: 'post',

        transform(code: string, id: string) {
            if (!shouldObfuscate || !isProduction) return null

            const normalizedId = id.replace(/\\/g, '/').split('?')[0]
            const shouldObfuscateFile = PROPRIETARY_PATHS.some(p =>
                normalizedId.endsWith(p.split('/').slice(-2).join('/'))
            )

            if (!shouldObfuscateFile) return null

            const isNodeFile = normalizedId.includes('/electron/') || normalizedId.includes('/handlers/')
            const target = isNodeFile ? 'node' : 'browser'
            const options = getObfuscationOptions(target)

            console.log(`[Obfuscator] Obfuscating proprietary ${target} file: ${path.basename(normalizedId)}`)

            try {
                const result = JavaScriptObfuscator.obfuscate(code, options)
                return {
                    code: result.getObfuscatedCode(),
                    map: null
                }
            } catch (error) {
                console.error(`[Obfuscator] Failed to obfuscate ${path.basename(normalizedId)}:`, error)
                return null
            }
        }
    }
}

export default defineConfig({
    plugins: [
        react(),
        createObfuscatorPlugin(),
        electron({
            main: {
                entry: ['electron/main.ts', 'electron/extensions/extensionHostProcess.ts'],
                vite: {
                    build: {
                        outDir: 'dist-electron',
                        minify: isProduction ? 'terser' : false,
                        terserOptions: isProduction ? {
                            mangle: {
                                toplevel: true,
                                properties: {
                                    regex: /^_private_/
                                }
                            },
                            // console.error and console.warn stay so failures can be diagnosed.
                            compress: {
                                drop_debugger: true,
                                passes: 3,
                                pure_funcs: ['console.log', 'console.info', 'console.debug']
                            },
                            format: {
                                comments: false
                            }
                        } : undefined,
                        rollupOptions: {
                            external: [
                                'electron',
                                'better-sqlite3',
                                'node-pty',
                                'simple-git',
                                'node-llama-cpp',
                                'chokidar'
                            ],
                            output: {
                                format: 'cjs',
                                // Stable names: hashed shared chunks piled up in dist-electron on every build.
                                chunkFileNames: '[name].js'
                            }
                        }
                    }
                }
            },
            preload: {
                input: 'electron/preload.ts',
                vite: {
                    build: {
                        outDir: 'dist-electron',
                        minify: isProduction ? 'terser' : false,
                        terserOptions: isProduction ? {
                            mangle: { toplevel: true },
                            compress: {
                                drop_debugger: true,
                                pure_funcs: ['console.log', 'console.info', 'console.debug']
                            },
                            format: { comments: false }
                        } : undefined
                    }
                }
            },
            renderer: {}
        })
    ],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@collabforge/crdt': path.resolve(__dirname, '../../packages/crdt/src'),
            '@collabforge/networking': path.resolve(__dirname, '../../packages/networking/src'),
            '@collabforge/crypto': path.resolve(__dirname, '../../packages/crypto/src'),
            '@collabforge/shared': path.resolve(__dirname, '../../packages/shared/src')
        }
    },
    optimizeDeps: {
        include: ['react-window', 'lodash.debounce']
    },
    build: {
        rollupOptions: {
            external: ['better-sqlite3'],
            output: {
                chunkFileNames: isProduction ? 'assets/[hash].js' : 'assets/[name]-[hash].js',
                entryFileNames: isProduction ? 'assets/[hash].js' : 'assets/[name]-[hash].js',
                assetFileNames: isProduction ? 'assets/[hash][extname]' : 'assets/[name]-[hash][extname]'
            }
        },
        minify: isProduction ? 'terser' : 'esbuild',
        terserOptions: isProduction ? {
            mangle: {
                toplevel: true
            },
            compress: {
                drop_console: true,
                drop_debugger: true,
                // A second pass removes the __reExport() call in Monaco's bundled language
                // contributions, leaving `Emitter` undefined and the editor unable to load.
                passes: 1
            },
            format: {
                comments: false
            }
        } : undefined,
        sourcemap: !isProduction
    },
    esbuild: isProduction ? {
        drop: ['console', 'debugger'],
        legalComments: 'none'
    } : {}
})

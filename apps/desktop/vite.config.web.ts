/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Web-only mode config - runs Kalynt in a browser without Electron
 * Usage: npm run dev:web
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const isProduction = process.env.NODE_ENV === 'production'

export default defineConfig({
    plugins: [
        react(),
    ],
    define: {
        'process.env.IS_WEB': JSON.stringify('true'),
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@collabforge/crdt': path.resolve(__dirname, '../../packages/crdt/src'),
            '@collabforge/networking': path.resolve(__dirname, '../../packages/networking/src'),
            '@collabforge/shared': path.resolve(__dirname, '../../packages/shared/src')
        }
    },
    optimizeDeps: {
        exclude: ['node-pty', 'electron']
    },
    server: {
        host: '0.0.0.0',
        port: 5000,
        allowedHosts: true,
        headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
    },
    preview: {
        host: '0.0.0.0',
        port: 5000,
        allowedHosts: true,
    },
    build: {
        outDir: 'dist',
        rollupOptions: {
            external: ['electron'],
            output: {
                chunkFileNames: isProduction ? 'assets/[hash].js' : 'assets/[name]-[hash].js',
                entryFileNames: isProduction ? 'assets/[hash].js' : 'assets/[name]-[hash].js',
                assetFileNames: isProduction ? 'assets/[hash][extname]' : 'assets/[name]-[hash][extname]'
            }
        },
        minify: 'esbuild',
        sourcemap: !isProduction
    },
})

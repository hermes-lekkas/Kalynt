/* SPDX-License-Identifier: AGPL-3.0-only */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const files = ['electron', 'src'].flatMap(dir => fs.readdirSync(path.join(root, dir), { recursive: true })
    .filter(file => file.endsWith('.test.mjs')).map(file => path.join(root, dir, file))).sort()
if (!files.length) throw new Error('No desktop tests found')
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' })
if (result.error) console.error(result.error)
process.exitCode = result.status ?? 1

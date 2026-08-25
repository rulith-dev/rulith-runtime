// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const files = [
  'agent/rulith-agent.mjs',
  'worker/rulith-worker.mjs',
  'station/rulith-station.mjs',
  'config/rulith-sources.example.json',
  'config/rulith-station.example.json',
  'config/rulith-tools.example.json',
  'examples/verified-calculation/README.md',
  'examples/verified-calculation/data/input.json',
  'examples/verified-calculation/prepare-runtime.mjs',
  'examples/verified-calculation/prepare-station.mjs',
  'examples/verified-calculation/read-input.mjs',
  'examples/verified-calculation/recipe.template.json',
  'examples/verified-calculation/setup.mjs',
  'examples/verified-calculation/verify-output.mjs',
  'examples/verified-calculation/worker-tools.template.json',
  'examples/verified-calculation/write-output.mjs',
]

const sha256 = (file) => createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')
const manifest = {
  schema: 'rulith-local-runtime-artifacts/v1',
  source: 'https://github.com/rulith-dev/rulith-runtime',
  files: Object.fromEntries(files.map((file) => [file, { sha256: sha256(file) }])),
}

writeFileSync(resolve(root, 'artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote ${files.length} artifact hashes`)

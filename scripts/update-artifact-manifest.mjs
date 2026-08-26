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
  'examples/verified-calculation/write-output.mjs',
]

// The public release is served from Git blobs, whose text form is LF. Windows
// checkouts may present the same tracked file as CRLF; hashing that worktree
// representation made the manifest disagree with GitHub Raw and Linux CI.
// Hash the repository-canonical text bytes instead. `.gitattributes` pins LF
// for future checkouts; this normalization also makes the generator stable in
// an already-created Windows checkout.
const canonicalBytes = (file) => Buffer.from(
  readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n'),
  'utf8',
)
const sha256 = (file) => createHash('sha256').update(canonicalBytes(file)).digest('hex')
const manifest = {
  schema: 'rulith-local-runtime-artifacts/v1',
  source: 'https://github.com/rulith-dev/rulith-runtime',
  files: Object.fromEntries(files.map((file) => [file, { sha256: sha256(file) }])),
}

writeFileSync(resolve(root, 'artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote ${files.length} artifact hashes`)

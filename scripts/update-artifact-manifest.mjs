// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const files = [
  'agent/rulith-agent.mjs',
  // The vendored public MCP contract. The Agent's surface is generated from it, so a
  // download that fetched the agent without it would install bytes nobody could reconcile
  // against the commit they were projected from.
  'protocol/mcp-contract.json',
  // The vendored private Worker hop. The Worker's projection is generated from it, so a
  // download that fetched the worker without it would install bytes nobody could reconcile
  // against the commit they were projected from.
  'protocol/worker-contract.json',
  'worker/rulith-worker.mjs',
  'worker/mcp-client.mjs',
  'local/rulith-local.mjs',
  'local/local-ui.mjs',
  'local/mcp-services.mjs',
  'local/mcp-registry.mjs',
  'local/mcp-registry-ui.mjs',
  'local/mcp-services-ui.mjs',
  'docs/local-mcp-setup.md',
  'config/rulith-sources.example.json',
  'config/rulith-local.example.json',
  'config/worker-tools.example.json',
  'examples/verified-calculation/README.md',
  'examples/verified-calculation/data/input.json',
  'examples/verified-calculation/read-input.mjs',
  'examples/verified-calculation/setup.mjs',
  'examples/verified-calculation/worker-tools.json',
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

const output = `${JSON.stringify(manifest, null, 2)}\n`
const target = resolve(root, 'artifact-manifest.json')
if (process.argv.includes('--check')) {
  const current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
  if (current !== output) {
    throw new Error('artifact-manifest.json is stale. Run npm run manifest, review the changed trust anchors, and commit them before packing.')
  }
  console.log(`verified ${files.length} artifact hashes`)
} else {
  writeFileSync(target, output)
  console.log(`wrote ${files.length} artifact hashes`)
}

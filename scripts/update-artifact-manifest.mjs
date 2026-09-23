// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const files = [
  'agent/rulith-agent.mjs',
  'agent/local-trace.mjs',
  'agent/conversation-store.mjs',
  'agent/conversation-reader.mjs',
  // The vendored public MCP contract. The Agent's surface is generated from it, so a
  // download that fetched the agent without it would install bytes nobody could reconcile
  // against the commit they were projected from.
  'protocol/mcp-contract.json',
  // The vendored private Worker hop. The Worker's projection is generated from it, so a
  // download that fetched the worker without it would install bytes nobody could reconcile
  // against the commit they were projected from.
  'protocol/worker-contract.json',
  // Separately approved material amendment; the historical execution bundle keeps its pin.
  'protocol/worker-material.json',
  'protocol/worker-material-sha256.txt',
  'worker/rulith-worker.mjs',
  'worker/mcp-client.mjs',
  'worker/material-store.mjs',
  'worker/material-transport.mjs',
  'worker/local-authoring.mjs',
  'worker/authoring-diagnostics.mjs',
  'local/authoring-checker.mjs',
  'local/authoring-checker.json',
  'local/process-tree.mjs',
  'local/rulith-local.mjs',
  'local/material-service.mjs',
  'local/local-ui.mjs',
  'local/theme.mjs',
  'local/manager-registry.mjs',
  'local/model-settings.mjs',
  'local/device-client.mjs',
  'local/instance-manager.mjs',
  'local/manager-server.mjs',
  'local/manager-ui.mjs',
  'docs/local-manager.md',
  'docs/local-materials.md',
  'local/markdown.mjs',
  'local/setup-service.mjs',
  'local/setup-ui.mjs',
  'local/mcp-services.mjs',
  'local/mcp-registry.mjs',
  'local/mcp-registry-ui.mjs',
  'local/worker-tools-ui.mjs',
  'local/worker-tools-browser.mjs',
  'local/worker-tool-management.mjs',
  'docs/local-mcp-setup.md',
  'docs/local-setup.md',
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

// Every shipped executable module must be pinned. Keep the list explicit for review,
// but reject an overlooked new import instead of silently packing unpinned source.
for (const directory of ['agent', 'worker', 'local']) {
  for (const entry of readdirSync(resolve(root, directory), { recursive: true })) {
    const file = directory + '/' + entry.replaceAll('\\', '/')
    if (file.endsWith('.mjs') && !files.includes(file))
      throw new Error(`Shipped module ${file} is missing from the artifact manifest list.`)
  }
}

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

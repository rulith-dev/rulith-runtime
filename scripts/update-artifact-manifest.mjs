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
  // Separate Gateway pre-execution review bundle, pinned to its committed spec bytes.
  'protocol/worker-review-contract.json',
  // Separately approved material amendment; the historical execution bundle keeps its pin.
  'protocol/worker-material.json',
  'protocol/worker-material-sha256.txt',
  'protocol/action-input-guards.json',
  'protocol/action-input-guards-v1.json',
  'protocol/action-input-adoption.json',
  'protocol/worker-selected-material.schema.json',
  'protocol/worker-selected-material-overlay-pin.json',
  'worker/rulith-worker.mjs',
  'worker/run-artifacts.mjs',
  'worker/action-input-db.mjs',
  'worker/mcp-client.mjs',
  'worker/material-store.mjs',
  'worker/material-transport.mjs',
  'worker/local-authoring.mjs',
  'worker/authoring-diagnostics.mjs',
  // The run Tool implementation boundary (SYS-TOOL-01): the preload and its loader hooks.
  'worker/implementation-boundary.mjs',
  'worker/implementation-hooks.mjs',
  'local/authoring-checker.mjs',
  'local/authoring-checker.json',
  'local/process-tree.mjs',
  'local/rulith-local.mjs',
  'local/material-service.mjs',
  'local/local-ui.mjs',
  'local/theme.mjs',
  'local/manager-registry.mjs',
  'local/process-identity.mjs',
  'local/model-settings.mjs',
  'local/device-client.mjs',
  'local/instance-manager.mjs',
  'local/tool-library.mjs',
  'local/manager-server.mjs',
  'local/manager-ui.mjs',
  'local/manager-health.mjs',
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
  // The opt-in toolkit, contracts, examples and Source Capability ship together.
  'kits/general/README.md',
  'kits/general/acceptance.mjs',
  'kits/general/acceptance-specs.mjs',
  'kits/general/acceptance_v2.mjs',
  'kits/general/adapter.mjs',
  'kits/general/apply-patch.mjs',
  'kits/general/apply_patch.mjs',
  'kits/general/apply_patch_v2.mjs',
  'kits/general/general-settings.mjs',
  'kits/general/glob-files.mjs',
  'kits/general/glob.mjs',
  'kits/general/image.mjs',
  'kits/general/install.mjs',
  'kits/general/installer.mjs',
  'kits/general/job_poll.mjs',
  'kits/general/job_poll_v2.mjs',
  'kits/general/job_start.mjs',
  'kits/general/job_start_v2.mjs',
  'kits/general/job_stop.mjs',
  'kits/general/job_stop_v2.mjs',
  'kits/general/lib.mjs',
  'kits/general/list.mjs',
  'kits/general/measure_pinned.mjs',
  'kits/general/pack/build-pack.mjs',
  'kits/general/pack/official-recipe.json',
  'kits/general/pack/program.json',
  'kits/general/pack/program-v2.json',
  'kits/general/pack/program-v3.json',
  'kits/general/pack/sources.json',
  'kits/general/pack/sources-v3.json',
  'kits/general/pack/sources-v4.json',
  'kits/general/patch_file.mjs',
  'kits/general/patch_file_v2.mjs',
  'kits/general/pinned-measure-interpreted.example.json',
  'kits/general/pinned-measure.example.json',
  'kits/general/pinned-test.example.json',
  'kits/general/read.mjs',
  'kits/general/read_image.mjs',
  'kits/general/read_v2.mjs',
  'kits/general/run.mjs',
  'kits/general/run_v2.mjs',
  'kits/general/search.mjs',
  'kits/general/settings.example.json',
  'kits/general/supervisor.mjs',
  'kits/general/test.mjs',
  'kits/general/test_v2.mjs',
  'kits/general/test_v3.mjs',
  'kits/general/tree_state.mjs',
  'kits/general/web.mjs',
  'kits/general/web_fetch.mjs',
  'kits/general/web_search.mjs',
  'kits/general/worker-tools.json',
  'kits/general/write_file.mjs',
  'kits/general/write_file_v2.mjs',
]

// Every shipped executable module must be pinned. Keep the list explicit for review,
// but reject an overlooked new import instead of silently packing unpinned source.
for (const directory of ['agent', 'worker', 'local', 'kits']) {
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

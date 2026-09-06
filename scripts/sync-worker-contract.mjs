// SPDX-License-Identifier: Apache-2.0
/**
 * Vendor the private Worker protocol from a named commit of the contract repository.
 *
 * This is a **separate** artefact from `protocol/mcp-contract.json`, and deliberately so.
 * That one is the Agent's public MCP surface; this one is the Worker's private hop, which
 * no model ever sees. Folding one into the other would let a change to a private execution
 * rule ride in under a public-surface pin, so they are vendored, verified and named apart.
 *
 * The bytes come from Git, not from the working tree: every file is read with
 * `git show <commit>:<path>` and recorded beside the blob object id `git rev-parse` gives
 * for it. That pair is what makes the pin checkable by anyone holding the repository —
 * a digest this file computed over itself would only prove self-consistency.
 *
 *   node scripts/sync-worker-contract.mjs --repo D:/Work/rulith --commit <40-hex>
 *
 * Nothing is written unless every file resolves at that exact commit and the working tree
 * of the contract repository is irrelevant to the result.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { WORKER_BUNDLE_PATH, WORKER_BUNDLE_SCHEMA, WORKER_CONTRACT_FILES, readWorkerContract } from './verify-worker-contract.mjs'
import { workerProjectionBlock, withWorkerProjection } from './generate-worker-protocol.mjs'
import { readFileSync } from 'node:fs'

const ROOT = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const flag = (name) => {
  const at = argv.indexOf(name)
  return at < 0 || at + 1 >= argv.length ? undefined : argv[at + 1]
}
const die = (message) => { console.error(`\n✗ ${message}\n`); process.exit(1) }

const repo = flag('--repo')
const commit = flag('--commit')
if (repo === undefined || commit === undefined) {
  die('Usage: node scripts/sync-worker-contract.mjs --repo <contract-repo> --commit <40-hex>')
}
if (!/^[0-9a-f]{40}$/u.test(commit)) {
  die(`--commit ${commit} is not a full 40-character commit id. A short id names a commit that may become ambiguous;`
    + ' the pin has to say exactly which bytes were read.')
}

const git = (args) => {
  const run = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (run.status !== 0) die(`git ${args.join(' ')} failed in ${repo}: ${String(run.stderr ?? '').trim()}`)
  return run.stdout
}

// The commit must exist and be a commit, not a tag or a branch tip that moves.
const type = git(['cat-file', '-t', commit]).trim()
if (type !== 'commit') die(`${commit} is a ${type}, not a commit.`)

const files = {}
for (const path of WORKER_CONTRACT_FILES) {
  const content = git(['show', `${commit}:${path}`])
  const gitBlobOid = git(['rev-parse', `${commit}:${path}`]).trim()
  files[path] = {
    sha256: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
    gitBlobOid,
    content,
  }
}

const bundle = {
  schema: WORKER_BUNDLE_SCHEMA,
  sourceCommit: commit,
  sourceRepository: git(['config', '--get', 'remote.origin.url']).trim() || 'rulith',
  files,
}

// The reader this Runtime uses at every `npm run check` has to accept it before it is written.
let parsed
try {
  parsed = readWorkerContract(bundle, { path: WORKER_BUNDLE_PATH })
} catch (error) {
  die(`The exported bundle is not one this Runtime can read: ${String(error?.message ?? error)}`)
}

writeFileSync(resolve(ROOT, WORKER_BUNDLE_PATH), `${JSON.stringify(bundle, null, 2)}\n`)
const worker = resolve(ROOT, 'worker', 'rulith-worker.mjs')
writeFileSync(worker, withWorkerProjection(readFileSync(worker, 'utf8'), workerProjectionBlock(parsed)))

console.log(`Vendored ${WORKER_BUNDLE_PATH} from ${commit} (${Object.keys(files).length} file(s) read out of Git)`
  + ' and regenerated the Worker projection.'
  + '\nRun: npm run manifest && npm run check && npm test')

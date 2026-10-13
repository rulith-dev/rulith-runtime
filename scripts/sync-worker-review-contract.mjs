// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readWorkerReviewContract, WORKER_REVIEW_BUNDLE_PATH } from './verify-worker-review-contract.mjs'
import { withWorkerProjection, workerProjectionBlock } from './generate-worker-protocol.mjs'
import { loadWorkerContract } from './verify-worker-contract.mjs'

const args = process.argv.slice(2)
const flag = name => args[args.indexOf(name) + 1]
const repository = flag('--repo'), commit = flag('--commit')
if (!args.includes('--repo') || !args.includes('--commit') || !/^[a-f0-9]{40}$/.test(commit ?? '')) {
  throw new Error('Usage: node scripts/sync-worker-review-contract.mjs --repo <contract-repo> --commit <40-hex>')
}
const root = resolve(import.meta.dirname, '..')
const path = resolve(root, WORKER_REVIEW_BUNDLE_PATH)
const bundle = execFileSync(process.execPath, [resolve(repository, 'scripts/export-worker-review-contract.mjs'), commit],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
const review = readWorkerReviewContract(JSON.parse(bundle))
writeFileSync(path, bundle)
execFileSync(process.execPath, [resolve(repository, 'scripts/verify-worker-review-contract.mjs'), path],
  { stdio: 'inherit', windowsHide: true })
const worker = resolve(root, 'worker/rulith-worker.mjs')
writeFileSync(worker, withWorkerProjection(readFileSync(worker, 'utf8'), workerProjectionBlock(loadWorkerContract(root), review)))
console.log(`Vendored ${WORKER_REVIEW_BUNDLE_PATH} using the spec exporter at ${commit}; source bytes verified.`)

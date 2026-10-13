// SPDX-License-Identifier: Apache-2.0
// The exporter/byte verifier is the spec's own separate review bundle mechanism.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { workerReviewContractBundle, verifyGitWorkerReviewContractBundle } from './lib/worker-review-contract.mjs'
import { contractRepoPath } from './verify-worker-contract.mjs'

export const WORKER_REVIEW_BUNDLE_PATH = 'protocol/worker-review-contract.json'
const ROOT = resolve(import.meta.dirname, '..')

export function readWorkerReviewContract(bundle) {
  const expected = workerReviewContractBundle(path => {
    const file = bundle.files?.[path]
    if (typeof file?.content !== 'string') throw new Error(`Missing review source: ${path}`)
    return file.content
  }, bundle.sourceCommit)
  if (!isDeepStrictEqual(bundle, expected)) throw new Error('Worker review bundle bytes, digests or definitions differ')
  return { sourceCommit: bundle.sourceCommit, defs: bundle.contract.$defs,
    capability: Object.fromEntries(Object.entries(bundle.contract.$defs.ReviewerCapability.properties)
      .map(([key, rule]) => [key, rule.const])) }
}

export function loadWorkerReviewContract(root = ROOT) {
  const bundle = JSON.parse(readFileSync(resolve(root, WORKER_REVIEW_BUNDLE_PATH), 'utf8'))
  const contract = readWorkerReviewContract(bundle)
  const repository = contractRepoPath(root)
  if (repository !== undefined) verifyGitWorkerReviewContractBundle(repository, bundle)
  return contract
}

if (process.argv[1]?.endsWith('verify-worker-review-contract.mjs')) {
  const contract = loadWorkerReviewContract()
  console.log(`${WORKER_REVIEW_BUNDLE_PATH}: verified separate review bundle from ${contract.sourceCommit}`)
}

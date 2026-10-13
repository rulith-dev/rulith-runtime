import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'

export const workerReviewSources = [
  'docs/specs/schemas/rulith-worker-protocol-v2.schema.json',
  'docs/specs/worker-tool-execution-spec.md',
  'docs/reviews/d1013c-texts-2026-10-13.md',
]

// A separate, self-contained Gateway review overlay; no Kernel clearance contracts.
export function workerReviewContractBundle(read, sourceCommit) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('A full committed source identity is required')
  const files = Object.fromEntries(workerReviewSources.map(path => {
    const content = read(path)
    return [path, { content, sha256: createHash('sha256').update(content).digest('hex'),
      gitBlobOid: createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex') }]
  }))
  const schema = JSON.parse(files[workerReviewSources[0]].content)
  const names = ['WorkerId', 'Generation', 'Digest', 'Lease', 'ReviewerCapability',
    'PreExecutionReviewReply', 'PreExecutionReviewErrorCode', 'PreExecutionReviewMaterial',
    'WorkerPreExecutionReviewOffer', 'WorkerPreExecutionReviewPollResponse', 'ReportWorkPreExecutionReview']
  const defs = Object.fromEntries(names.map(name => {
    if (!schema.$defs[name]) throw new Error(`Missing review definition: ${name}`)
    return [name, schema.$defs[name]]
  }))
  return { schema: 'rulith-worker-pre-execution-review-bundle/v1', sourceCommit,
    contract: { $schema: schema.$schema, $id: 'rulith-worker-pre-execution-review.schema.json', $defs: defs },
    pollProperty: { reviewer: { $ref: '#/$defs/ReviewerCapability' } }, files }
}

export function readGitWorkerReviewContractBundle(repository, revision) {
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 })
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).trim()
  return workerReviewContractBundle(path => git(['show', `${commit}:${path}`]), commit)
}

export function verifyGitWorkerReviewContractBundle(repository, bundle) {
  if (!/^[a-f0-9]{40}$/.test(bundle?.sourceCommit)) throw new Error('A full source commit is required')
  const expected = readGitWorkerReviewContractBundle(repository, bundle.sourceCommit)
  if (!isDeepStrictEqual(bundle, expected)) throw new Error('Worker review bundle differs from its committed source or definitions')
  return expected
}

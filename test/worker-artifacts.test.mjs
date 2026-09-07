// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { prepareActionReport, actionRowFaults } from '../worker/rulith-worker.mjs'
import { loadWorkerContract } from '../scripts/verify-worker-contract.mjs'
import { shapeFaults } from './support/contract-shape.mjs'
import { actionRow, CONNECTION, HOLD, driveWorker } from './support/worker-harness.mjs'

const contract = loadWorkerContract()
const artifactDefs = contract.artifactSchema.$defs
const ref = `art_${'a'.repeat(32)}`
const response = upload => ({ ref, mediaType: upload.mediaType, encoding: 'utf8',
  digest: upload.digest, totalBytes: Buffer.from(upload.bytes, 'base64').length })

test('ART-WK-1: real report routing enforces each committed Source and budget decision before upload', async () => {
  const rows = contract.fixture.boundaries.find(row => row.id === 'worker-action-item').valid
  for (const arm of contract.fixture.actionWorkUploadInvariants.arms) {
    const row = { ...rows.find(row => row.work === arm.work), ...arm.change }
    let uploads = 0
    const result = await prepareActionReport(row, { ok: true, result: 'x'.repeat(arm.resultBytes) }, async payload => {
      uploads++
      if (arm.storageFailure) throw Error(arm.storageFailure)
      assert.deepEqual(shapeFaults(payload, artifactDefs.ArtifactUpload, artifactDefs), [], arm.id)
      return response(payload)
    })
    if (['refused', 'undeliverable'].includes(arm.outcome)) {
      assert.ok(result.unavailable, arm.id)
      assert.equal(result.body, undefined, arm.id)
      assert.equal(uploads, arm.storageFailure ? 1 : 0, arm.id)
      if (arm.refusal) assert.equal(result.unavailable, arm.refusal, arm.id)
    } else {
      assert.equal(result.unavailable, undefined, arm.id)
      assert.equal(uploads, arm.outcome === 'upload' ? 1 : 0, arm.id)
      assert.equal(result.body.ok, true)
      assert.deepEqual(result.body.artifacts ?? [], arm.outcome === 'upload' ? [{ ref }] : [], arm.id)
    }
  }
})

test('ART-WK-2: required fact values never become refs and a false upload confirmation never becomes a receipt', async () => {
  const row = actionRow()
  const facts = [{ predicate: 'order_total', args: { amount: 34 } }]
  const text = '中文'.repeat(9000)
  const prepared = await prepareActionReport(row, { ok: true, result: text, facts }, async payload => {
    const bytes = Buffer.from(payload.bytes, 'base64')
    assert.equal(bytes.toString('utf8'), text)
    assert.equal(payload.digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
    return response(payload)
  })
  assert.deepEqual(prepared.body.facts, facts)
  assert.equal(prepared.body.result, '')
  for (const change of [{ digest: `sha256:${'b'.repeat(64)}` }, { totalBytes: 2 }, { ref: 'file:///secret' }]) {
    const bad = await prepareActionReport(row, { ok: true, result: text }, async payload => ({ ...response(payload), ...change }))
    assert.equal(bad.body, undefined)
    assert.equal(bad.unavailable, 'artifact_delivery_unconfirmed')
  }
  const oversizedFacts = await prepareActionReport(row, { ok: true, result: text, facts: [{ predicate: 'required', args: { value: text } }] }, async () => assert.fail('facts must not be uploaded as replacements'))
  assert.equal(oversizedFacts.unavailable, 'required_facts_exceed_inline_budget')
})

test('ART-WK-3: nested policy and permission shapes are checked from the committed contract', () => {
  const boundary = contract.fixture.boundaries.find(row => row.id === 'worker-action-item')
  for (const row of boundary.valid) assert.deepEqual(actionRowFaults(row, row.connectionId), [])
  for (const entry of boundary.invalid) assert.ok(actionRowFaults(entry.value, entry.value.connectionId).length, entry.fault)
  const valid = actionRow()
  valid.executionGrant = 'signed.payload'
  for (const value of [NaN, Infinity, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.ok(actionRowFaults({ ...valid, artifactPolicy: { ...valid.artifactPolicy, inlineBytes: value } }, CONNECTION).length)
  }
})

for (const fail of [false, true]) test(`ART-WK-4: real Worker uploads before its receipt; retention failure=${fail}`, async () => {
  let polls = 0
  const run = await driveWorker({
    extraAdapters: { 'ship-adapter.mjs': "import { appendFileSync } from 'node:fs'; import { join } from 'node:path'; appendFileSync(join(process.env.RULITH_SOURCE_ACCESS, 'effects.log'), 'ship\\n'); console.log(JSON.stringify({result:'x'.repeat(12000)}));" },
    reply: operation => operation.kind === 'Poll'
      ? ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      : { body: { accepted: true, revision: 'r2' } },
    artifactReply: payload => fail ? { status: 503, body: { errorCode: 'artifact_unavailable' } } : { body: response(payload) },
    done: (seen, output) => seen.some(entry => entry.operation.kind === 'ReportWork') || /could not be delivered/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.deepEqual(run.effects, ['ship'], 'the actual external effect happens exactly once')
  const uploads = run.of('ArtifactUpload')
  assert.equal(uploads.length, 1, run.output)
  assert.deepEqual(shapeFaults(uploads[0].artifact, artifactDefs.ArtifactUpload, artifactDefs), [])
  const reports = run.of('ReportWork')
  assert.equal(reports.length, fail ? 0 : 1, run.output)
  if (!fail) {
    assert.deepEqual(reports[0].operation.artifacts, [{ ref }])
    assert.equal(reports[0].operation.result, '')
    assert.equal(reports[0].operation.executionGrant, uploads[0].artifact.executionGrant)
  } else assert.match(run.output, /remains pending.*do not rerun/)
})

test('ART-WK-5: capture overflow is unavailable data, never a fabricated executor failure', async () => {
  let polls = 0
  const row = actionRow()
  row.artifactPolicy.objectBytes = 1024
  const run = await driveWorker({
    extraAdapters: { 'ship-adapter.mjs': "import { appendFileSync } from 'node:fs'; import { join } from 'node:path'; appendFileSync(join(process.env.RULITH_SOURCE_ACCESS, 'effects.log'), 'ship\\n'); console.log('x'.repeat(12000));" },
    reply: operation => operation.kind === 'Poll'
      ? ++polls === 1 ? { body: { accepted: true, payload: { work: [row] } } } : HOLD
      : { body: { accepted: true, revision: 'r2' } },
    done: (_seen, output) => /could not be delivered|receipt committed/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.deepEqual(run.effects, ['ship'])
  assert.equal(run.of('ArtifactUpload').length, 0)
  assert.equal(run.of('ReportWork').length, 0, run.output)
  assert.match(run.output, /adapter_output_exceeds_object_budget/)
})

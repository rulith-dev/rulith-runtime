// SPDX-License-Identifier: Apache-2.0
/**
 * The claim and the receipt, checked as bytes against the contract's own shapes.
 *
 * A fake endpoint accepts whatever the client sends, so every scenario arm in this suite
 * would stay green while the Worker put a shape on the wire that the real Gateway refuses.
 * The poll was already read back and validated this way; the two hops that matter more —
 * the one that records a dispatch on the Board and the one that carries the outcome of a
 * hand that has already moved — were not.
 *
 * `ClaimWorkRequest` is conditional: an action claim must carry the signed `executionGrant`
 * it was dispatched with, and any other work type must not. That is the rule the schema
 * states with `if`/`then`/`else`, and it is checked here on the real bytes for all four
 * work types rather than on the one that happened to be convenient.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadWorkerContract } from '../scripts/verify-worker-contract.mjs'
import { shapeFaults } from './support/contract-shape.mjs'
import {
  CONNECTION, DONE, HOLD, actionRow, driveWorker, verificationRow,
} from './support/worker-harness.mjs'
import { actionRowFaults } from '../worker/rulith-worker.mjs'

const CONTRACT = loadWorkerContract()
const DEFS = CONTRACT.defs

/** The bytes that arrived, parsed back out of the endpoint's log. */
const sent = (run, kind) => run.of(kind).map((entry) => JSON.parse(entry.raw).operation)

const assertShape = (operation, name, where) => {
  assert.deepEqual(shapeFaults(operation, DEFS[name], DEFS), [],
    `${where}: this is not a ${name} the contract accepts — ${JSON.stringify(operation).slice(0, 400)}`)
}

test('RT-WK-WIRE-1 an action claim and its receipt are the shapes the contract states', async () => {
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      return { body: { accepted: true, revision: 'b12' } }
    },
    done: (seen, output) => DONE.action.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)

  const [claim] = sent(run, 'ClaimWork')
  assert.ok(claim, `no claim was sent:\n${run.output}`)
  assertShape(claim, 'ClaimWorkRequest', 'the action claim')
  // The conditional half, stated the other way round so a checker that ignored `if`/`then`
  // could not pass this arm: strip the grant and the same shape must refuse it.
  const { executionGrant, ...ungranted } = claim
  assert.equal(typeof executionGrant, 'string')
  assert.notDeepEqual(shapeFaults(ungranted, DEFS.ClaimWorkRequest, DEFS), [],
    'an action claim without its signed grant is accepted by the shape, so the condition is not being read')

  const [report] = sent(run, 'ReportWork')
  assert.ok(report, `no receipt was filed:\n${run.output}`)
  assertShape(report, 'ReportWorkAction', 'the action receipt')
  assert.equal(report.executionGrant, executionGrant,
    'the receipt carries a different licence from the claim, for one dispatch')
})

test('RT-WK-WIRE-2 a claim for another work type carries no action grant', async () => {
  // The `else` half. A verification claim that carried a grant would be a token travelling
  // where nothing consumes it, and the shape refuses it by construction.
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [verificationRow()] } } } : HOLD
      return { body: { accepted: true, revision: 'b12' } }
    },
    done: (seen, output) => DONE.verification.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  const [claim] = sent(run, 'ClaimWork')
  assert.ok(claim)
  assertShape(claim, 'ClaimWorkRequest', 'the verification claim')
  assert.equal('executionGrant' in claim, false, 'a verification claim carried an action grant')
  // And the shape is doing the work: adding one must make it fail.
  assert.notDeepEqual(shapeFaults({ ...claim, executionGrant: 'x' }, DEFS.ClaimWorkRequest, DEFS), [],
    'a verification claim with a grant is accepted by the shape, so the condition is not being read')
})

// ── Rows this Runtime must refuse before it claims ───────────────────────────

for (const [label, override, expected] of [
  ['an unknown field', { extraField: 'ride-along' }, /carries extraField, which this action row shape does not define/],
  ['no toolDigest', { toolDigest: undefined }, /states toolDigest undefined, which is not the bare lowercase Tool pin/],
  ['a prefixed toolDigest', { toolDigest: `sha256:${'a'.repeat(64)}` }, /which is not the bare lowercase Tool pin/],
  ['no boardId', { boardId: undefined }, /states no boardId/],
  ['an empty toolSpec', { toolSpec: '' }, /states an empty toolSpec/],
  ['an empty args', { args: '' }, /states an empty args/],
  ['no target', { target: undefined }, /states no target/],
  ['another Connection', { connectionId: 'conn-somebody-else' }, /is addressed to Connection "conn-somebody-else"/],
]) {
  test(`RT-WK-WIRE-3 an action row with ${label} is refused before the claim`, async () => {
    let polls = 0
    const run = await driveWorker({
      reply: (operation) => {
        if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
        return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow(override)] } } } : HOLD
      },
      done: (seen, output) => /the action work item |does not handle/.test(output),
      timeoutMs: 15_000,
    })
    assert.equal(run.timedOut, false, `${label} was never refused:\n${run.output}`)
    assert.equal(run.ran('ship'), 0, `${label}: the executor ran anyway`)
    assert.equal(run.of('ClaimWork').length, 0, `${label}: a dispatch was recorded`)
    assert.match(run.output, expected, `${label}: refused for the wrong reason`)
    assert.match(run.output, /Nothing was claimed and nothing ran/)
  })
}

test('RT-WK-WIRE-3b the row shape is checked, not just the fields the action arm happens to read', () => {
  // Two faults that cannot be reached end to end because the batch loop routes by
  // `workType` before the action arm sees the row. They are still part of the shape, and a
  // gate that only checked what the caller already reads would be checking nothing.
  // In the harness a row's grant is a marker the endpoint replaces when it answers the poll;
  // here the row is being checked as it would arrive, so the token is a string.
  const arrived = (overrides = {}) => ({ ...actionRow(), executionGrant: 'payload.signature', ...overrides })
  assert.deepEqual(actionRowFaults(arrived(), CONNECTION), [])
  assert.deepEqual(actionRowFaults(arrived({ workType: 'verification' }), CONNECTION),
    ['states workType "verification" and this shape is "action"'])
  assert.deepEqual(actionRowFaults(null, CONNECTION), ['the work item is not an object'])
  // Every mandatory field, one at a time: none of them may be optional by accident.
  for (const field of Object.keys(arrived())) {
    const faults = actionRowFaults(arrived({ [field]: undefined }), CONNECTION)
    assert.ok(faults.length > 0, `${field} may be omitted from an action row without complaint`)
  }
})

test('RT-WK-WIRE-4 a row addressed to another Connection is refused even when its grant agrees', async () => {
  // The row's `connectionId` travels for comparison and is never adopted. A row and a token
  // that agree with each other but not with the Connection this process authenticated as are
  // still two documents about somebody else's line.
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow({ connectionId: 'conn-other' })] } } } : HOLD
    },
    done: (seen, output) => /is addressed to Connection/.test(output),
    timeoutMs: 15_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('ship'), 0)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.match(run.output, new RegExp(`authenticated as "${CONNECTION}"`))
})

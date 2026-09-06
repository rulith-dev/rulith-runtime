// SPDX-License-Identifier: Apache-2.0
/**
 * The Worker must fail visibly on a work item it cannot scope — never execute under a
 * guessed contract.
 *
 * The shared agreement retires the Case write revision from command scoping: Worker
 * commands are to be governed by invocation, lease and Connection identity. Core has not
 * published that shape yet, so this Runtime deliberately does **not** guess it — the
 * `caseId`/`caseRevision` wire is unchanged, and any field change will be coordinated with
 * Core before it is written here.
 *
 * What must hold in the meantime is the direction of failure. When the authority starts
 * sending Poll rows in a shape this Worker does not understand, the Worker has to stop
 * *before* it claims and before the adapter touches the outside world. The opposite order
 * is the worst outcome on this whole chain: the hand moves, the receipt is refused, the
 * invocation is never dispatched again, and the Case reads as unfinished work that was in
 * fact done.
 *
 * The assertion is therefore on the effect log — a file a real local adapter appends to.
 * A Worker cannot fake an appended line, and it cannot un-write one.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { CASE, CLAIMED, HOLD, POLLED, REPORTED, actionRow, driveWorker, verificationRow } from './support/worker-harness.mjs'

const refused = (_seen, output) => /refusing to claim or report unscoped or stale work/.test(output)

for (const [label, row] of [
  ['no caseRevision at all', actionRow({ caseRevision: undefined })],
  ['an empty caseRevision', actionRow({ caseRevision: '' })],
  ['no caseId', actionRow({ caseId: undefined })],
]) {
  test(`RT-WK-WIRE-1 an action row with ${label} is refused before the hand moves`, async () => {
    let polls = 0
    const run = await driveWorker({
      reply: (operation) => {
        if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [row] } } } : HOLD
        return { body: { accepted: true, revision: 'b1', caseRevision: POLLED } }
      },
      done: refused,
      timeoutMs: 10_000,
    })
    assert.equal(run.timedOut, false, `the Worker never reported the unusable work item:\n${run.output}`)
    assert.equal(run.ran('ship'), 0,
      `the adapter changed the outside world for work the Worker could not scope:\n${run.output}`)
    assert.equal(run.of('ClaimWork').length, 0,
      `the Worker claimed work it could not scope, so the Board now records a dispatch that will never be receipted:\n${run.output}`)
    assert.match(run.output, /refusing to claim or report unscoped or stale work/)
  })
}

test('RT-WK-WIRE-2 a verification row it cannot scope is refused before the probe runs', async () => {
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [verificationRow({ caseRevision: undefined })] } } } : HOLD
      return { body: { accepted: true, revision: 'b1', caseRevision: POLLED } }
    },
    done: refused,
    timeoutMs: 10_000,
  })
  assert.equal(run.timedOut, false, `the Worker never reported the unusable work item:\n${run.output}`)
  assert.equal(run.ran('check'), 0, `the verification probe ran for work the Worker could not scope:\n${run.output}`)
  assert.match(run.output, /refusing to claim or report unscoped or stale work/)
})

test('RT-WK-WIRE-3 the same row with the scoping the Worker understands is executed (calibration)', async () => {
  // Without this arm, a Worker that refused every item would satisfy the arms above while
  // doing no work at all.
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b2', caseRevision: CLAIMED } }
      return { body: { accepted: true, revision: 'b3', caseRevision: REPORTED } }
    },
    done: (seen) => seen.some((entry) => entry.operation.kind === 'ReportWork'),
    timeoutMs: 10_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('ship'), 1, run.output)
  const claimed = run.of('ClaimWork')[0]
  assert.equal(claimed.operation.caseId, CASE)
  assert.doesNotMatch(run.output, /refusing to claim or report unscoped or stale work/)
})

// SPDX-License-Identifier: Apache-2.0
/**
 * RT-WK-CLAIMREV (2026-08-30): a receipt must be filed against the Case revision the
 * accepted `ClaimWork` returned — never the one the Poll row carried.
 *
 * ## The break these arms exist for
 *
 * `ClaimWork` is a **write**. Core names it in `operation_kind_writes`, and
 * `idem_cache::cache_put` advances the Case revision on any accepted write, so an accepted
 * claim moves the Case from `cN` to `cN+1` and returns the new value as `caseRevision`.
 * The Worker built every follow-up through `inCase(w, …)` — the Poll row's revision,
 * replayed unchanged — so its receipt arrived one revision behind and core answered
 *
 *   {"accepted":false,"errorCode":"stale_case_revision",
 *    "teaching":"Case revision is stale: expected c4, current c5 …"}
 *
 * `stale_case_revision` carries an `errorCode`, and the receipt retry loop breaks on
 * exactly that ("board semantics rejected it; resending is the same answer"). So the loop
 * gave up **after the executor had already changed the external system**. The claim had
 * already recorded a trusted `dispatched`, so the invocation is never dispatched again:
 * the world moved, no receipt exists, and the Case reads as unfinished work that was done.
 *
 * ## Where the assertions are placed, and why there
 *
 * On **ordering**, not on the return value of the fix. A change that made a receipt land by
 * taking the executor out of the path under test would satisfy any "the report carried c5"
 * assertion on its own, so every arm here also counts real executor runs through a file the
 * adapter appends to — the Worker cannot fake that line, and it cannot un-write it.
 *
 * The two negative arms are the calibration. `stale revision is refused` proves the model
 * Board is actually checking (without it, every arm would be equally green against a Board
 * that accepted anything), and `evidence and review keep the Poll revision` proves the fix
 * did not simply rewrite the revision everywhere — those two flows never claim, so there is
 * no newer revision for them to use and the Poll row's value is the correct one.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

/** The harness, adapters, rows and Case-revision gate live in test/support/worker-harness.mjs:
 *  the receipt-ladder arms drive the same real Worker against the same scripted endpoint, and a
 *  second copy of it would be a second thing to keep true. */
import {
  CLAIMED, DONE, HOLD, POLLED, REPORTED, CASE,
  actionRow, caseRevisionGate, driveWorker, verificationRow,
} from './support/worker-harness.mjs'

test('RT-WK-CLAIMREV-1: an action receipt carries the revision ClaimWork returned, and the executor runs once', async () => {
  const gate = caseRevisionGate(CLAIMED, () => ({ body: { accepted: true, revision: 'b13', caseRevision: REPORTED } }))
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12', caseRevision: CLAIMED } }
      if (operation.kind === 'ReportWork') return gate(operation)
      throw new Error(`unexpected operation ${String(operation.kind)}`)
    },
    done: (seen, output) => DONE.action.test(output),
  })

  assert.equal(run.timedOut, false, `the action flow never finished:\n${run.output}`)
  // Ordering first: the world really did change, exactly once. Every assertion below is
  // about a receipt for an effect that has already happened.
  assert.equal(run.ran('ship'), 1, `the executor must run exactly once; effect log: ${JSON.stringify(run.effects)}`)

  const reports = run.of('ReportWork')
  assert.equal(reports.length, 1, `expected one receipt, saw ${reports.length}`)
  assert.equal(reports[0].operation.caseRevision, CLAIMED,
    'the receipt was filed against the Poll row revision. ClaimWork is a write: it moved the Case to '
    + `${CLAIMED}, so ${POLLED} is stale by one and the Board answers `
    + `${JSON.stringify(reports[0].reply?.body)} — after the executor already changed the external system.`)
  assert.equal(reports[0].reply?.body?.accepted, true,
    `the receipt did not commit: ${JSON.stringify(reports[0].reply?.body)}`)
  assert.match(run.output, /receipt committed/)
  assert.doesNotMatch(run.output, /stale_case_revision/)
})

test('RT-WK-CLAIMREV-2: a verification receipt carries the revision ClaimWork returned', async () => {
  const gate = caseRevisionGate(CLAIMED, () => ({ body: { accepted: true, revision: 'b13', caseRevision: REPORTED } }))
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [verificationRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12', caseRevision: CLAIMED } }
      if (operation.kind === 'ReportWork') return gate(operation)
      throw new Error(`unexpected operation ${String(operation.kind)}`)
    },
    done: (seen, output) => DONE.verification.test(output),
  })

  assert.equal(run.timedOut, false, `the verification flow never finished:\n${run.output}`)
  assert.equal(run.ran('check'), 1, `the verification Tool must run exactly once; effect log: ${JSON.stringify(run.effects)}`)
  const reports = run.of('ReportWork')
  assert.equal(reports.length, 1)
  assert.equal(reports[0].operation.caseRevision, CLAIMED,
    'verification claims are writes too, so this receipt is stale by one: '
    + `${JSON.stringify(reports[0].reply?.body)}`)
  assert.equal(reports[0].reply?.body?.accepted, true, JSON.stringify(reports[0].reply?.body))
  assert.match(run.output, /accepted by Board/)
})

test('RT-WK-CLAIMREV-3: the model Board really refuses a stale revision (calibration)', async () => {
  // Without this arm every other arm would read green against a Board that accepted any
  // revision at all, which is the exact shape of the defect under repair.
  const gate = caseRevisionGate(CLAIMED, () => ({ body: { accepted: true, revision: 'b13', caseRevision: REPORTED } }))
  const refused = gate({ kind: 'ReportWork', caseRevision: POLLED })
  assert.equal(refused.body.accepted, false)
  assert.equal(refused.body.errorCode, 'stale_case_revision')
  assert.match(refused.body.teaching, /expected c4, current c5/)
  assert.equal(gate({ kind: 'ReportWork', caseRevision: CLAIMED }).body.accepted, true)
})

for (const [label, claimBody] of [
  ['no caseRevision field', { accepted: true, revision: 'b12' }],
  ['an empty caseRevision', { accepted: true, revision: 'b12', caseRevision: '' }],
  ['a non-string caseRevision', { accepted: true, revision: 'b12', caseRevision: 5 }],
]) {
  test(`RT-WK-CLAIMREV-4: an accepted claim with ${label} stops the Worker before the executor runs`, async () => {
    let polls = 0
    const run = await driveWorker({
      timeoutMs: 10_000,
      reply: (operation) => {
        if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
        if (operation.kind === 'ClaimWork') return { body: claimBody }
        // Reaching here at all is the failure: a receipt can only be filed after the hand
        // has moved, and there is no revision to file it against.
        if (operation.kind === 'ReportWork') return { body: { accepted: true, revision: 'b13', caseRevision: REPORTED } }
        throw new Error(`unexpected operation ${String(operation.kind)}`)
      },
      // True on both paths, so a regression fails an assertion instead of timing out.
      done: (seen, output) => /without a Case revision/.test(output) || DONE.action.test(output),
    })

    assert.equal(run.timedOut, false, `neither the refusal nor an executed action appeared:\n${run.output}`)
    assert.equal(run.ran('ship'), 0,
      'the executor ran against a claim that returned no Case revision. Its receipt can only be filed'
      + ' against a guessed number, and a guess is how this defect stops being loud:'
      + ` effect log ${JSON.stringify(run.effects)}, receipts ${JSON.stringify(run.of('ReportWork').map((entry) => entry.operation.caseRevision))}`)
    assert.deepEqual(run.of('ReportWork'), [], 'no receipt may be filed against a revision the Board never returned')
    assert.match(run.output, /without a Case revision/,
      `the refusal must be visible; the Worker printed:\n${run.output}`)
    assert.doesNotMatch(run.output, /executing/, 'the Worker announced execution for work it must not execute')
  })
}

test('RT-WK-CLAIMREV-5: a lost receipt response is resent byte-identically and replays the committed receipt', async () => {
  // The production shape of a lost receipt is not a thrown socket error — it is a response
  // the Worker cannot read (a 500 with a non-JSON body), while the Board did commit. The
  // resend must reach the same idempotency slot, which upstream keys on the operation
  // identity including caseRevision, so the two bodies have to be equal byte for byte.
  let polls = 0
  let committed
  const run = await driveWorker({
    reply: (operation, seen) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12', caseRevision: CLAIMED } }
      if (operation.kind !== 'ReportWork') throw new Error(`unexpected operation ${String(operation.kind)}`)
      return caseRevisionGate(CLAIMED, () => {
        const first = seen.filter((entry) => entry.operation.kind === 'ReportWork').length === 1
        committed ??= { accepted: true, revision: 'b13', caseRevision: REPORTED }
        // First attempt: commit, then lose the response on the way back.
        return first ? { status: 500, text: 'upstream unavailable' } : { body: committed }
      })(operation)
    },
    done: (seen, output) => DONE.action.test(output),
  })

  assert.equal(run.timedOut, false, `the resend never resolved:\n${run.output}`)
  assert.equal(run.ran('ship'), 1,
    `a lost receipt response must not re-run the executor; effect log: ${JSON.stringify(run.effects)}`)
  const reports = run.of('ReportWork')
  assert.equal(reports.length, 2, `expected the original receipt and one resend, saw ${reports.length}`)
  assert.equal(reports[0].raw, reports[1].raw,
    `the resend was not byte-identical, so it lands in a different idempotency slot and the`
    + ` at-most-once gate answers already_reported:\n  ${reports[0].raw}\n  ${reports[1].raw}`)
  for (const report of reports) {
    assert.equal(report.operation.caseRevision, CLAIMED, `a receipt carried ${String(report.operation.caseRevision)}`)
  }
  assert.equal(reports[1].reply?.body?.accepted, true, JSON.stringify(reports[1].reply?.body))
  assert.match(run.output, /receipt committed/)
})

test('RT-WK-CLAIMREV-6: evidence and review never claim, so they keep the Poll row revision', async () => {
  // The opposite calibration. A fix that refreshed the revision everywhere would break these
  // two: neither flow claims, so no newer revision exists and the Poll row's value is right.
  let polls = 0
  const rows = [
    { workType: 'evidence', material: 'inventory', tool: 'acme.fetch@1', norm: 'norm_1', caseId: CASE, caseRevision: POLLED, source: 'orders', sourceType: 'file', payload: { snapshot: 's1' } },
    { workType: 'review', tool: 'acme.ship@1', norm: 'norm_1', caseId: CASE, caseRevision: POLLED, caseFile: { rendered: 'Action acme.ship@1 under clause norm_1.' } },
  ]
  const run = await driveWorker({
    reviewer: { verdict: 'allow', citedClause: 'norm_1', reason: 'the clause is satisfied' },
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: rows } } } : HOLD
      if (operation.kind === 'ClaimWork') throw new Error('evidence and review have no claim step; the Worker must not claim for them')
      if (operation.kind === 'ReportWork') return caseRevisionGate(POLLED, () => ({ body: { accepted: true, revision: 'b13', caseRevision: POLLED } }))(operation)
      throw new Error(`unexpected operation ${String(operation.kind)}`)
    },
    done: (seen, output) => DONE.evidence.test(output) && DONE.review.test(output),
  })

  assert.equal(run.timedOut, false, `one of the two non-claiming flows never finished:\n${run.output}`)
  assert.equal(run.ran('fetch'), 1, `effect log: ${JSON.stringify(run.effects)}`)
  assert.deepEqual(run.of('ClaimWork'), [], 'neither flow may claim')
  const reports = run.of('ReportWork')
  assert.equal(reports.length, 2, `expected an evidence receipt and a review receipt, saw ${reports.length}`)
  assert.deepEqual(reports.map((entry) => entry.operation.workType).sort(), ['evidence', 'review'])
  for (const report of reports) {
    assert.equal(report.operation.caseRevision, POLLED,
      `${String(report.operation.workType)} does not claim, so its receipt must carry the Poll row revision`)
    assert.equal(report.reply?.body?.accepted, true, JSON.stringify(report.reply?.body))
  }
})

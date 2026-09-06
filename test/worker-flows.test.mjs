// SPDX-License-Identifier: Apache-2.0
/**
 * The three work types that are not actions, end to end, and the receipt path a deleted test
 * took with it.
 *
 * When `worker-case-revision.test.mjs` was retired with the Case field it named, two live
 * assertions went with it and nobody noticed, because the file that referred to them still
 * said they were covered:
 *
 *   · **A receipt answered 500 with a non-JSON body.** That is a different route through the
 *     Worker from the two the remaining arms drive: a destroyed connection reaches it as a
 *     thrown `fetch`, and a Board refusal reaches it as an `errorCode`. A 500 with an HTML
 *     error page reaches it as an *unreadable* response — `r.json()` fails, the body becomes
 *     `{}`, and there is no `errorCode` to tell the ladder the Board has ruled. That is the
 *     shape where the hand has moved and nobody knows, so it must be resent unchanged.
 *   · **`evidence` and `review` running at all.** Both are live code that runs a local Tool
 *     or calls a model endpoint, and after the deletion nothing drove either. `DONE.evidence`,
 *     `DONE.review` and the harness's `reviewer` option were all sitting unreferenced.
 *
 * The named conforming endpoint (`leasingGateway`) is used here rather than left as scenery:
 * it admits the poll the way the committed admission rule does, and answers the two lease
 * control calls, so these arms are about the work type rather than about the lease.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadWorkerContract } from '../scripts/verify-worker-contract.mjs'
import {
  CONNECTION, DONE, HOLD, actionRow, activeLease, driveWorker, leasingGateway, verificationRow,
} from './support/worker-harness.mjs'

const CONTRACT = loadWorkerContract()

/** One material request, as the Gateway projects it. */
const evidenceRow = (overrides = {}) => ({
  workType: 'evidence',
  material: 'inventory',
  tool: 'acme.ship@1',
  norm: 'n1',
  connectionId: CONNECTION,
  source: 'orders',
  sourceType: 'file',
  ...overrides,
})

/** One clearance file, as the review seat receives it. */
const reviewRow = (overrides = {}) => ({
  workType: 'review',
  work: 'inv_review',
  tool: 'acme.ship@1',
  norm: 'clause-7',
  connectionId: CONNECTION,
  caseFile: { rendered: 'The action ships an order for a customer in the EU.' },
  ...overrides,
})

test('RT-WK-FLOW-1 a receipt answered 500 with a non-JSON body is resent unchanged', async () => {
  // The route the deleted test owned. A 500 whose body is an error page is not a Board
  // verdict: there is no `errorCode`, so nothing has ruled on this invocation and the
  // receipt is still owed. Resending must be the same bytes — the upstream idempotency key
  // is minted from the operation identity, so one changed byte lands in another slot and a
  // receipt that did commit comes back as `already_reported`.
  let polls = 0
  let receipts = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12' } }
      if (operation.kind === 'ReportWork') {
        return ++receipts <= 2
          ? { status: 500, text: '<html><body>upstream error</body></html>' }
          : { body: { accepted: true, revision: 'b13' } }
      }
      return { body: { accepted: true } }
    },
    done: (seen, output) => DONE.action.test(output),
    timeoutMs: 30_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('ship'), 1, 'the ladder re-ran the executor instead of resending its receipt')
  const attempts = run.of('ReportWork')
  assert.ok(attempts.length >= 3, `an unreadable 500 did not go back up the ladder: ${attempts.length} attempt(s)`)
  const [first] = attempts
  for (const attempt of attempts) {
    assert.equal(attempt.raw, first.raw, 'a retry changed the request bytes after an unreadable response')
  }
  assert.match(run.output, /receipt committed/)
  // And the operator can tell the two apart: a transport failure is not a Board refusal.
  assert.match(run.output, /Receipt was not committed \(attempt 1\)/)
})

test('RT-WK-FLOW-2 a material request runs its Tool once and reports the facts it found', async () => {
  // Evidence claims nothing and reports facts. The whole point of the arm is that it runs:
  // after the old file was deleted nothing drove this path at all, and it is live code that
  // executes a local Adapter.
  let polls = 0
  const gateway = leasingGateway({
    onWork: (operation) => {
      if (operation.kind === 'ReportWork') return { body: { accepted: true, revision: 'b13' } }
      return { body: { accepted: true } }
    },
  })
  const run = await driveWorker({
    reply: (operation, seen) => {
      if (operation.kind === 'Poll') {
        if (++polls !== 1) return HOLD
        const admitted = gateway(operation, seen)
        return { body: { ...admitted.body, payload: { work: [evidenceRow()] } } }
      }
      return gateway(operation, seen)
    },
    done: (seen, output) => DONE.evidence.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('fetch'), 1, 'the evidence Adapter did not run exactly once')
  assert.equal(run.of('ClaimWork').length, 0, 'material work has no claim of its own')
  const [report] = run.of('ReportWork')
  assert.ok(report, `no material report was filed:\n${run.output}`)
  assert.equal(report.operation.workType, 'evidence')
  assert.equal(report.operation.material, 'inventory')
  assert.deepEqual(report.operation.facts, [{ predicate: 'stock_level', args: { sku: 'A-1', qty: 7 } }])
  assert.equal(report.operation.workerGeneration, 7, 'the material report stated no generation')
})

test('RT-WK-FLOW-3 a review seat reaches a verdict and reports it, and refuses to guess', async () => {
  // The clearance seat is the one place a model's words become an input to the host's
  // bookkeeping, and the fail-closed direction is the whole design: anything that is not a
  // literal allow / block / not_applicable folds to `uncertain`, which clears nothing.
  for (const [label, said, verdict] of [
    ['a clear allow', { verdict: 'allow', citedClause: 'clause-7', reason: 'no EU restriction applies' }, 'allow'],
    ['half an answer', { verdict: 'Allow (with caution)', reason: 'probably fine' }, 'uncertain'],
  ]) {
    let polls = 0
    const run = await driveWorker({
      reviewer: said,
      reply: (operation) => {
        if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [reviewRow()] } } } : HOLD
        return { body: { accepted: true, revision: 'b13' } }
      },
      done: (seen, output) => DONE.review.test(output),
      timeoutMs: 20_000,
    })
    assert.equal(run.timedOut, false, `${label}: ${run.output}`)
    const [report] = run.of('ReportWork')
    assert.ok(report, `${label}: no verdict was reported:\n${run.output}`)
    assert.equal(report.operation.workType, 'review')
    assert.equal(report.operation.norm, 'clause-7')
    assert.equal(report.operation.verdict, verdict, `${label}: the seat reported the wrong verdict`)
    assert.equal(report.operation.workerGeneration, 7, `${label}: the verdict stated no generation`)
    assert.equal(run.of('ClaimWork').length, 0, `${label}: review has no claim of its own`)
  }
})

test('RT-WK-FLOW-4 one unusable row does not swallow the rest of the batch', async () => {
  // The endpoint that has not been cut over sends a verification row still carrying Case
  // scoping. Refusing it is correct; taking the whole poll down with it is not. The throw
  // used to escape the batch loop into the poll catch, so every other item was dropped and
  // the fault was printed as `Polling failed (…)` — a work-item defect wearing a transport
  // failure's name, on a row that comes back every round.
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') {
        // Ordered action → review → verification → evidence, so the bad verification row is
        // reached first only if it sorts first; put the action second on purpose and check
        // that it still runs. `orderWork` puts the action first, so the real check is that
        // the verification fault does not stop the *following* evidence row.
        return ++polls === 1
          ? { body: { accepted: true, payload: { work: [verificationRow({ caseId: 'CASE_1' }), evidenceRow()] } } }
          : HOLD
      }
      return { body: { accepted: true, revision: 'b13' } }
    },
    done: (seen, output) => DONE.evidence.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.match(run.output, /carries the retired hop field\(s\) caseId/)
  assert.match(run.output, /This is a fault of that item, not of the poll/)
  assert.doesNotMatch(run.output, /Polling failed/, 'a row-level fault was reported as a polling failure')
  assert.equal(run.ran('check'), 0, 'the refused verification row was probed anyway')
  assert.equal(run.ran('fetch'), 1, 'the item behind the refused row was dropped with it')
  assert.equal(run.of('ReportWork').length, 1)
})

for (const [label, row, marker] of [
  ['an evidence row', evidenceRow({ caseId: 'CASE_1' }), /evidence work item inventory/],
  ['a review row', reviewRow({ caseRevision: 'c4' }), /review work item inv_review/],
  ['a verification row nothing handles', verificationRow({ caseId: 'CASE_1', claim: { predicate: 'nobody_handles_this' } }), /verification work item wo_p2/],
]) {
  test(`RT-WK-FLOW-6 ${label} still naming a Case is refused, out loud`, async () => {
    // The rule is about the hop, so it is checked where the hop arrives rather than inside
    // two of the four arms. Evidence and review never checked it at all; the verification
    // arm checked it *after* deciding whether any local Tool handled the row, so a row
    // nothing handled was dropped in silence while still carrying the field.
    let polls = 0
    const run = await driveWorker({
      reviewer: { verdict: 'allow', citedClause: 'clause-7' },
      reply: (operation) => {
        if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [row] } } } : HOLD
        return { body: { accepted: true, revision: 'b13' } }
      },
      done: (seen, output) => /carries the retired hop field/.test(output),
      timeoutMs: 20_000,
    })
    assert.equal(run.timedOut, false, `${label} was never refused:\n${run.output}`)
    assert.match(run.output, marker, `${label}: the refusal did not name the item`)
    assert.match(run.output, /Case identity left the Worker hop/)
    assert.equal(run.of('ReportWork').length, 0, `${label}: something was reported for a refused row`)
    assert.equal(run.ran('fetch') + run.ran('check'), 0, `${label}: a Tool ran for a refused row`)
  })
}

test('RT-WK-FLOW-7 a review arriving without a lease does not spend the re-review interval', async () => {
  // `shouldReview` records the attempt, so reading the lease after it meant a batch landing
  // in the tick where the lease had just gone consumed the minimum interval without
  // reviewing anything — and the next tick, lease alive, was turned away by the time gate
  // for up to twenty seconds. The lease is read first now, so the slot is untouched.
  let polls = 0
  const run = await driveWorker({
    reviewer: { verdict: 'allow', citedClause: 'clause-7' },
    // The first poll confirms no lease and carries the case file; later polls do confirm one.
    lease: (operation) => (polls <= 1 ? null : activeLease({ workerId: operation.workerId })),
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b13' } }
      polls += 1
      return polls <= 2 ? { body: { accepted: true, payload: { work: [reviewRow()] } } } : HOLD
    },
    done: (seen, output) => DONE.review.test(output),
    timeoutMs: 25_000,
  })
  assert.equal(run.timedOut, false, `the verdict never landed, so the interval was spent while idle:\n${run.output}`)
  const [report] = run.of('ReportWork')
  assert.ok(report, 'the review never reported once the lease came back')
  assert.equal(report.operation.verdict, 'allow')
})

test('RT-WK-FLOW-5 the two protected headers carry the identity, in the grammar the contract states', async () => {
  // The headers are what the Gateway authenticates; the operation fields are what Core
  // records. Both were being claimed in the README and neither was ever read off a real
  // request. The generation is text on the wire, and the contract states its grammar: a
  // decimal integer, no sign, no leading zero, no fraction, no exponent.
  const grammar = new RegExp(CONTRACT.headerGenerationPattern, 'u')
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
  const hops = run.seen.filter((entry) => ['Poll', 'ClaimWork', 'ReportWork'].includes(entry.operation.kind))
  assert.ok(hops.length >= 3)
  for (const entry of hops) {
    assert.match(String(entry.headers[CONTRACT.headerNames.workerId]), new RegExp(CONTRACT.workerIdPattern, 'u'),
      `${entry.operation.kind} sent no instance header`)
    assert.equal(entry.headers[CONTRACT.headerNames.workerId], entry.operation.workerId,
      `${entry.operation.kind} stated two different instances in its header and its body`)
    const generation = entry.headers[CONTRACT.headerNames.workerGeneration]
    if (entry.operation.workerGeneration === undefined) {
      assert.equal(generation, undefined,
        'a hop that states no generation in its body sent one in its header, so the two disagree')
      continue
    }
    assert.match(String(generation), grammar, `${entry.operation.kind} sent a generation header outside the contract grammar`)
    assert.equal(Number(generation), entry.operation.workerGeneration,
      `${entry.operation.kind} stated two different generations in its header and its body`)
  }
})

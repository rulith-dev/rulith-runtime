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
  CONNECTION, DONE, HOLD, actionRow, activeLease, driveWorker, evidenceRow, leasingGateway, verificationRow, workItemShape,
} from './support/worker-harness.mjs'

const CONTRACT = loadWorkerContract()

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
  // `ReportWorkEvidence` requires `source`, and it must be the one the order named. Core
  // refuses a report that omits it rather than choosing from the Connection, so a Worker that
  // left it out filed nothing at all — and one that chose could file weak material under a
  // strong Source the same line happens to carry.
  assert.equal(report.operation.source, 'orders',
    'the material report must file under the Source the order it collected against named')
})

test('RT-WK-FLOW-10 the exact row a Gateway sends is claimed and reported, with nothing filled in behind it', async () => {
  // The row is pinned twice over: against the committed schema's own property list, and
  // against the key set `gateway.ts` authors field by field. Two arms of this suite were green
  // for months on rows carrying `sourceType` and then `connectionId` — fields no deployment
  // sends — and in both cases the code only reached its interesting part because the fixture
  // had handed it something the wire cannot carry. So the row is stated as the wire states it,
  // and the arm asserts that it is.
  const row = verificationRow()
  const declared = Object.keys(workItemShape('WorkerVerificationWorkItem').properties)
  assert.deepEqual(Object.keys(row).sort(), ['boardId', 'channel', 'claim', 'source', 'work', 'workType'].sort(),
    'this is the key set the Gateway authors for a verification order')
  for (const key of Object.keys(row)) assert.ok(declared.includes(key), `${key} is not declared by the contract`)
  assert.equal(row.connectionId, undefined, 'a verification order carries no connectionId; the carrier is channel')
  assert.equal(row.sourceType, undefined, 'a verification order carries no Source type; the type belongs to the Source record')

  let polls = 0
  const gateway = leasingGateway({ onWork: () => ({ body: { accepted: true, revision: 'b13' } }) })
  const run = await driveWorker({
    reply: (operation, seen) => {
      if (operation.kind === 'Poll') {
        if (++polls !== 1) return HOLD
        const admitted = gateway(operation, seen)
        return { body: { ...admitted.body, payload: { work: [row] } } }
      }
      return gateway(operation, seen)
    },
    done: (seen, output) => DONE.verification.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('check'), 1, 'the verification Adapter did not run exactly once')
  const [claimed] = run.of('ClaimWork')
  assert.ok(claimed, `the order the Gateway really sends was never claimed:\n${run.output}`)
  assert.equal(claimed.operation.workType, 'verification')
  assert.equal(claimed.operation.id, row.work)
  const [report] = run.of('ReportWork')
  assert.ok(report, `the claimed order was never reported:\n${run.output}`)
  assert.equal(report.operation.workType, 'verification')
  assert.equal(report.operation.id, row.work)
  assert.equal(report.operation.outcome, 'satisfied')
  assert.equal(report.operation.workerGeneration, 7)
})

test('RT-WK-FLOW-11 a verification order for another Connection, or naming no carrier, is refused by name', async () => {
  // `channel` is the carrying Connection and the contract requires it. The check used to read
  // `w.connectionId`, which the row does not have, so the comparison was `undefined !== <id>`:
  // always true, and every real order returned there with no claim, no report and no line. A
  // missing carrier is refused as malformed rather than read as permission — a Worker that
  // treated absence as "addressed to me" would complete work nobody addressed to it.
  for (const [what, row, marker] of [
    ['another Connection', verificationRow({ channel: 'conn-somebody-else' }), /carried by Connection "conn-somebody-else"/],
    ['no carrier at all', (() => { const { channel: _gone, ...rest } = verificationRow(); return rest })(), /states no carrying Connection/],
  ]) {
    let polls = 0
    const gateway = leasingGateway({ onWork: () => ({ body: { accepted: true, revision: 'b13' } }) })
    const run = await driveWorker({
      reply: (operation, seen) => {
        if (operation.kind === 'Poll') {
          if (++polls !== 1) return HOLD
          const admitted = gateway(operation, seen)
          return { body: { ...admitted.body, payload: { work: [row] } } }
        }
        return gateway(operation, seen)
      },
      done: (seen, output) => /Skipping verification work/.test(output),
      timeoutMs: 20_000,
    })
    assert.equal(run.timedOut, false, `${what}: ${run.output}`)
    assert.match(run.output, marker, `${what} was not refused by name: ${run.output}`)
    assert.equal(run.of('ClaimWork').length, 0, `${what} was claimed`)
    assert.equal(run.of('ReportWork').length, 0, `${what} was reported`)
    assert.equal(run.ran('check'), 0, `${what} ran the Adapter`)
  }
})

test('RT-WK-FLOW-8 two Sources on one Connection do not borrow each other\'s authority', async () => {
  // One line, two Sources of different accredited types. The Tool that handles this material
  // declares `sourceTypes: ["file"]`, so an order naming the `db` Source must not reach it —
  // and an order naming the `file` Source must, on the same Connection, in the same process.
  // Before the type came from the Source record the Worker read `w.sourceType` off the row;
  // with the field gone that read was `undefined`, no Tool ever matched, and both arms below
  // would have been silently skipped rather than one of them refused.
  const sources = (root) => [
    { name: 'orders', type: 'file', access: root },
    { name: 'ledger-mirror', type: 'db', access: 'postgres://unused/ledger' },
  ]
  const drive = async (row, done) => {
    let polls = 0
    const gateway = leasingGateway({ onWork: () => ({ body: { accepted: true, revision: 'b13' } }) })
    return await driveWorker({
      sources,
      reply: (operation, seen) => {
        if (operation.kind === 'Poll') {
          if (++polls !== 1) return HOLD
          const admitted = gateway(operation, seen)
          return { body: { ...admitted.body, payload: { work: [row] } } }
        }
        return gateway(operation, seen)
      },
      done,
      timeoutMs: 20_000,
    })
  }

  const refused = await drive(evidenceRow({ source: 'ledger-mirror' }),
    (seen, output) => /Skipping material request/.test(output))
  assert.equal(refused.timedOut, false, refused.output)
  assert.equal(refused.ran('fetch'), 0, 'the file Adapter ran for an order naming the db Source')
  assert.equal(refused.of('ReportWork').length, 0, 'nothing may be filed for an order no Tool handles')
  assert.match(refused.output, /through a db Source/,
    `the refusal must name the accredited type it resolved: ${refused.output}`)

  // Calibration on the same two-Source line: the order naming the file Source still runs, and
  // still files under its own name rather than the other one.
  const accepted = await drive(evidenceRow({ source: 'orders' }), (seen, output) => DONE.evidence.test(output))
  assert.equal(accepted.timedOut, false, accepted.output)
  assert.equal(accepted.ran('fetch'), 1, 'the legitimate order did not run its Adapter')
  assert.equal(accepted.of('ReportWork')[0]?.operation.source, 'orders')
})

test('RT-WK-FLOW-9 a Source-less order is left alone rather than claimed under a default', async () => {
  // A pre-migration record. Core neither lists nor hands it out, and does not settle it either;
  // if one reaches a Worker anyway, picking a Source from the Connection would decide the tier
  // the answer lands at. Both work types refuse by name and file nothing.
  // Both rows are built by deleting `source` from a conforming one, after the factory: the
  // factory refuses a row the contract does not admit, and a Source-less order is exactly that
  // — Core neither lists nor hands one out. The arm is about what this Worker does if one
  // reaches it anyway, so the row is made inadmissible on purpose and visibly.
  const withoutSource = (row) => { const { source: _dropped, ...rest } = row; return rest }
  for (const [what, row, marker] of [
    ['an evidence order', withoutSource(evidenceRow()), /Skipping material request/],
    ['a verification order', withoutSource(verificationRow()), /Skipping verification work/],
  ]) {
    let polls = 0
    const gateway = leasingGateway({ onWork: () => ({ body: { accepted: true, revision: 'b13' } }) })
    const run = await driveWorker({
      reply: (operation, seen) => {
        if (operation.kind === 'Poll') {
          if (++polls !== 1) return HOLD
          const admitted = gateway(operation, seen)
          return { body: { ...admitted.body, payload: { work: [row] } } }
        }
        return gateway(operation, seen)
      },
      done: (seen, output) => marker.test(output),
      timeoutMs: 20_000,
    })
    assert.equal(run.timedOut, false, `${what}: ${run.output}`)
    assert.match(run.output, /names no Source/, `${what} was not refused by name: ${run.output}`)
    assert.equal(run.of('ClaimWork').length, 0, `${what} was claimed`)
    assert.equal(run.of('ReportWork').length, 0, `${what} was reported`)
    assert.equal(run.ran('fetch') + run.ran('check'), 0, `${what} ran an Adapter`)
    assert.doesNotMatch(run.output, /orders/, `${what} was matched to a Source this Connection happens to carry`)
  }
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
          ? { body: { accepted: true, payload: { work: [{ ...verificationRow(), caseId: 'CASE_1' }, evidenceRow()] } } }
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

// The retired hop field is added **after** the factory on purpose. The factory refuses a row
// the contract does not admit, which is what keeps the ordinary fixtures honest; a negative arm
// that needs an inadmissible row says so in its own line rather than by widening that floor.
for (const [label, row, marker] of [
  ['an evidence row', { ...evidenceRow(), caseId: 'CASE_1' }, /evidence work item ev_p2/],
  ['a review row', reviewRow({ caseRevision: 'c4' }), /review work item inv_review/],
  ['a verification row nothing handles',
    { ...verificationRow({ claim: { predicate: 'nobody_handles_this' } }), caseId: 'CASE_1' }, /verification work item wo_p2/],
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

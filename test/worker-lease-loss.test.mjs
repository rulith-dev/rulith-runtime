// SPDX-License-Identifier: Apache-2.0
/**
 * Losing the line mid-work: what stops, and what the receipt still says.
 *
 * These arms exist because a green suite said the opposite. `RT-WK-LEASE-5` stopped the
 * child at the first warning, which is *before* the slow adapter returns — so it asserted
 * "one claim" at a moment when the second claim had not been attempted yet, and read that as
 * proof it never would be. Driven to the end of the batch, the real Worker sent a second
 * `ClaimWork` with no generation on it at all, and dropped the generation off the receipt for
 * the execution that had actually run. Only the fake endpoint refusing the second claim kept
 * the hand still.
 *
 * So every arm here waits for the batch to *drain*, not for a warning to appear. The two
 * things being checked are:
 *
 *   · nothing further is claimed once the line is gone — the leftovers stay dispatchable and
 *     come back to whoever holds the line, rather than being taken by a process that does not;
 *   · the work that did run reports under the identity it was **dispatched under**. A receipt
 *     that quietly drops its generation is this Worker awarding itself a permission it no
 *     longer has. Stating the captured identity truthfully is the Worker's job; deciding
 *     whether a late receipt may land is the Gateway's, and it cannot decide on a field that
 *     was not sent.
 *
 * Nothing here re-executes anything. A receipt retry is the same bytes and the same identity
 * — one dispatch, one execution, one document sent more than once.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DONE, HOLD, RESET, actionRow, activeLease, driveWorker, slowActionRow, verificationRow,
} from './support/worker-harness.mjs'

const SLOW_ADAPTER = {
  'slow-adapter.mjs':
    "import { appendFileSync } from 'node:fs'\n"
    + "appendFileSync(process.env.P2_EFFECT_LOG, 'slow\\n')\n"
    + "await new Promise((done) => setTimeout(done, Number(process.env.P2_SLOW_MS ?? 1400)))\n"
    + "process.stdout.write(JSON.stringify({ rows: [] }))\n",
}
const SLOW_TOOL = { 'acme.slow@1': { adapter: 'run', sourceTypes: ['file'], entry: 'slow-adapter.mjs' } }
const slowRow = () => slowActionRow()
/** A lease whose heartbeat falls due while the slow adapter is still running. */
const shortLease = (operation) => activeLease({ workerId: operation.workerId, windowMs: 4000, heartbeatAfterMs: 200 })

/** The identity one hop stated, in both places it has to state it. */
const identityOf = (entry) => ({
  body: entry.operation.workerGeneration,
  header: entry.headers['x-rulith-worker-generation'],
  workerId: entry.operation.workerId,
  workerIdHeader: entry.headers['x-rulith-worker'],
})

test('RT-WK-LOSS-1 a lost lease stops the rest of the batch, and the receipt keeps its own identity', async () => {
  // Root's counterexample, kept. Two items in one poll answer; the renewal is refused while
  // the first is executing; the run is driven until the batch drains.
  let polls = 0
  let lost = false
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [slowRow(), actionRow()] } } } : HOLD
      if (operation.kind === 'RenewLease') {
        lost = true
        return { body: { accepted: false, errorCode: 'worker_lease_lost', teaching: 'This lease is no longer active.' } }
      }
      // After the loss the endpoint refuses everything, exactly as a fenced Gateway would.
      if (lost) return { body: { accepted: false, errorCode: 'worker_lease_lost' } }
      return { body: { accepted: true, revision: 'b12' } }
    },
    lease: shortLease,
    extraAdapters: SLOW_ADAPTER,
    extraTools: SLOW_TOOL,
    // The batch has drained when the Worker comes back for another poll. Waiting on the
    // warning instead is what made the earlier arm assert a "one claim" that had simply not
    // happened yet.
    done: (seen) => seen.filter((entry) => entry.operation.kind === 'Poll').length >= 2,
    timeoutMs: 25_000,
  })
  assert.equal(run.timedOut, false, run.output)

  const claims = run.of('ClaimWork')
  assert.deepEqual(claims.map((entry) => entry.operation.id), ['inv_slow'],
    'a second item was claimed after the line was lost')
  assert.equal(run.ran('slow'), 1, 'the executor did not run exactly once')
  assert.equal(run.ran('ship'), 0, 'the second item executed after the line was lost')

  const reports = run.of('ReportWork')
  assert.deepEqual(reports.map((entry) => entry.operation.id), ['inv_slow'])
  assert.deepEqual(identityOf(reports[0]), {
    body: 7, header: '7', workerId: claims[0].operation.workerId, workerIdHeader: claims[0].operation.workerId,
  }, 'the receipt for the execution that ran dropped the identity it was dispatched under')
  assert.equal(reports[0].operation.workerGeneration, claims[0].operation.workerGeneration,
    'the receipt and the claim for one execution state two different generations')

  // And the leftover is said out loud, as unclaimed rather than as done or as lost.
  assert.match(run.output, /Stopping this batch with 1 item\(s\) unclaimed/)
  assert.match(run.output, /no claim was sent; they stay dispatchable/)
})

test('RT-WK-LOSS-2 the receipt retry after a lost lease is the same bytes and the same identity', async () => {
  // A lost lease and a lost receipt at once. Nothing here re-executes: the ladder resends one
  // document, and the identity it states is the one captured at the claim, on every attempt.
  let polls = 0
  let receipts = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [slowRow()] } } } : HOLD
      if (operation.kind === 'RenewLease') return { body: { accepted: false, errorCode: 'worker_lease_lost' } }
      if (operation.kind === 'ReportWork') return ++receipts <= 2 ? RESET : { body: { accepted: true, revision: 'b13' } }
      return { body: { accepted: true, revision: 'b12' } }
    },
    lease: shortLease,
    extraAdapters: SLOW_ADAPTER,
    extraTools: SLOW_TOOL,
    done: (seen, output) => DONE.action.test(output),
    timeoutMs: 30_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('slow'), 1, 'the ladder re-ran the executor instead of resending its receipt')

  const attempts = run.of('ReportWork')
  assert.ok(attempts.length >= 3, `the ladder did not retry: ${attempts.length} attempt(s)`)
  const [first] = attempts
  for (const attempt of attempts) {
    assert.equal(attempt.raw, first.raw, 'a retry changed the request bytes, which would key a different idempotency slot')
    assert.deepEqual(identityOf(attempt), identityOf(first), 'a retry changed the identity it reported under')
  }
  assert.equal(first.operation.workerGeneration, 7, 'the receipt did not state the generation it was dispatched under')
  assert.match(run.output, /receipt committed/)
})

test('RT-WK-LOSS-3 a long verification keeps its lease alive, and keeps its identity when it goes', async () => {
  // Verification claims too, and its probe is a long call. Before this arm it renewed
  // nothing: a probe slower than one lease window lost the line silently, and then reported
  // as a process that had never held one.
  let polls = 0
  let renewals = 0
  const run = await driveWorker({
    env: { P2_SLOW_MS: '2400' },
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [verificationRow()] } } } : HOLD
      if (operation.kind === 'RenewLease') {
        // The first renewal succeeds — otherwise this arm could not tell "renews" from
        // "never renewed and lost it anyway" — and the second is refused.
        renewals += 1
        return renewals === 1
          ? { body: { accepted: true, lease: activeLease({ workerId: operation.workerId, windowMs: 6000, heartbeatAfterMs: 200 }) } }
          : { body: { accepted: false, errorCode: 'worker_lease_lost' } }
      }
      return { body: { accepted: true, revision: 'b12' } }
    },
    lease: shortLease,
    extraAdapters: {
      'check-adapter.mjs':
        "import { appendFileSync } from 'node:fs'\n"
        + "appendFileSync(process.env.P2_EFFECT_LOG, 'check\\n')\n"
        + "await new Promise((done) => setTimeout(done, Number(process.env.P2_SLOW_MS ?? 1400)))\n"
        + "process.stdout.write(JSON.stringify({ outcome: 'satisfied', evidence: 'probe read the backend' }))\n",
    },
    done: (seen) => seen.filter((entry) => entry.operation.kind === 'Poll').length >= 2,
    timeoutMs: 30_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.ok(renewals >= 2, `a long verification renewed ${renewals} time(s); it must keep its lease alive while it runs`)
  assert.equal(run.ran('check'), 1)

  const [report] = run.of('ReportWork')
  assert.ok(report, 'the verification produced no report at all')
  assert.equal(report.operation.workerGeneration, 7, 'the verification report dropped the generation it was claimed under')
  assert.equal(report.headers['x-rulith-worker-generation'], '7')
  assert.match(run.output, /The lease was lost while verification work/)
})

test('RT-WK-LOSS-4 a long material fetch does the same, and stops the batch behind it', async () => {
  let polls = 0
  let renewals = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') {
        // Two material requests, because the batch is ordered action → review → verification
        // → evidence: anything of another type would run *before* the fetch, not behind it.
        // Both name the same material, so a guard that failed would fetch twice.
        const material = { workType: 'evidence', material: 'inventory', tool: 'acme.ship@1', norm: 'n1', connectionId: 'conn-p2', source: 'orders', sourceType: 'file' }
        return ++polls === 1 ? { body: { accepted: true, payload: { work: [material, { ...material, norm: 'n2' }] } } } : HOLD
      }
      if (operation.kind === 'RenewLease') {
        renewals += 1
        return renewals === 1
          ? { body: { accepted: true, lease: activeLease({ workerId: operation.workerId, windowMs: 6000, heartbeatAfterMs: 200 }) } }
          : { body: { accepted: false, errorCode: 'worker_lease_lost' } }
      }
      return { body: { accepted: true, revision: 'b12' } }
    },
    lease: shortLease,
    extraAdapters: {
      'fetch-adapter.mjs':
        "import { appendFileSync } from 'node:fs'\n"
        + "appendFileSync(process.env.P2_EFFECT_LOG, 'fetch\\n')\n"
        + "await new Promise((done) => setTimeout(done, 2400))\n"
        + "process.stdout.write(JSON.stringify({ facts: [{ predicate: 'stock_level', args: { sku: 'A-1', qty: 7 } }] }))\n",
    },
    done: (seen) => seen.filter((entry) => entry.operation.kind === 'Poll').length >= 2,
    timeoutMs: 30_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.ok(renewals >= 2, `a long material fetch renewed ${renewals} time(s)`)
  assert.equal(run.ran('fetch'), 1, 'the second material request was fetched after the line was lost')
  assert.equal(run.of('ClaimWork').length, 0, 'material work claims nothing')

  const [report] = run.of('ReportWork')
  assert.ok(report, 'the material fetch produced no report')
  assert.equal(report.operation.workerGeneration, 7, 'the material report dropped the generation that fetched it')
  assert.match(run.output, /Stopping this batch with 1 item\(s\) unclaimed/)
})

test('RT-WK-LOSS-5 a rejected credential during renewal is not an unhandled rejection', async () => {
  // `renewLease` rethrows a rejected Connection credential, and a timer callback's rejection
  // is nobody's to catch. On a default Node that ends the process — in the middle of an
  // execution whose receipt has not been sent, which is the one moment a Worker must not
  // disappear. The renewals stop, the receipt is still offered, and the poll loop meets the
  // same 401 on its next hop and exits with its own teaching.
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [slowRow()] } } } : HOLD
      if (operation.kind === 'RenewLease') return { status: 401, text: JSON.stringify({ teaching: 'This Connection key was rotated.' }) }
      return { body: { accepted: true, revision: 'b12' } }
    },
    lease: shortLease,
    extraAdapters: SLOW_ADAPTER,
    extraTools: SLOW_TOOL,
    done: (seen, output) => DONE.action.test(output),
    timeoutMs: 25_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.doesNotMatch(run.output, /UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION|unhandledRejection/,
    'a background renewal took the process down with an unhandled rejection')
  assert.equal(run.ran('slow'), 1)
  const [report] = run.of('ReportWork')
  assert.ok(report, 'the execution ran and its receipt was never sent')
  assert.equal(report.operation.workerGeneration, 7)
  assert.match(run.output, /Renewals stopped/)
})

test('RT-WK-LOSS-6 stopping mid-batch leaves the rest unclaimed rather than half-taken', async () => {
  // The shutdown shape of the same rule. A rotated credential ends the loop the way a signal
  // does — a portable signal is not available here — and what matters is the same: the item
  // in flight finishes and reports, and the ones behind it are left for whoever holds the
  // line next.
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') {
        return ++polls === 1 ? { body: { accepted: true, payload: { work: [slowRow(), actionRow()] } } } : HOLD
      }
      if (operation.kind === 'RenewLease') return { status: 401, text: JSON.stringify({ teaching: 'This Connection key was rotated.' }) }
      if (operation.kind === 'ReleaseLease') return { body: { accepted: true } }
      return { body: { accepted: true, revision: 'b12' } }
    },
    lease: shortLease,
    extraAdapters: SLOW_ADAPTER,
    extraTools: SLOW_TOOL,
    done: (seen, output) => /Stopping this batch/.test(output),
    timeoutMs: 25_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.deepEqual(run.of('ClaimWork').map((entry) => entry.operation.id), ['inv_slow'])
  assert.equal(run.ran('ship'), 0)
  assert.match(run.output, /Stopping this batch with 1 item\(s\) unclaimed/)
})

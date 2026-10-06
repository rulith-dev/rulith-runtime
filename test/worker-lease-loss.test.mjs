// SPDX-License-Identifier: Apache-2.0
/**
 * Losing the line mid-work: no new claim uses the lost lease, while completed work still
 * offers a receipt under the generation it was dispatched under for the Gateway to decide.
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
 *   · work that did run still offers its receipt under the captured dispatch generation;
 *     the Gateway decides whether to accept it after the Worker loses its lease.
 *
 * Nothing here re-executes anything. A receipt retry is the same bytes and the same identity
 * — one dispatch, one execution, one document sent more than once.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { leaseSnapshotRegresses } from '../worker/rulith-worker.mjs'

import {
  DONE, HOLD, RESET, actionRow, activeLease, driveWorker, evidenceRow, slowActionRow, verificationRow,
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
const shortLease = (operation) => activeLease({ workerId: operation.workerId, windowMs: 14_000, heartbeatAfterMs: 200 })
/** Identity carried on both the operation and the protected headers. */
const identityOf = entry => ({
  body: entry.operation.workerGeneration,
  header: entry.headers['x-rulith-worker-generation'],
  workerId: entry.operation.workerId,
  workerIdHeader: entry.headers['x-rulith-worker'],
})

test('late same-generation Poll snapshots cannot roll back a renewed lease', () => {
  const current = { workerGeneration: 7, serverTime: '2026-09-28T10:00:01.000Z',
    expiresAt: '2026-09-28T10:01:01.000Z' }
  assert.equal(leaseSnapshotRegresses(current, { ...current,
    serverTime: '2026-09-28T10:00:00.999Z', expiresAt: '2026-09-28T10:01:00.999Z' }), true)
  assert.equal(leaseSnapshotRegresses(current, { ...current,
    expiresAt: '2026-09-28T10:01:00.999Z' }), true)
  assert.equal(leaseSnapshotRegresses(current, { ...current }), true)
  assert.equal(leaseSnapshotRegresses(current, { ...current,
    expiresAt: '2026-09-28T10:01:01.001Z' }), false)
  assert.equal(leaseSnapshotRegresses(current, { ...current,
    workerGeneration: 8, expiresAt: '2026-09-28T10:00:01.500Z' }), false)
})

test('an idle long Poll renews its existing generation before its lease expires', async () => {
  let polls = 0, renewals = 0
  const run = await driveWorker({
    lease: shortLease,
    reply: operation => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [] } } } : HOLD
      if (operation.kind === 'RenewLease') {
        renewals++
        return { body: { accepted: true, lease: shortLease(operation) } }
      }
      return { body: { accepted: true } }
    },
    done: () => renewals >= 3,
    timeoutMs: 7000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(polls, 2, 'renewals must happen while the same Poll is waiting')
  assert.ok(run.of('RenewLease').every(row => row.operation.workerGeneration === 7))
  assert.equal(run.of('ClaimWork').length, 0)
})

test('short empty Polls keep one lease renewed across the whole idle window', async () => {
  let generation = 7, expires = 0, renewals = 0, refusals = 0
  const begun = Date.now()
  const lease = operation => {
    const now = Date.now()
    return { workerId: operation.workerId, workerGeneration: generation,
      serverTime: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString(),
      heartbeatAfterMs: Math.min(1100, Math.max(1, Math.floor((expires - now) / 2))) }
  }
  const run = await driveWorker({
    reply: operation => {
      if (operation.kind === 'Poll') {
        if (expires && Date.now() >= expires && operation.workerGeneration !== undefined) {
          refusals++
          return { status: 409, body: { accepted: false, errorCode: 'worker_lease_expired' } }
        }
        if (!expires || Date.now() >= expires) { generation++; expires = Date.now() + 12_400 }
        return { delayMs: 25, body: { accepted: true, lease: lease(operation), payload: { work: [] } } }
      }
      if (operation.kind === 'RenewLease') {
        renewals++
        expires = Date.now() + 12_400
        return { body: { accepted: true, lease: lease(operation) } }
      }
      return { body: { accepted: true } }
    },
    done: () => Date.now() - begun >= 5500 || refusals > 0,
    timeoutMs: 8000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(refusals, 0, 'a rapid empty Poll loop let its still-needed lease expire')
  assert.ok(renewals >= 2, `only ${renewals} renewal(s) across 5.5 seconds of ${run.of('Poll').length} short Polls: ${run.output.slice(-600)}`)
  assert.deepEqual([...new Set(run.of('Poll').map(row => row.operation.workerGeneration).filter(Boolean))], [8])
})

test('repeated identical Poll snapshots cannot extend a locally expired lease', async () => {
  let snapshot, firstLeaseAt = 0, offeredAt = 0
  const run = await driveWorker({
    reply: operation => {
      if (operation.kind === 'Poll') {
        if (!snapshot) {
          snapshot = activeLease({ workerId: operation.workerId, windowMs: 12_100, heartbeatAfterMs: 200 })
          firstLeaseAt = Date.now()
        }
        const offer = Date.now() - firstLeaseAt >= 12_700
        if (offer && !offeredAt) offeredAt = Date.now()
        return { delayMs: 25, body: { accepted: true, lease: snapshot,
          payload: { work: offer ? [actionRow()] : [] } } }
      }
      if (operation.kind === 'RenewLease') return { body: { accepted: true, lease: snapshot } }
      return { body: { accepted: true } }
    },
    done: seen => seen.some(row => row.operation.kind === 'ClaimWork')
      || (offeredAt > 0 && Date.now() - offeredAt >= 350),
    timeoutMs: 21_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.ok(run.of('RenewLease').length >= 1, 'the duplicate snapshot never exercised renewal')
  assert.equal(run.of('ClaimWork').length, 0,
    'an identical Poll or Renew response refreshed heldSince and authorized an expired claim')
})

test('a generation change retires the old keeper before renewing the new lease', async () => {
  let polls = 0, switched = false
  const run = await driveWorker({
    reply: operation => {
      if (operation.kind === 'Poll') {
        if (++polls === 5) switched = true
        return { delayMs: 25, body: { accepted: true, lease: activeLease({ workerId: operation.workerId,
          workerGeneration: switched ? 8 : 7, windowMs: 14_000, heartbeatAfterMs: 200 }), payload: { work: [] } } }
      }
      if (operation.kind === 'RenewLease') return { body: { accepted: true,
        lease: activeLease({ workerId: operation.workerId, workerGeneration: operation.workerGeneration,
          windowMs: 14_000, heartbeatAfterMs: 200 }) } }
      return { body: { accepted: true } }
    },
    done: seen => seen.some(row => row.operation.kind === 'RenewLease'
      && row.operation.workerGeneration === 8),
    timeoutMs: 5000,
  })
  assert.equal(run.timedOut, false, run.output)
  const renewals = run.of('RenewLease')
  assert.ok(renewals.length >= 1)
  assert.ok(renewals.every(row => row.operation.workerGeneration === 8),
    'the old generation renewed after the replacement was adopted')
  assert.equal(run.of('ClaimWork').length, 0)
})

test('managed stop joins a pending renewal before releasing the lease', async () => {
  let sentStop = false, releaseSeenAt = 0
  const run = await driveWorker({
    ipc: true,
    lease: operation => activeLease({ workerId: operation.workerId, windowMs: 14_000, heartbeatAfterMs: 200 }),
    reply: operation => operation.kind === 'Poll' ? { body: { accepted: true, payload: { work: [] } } }
      : operation.kind === 'RenewLease' ? { delayMs: 400, body: { accepted: true,
        lease: activeLease({ workerId: operation.workerId, windowMs: 14_000, heartbeatAfterMs: 200 }) } }
        : operation.kind === 'ReleaseLease' ? { delayMs: 1800, body: { accepted: true } }
          : { body: { accepted: true } },
    done: (seen, _output, control) => {
      if (!sentStop && seen.some(row => row.operation.kind === 'RenewLease')) {
        sentStop = true
        control.send({ protocol: 'rulith-local-control', operation: 'stop' })
      }
      if (!releaseSeenAt && seen.some(row => row.operation.kind === 'ReleaseLease')) releaseSeenAt = Date.now()
      return releaseSeenAt > 0 && Date.now() - releaseSeenAt >= 1300
    },
    timeoutMs: 6000,
  })
  assert.equal(run.timedOut, false, run.output)
  const kinds = run.seen.map(row => row.operation.kind)
  assert.ok(kinds.indexOf('RenewLease') < kinds.indexOf('ReleaseLease'))
  assert.equal(run.of('RenewLease').length, 1, 'a late Renew response revived a keeper during managed shutdown')
})

test('a Poll already in flight cannot adopt a lease after managed stop begins', async () => {
  let polls = 0, sentStop = false, releaseSeenAt = 0
  const run = await driveWorker({
    ipc: true,
    lease: operation => activeLease({ workerId: operation.workerId, windowMs: 14_000, heartbeatAfterMs: 200 }),
    reply: operation => {
      if (operation.kind === 'Poll') return ++polls === 1
        ? { body: { accepted: true, payload: { work: [] } } }
        : { delayMs: 1200, body: { accepted: true, payload: { work: [] } } }
      if (operation.kind === 'ReleaseLease') return { delayMs: 2500, body: { accepted: true } }
      if (operation.kind === 'RenewLease') return { body: { accepted: true,
        lease: activeLease({ workerId: operation.workerId, windowMs: 14_000, heartbeatAfterMs: 200 }) } }
      return { body: { accepted: true } }
    },
    done: (seen, _output, control) => {
      if (!sentStop && polls >= 2) {
        sentStop = true
        control.send({ protocol: 'rulith-local-control', operation: 'stop' })
      }
      if (!releaseSeenAt && seen.some(row => row.operation.kind === 'ReleaseLease')) releaseSeenAt = Date.now()
      return releaseSeenAt > 0 && Date.now() - releaseSeenAt >= 2300
    },
    timeoutMs: 6000,
  })
  assert.equal(run.timedOut, false, run.output)
  const release = run.seen.findIndex(row => row.operation.kind === 'ReleaseLease')
  assert.equal(run.seen.slice(release + 1).filter(row => row.operation.kind === 'RenewLease').length, 0,
    'a late Poll answer restarted renewal after stop requested ReleaseLease')
  assert.equal(run.of('ClaimWork').length, 0)
})

test('managed stop drains one claimed external action and its original receipt before release', async () => {
  let polls = 0, claimedAt = 0, effectAt = 0, stoppedAt = 0, releasedAt = 0
  const run = await driveWorker({
    ipc: true,
    lease: shortLease,
    extraAdapters: SLOW_ADAPTER,
    extraTools: SLOW_TOOL,
    env: { P2_SLOW_MS: '2400' },
    reply: operation => {
      if (operation.kind === 'Poll') return ++polls === 1
        ? { body: { accepted: true, payload: { work: [slowRow(), actionRow()] } } }
        : HOLD
      if (operation.kind === 'RenewLease') return { body: { accepted: true, lease: shortLease(operation) } }
      if (operation.kind === 'ReleaseLease') return { delayMs: 1000, body: { accepted: true } }
      return { body: { accepted: true, revision: 'b12' } }
    },
    done: (seen, _output, control) => {
      if (!claimedAt && seen.some(row => row.operation.kind === 'ClaimWork')) claimedAt = Date.now()
      if (claimedAt && !effectAt && control.ran('slow') === 1) effectAt = Date.now()
      if (effectAt && !stoppedAt && Date.now() - effectAt >= 350) {
        stoppedAt = Date.now()
        control.send({ protocol: 'rulith-local-control', operation: 'stop' })
      }
      if (!releasedAt && seen.some(row => row.operation.kind === 'ReleaseLease')) releasedAt = Date.now()
      return releasedAt > 0 && control.exited
    },
    timeoutMs: 8000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('slow'), 1, 'the already claimed action did not execute exactly once')
  assert.equal(run.ran('ship'), 0, 'managed stop claimed a second action')
  assert.ok(releasedAt - stoppedAt >= 1500, 'managed stop exited before the in-flight action drained')
  const kinds = run.seen.map(row => row.operation.kind)
  assert.ok(kinds.indexOf('ClaimWork') < kinds.indexOf('ReportWork')
    && kinds.indexOf('ReportWork') < kinds.indexOf('ReleaseLease'),
  'the original action receipt was skipped or sent after releasing the lease')
  assert.equal(run.of('ReportWork').length, 1)
  assert.equal(run.of('ReportWork')[0].operation.workerGeneration,
    run.of('ClaimWork')[0].operation.workerGeneration)
})

test('Host disconnect escalates managed drain and leaves the dispatched action unresolved', async () => {
  let claimedAt = 0, effectAt = 0, stoppedAt = 0, disconnectedAt = 0, exitedAt = 0
  const run = await driveWorker({
    ipc: true,
    lease: shortLease,
    extraAdapters: SLOW_ADAPTER,
    extraTools: SLOW_TOOL,
    env: { P2_SLOW_MS: '3000' },
    reply: operation => {
      if (operation.kind === 'Poll') return { body: { accepted: true,
        payload: { work: [slowRow(), actionRow()] } } }
      if (operation.kind === 'RenewLease') return { body: { accepted: true, lease: shortLease(operation) } }
      return { body: { accepted: true, revision: 'b12' } }
    },
    done: (seen, _output, control) => {
      if (!claimedAt && seen.some(row => row.operation.kind === 'ClaimWork')) claimedAt = Date.now()
      if (claimedAt && !effectAt && control.ran('slow') === 1) effectAt = Date.now()
      if (effectAt && !stoppedAt && Date.now() - effectAt >= 350) {
        stoppedAt = Date.now()
        control.send({ protocol: 'rulith-local-control', operation: 'stop' })
      }
      if (stoppedAt && !disconnectedAt && Date.now() - stoppedAt >= 350) {
        disconnectedAt = Date.now()
        control.disconnect()
      }
      if (control.exited && !exitedAt) exitedAt = Date.now()
      return exitedAt > 0
    },
    timeoutMs: 6000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('slow'), 1, 'the original external effect did not start')
  assert.equal(run.ran('ship'), 0, 'a second action was claimed after stop')
  assert.ok(exitedAt - claimedAt < 2500, 'Host disconnect did not interrupt the pending drain')
  assert.equal(run.of('ClaimWork').length, 1)
  assert.equal(run.of('ReportWork').length, 0,
    'an interrupted action was falsely reported as completed or failed')
})

test('a refused renewal retires the keeper and the next Poll acquires without an old generation', async () => {
  let refused = false
  const run = await driveWorker({
    ipc: true, env: { RULITH_LOCAL_EVENTS: 'ipc' },
    lease: operation => activeLease({ workerId: operation.workerId, windowMs: 14_000, heartbeatAfterMs: 200 }),
    reply: operation => {
      if (operation.kind === 'Poll') return { delayMs: 25, body: { accepted: true, payload: { work: [] } } }
      if (operation.kind === 'RenewLease') {
        refused = true
        return { body: { accepted: false, errorCode: 'worker_lease_lost' } }
      }
      return { body: { accepted: true } }
    },
    done: seen => {
      const renewal = seen.findIndex(row => row.operation.kind === 'RenewLease')
      return refused && renewal >= 0 && seen.slice(renewal + 1).some(row => row.operation.kind === 'Poll'
        && row.operation.workerGeneration === undefined)
    },
    timeoutMs: 8000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('RenewLease').length, 1, 'the refused generation kept renewing')
  assert.equal(run.of('ClaimWork').length, 0)
  const availability = run.messages.filter(message => message.event?.type === 'availability').map(message => message.event.state)
  assert.ok(availability.includes('online'), 'the confirmed lease makes this Worker online')
  assert.ok(availability.includes('offline'), 'a refused renewal makes this Worker offline')
})

test('a late Poll response cannot restore a lease refused by a concurrent renewal', async () => {
  let polls = 0, refused = false
  const run = await driveWorker({
    lease: shortLease,
    reply: operation => {
      if (operation.kind === 'Poll') return ++polls === 1
        ? { body: { accepted: true, payload: { work: [] } } }
        : { delayMs: 1800, body: { accepted: true, payload: { work: [verificationRow()] } } }
      if (operation.kind === 'RenewLease') { refused = true; return { body: { accepted: false, errorCode: 'worker_lease_lost' } } }
      return { body: { accepted: true } }
    },
    done: (seen, output) => /lost while Poll was waiting/.test(output) || seen.some(row => row.operation.kind === 'ClaimWork'),
    timeoutMs: 7000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(refused, true)
  assert.equal(run.of('ClaimWork').length, 0, 'a late inbox answer must not resurrect execution authority')
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
  }, 'the already-run receipt must be offered under the generation it was dispatched under')

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
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
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
  assert.equal(run.ran('ship'), 1, 'the ladder must never re-run the executor')

  const attempts = run.of('ReportWork')
  assert.ok(attempts.length >= 3, `the ladder did not retry: ${attempts.length} attempt(s)`)
  const [first] = attempts
  for (const attempt of attempts) {
    assert.equal(attempt.raw, first.raw, 'a retry changed the receipt request bytes')
    assert.deepEqual(identityOf(attempt), identityOf(first), 'a retry changed the dispatch identity')
  }
  assert.equal(first.operation.workerGeneration, 7, 'the receipt did not state the generation it was dispatched under')
  assert.match(run.output, /receipt committed/)
})

test('RT-WK-LOSS-3 a long verification renews its lease and offers its report under the original generation after loss', async () => {
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
          ? { body: { accepted: true, lease: activeLease({ workerId: operation.workerId, windowMs: 16_000, heartbeatAfterMs: 200 }) } }
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

  assert.equal(run.of('ReportWork').length, 1, 'the completed verification must still offer its report')
  assert.equal(run.of('ReportWork')[0].operation.workerGeneration, 7)
  assert.equal(run.of('ReportWork')[0].headers['x-rulith-worker-generation'], '7')
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
        const material = evidenceRow()
        return ++polls === 1 ? { body: { accepted: true, payload: { work: [material, { ...material }] } } } : HOLD
      }
      if (operation.kind === 'RenewLease') {
        renewals += 1
        return renewals === 1
          ? { body: { accepted: true, lease: activeLease({ workerId: operation.workerId, windowMs: 16_000, heartbeatAfterMs: 200 }) } }
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

  assert.equal(run.of('ReportWork').length, 1, 'the completed fetch must still offer its report')
  assert.equal(run.of('ReportWork')[0].operation.workerGeneration, 7)
  assert.equal(run.of('ReportWork')[0].headers['x-rulith-worker-generation'], '7')
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
    ipc: true, env: { RULITH_LOCAL_EVENTS: 'ipc' },
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [slowRow()] } } } : HOLD
      if (operation.kind === 'RenewLease') return { status: 401, text: JSON.stringify({ teaching: 'This Connection key was rotated.' }) }
      return { body: { accepted: true, revision: 'b12' } }
    },
    lease: shortLease,
    extraAdapters: SLOW_ADAPTER,
    extraTools: SLOW_TOOL,
    done: (seen, output, { messages }) => messages.some(message => message.event?.type === 'reported' && message.event.kind === 'action'),
    timeoutMs: 25_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.doesNotMatch(run.output, /UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION|unhandledRejection/,
    'a background renewal took the process down with an unhandled rejection')
  assert.equal(run.ran('slow'), 1)
  assert.equal(run.of('ReportWork').length, 1, 'the completed action must still offer its receipt')
  assert.equal(run.of('ReportWork')[0].operation.workerGeneration, 7)
  assert.match(run.output, /Renewals stopped/)
  assert.ok(run.messages.some(message => message.event?.type === 'availability' && message.event.state === 'needs setup'))
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
  assert.equal(run.of('ReportWork').length, 1, 'the in-flight action must report before the batch stops')
  assert.match(run.output, /Stopping this batch with 1 item\(s\) unclaimed/)
})

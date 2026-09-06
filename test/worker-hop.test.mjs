// SPDX-License-Identifier: Apache-2.0
/**
 * The v2 Worker hop: a fenced instance, an active lease, and no Case anywhere.
 *
 * What replaced the retired `caseId` / `caseRevision` scoping is not a rename. The Worker no
 * longer states which Case its work belongs to — that is the Gateway's authenticated
 * envelope against Core, and which Cases an execution advances is the shared graph's answer
 * — and what it does state is which instance it is and which fencing generation it holds.
 * Everything downstream hangs off that pair: no confirmed lease, no claim and no execution.
 *
 * These arms drive the real Worker binary against a named fake `/work` endpoint. The
 * deployed Gateway does not serve the lease operations yet, which is why the fake is named
 * as one rather than hidden behind a compatibility path in the Worker: the client behaviour
 * is what is under test, and the dependency is stated rather than papered over.
 *
 * Every assertion that matters is made from outside the Worker — the endpoint's request log
 * and a file the Adapter appends to. A Worker cannot fake an appended line, and it cannot
 * un-write one.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DONE, HOLD, actionRow, activeLease, driveWorker, slowActionRow, verificationRow,
} from './support/worker-harness.mjs'

test('RT-WK-HOP-1 the hop states an instance and a generation, and no Case at all', async () => {
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12' } }
      return { body: { accepted: true, revision: 'b13' } }
    },
    done: (seen, output) => DONE.action.test(output),
  })
  assert.equal(run.timedOut, false, run.output)

  const hops = run.seen.filter((entry) => ['Poll', 'ClaimWork', 'ReportWork'].includes(entry.operation.kind))
  assert.ok(hops.length >= 3, `expected a poll, a claim and a report: ${hops.map((h) => h.operation.kind).join(', ')}`)
  for (const { operation, raw } of hops) {
    assert.match(String(operation.workerId), /^wkr_[A-Za-z0-9_-]{8,80}$/u,
      `${operation.kind} stated no contract-shaped instance identity`)
    // Not "absent from the fields we happen to read" — absent from the bytes.
    assert.doesNotMatch(raw, /caseId|caseRevision/,
      `${operation.kind} still carries retired Case scoping: ${raw}`)
  }
  // The first poll is the one hop that cannot state a generation: it is the hop that asks
  // for the lease that would tell it one, and this Worker states nothing it has not been
  // given. Every hop after the lease is confirmed carries the generation it holds.
  const [acquisition, ...afterLease] = hops
  assert.equal(acquisition.operation.kind, 'Poll')
  assert.equal(acquisition.operation.workerGeneration, undefined,
    'the acquisition poll asserted a generation this process had never been given')
  assert.ok(afterLease.length >= 2, 'nothing happened after the lease was confirmed')
  for (const { operation } of afterLease) {
    assert.equal(operation.workerGeneration, 7, `${operation.kind} did not state the generation it holds`)
  }
})

test('RT-WK-HOP-2 a work item that still names a Case is refused before the hand moves', async () => {
  // The endpoint that has not been cut over. Refusing after the executor ran would be the
  // worst outcome on this whole chain: the hand moves, the receipt is refused, the
  // invocation is never dispatched again, and the Case reads as unfinished work that was
  // in fact done.
  for (const [label, row] of [
    ['a retired Case id', actionRow({ caseId: 'CASE_1' })],
    ['a retired Case revision', actionRow({ caseRevision: 'c4' })],
  ]) {
    let polls = 0
    const run = await driveWorker({
      reply: (operation) => {
        if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [row] } } } : HOLD
        return { body: { accepted: true, revision: 'b12' } }
      },
      done: (seen, output) => /retired hop field/.test(output),
      timeoutMs: 12_000,
    })
    assert.equal(run.timedOut, false, `${label} was never refused:\n${run.output}`)
    assert.equal(run.ran('ship'), 0, `${label}: the adapter changed the outside world anyway`)
    assert.equal(run.of('ClaimWork').length, 0, `${label}: the Worker claimed work it would not execute`)
    assert.match(run.output, /Case identity left the Worker hop/)
  }
})

test('RT-WK-LEASE-1 without a confirmed lease the Worker claims nothing and executes nothing', async () => {
  // The endpoint answers polls but confirms no lease. Everything after that is idle by
  // design: a Worker that "just carried on" would be executing under a fence it does not
  // hold, which is the state a fence exists to make impossible.
  const run = await driveWorker({
    lease: null,
    reply: (operation) => {
      if (operation.kind === 'Poll') return { body: { accepted: true, payload: { work: [actionRow()] } } }
      return { body: { accepted: true } }
    },
    done: (seen, output) => /has not confirmed an active lease/.test(output),
    timeoutMs: 12_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('ship'), 0, 'the executor ran without a lease')
  assert.equal(run.of('ClaimWork').length, 0, 'work was claimed without a lease')
  assert.match(run.output, /may not claim work, execute a Tool, or change what it advertises/)
})

for (const [label, spoil] of [
  ['a lease whose window has already closed', { windowMs: -1000 }],
  ['a heartbeat that fills the whole window', { heartbeatAfterMs: 60_000 }],
  ['a calendar day that does not exist', { expiresAt: '2026-02-30T00:00:00.000Z' }],
  ['a second that does not exist', { expiresAt: '2026-09-06T00:00:61.000Z' }],
  ['a zone offset instead of UTC', { expiresAt: '2026-09-06T08:01:00.000+08:00' }],
]) {
  test(`RT-WK-LEASE-2 ${label} is not an active lease`, async () => {
    // Each of these passes a shape check and fails the thing the shape cannot state. The
    // impossible dates matter most: a lenient parser rolls them *forward*, so the Worker
    // would believe it held a longer lease than the Gateway granted.
    const run = await driveWorker({
      lease: (operation) => activeLease({ workerId: operation.workerId, ...spoil }),
      reply: (operation) => {
        if (operation.kind === 'Poll') return { body: { accepted: true, payload: { work: [actionRow()] } } }
        return { body: { accepted: true } }
      },
      done: (seen, output) => /has not confirmed an active lease/.test(output),
      timeoutMs: 12_000,
    })
    assert.equal(run.timedOut, false, `${label} was accepted as a lease:\n${run.output}`)
    assert.equal(run.ran('ship'), 0)
    assert.equal(run.of('ClaimWork').length, 0)
  })
}

test('RT-WK-LEASE-3 a lease issued to another instance is not this process\'s to use', async () => {
  // Two processes started from one copied Connection secret is the scenario the fence is
  // for. The second instance must not work on the strength of a lease naming the first.
  const run = await driveWorker({
    lease: activeLease({ workerId: 'wkr_somebody_else_00000000' }),
    reply: (operation) => {
      if (operation.kind === 'Poll') return { body: { accepted: true, payload: { work: [actionRow()] } } }
      return { body: { accepted: true } }
    },
    done: (seen, output) => /is not this one's to use/.test(output),
    timeoutMs: 12_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('ship'), 0)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.match(run.output, /A lease issued to another instance/)
})

test('RT-WK-LEASE-4 a second process cannot take work while another instance holds the Connection', async () => {
  // One endpoint, one holder. The first instance to poll is fenced in; a second process
  // started from the same secret is refused before any Manifest or Tool lock change, and it
  // never claims anything.
  const holder = { id: undefined }
  const scenario = (operation) => {
    if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
    holder.id ??= operation.workerId
    if (operation.workerId !== holder.id) {
      // No lease, and no identifying detail about who does hold it.
      return { body: { accepted: false, errorCode: 'worker_lease_held', teaching: 'Another instance holds this Connection.' } }
    }
    return { body: { accepted: true, payload: { work: [] } } }
  }
  const first = await driveWorker({
    reply: scenario,
    done: (seen) => seen.filter((entry) => entry.operation.kind === 'Poll').length >= 1,
    timeoutMs: 12_000,
  })
  assert.equal(first.timedOut, false, first.output)
  const firstId = first.of('Poll')[0].operation.workerId

  const second = await driveWorker({
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      // The holder is the first process; this one is somebody else by construction.
      if (operation.workerId !== firstId) {
        return { body: { accepted: false, errorCode: 'worker_lease_held', teaching: 'Another instance holds this Connection.' } }
      }
      return { body: { accepted: true, payload: { work: [actionRow()] } } }
    },
    done: (seen, output) => /refused Poll/.test(output),
    timeoutMs: 12_000,
  })
  assert.equal(second.timedOut, false, second.output)
  assert.notEqual(second.of('Poll')[0].operation.workerId, firstId,
    'two processes presented the same instance identity, so a fence could not tell them apart')
  assert.equal(second.ran('ship'), 0, 'the second instance executed while another held the Connection')
  assert.equal(second.of('ClaimWork').length, 0, 'the second instance claimed while another held the Connection')
  // The Manifest travelled on the refused poll and changed nothing: the refusal is decided
  // before it is read, so the endpoint never had to decide whether to trust it.
  assert.ok(Array.isArray(second.of('Poll')[0].operation.tools),
    'the refused poll carried no Manifest, so this arm is not testing the ordering it claims to')
  assert.doesNotMatch(second.output, new RegExp(firstId),
    'the refusal told the turned-away process who is holding the line')
})

test('RT-WK-LEASE-5 a renewal that is refused mid-execution stops the Worker taking more work', async () => {
  // The long task. The hand cannot be un-run, so what stops is everything after it: no
  // further claim, and the loss is said out loud rather than absorbed.
  let polls = 0
  const run = await driveWorker({
    env: { P2_SLOW_MS: '1200' },
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [slowActionRow()] } } } : HOLD
      if (operation.kind === 'RenewLease') return { body: { accepted: false, errorCode: 'lease_expired', teaching: 'This lease is no longer active.' } }
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12' } }
      return { body: { accepted: true, revision: 'b13' } }
    },
    // The lease's own heartbeat is short, so a renewal is due while the adapter is running.
    lease: (operation) => activeLease({ workerId: operation.workerId, windowMs: 4000, heartbeatAfterMs: 200 }),
    extraAdapters: {
      'slow-adapter.mjs':
        "import { appendFileSync } from 'node:fs'\n"
        + "appendFileSync(process.env.P2_EFFECT_LOG, 'slow\\n')\n"
        + "await new Promise((done) => setTimeout(done, Number(process.env.P2_SLOW_MS ?? 1200)))\n"
        + "process.stdout.write(JSON.stringify({ rows: [] }))\n",
    },
    extraTools: { 'acme.slow@1': { adapter: 'run', sourceTypes: ['file'], entry: 'slow-adapter.mjs' } },
    done: (seen, output) => /lease .*was lost while it was executing|stops taking work/.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.match(run.output, /stops taking work|was lost while it was executing/)
  // The executor ran once and is not re-run under a new identity.
  assert.equal(run.ran('slow'), 1, `the long task ran ${run.ran('slow')} time(s)`)
  assert.equal(run.of('ClaimWork').length, 1, 'more work was claimed after the lease was lost')
})

test('RT-WK-LEASE-6 a lease naming this instance is adopted and worked under', async () => {
  // The calibration arm. Without it, a Worker that refused every lease would satisfy all of
  // the above. Shutdown is not tested here — this harness kills the child, which is not a
  // shutdown — it is RT-WK-POLL-5, which ends the loop the way a rotated credential does.
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12' } }
      return { body: { accepted: true, revision: 'b13' } }
    },
    done: (seen, output) => DONE.action.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('ship'), 1, 'the calibration arm never executed, so the refusals above prove nothing')
  assert.equal(run.of('ClaimWork').length, 1)
  assert.doesNotMatch(run.output, /has not confirmed an active lease/)
})

test('RT-WK-HOP-3 the verification hop carries the same identity and no Case', async () => {
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [verificationRow()] } } } : HOLD
      return { body: { accepted: true, revision: 'b12' } }
    },
    done: (seen, output) => DONE.verification.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('check'), 1)
  const report = run.of('ReportWork')[0]
  assert.equal(report.operation.id, 'wo_p2', 'the report is keyed on the work identity')
  assert.equal(report.operation.workerGeneration, 7)
  assert.doesNotMatch(report.raw, /caseId|caseRevision/)
})

test('RT-WK-LEASE-7 a lease answer from an older generation does not put this instance back to work', async () => {
  // The late reply. A generation only moves forward, so an answer carrying an older one is
  // a message from a fence that has already been replaced — and acting on it would be this
  // instance working under a holder it is no longer. Nothing executes and nothing reports.
  let polls = 0
  const run = await driveWorker({
    // First answer establishes generation 9; the second tries to walk it back to 7.
    lease: (operation) => activeLease({ workerId: operation.workerId, workerGeneration: polls <= 1 ? 9 : 7 }),
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      polls += 1
      // Work is only offered on the poll that carries the older generation, so anything that
      // runs, runs on the strength of that answer.
      return { body: { accepted: true, payload: { work: polls >= 2 ? [actionRow()] : [] } } }
    },
    done: (seen, output) => /older than the/.test(output),
    timeoutMs: 15_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.match(run.output, /A fence only moves forward/)
  assert.equal(run.ran('ship'), 0, 'the executor ran on the strength of a replaced generation')
  assert.equal(run.of('ClaimWork').length, 0, 'work was claimed under a generation that had been replaced')
  assert.equal(run.of('ReportWork').length, 0, 'a report went out under a replaced generation')
})

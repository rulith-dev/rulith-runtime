// SPDX-License-Identifier: Apache-2.0
/**
 * Every `/work` call has its own deadline, and an unanswered claim or report is asked again, unchanged.
 *
 * Production, 2026-10-13: a flaky network dropped one response. The Worker handles one item at
 * a time and its Poll, ClaimWork and ReportWork had no deadline, so every later claim waited for
 * Node's built-in fetch timeout (UND_ERR_HEADERS_TIMEOUT, measured at 304.6 s). And a claim that
 * threw fell out of the action arm: the item was dropped, while Core — if it had recorded the
 * claim — held the invocation as dispatched and would never dispatch it again.
 *
 * The fake Gateway below never answers one request. The arms check, from the endpoint's request
 * log and the Adapter's own effect file, that the Worker resumes within the deadline, resends the
 * identical bytes, executes once and reports once; and that losing the lease ends the resends
 * without executing anything.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DONE, HOLD, RESET, actionRow, activeLease, driveWorker, verificationRow } from './support/worker-harness.mjs'

/** Short enough for a test, long enough that a loaded machine still answers the other requests. */
const DEADLINES = { RULITH_POLL_DEADLINE_MS: '1500', RULITH_WORK_CALL_DEADLINE_MS: '1500' }
const accepted = { body: { accepted: true, revision: 'b12' } }
const arrivals = entries => entries.map(entry => entry.at)

/** Stamp each request as it arrives, so the gap between an unanswered one and its resend is measured. */
const stamped = reply => (operation, seen) => {
  seen.at(-1).at = Date.now()
  return reply(operation, seen)
}

test('RT-WK-DEADLINE-1: an unanswered Poll is asked again after its deadline, under the same lease', async () => {
  let polls = 0
  const run = await driveWorker({
    env: DEADLINES,
    reply: stamped((operation) => {
      if (operation.kind === 'Poll') {
        polls += 1
        // 1: takes the lease, empty inbox. 2: never answered. 3: the work. Then idle.
        if (polls === 1) return { body: { accepted: true, payload: { work: [] } } }
        if (polls === 3) return { body: { accepted: true, payload: { work: [actionRow()] } } }
        return HOLD
      }
      return accepted
    }),
    done: (seen, output) => DONE.action.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  const [, unanswered, next] = run.of('Poll')
  assert.ok(next, `the Worker never polled again after the unanswered Poll:\n${run.output}`)
  const gap = next.at - unanswered.at
  assert.ok(gap >= 1000 && gap < 5000, `the next Poll came ${gap} ms after the unanswered one, not at its 1.5 s deadline`)
  // No lease change by itself: the next Poll restates the generation it held, and nothing was dropped.
  assert.equal(unanswered.operation.workerGeneration, 7)
  assert.equal(next.operation.workerGeneration, 7)
  assert.match(run.output, /Poll got no answer within 1\.5s; polling again now\. The lease is unchanged\./)
  assert.doesNotMatch(run.output, /Polling failed|holding none|has not confirmed an active lease/)
  assert.equal(run.ran('ship'), 1)
  assert.equal(run.of('ClaimWork').length, 1)
  assert.equal(run.of('ReportWork').length, 1)
  assert.match(run.output, /receipt committed/)
})

for (const [label, first, why] of [
  ['is never answered', HOLD, /ClaimWork got no answer within 3s/],
  ['loses its connection', RESET, /attempt 1: /],
  // The Gateway's own envelope when Core's result is unconfirmed: a code, on a 503, asking for the same request again.
  ['is answered 503 upstream_unavailable', { status: 503, body: { accepted: false, errorCode: 'rejected',
    reason: 'upstream_unavailable', teaching: 'Kernel result is unconfirmed; retry the same request without repeating external execution' } },
  /HTTP 503 rejected\/upstream_unavailable/],
]) {
  test(`RT-WK-DEADLINE-2: a claim that ${label} is resent unchanged and executed once`, async () => {
    let polls = 0, claims = 0
    const run = await driveWorker({
      env: DEADLINES,
      reply: stamped((operation) => {
        if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
        if (operation.kind === 'ClaimWork') return ++claims === 1 ? first : accepted
        return accepted
      }),
      done: (seen, output) => DONE.action.test(output),
    })
    assert.equal(run.timedOut, false, run.output)
    const sent = run.of('ClaimWork')
    assert.equal(sent.length, 2, run.output)
    assert.equal(sent[1].raw, sent[0].raw, 'the resent claim is not the same request')
    assert.equal(sent[1].headers['x-rulith-worker-generation'], sent[0].headers['x-rulith-worker-generation'])
    // A claim attempt waits twice the call deadline (3 s here), then 1 s before the resend.
    assert.ok(sent[1].at - sent[0].at < 6500, `the resend came ${sent[1].at - sent[0].at} ms after the first claim`)
    assert.match(run.output, /Claiming acme\.ship got no answer \(attempt 1/)
    assert.match(run.output, why)
    // Not dropped, not read as a refusal, and not reported as a fault of the item.
    assert.doesNotMatch(run.output, /was rejected|could not be handled|Polling failed/)
    assert.equal(run.ran('ship'), 1, `effect log: ${JSON.stringify(run.effects)}`)
    assert.equal(run.of('ReportWork').length, 1)
    assert.match(run.output, /receipt committed/)
  })
}

test('RT-WK-DEADLINE-3: an unanswered receipt is resent byte-identically and the executor does not run again', async () => {
  let polls = 0, reports = 0
  const run = await driveWorker({
    env: DEADLINES,
    reply: stamped((operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ReportWork') return ++reports === 1 ? HOLD : { body: { accepted: true, revision: 'b13' } }
      return accepted
    }),
    done: (seen, output) => DONE.action.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  const sent = run.of('ReportWork')
  assert.equal(sent.length, 2, run.output)
  assert.equal(sent[1].raw, sent[0].raw, 'the resent receipt is not the same request')
  assert.ok(sent[1].at - sent[0].at < 5000, `the resend came ${sent[1].at - sent[0].at} ms after the first receipt`)
  assert.match(run.output, /Receipt was not committed \(attempt 1\); retrying unchanged in 1s\..*ReportWork got no answer within 1\.5s/)
  assert.equal(run.ran('ship'), 1, `effect log: ${JSON.stringify(run.effects)}`)
  assert.equal(run.of('ClaimWork').length, 1)
  assert.match(run.output, /receipt committed/)
})

test('RT-WK-DEADLINE-4: a verification report with no answer is resent unchanged', async () => {
  let polls = 0, reports = 0
  const run = await driveWorker({
    env: DEADLINES,
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [verificationRow()] } } } : HOLD
      if (operation.kind === 'ReportWork') return ++reports === 1 ? HOLD : { body: { accepted: true } }
      return accepted
    },
    done: (seen, output) => DONE.verification.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  const sent = run.of('ReportWork')
  assert.equal(sent.length, 2, run.output)
  assert.equal(sent[1].raw, sent[0].raw)
  assert.match(run.output, /The report for verification work wo_p2 got no answer \(attempt 1: ReportWork got no answer within 1\.5s\)/)
  assert.match(run.output, /Work report wo_p2: satisfied → accepted by Board/)
  assert.equal(run.ran('check'), 1)
})

test('RT-WK-DEADLINE-5: losing the lease while a claim is unanswered stops the claims and runs nothing', async () => {
  let polls = 0, markedAt
  const second = actionRow({ work: 'inv_second' })
  const run = await driveWorker({
    env: DEADLINES,
    // Renewed often, so the refusal below ends the lease while the claim is still waiting.
    lease: operation => activeLease({ workerId: operation.workerId, heartbeatAfterMs: 200 }),
    reply: (operation, seen) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow(), second] } } } : HOLD
      if (operation.kind === 'ClaimWork') {
        seen.at(-1).at = Date.now()
        return HOLD
      }
      if (operation.kind === 'RenewLease' && seen.some(entry => entry.operation.kind === 'ClaimWork')) {
        return { body: { accepted: false, errorCode: 'worker_fenced', teaching: 'Not the current holder.' } }
      }
      return undefined
    },
    // Keep watching for a while after the line, so a claim sent after it would be seen.
    done: (seen, output) => {
      if (markedAt === undefined && /has no confirmed answer \(the lease ended\)/.test(output)) markedAt = Date.now()
      return markedAt !== undefined && Date.now() - markedAt > 2500
    },
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  // One claim, or a resend or two if the refused renewal landed after the first deadline: never
  // a claim after the lease ended, and never one for the second item.
  const claims = run.of('ClaimWork')
  assert.ok(claims.length >= 1 && claims.length <= 3, `${claims.length} claims:\n${run.output}`)
  for (const claim of claims) {
    assert.equal(claim.raw, claims[0].raw, 'a resent claim changed its bytes')
    assert.equal(claim.operation.id, 'inv_p2', 'the second item was claimed after the lease ended')
    assert.ok(claim.at < markedAt, 'a claim was sent after the Worker said the lease had ended')
  }
  assert.match(run.output, /Claiming acme\.ship has no confirmed answer \(the lease ended\)\. It was not executed and is left unclaimed here\. If the Gateway recorded the claim, it stays dispatched without an execution; resolve it in Console\./)
  assert.match(run.output, /Stopping this batch with 1 item\(s\) unclaimed because this Worker no longer holds an active lease/)
  assert.doesNotMatch(run.output, /was rejected|could not be handled/)
  assert.equal(run.ran('ship'), 0, `the executor ran without a confirmed claim: ${JSON.stringify(run.effects)}`)
  assert.equal(run.of('ReportWork').length, 0)
})

// ── The wall-clock bounds: a persistent server failure must not hold the one work loop ──────

/** The Gateway's own envelope when Core's result is unconfirmed. */
const unconfirmed503 = { status: 503, body: { accepted: false, errorCode: 'rejected', reason: 'upstream_unavailable',
  teaching: 'Kernel result is unconfirmed; retry the same request without repeating external execution' } }

test('RT-WK-DEADLINE-6: a claim answered 503 every time ends within its budget, and the next item is processed', async () => {
  let polls = 0
  const run = await driveWorker({
    env: DEADLINES,
    reply: stamped((operation) => {
      if (operation.kind === 'Poll') {
        return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow(), actionRow({ work: 'inv_second' })] } } } : HOLD
      }
      if (operation.kind === 'ClaimWork') return operation.id === 'inv_p2' ? unconfirmed503 : accepted
      return accepted
    }),
    done: (seen, output) => DONE.action.test(output),
    timeoutMs: 25_000,
  })
  assert.equal(run.timedOut, false, run.output)
  const stuck = run.of('ClaimWork').filter(entry => entry.operation.id === 'inv_p2')
  assert.ok(stuck.length >= 2, run.output)
  assert.equal(new Set(stuck.map(entry => entry.raw)).size, 1, 'a resent claim changed its bytes')
  // The budget is 4x the 1.5 s call deadline: no resend may start beyond it.
  assert.ok(stuck.at(-1).at - stuck[0].at < 6000, `claims were resent for ${stuck.at(-1).at - stuck[0].at} ms`)
  assert.match(run.output, /Claiming acme\.ship has no confirmed answer \(no answer within 6s\)\. It was not executed and is left unclaimed here\./)
  assert.doesNotMatch(run.output, /was rejected|could not be handled/)
  // The loop moved on: the second item was claimed, ran once and was reported.
  assert.equal(run.ran('ship'), 1, `effect log: ${JSON.stringify(run.effects)}`)
  assert.deepEqual(run.of('ReportWork').map(entry => entry.operation.id), ['inv_second'])
})

test('RT-WK-DEADLINE-7: a stop requested while a claim is being resent ends the claim and the Worker promptly', async () => {
  let polls = 0, stopAt, exitedAt
  const run = await driveWorker({
    env: DEADLINES,
    ipc: true,
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') return unconfirmed503
      return undefined
    },
    done: (seen, output, { send, exited }) => {
      if (stopAt === undefined && seen.some(entry => entry.operation.kind === 'ClaimWork')) {
        stopAt = Date.now()
        send({ protocol: 'rulith-local-control', operation: 'stop' })
      }
      if (exited && exitedAt === undefined) exitedAt = Date.now()
      return exited
    },
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, `the Worker did not stop while its claim was being resent:\n${run.output}`)
  assert.equal(run.exitCode, 0, run.output)
  assert.ok(exitedAt - stopAt < 5000, `the Worker took ${exitedAt - stopAt} ms to stop`)
  assert.match(run.output, /Claiming acme\.ship has no confirmed answer \(this Worker is stopping\)/)
  assert.equal(run.ran('ship'), 0)
  assert.equal(run.of('ReportWork').length, 0)
  assert.equal(run.of('ReleaseLease').length, 1, 'the stop did not release the lease')
})

test('RT-WK-DEADLINE-8: a refusal of the resend after an unanswered claim is reported as unconfirmed, not rejected', async () => {
  let polls = 0, claims = 0
  const run = await driveWorker({
    env: DEADLINES,
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') {
        return ++claims === 1 ? HOLD : { status: 409, body: { accepted: false, errorCode: 'rejected',
          reason: 'invocation_unconfirmed', teaching: 'Kernel did not confirm this pending invocation' } }
      }
      return accepted
    },
    done: (seen, output) => /has no confirmed answer/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').length, 2)
  assert.match(run.output, /Claiming acme\.ship has no confirmed answer \(the resent claim was refused: rejected\/invocation_unconfirmed\)\. It was not executed and is left unclaimed here\. If the Gateway recorded the claim, it stays dispatched without an execution; resolve it in Console\./)
  assert.doesNotMatch(run.output, /was rejected/)
  assert.equal(run.ran('ship'), 0)
  assert.equal(run.of('ReportWork').length, 0)
})

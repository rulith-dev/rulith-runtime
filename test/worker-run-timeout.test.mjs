import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { handWorkspace, leaseIsLive, parseLease, runAdapterTimeoutMs } from '../worker/rulith-worker.mjs'
import { DONE, HOLD, RESET, actionRow, activeLease, driveWorker, slowActionRow } from './support/worker-harness.mjs'

test('a run Adapter keeps the 60 s stop unless this Worker sets RULITH_WORKER_RUN_TIMEOUT_SECONDS', () => {
  assert.equal(runAdapterTimeoutMs({}), 60_000)
  assert.equal(runAdapterTimeoutMs({ RULITH_WORKER_RUN_TIMEOUT_SECONDS: '' }), 60_000)
  assert.equal(runAdapterTimeoutMs({ RULITH_WORKER_RUN_TIMEOUT_SECONDS: '3600' }), 3_600_000)
  assert.equal(runAdapterTimeoutMs({ RULITH_WORKER_RUN_TIMEOUT_SECONDS: '604800' }), 604_800_000)
  for (const bad of ['0', '-5', '1.5', '60s', '604801', 'NaN'])
    assert.throws(() => runAdapterTimeoutMs({ RULITH_WORKER_RUN_TIMEOUT_SECONDS: bad }), /whole number of seconds/)
})

test('an invalid run timeout refuses startup with one message and exit code 2', () => {
  const child = spawnSync(process.execPath, ['worker/rulith-worker.mjs'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, RULITH_WORKER_RUN_TIMEOUT_SECONDS: '60s' },
  })
  assert.equal(child.status, 2)
  assert.equal(child.stdout, '')
  assert.equal(child.stderr.trim(), 'RULITH_WORKER_RUN_TIMEOUT_SECONDS must be a whole number of seconds from 1 to 604800')
})

test('a late renewal answer cannot extend leaseIsLive beyond the Gateway expiry', () => {
  const startedAt = performance.now() - 9000
  const answer = activeLease({ workerId: 'wkr_late_renewal', windowMs: 60_000 })
  const held = parseLease(answer, startedAt)
  assert.equal(held.heldSince, startedAt)
  assert.equal(leaseIsLive(held, startedAt + 59_999), true)
  assert.equal(leaseIsLive(held, startedAt + 60_000), false)
  assert.equal(leaseIsLive(held, startedAt + 65_000), false)
})

test('a wall clock jump forward expires the lease even if the monotonic clock barely moved', () => {
  const startedAt = performance.now()
  const wallStartedAt = Date.now()
  const held = parseLease(activeLease({ workerId: 'wkr_suspender', windowMs: 60_000 }), startedAt, wallStartedAt)
  assert.equal(held.wallClockSince, wallStartedAt)
  assert.equal(leaseIsLive(held, startedAt + 1000, wallStartedAt + 60_000), false)
})

const slowAdapters = {
  'slow-adapter.mjs': "import { appendFileSync } from 'node:fs'\n"
    + "appendFileSync(process.env.P2_EFFECT_LOG, 'slow\\n')\n"
    + "await new Promise(done => setTimeout(done, 1400))\n"
    + "process.stdout.write(JSON.stringify({ rows: [] }))\n",
}
const slowTools = { 'acme.slow@1': { adapter: 'run', sourceTypes: ['file'], entry: 'slow-adapter.mjs' } }
// A 5 s window, measured from the Poll's send: renewal starts by 3.75 s at the latest (a quarter
// of a window shorter than 40 s is kept in reserve) and may be confirmed until the window ends.
const shortLease = operation => activeLease({ workerId: operation.workerId, windowMs: 5_000, heartbeatAfterMs: 200 })

for (const scenario of ['recover', 'expire', '409', 'timeout', 'late', '503-recover', '429-recover', '503-expire', 'truncated-recover']) {
  test(`renewal ${scenario}: finished receipts wait for pending confirmation`, async () => {
    let polls = 0, renewals = 0, recovered = false
    const run = await driveWorker({
      lease: shortLease,
      extraAdapters: slowAdapters, extraTools: slowTools,
      timeoutMs: 9000,
      reply: (operation) => {
        if (operation.kind === 'Poll') return ++polls === 1
          ? { body: { accepted: true, payload: { work: [slowActionRow({}, slowAdapters['slow-adapter.mjs']), actionRow()] } } } : HOLD
        if (operation.kind === 'RenewLease') {
          renewals++
          if (scenario === '409') return { status: 409, body: { accepted: false, errorCode: 'worker_lease_superseded' } }
          if (scenario === 'timeout') return HOLD
          // Answered after the held lease's live end: the attempt is abandoned at that end.
          if (scenario === 'late') return { delayMs: 6000, body: { accepted: true, lease: shortLease(operation) } }
          if (scenario === '503-recover' && renewals === 1) return { status: 503, body: { errorCode: 'temporarily_unavailable' } }
          if (scenario === '429-recover' && renewals === 1) return { status: 429, body: { errorCode: 'rate_limited' } }
          if (scenario === '503-expire') return { status: 503, body: { errorCode: 'temporarily_unavailable' } }
          if (scenario === 'truncated-recover' && renewals === 1) return { partial: '{"accepted":true' }
          if (scenario === 'expire' || renewals === 1) return RESET
          recovered = true
          return { body: { accepted: true, lease: shortLease(operation) } }
        }
        if (operation.kind === 'ClaimWork' && operation.id !== 'inv_slow') {
          assert.equal(recovered, true, 'the Worker claimed before renewal confirmed its lease')
        }
        if (operation.kind === 'ReportWork' && ['recover', '503-recover', '429-recover', 'truncated-recover'].includes(scenario)) {
          assert.equal(recovered, true, 'the Worker reported before renewal confirmed its lease')
        }
        return { body: { accepted: true } }
      },
      done: seen => seen.filter(row => row.operation.kind === 'Poll').length >= 2,
    })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(run.ran('slow'), 1, 'renewal must never repeat the external action')
    if (['recover', '503-recover', '429-recover', 'truncated-recover'].includes(scenario)) {
      assert.ok(renewals >= 2)
      assert.equal(run.of('ReportWork').length, 2)
      assert.equal(run.ran('ship'), 1, 'the confirmed lease should remain usable')
      assert.match(run.output, /receipt committed/)
      for (const row of [...run.of('ClaimWork'), ...run.of('ReportWork')]) {
        assert.equal(row.operation.workerGeneration, 7)
        assert.equal(row.headers['x-rulith-worker-generation'], '7')
      }
    } else {
      const reports = run.of('ReportWork')
      assert.equal(reports.length, 1, 'the already-run slow item must be offered once after renewal is refused or expires')
      assert.equal(reports[0].operation.id, 'inv_slow')
      assert.equal(reports[0].operation.workerGeneration, 7)
      assert.equal(reports[0].headers['x-rulith-worker-generation'], '7')
      assert.equal(run.of('ClaimWork').length, 1)
      assert.equal(run.ran('ship'), 0)
      assert.match(run.output, /Stopping this batch with 1 item\(s\) unclaimed/)
      if (scenario === 'expire' || scenario === '503-expire') assert.ok(renewals >= 2, 'unavailable answers should retry until the lease stops being live')
      else assert.equal(renewals, 1, 'a refusal or request exceeding the window must not start another renewal')
    }
  })
}

test('a lease acquired by a long-held Poll is renewed at once instead of given up', async () => {
  // The production Gateway grants the lease when a Poll arrives, holds the Poll, and states the
  // window left when it answers. Measured from the Poll's send, the Worker then has less than
  // its renewal reserve left: 0.12.0 gave such a lease up before sending a single RenewLease.
  const windowMs = 8_000, holdMs = 3_500
  let polls = 0
  const run = await driveWorker({
    timeoutMs: 15_000,
    reply: (operation) => {
      if (operation.kind === 'RenewLease' || operation.kind === 'ReleaseLease') return undefined
      if (operation.kind !== 'Poll') return { body: { accepted: true } }
      polls++
      if (polls === 1) {
        const granted = Date.now()
        return { delayMs: holdMs, body: { accepted: true, payload: { work: [] }, lease: activeLease({
          workerId: operation.workerId, heartbeatAfterMs: 1_000,
          serverTime: new Date(granted + holdMs).toISOString(), expiresAt: new Date(granted + windowMs).toISOString() }) } }
      }
      return polls === 2 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
    },
    done: (_seen, output) => DONE.action.test(output) || /could not be confirmed inside its validity window/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.doesNotMatch(run.output, /could not be confirmed inside its validity window/)
  assert.ok(run.of('RenewLease').length >= 1, 'the adopted lease was never renewed')
  assert.equal(run.ran('ship'), 1, 'work offered after the acquisition was not executed')
  assert.match(run.output, /receipt committed/)
})

// 2026-10-23 production: a stalling Gateway answered a Poll 36 s after it was sent, stating 31 s
// left. Measured from the send, that lease was dead on arrival: the Worker dropped it, its next
// Poll restated the generation nobody had renewed and got 409, and the cycle repeated every ~37 s.
// The instants below are one consistent timeline: sent at 18:00:00, `serverTime` stated at
// 18:00:31, answer read at 18:00:36 — exactly the 5 s transit margin after `serverTime`.
const PRODUCTION_POLL = Object.freeze({ workerId: 'wkr_long_poll', workerGeneration: 183, heartbeatAfterMs: 10_000,
  serverTime: '2026-10-23T18:00:31.000Z', expiresAt: '2026-10-23T18:01:02.000Z' })

test('a Poll answer is measured from its arrival less the transit margin, never from before its send', () => {
  const sentAt = 1_000_000, wallSentAt = Date.parse('2026-10-23T18:00:00.000Z')
  const arrived = sentAt + 36_000, wallArrived = wallSentAt + 36_000
  const held = parseLease(PRODUCTION_POLL, sentAt, wallSentAt, arrived)
  // 31 s were left at 18:00:31 and the answer arrived 5 s later: live until exactly 18:01:02.
  assert.equal(leaseIsLive(held, arrived, wallArrived), true)
  assert.equal(leaseIsLive(held, arrived + 25_999, wallArrived + 25_999), true)
  assert.equal(leaseIsLive(held, arrived + 26_000, wallArrived + 26_000), false)
  // The margin is an estimate, not a bound. The same answer read 7 s after `serverTime` (the
  // Gateway still working after stating it, or a stall in this process) is believed live until
  // 18:01:04, 2 s past the Gateway's expiry — which is why such an acquisition is renewed before
  // anything is claimed under it, and why the Gateway judges every claim by its own lease.
  const late = parseLease(PRODUCTION_POLL, sentAt, wallSentAt, arrived + 2_000)
  assert.equal(leaseIsLive(late, arrived + 2_000 + 25_999, wallArrived + 2_000 + 25_999), true)
  // The same answer measured from its send (how a renewal is measured) is the defect.
  assert.equal(leaseIsLive(parseLease(PRODUCTION_POLL, sentAt, wallSentAt), arrived, wallArrived), false)
  // Only the monotonic hold is credited: wall time that passed beyond it during the Poll (a
  // suspend) still counts against the window.
  assert.equal(leaseIsLive(held, arrived, wallArrived + 26_000), false)
  // An answer that came back within the margin is measured from the send, exactly as before.
  const quick = parseLease(PRODUCTION_POLL, sentAt, wallSentAt, sentAt + 4_000)
  assert.equal(quick.heldSince, sentAt)
  assert.equal(quick.wallClockSince, wallSentAt)
})

test('a Poll answer whose window elapsed before it arrived is still not live', () => {
  const sentAt = 1_000_000, wallSentAt = Date.parse('2026-10-23T18:00:00.000Z')
  // 4 s left when stated at 18:00:31, and the answer spent the 5 s margin reaching here at 18:00:36.
  const stale = { ...PRODUCTION_POLL, expiresAt: '2026-10-23T18:00:35.000Z', heartbeatAfterMs: 2_000 }
  assert.equal(leaseIsLive(parseLease(stale, sentAt, wallSentAt, sentAt + 36_000), sentAt + 36_000, wallSentAt + 36_000), false)
  // A short Poll whose answer took longer than the window it states.
  const short = { ...PRODUCTION_POLL, serverTime: '2026-10-23T18:00:00.200Z', expiresAt: '2026-10-23T18:00:01.200Z',
    heartbeatAfterMs: 500 }
  assert.equal(leaseIsLive(parseLease(short, sentAt, wallSentAt, sentAt + 1_500), sentAt + 1_500, wallSentAt + 1_500), false)
})

/**
 * A Gateway that holds the line the way the Java one does: an acquisition lasts `grantMs`; a
 * renewal lasts `renewMs` and is answered `renewDelayMs` after it arrives, so a request sent
 * before that answer is visibly early; a Poll that restates a generation no longer active is
 * refused with 409, and so are RenewLease, ClaimWork and ReportWork under one (WorkerService
 * `currentLease`); a Poll without a generation after expiry acquires the next one.
 * `firstPoll(grant)` shapes the acquiring Poll's answer, `offer` what a held Poll hands out.
 */
function holdingGateway({ grantMs, renewMs = 6_000, renewDelayMs = 200, firstPoll, offer = () => undefined }) {
  const line = { generation: 6, expires: 0, refusedPolls: 0, refusedWork: 0, renewals: [] }
  // The heartbeat is the Gateway's: its policy value, or half of what is left if that is shorter.
  const leaseFor = (workerId, now = Date.now()) => activeLease({ workerId, workerGeneration: line.generation,
    heartbeatAfterMs: Math.max(1, Math.min(1_000, Math.floor((line.expires - now) / 2))),
    serverTime: new Date(now).toISOString(), expiresAt: new Date(line.expires).toISOString() })
  const fenced = { status: 409, body: { accepted: false, errorCode: 'worker_fenced',
    teaching: 'This Worker no longer holds the current lease; no work was reassigned' } }
  const reply = (operation) => {
    const active = Date.now() < line.expires
    const holds = active && operation.workerGeneration === line.generation
    if (operation.kind === 'RenewLease') {
      line.renewals.push({ generation: operation.workerGeneration, active })
      if (!holds) return { status: 409, body: { accepted: false, errorCode: 'rejected', reason: 'worker_lease_lost' } }
      line.expires = Date.now() + renewMs
      return { delayMs: renewDelayMs, body: { accepted: true, lease: leaseFor(operation.workerId) } }
    }
    if (operation.kind === 'ClaimWork' || operation.kind === 'ReportWork') {
      if (holds) return { body: { accepted: true } }
      line.refusedWork++
      return fenced
    }
    if (operation.kind !== 'Poll') return { body: { accepted: true } }
    if (operation.workerGeneration !== undefined && !holds) {
      line.refusedPolls++
      return fenced
    }
    if (operation.workerGeneration === undefined && !active) {
      line.generation++
      const grantedAt = Date.now()
      line.expires = grantedAt + grantMs
      return firstPoll({ workerId: operation.workerId, workerGeneration: line.generation, grantedAt, expires: line.expires })
    }
    const work = offer(operation)
    return work === undefined ? HOLD : { delayMs: 25, body: { accepted: true, lease: leaseFor(operation.workerId), payload: { work } } }
  }
  return { line, reply }
}

/** Whether the first claim was sent only after the first renewal had been answered. */
const claimedAfterRenewal = run => run.of('ClaimWork')[0]?.arrived > run.of('RenewLease')[0]?.answered

test('an acquisition answered later than the transit margin is renewed before anything is claimed, and keeps its lease through a long action', async () => {
  // The Gateway stated 11 s left as it took the Poll and delivered the answer 8 s later (still
  // working after stating it: Kernel ListWork, offer records, identity writes). Credited for that,
  // this Worker believes 6 s are left while the Gateway has 3 s. Scheduled by the heartbeat
  // (10 s, less the 5 s margin, held back by the reserve), the first renewal would come 3.25 s
  // after arrival, after the Gateway let the lease go, and the action claimed at once (3.5 s
  // long) would have lost its lease mid-run with its receipt refused. Renewed on adoption, the
  // claim waits for the Gateway's confirmation and the keeper carries the lease through.
  const deliveredAfterMs = 8_000, windowMs = 11_000
  const longAdapter = "import { appendFileSync } from 'node:fs'\n"
    + "appendFileSync(process.env.P2_EFFECT_LOG, 'slow\\n')\n"
    + 'await new Promise(done => setTimeout(done, 3500))\n'
    + 'process.stdout.write(JSON.stringify({ rows: [] }))\n'
  const { line, reply } = holdingGateway({
    grantMs: windowMs,
    firstPoll: ({ workerId, workerGeneration, grantedAt, expires }) => ({ delayMs: deliveredAfterMs, body: { accepted: true,
      payload: { work: [slowActionRow({}, longAdapter)] },
      lease: activeLease({ workerId, workerGeneration, heartbeatAfterMs: 10_000,
        serverTime: new Date(grantedAt).toISOString(), expiresAt: new Date(expires).toISOString() }) } }),
  })
  const run = await driveWorker({
    timeoutMs: 25_000,
    extraAdapters: { 'slow-adapter.mjs': longAdapter }, extraTools: slowTools,
    reply,
    done: (_seen, output) => DONE.action.test(output) || /could not be confirmed|Stopping this batch|did not renew/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.doesNotMatch(run.output, /could not be confirmed|Stopping this batch|did not renew|lost while/)
  assert.deepEqual(line.renewals[0], { generation: 7, active: true }, 'the acquisition was not renewed while the Gateway still held it')
  assert.ok(line.renewals.every(row => row.active && row.generation === 7), JSON.stringify(line.renewals))
  assert.ok(claimedAfterRenewal(run), 'the action was claimed before the Gateway confirmed the lease')
  assert.deepEqual(run.of('ClaimWork').map(row => row.operation.workerGeneration), [7])
  assert.equal(line.refusedWork, 0, 'a claim or receipt reached the Gateway under a lease it no longer held')
  assert.equal(line.refusedPolls, 0)
  assert.equal(run.ran('slow'), 1)
  assert.match(run.output, /receipt committed/)
})

test('a lease that arrives spent but still stands at the Gateway is renewed at once and then used, not dropped into a 409 loop', async () => {
  // Every acquisition is answered 4 s after the Poll with 3.5 s left: spent by this Worker's
  // measure (taken from the send, 4 s being inside the transit margin), though the Gateway holds
  // it for another 3.5 s. Dropping it meant nobody renewed it, so the next Poll restated an
  // expired generation and got 409 — on every acquisition. It is asked about at once instead, and
  // the action in that same answer is claimed once the Gateway has renewed it, not before.
  const holdMs = 4_000, leftMs = 3_500
  const { line, reply } = holdingGateway({
    grantMs: holdMs + leftMs,
    firstPoll: ({ workerId, workerGeneration, grantedAt, expires }) => ({ delayMs: holdMs, body: { accepted: true,
      payload: { work: [actionRow()] },
      lease: activeLease({ workerId, workerGeneration, heartbeatAfterMs: 1_000,
        serverTime: new Date(grantedAt + holdMs).toISOString(), expiresAt: new Date(expires).toISOString() }) } }),
  })
  const run = await driveWorker({
    timeoutMs: 15_000,
    reply,
    done: (_seen, output) => DONE.action.test(output) || line.refusedPolls >= 1
      || /could not be confirmed|Stopping this batch|did not renew/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.doesNotMatch(run.output, /could not be confirmed|Stopping this batch|did not renew/)
  assert.equal(line.refusedPolls, 0, 'a Poll restated a generation that had expired unrenewed')
  assert.deepEqual(line.renewals[0], { generation: 7, active: true }, 'the spent lease was not asked about while it still stood')
  assert.equal(line.generation, 7, 'the line was re-acquired instead of renewed')
  assert.ok(claimedAfterRenewal(run), 'the action was claimed before the Gateway confirmed the lease')
  assert.deepEqual(run.of('ClaimWork').map(row => row.operation.workerGeneration), [7])
  assert.equal(line.refusedWork, 0)
  assert.equal(run.ran('ship'), 1)
})

test('a lease whose window truly elapsed before it arrived is never used, asked about once, and replaced', async () => {
  // The Gateway stated 1 s when it took the Poll and answered 1.5 s later: the lease had expired
  // before it arrived. The action in that answer must not be claimed under it; the one renewal
  // is refused, and the next acquisition (with a usable window) takes the re-offered action.
  let acquisitions = 0
  const { line, reply } = holdingGateway({
    grantMs: 1_000,
    firstPoll: ({ workerId, workerGeneration, grantedAt, expires }) => (++acquisitions === 1
      ? { delayMs: 1_500, body: { accepted: true, payload: { work: [actionRow()] }, lease: activeLease({ workerId, workerGeneration,
        heartbeatAfterMs: 400, serverTime: new Date(grantedAt).toISOString(), expiresAt: new Date(expires).toISOString() }) } }
      : (line.expires = grantedAt + 60_000, { delayMs: 25, body: { accepted: true, payload: { work: [actionRow()] },
        lease: activeLease({ workerId, workerGeneration }) } })),
  })
  const run = await driveWorker({
    timeoutMs: 20_000,
    reply,
    done: (_seen, output) => DONE.action.test(output) || line.refusedPolls > 0 || line.refusedWork > 0,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').filter(row => row.operation.workerGeneration === 7).length, 0,
    'work was claimed under a lease whose window had elapsed before it arrived')
  // Only generation 7 is counted: when generation 8 first renews depends on how long the run took.
  assert.deepEqual(line.renewals.filter(row => row.generation === 7), [{ generation: 7, active: false }],
    'the spent lease was asked about other than once')
  assert.equal(line.refusedPolls, 0, 'a Poll restated the expired generation instead of waiting for its renewal to settle')
  assert.equal(line.refusedWork, 0)
  assert.deepEqual(run.of('ClaimWork').map(row => row.operation.workerGeneration), [8])
  assert.equal(run.ran('ship'), 1)
})

test('workspace list and search stop at a quarter of the inline budget and say they were truncated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-ws-budget-'))
  for (let i = 0; i < 40; i++) writeFileSync(join(dir, `f${String(i).padStart(2, '0')}.txt`), `needle ${'x'.repeat(250)}\n`)
  const sources = { docs: { type: 'file', access: dir } }
  const search = await handWorkspace({ operation: 'search', source: 'docs' }, { query: 'needle' }, sources, { inlineBytes: 4096 })
  assert.ok(search.rows.length > 0 && search.rows.length < 40, `${search.rows.length} matches`)
  assert.ok(Buffer.byteLength(JSON.stringify(search.rows)) <= 1024 + search.rows.length)
  // The rows travel twice (result text and facts); both copies together stay well inside the budget.
  assert.ok(Buffer.byteLength(search.result) + Buffer.byteLength(JSON.stringify(search.rows)) < 4096 / 2 + 200)
  assert.equal(JSON.parse(search.result).truncated, true)
  const list = await handWorkspace({ operation: 'list', source: 'docs' }, {}, sources, { inlineBytes: 2048 })
  assert.ok(list.rows.length > 0 && list.rows.length < 40)
  assert.equal(JSON.parse(list.result).truncated, true)
  // Calibration: without a stated budget nothing changes.
  const unbounded = await handWorkspace({ operation: 'search', source: 'docs' }, { query: 'needle' }, sources)
  assert.equal(unbounded.rows.length, 40)
  assert.equal(JSON.parse(unbounded.result).truncated, false)
  assert.equal(JSON.parse(unbounded.result).partial, undefined)
})

test('a search that stopped at the file limit says it was partial, and an empty result is not called truncated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-ws-partial-'))
  for (let i = 0; i < 520; i++) writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'nothing here\n')
  const sources = { docs: { type: 'file', access: dir } }
  const out = JSON.parse((await handWorkspace({ operation: 'search', source: 'docs' }, { query: 'needle' }, sources, { inlineBytes: 8192 })).result)
  assert.deepEqual(out.matches, [])
  assert.equal(out.truncated, false)
  assert.equal(out.filesSearched, 500)
  assert.match(out.partial, /^searched only the first 500 files/)
})

for (const kind of ['read', 'write', 'run']) {
  test(`a ${kind} result whose facts exceed the inline budget ${kind === 'read' ? 'settles with one failure receipt' : 'requests reconciliation once'}`, async () => {
    let polls = 0
    const row = actionRow()
    const big = 'y'.repeat(row.artifactPolicy.inlineBytes + 100)
    const run = await driveWorker({
      // A read Adapter runs without the scenario's effect log in its environment, so for a
      // read the claim and the receipt, not the log, are what this arm checks.
      extraAdapters: { 'ship-adapter.mjs': "import { appendFileSync } from 'node:fs'\n"
        + "if (process.env.P2_EFFECT_LOG) appendFileSync(process.env.P2_EFFECT_LOG, 'ship\\n')\n"
        + `process.stdout.write(JSON.stringify({ rows: [{ value: '${big}' }] }))\n` },
      reply: (operation) => {
        if (operation.kind === 'Poll') return ++polls === 1
          ? { body: { accepted: true, payload: { work: [actionRow({ toolSpec: JSON.stringify({
            impl: 'worker-tool', exec: 'acme.ship@1', kind, params: {}, sourceTypes: ['file'],
            returns: [{ predicate: 'demo.recorded', args: { value: '$value' } }],
          }) })] } } } : HOLD
        return { body: { accepted: true } }
      },
      done: (_seen, output) => DONE.action.test(output) || /Reconciliation requested|remains pending for operator reconciliation/.test(output),
    })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(run.of('ClaimWork').length, 1)
    if (kind !== 'read') assert.equal(run.ran('ship'), 1)
    const reports = run.of('ReportWork')
    if (kind === 'read') {
      assert.equal(reports.length, 1)
      assert.equal(reports[0].operation.ok, false)
      assert.equal(reports[0].operation.facts, undefined)
      assert.equal(reports[0].operation.reason, 'result_too_large: the result does not fit in one receipt; ask for a narrower path or query.')
      assert.match(run.output, /receipt committed/)
    } else {
      assert.equal(reports.length, 1, run.output)
      assert.equal(reports[0].operation.undeliverable, 'required_facts_exceed_inline_budget')
      assert.equal(reports[0].operation.ok, undefined)
      assert.equal(reports[0].operation.facts, undefined)
      assert.match(run.output, /Reconciliation requested/)
    }
  })
}

for (const kind of ['read', 'run']) {
  test(`a ${kind} result too large to report inline and with nowhere to register it ${kind === 'read' ? 'settles with one failure receipt' : 'requests reconciliation once'}`, async () => {
    // Small facts, large result text: the report needs a registered object, and this Worker has no
    // material area to hold one (production: a Source without material permission).
    let polls = 0
    const pad = 'z'.repeat(actionRow().artifactPolicy.inlineBytes + 500)
    const run = await driveWorker({
      extraAdapters: { 'ship-adapter.mjs': "import { appendFileSync } from 'node:fs'\n"
        + "if (process.env.P2_EFFECT_LOG) appendFileSync(process.env.P2_EFFECT_LOG, 'ship\\n')\n"
        + `process.stdout.write(JSON.stringify({ rows: [{ value: 7 }], pad: '${pad}' }))\n` },
      reply: (operation) => {
        if (operation.kind === 'Poll') return ++polls === 1
          ? { body: { accepted: true, payload: { work: [actionRow({ toolSpec: JSON.stringify({
            impl: 'worker-tool', exec: 'acme.ship@1', kind, params: {}, sourceTypes: ['file'],
            returns: [{ predicate: 'demo.recorded', args: { value: '$value' } }],
          }) })] } } } : HOLD
        return { body: { accepted: true } }
      },
      done: (_seen, output) => DONE.action.test(output) || /Reconciliation requested|remains pending for operator reconciliation/.test(output),
    })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(run.of('ClaimWork').length, 1)
    const reports = run.of('ReportWork')
    if (kind === 'read') {
      assert.equal(reports.length, 1, run.output.replace(/z{50,}/g, 'zzz…'))
      assert.equal(reports[0].operation.ok, false)
      assert.equal(reports[0].operation.facts, undefined)
      assert.match(reports[0].operation.reason, /^result_not_delivered: [a-z_]+\. The read ran, but its result could not be delivered; ask for a narrower path or query\.$/)
      assert.match(run.output, /receipt committed/)
    } else {
      assert.equal(reports.length, 1, run.output)
      assert.equal(reports[0].operation.undeliverable, 'materials_not_configured')
      assert.equal(reports[0].operation.ok, undefined)
      assert.equal(reports[0].operation.facts, undefined)
      assert.match(run.output, /Reconciliation requested/)
    }
  })
}

const resultFacts = [{ predicate: 'demo.recorded', args: { value: 7 } }]
for (const errorCode of ['ingest_rejected', 'bad_command', 'not_claimer', 'worker_lease_expired', 'worker_fenced', 'already_reported']) {
  test(`receipt rejection ${errorCode}: only result-recording failures get one failure receipt`, async () => {
    let polls = 0
    const teaching = 'Rejected secret fact value: PRIVATE_RESULT_123. ' + 'x'.repeat(400)
    const run = await driveWorker({
      extraAdapters: { 'ship-adapter.mjs': "import { appendFileSync } from 'node:fs'\n"
        + "appendFileSync(process.env.P2_EFFECT_LOG, 'ship\\n')\n"
        + "process.stdout.write(JSON.stringify({ rows: [{ value: 7 }] }))\n" },
      reply: (operation, seen) => {
        if (operation.kind === 'Poll') return ++polls === 1
          ? { body: { accepted: true, payload: { work: [actionRow({ toolSpec: JSON.stringify({
            impl: 'worker-tool', exec: 'acme.ship@1', kind: 'act', params: {}, sourceTypes: ['file'],
            returns: [{ predicate: 'demo.recorded', args: { value: '$value' } }],
          }) })] } } } : HOLD
        if (operation.kind === 'ReportWork') return seen.filter(row => row.operation.kind === 'ReportWork').length === 1
          ? { body: { accepted: false, errorCode, teaching } } : { body: { accepted: true } }
        return { body: { accepted: true } }
      },
      done: (_seen, output) => DONE.action.test(output),
    })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(run.ran('ship'), 1)
    const reports = run.of('ReportWork')
    assert.deepEqual(reports[0].operation.facts, resultFacts)
    const fallback = errorCode === 'ingest_rejected'
    assert.equal(reports.length, fallback ? 2 : 1)
    if (fallback) {
      const first = reports[0].operation, last = reports[1].operation
      assert.equal(first.ok, true)
      assert.equal(last.ok, false)
      assert.equal(last.id, first.id)
      assert.equal(last.executionGrant, first.executionGrant)
      assert.equal(last.workerGeneration, first.workerGeneration)
      assert.equal(last.result, '')
      assert.equal(last.facts, undefined)
      assert.equal(last.artifacts, undefined)
      assert.equal(last.reason, `result_not_recorded: ${errorCode}. The Board did not record this result; the action already ran; do not repeat it.`)
      assert.doesNotMatch(run.output, /PRIVATE_RESULT_123|executor succeeded/)
      assert.match(run.output, /result not recorded; failure receipt sent/)
      assert.match(run.output, /receipt committed/)
    }
  })
}

// The answer to a resend is the answer: the Gateway replays the request id and Core returns its
// original reply. So an ingest rejection that arrives after an unanswered attempt — an HTTP
// failure, a reset, a cut-off body — still authorizes the one failure receipt.
for (const prior of ['HTTP', 'reset', 'truncated body']) {
  test(`ingest rejection after ${prior} retry sends one failure receipt and keeps the success attempts byte-identical`, async () => {
    let polls = 0, reports = 0
    const run = await driveWorker({
      ipc: true, env: { RULITH_LOCAL_EVENTS: 'ipc' },
      reply: operation => {
        if (operation.kind === 'Poll') return ++polls === 1
          ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
        if (operation.kind === 'ReportWork') {
          if (++reports === 1) return prior === 'reset' ? RESET
            : prior === 'truncated body' ? { partial: '{"revision":' }
              : { status: 503, text: 'Unavailable' }
          if (reports === 2) return { body: { accepted: false, errorCode: 'ingest_rejected', teaching: 'PRIVATE_RESULT_123' } }
          return { body: { accepted: true } }
        }
        return { body: { accepted: true } }
      },
      done: (_seen, _output, { messages }) => messages.some(message => message.event?.type === 'reported'),
    })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(run.ran('ship'), 1)
    const receipts = run.of('ReportWork')
    assert.equal(receipts.length, 3)
    assert.equal(receipts[0].raw, receipts[1].raw, 'success retries must stay byte-identical')
    assert.equal(receipts[0].operation.ok, true)
    const event = run.messages.find(message => message.event?.type === 'reported').event
    assert.equal(receipts[2].operation.ok, false)
    assert.equal(event.ok, false)
    assert.equal(event.resultRecorded, false)
    assert.equal(event.failureReceiptSent, true)
    assert.equal(event.result, undefined)
    assert.match(event.reason, /The Board did not record this result/)
    assert.doesNotMatch(JSON.stringify(run.messages), /PRIVATE_RESULT_123/)
  })
}

test('a rejected fallback failure receipt is left for reconciliation without another submission', async () => {
  let polls = 0
  const run = await driveWorker({
    reply: operation => {
      if (operation.kind === 'Poll') return ++polls === 1
        ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ReportWork') return { body: { accepted: false, errorCode: 'ingest_rejected' } }
      return { body: { accepted: true } }
    },
    done: (_seen, output) => DONE.action.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.deepEqual(run.of('ReportWork').map(row => row.operation.ok), [true, false])
  assert.match(run.output, /receipt not committed \(Board rejected: ingest_rejected\)/)
})

test('bad_command without result facts does not authorize a fallback receipt', async () => {
  let polls = 0
  const run = await driveWorker({
    reply: operation => {
      if (operation.kind === 'Poll') return ++polls === 1
        ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ReportWork') return { body: { accepted: false, errorCode: 'bad_command' } }
      return { body: { accepted: true } }
    },
    done: (_seen, output) => DONE.action.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ReportWork').length, 1)
  assert.equal(run.of('ReportWork')[0].operation.ok, true)
})

test('a rejected executor failure receipt does not trigger another failure receipt', async () => {
  let polls = 0
  const run = await driveWorker({
    extraAdapters: { 'ship-adapter.mjs': 'process.exit(1)\n' },
    reply: operation => {
      if (operation.kind === 'Poll') return ++polls === 1
        ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ReportWork') return { body: { accepted: false, errorCode: 'ingest_rejected' } }
      return { body: { accepted: true } }
    },
    done: (_seen, output) => DONE.action.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ReportWork').length, 1)
  assert.equal(run.of('ReportWork')[0].operation.ok, false)
})

test('a failed run reports what the command said, bounded, never its command line', async () => {
  // 2026-10-07: a refused write echoed its whole command line (with the text being written) as the
  // reason; the report exceeded the inline budget and a known failure waited for an operator.
  let polls = 0
  const run = await driveWorker({
    extraAdapters: { 'ship-adapter.mjs': "process.stderr.write('file digest changed ' + 'y'.repeat(20000))\nprocess.exit(2)\n" },
    reply: operation => {
      if (operation.kind === 'Poll') return ++polls === 1
        ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      return { body: { accepted: true } }
    },
    done: (_seen, output) => DONE.action.test(output) || /remains pending for operator reconciliation/.test(output),
  })
  assert.equal(run.timedOut, false, run.output.replace(/y{50,}/g, 'yyy…'))
  const reports = run.of('ReportWork')
  assert.equal(reports.length, 1, run.output.replace(/y{50,}/g, 'yyy…'))
  assert.equal(reports[0].operation.ok, false)
  assert.match(reports[0].operation.reason, /^file digest changed y+$/)
  assert.ok(Buffer.byteLength(reports[0].operation.reason) <= 2048)
  assert.doesNotMatch(reports[0].operation.reason, /Command failed|ship-adapter/)
})

test('a failed write whose failure report cannot be delivered still settles as a failure, without its detail', async () => {
  // An inline budget smaller than the bounded reason and nowhere to register an object: before,
  // the known failure stayed pending for an operator as though its outcome were unknown.
  let polls = 0
  const tiny = actionRow()
  tiny.artifactPolicy = { ...tiny.artifactPolicy, inlineBytes: 600 }
  const run = await driveWorker({
    extraAdapters: { 'ship-adapter.mjs': "process.stderr.write('file digest changed ' + 'y'.repeat(1500))\nprocess.exit(2)\n" },
    reply: operation => {
      if (operation.kind === 'Poll') return ++polls === 1
        ? { body: { accepted: true, payload: { work: [{ ...tiny, toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.ship@1', kind: 'write', params: {}, sourceTypes: ['file'] }) }] } } } : HOLD
      return { body: { accepted: true } }
    },
    done: (_seen, output) => DONE.action.test(output) || /remains pending for operator reconciliation/.test(output),
  })
  assert.equal(run.timedOut, false, run.output.replace(/y{50,}/g, 'yyy…'))
  const reports = run.of('ReportWork')
  assert.equal(reports.length, 1, run.output.replace(/y{50,}/g, 'yyy…'))
  assert.equal(reports[0].operation.ok, false)
  assert.equal(reports[0].operation.facts, undefined)
  assert.match(reports[0].operation.reason, /^failure_detail_not_delivered: [a-z_]+\. The action failed; its detail could not be delivered\.$/)
  assert.equal(reports[0].operation.undeliverable, undefined)
  assert.doesNotMatch(run.output, /remains pending for operator reconciliation/)
})

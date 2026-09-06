// SPDX-License-Identifier: Apache-2.0
/**
 * Poll: the one Worker inbox verb, the line it takes, and the Manifest it carries.
 *
 * Two things are checked here that a scenario arm alone cannot check. The first is the
 * shape: a fake endpoint accepts whatever the client sends, so every one of these arms would
 * stay green while the Worker put last month's request on the wire. The bytes are therefore
 * read back out of the endpoint's log and checked against `PollRequest` in the vendored
 * schema itself. The second is the line: admission is decided against the lease the Gateway
 * holds, so a refused poll means what this process believes about its own lease is no longer
 * true, and the only correct answer is to take the line again the way it did at startup.
 *
 * The Core operation `ListWork` is internal Board Protocol and has no Worker-facing alias.
 * If one ever reappears on this wire, RT-WK-POLL-1 fails on the `kind` constant.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadWorkerContract } from '../scripts/verify-worker-contract.mjs'
import { shapeFaults } from './support/contract-shape.mjs'
import { HOLD, RESET, actionRow, driveWorker } from './support/worker-harness.mjs'

const CONTRACT = loadWorkerContract()
const DEFS = CONTRACT.defs

/** Every poll the endpoint received, as the bytes that arrived. */
const pollsOf = (run) => run.seen
  .filter((entry) => entry.operation.kind === CONTRACT.pollKind)
  .map((entry) => JSON.parse(entry.raw).operation)

/** Assert one poll is what the committed schema calls a poll. */
function assertWellFormed(poll, where) {
  assert.deepEqual(shapeFaults(poll, DEFS.PollRequest, DEFS), [],
    `${where}: this is not a poll the contract accepts — ${JSON.stringify(poll).slice(0, 400)}`)
}

test('RT-WK-POLL-1 every poll on the wire is a PollRequest, Manifest and all', async () => {
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      return ++polls <= 3 ? { body: { accepted: true, payload: { work: [] } } } : HOLD
    },
    done: (seen) => seen.filter((entry) => entry.operation.kind === 'Poll').length >= 3,
  })
  assert.equal(run.timedOut, false, run.output)
  const sent = pollsOf(run)
  assert.ok(sent.length >= 3, `only ${sent.length} polls were sent`)

  for (const [index, poll] of sent.entries()) assertWellFormed(poll, `poll ${index + 1}`)

  // The Manifest rides on every round, which is what makes a re-report possible after a
  // Connection secret rotates without any registration call existing. An empty array would
  // advertise nothing; omitting the field would leave the previous advertisement standing
  // unexamined, and the shape does not allow it.
  const advertised = sent.map((poll) => poll.tools)
  for (const tools of advertised) {
    assert.ok(Array.isArray(tools) && tools.length > 0, 'a poll carried no Tool Manifest')
  }
  assert.deepEqual(advertised[1], advertised[0], 'the Manifest changed between two polls of one process')
  assert.deepEqual(advertised[2], advertised[0])
  assert.ok(advertised[0].some((tool) => tool.id === 'acme.ship@1' && tool.kind === 'run'),
    'the operator-declared Tools are missing from the advertisement')
  assert.ok(advertised[0].some((tool) => tool.id === 'rulith.workspace.read_text@1'),
    'the built-in Tools are missing from the advertisement')

  // Acquisition states no generation; every poll after the lease is confirmed states it.
  assert.equal(sent[0].workerGeneration, undefined,
    'the acquiring poll stated a generation this process had never been given')
  for (const poll of sent.slice(1)) assert.equal(poll.workerGeneration, 7, 'a poll under a lease did not state its generation')
  // And nothing rides along that the shape does not define.
  for (const poll of sent) {
    assert.deepEqual(Object.keys(poll).sort(), poll.workerGeneration === undefined
      ? ['kind', 'tools', 'workerId'] : ['kind', 'tools', 'workerGeneration', 'workerId'])
  }
})

test('RT-WK-POLL-2 resending the startup request keeps one identity and takes one line', async () => {
  // The first answer is lost on the wire. The contract's own row says the resend returns the
  // acquisition already taken rather than taking a second one — which it can only do if the
  // resend is recognisable as the same request. So the process states the same workerId, and
  // still states no generation: it has been given none, and inventing one to look settled
  // would be the retry taking a second line.
  const row = CONTRACT.fixture.pollLeaseAdmission.rows.find((r) => r.id === 'same-process-resend-is-one-acquisition')
  assert.ok(row, 'the fixture no longer carries the resend row this arm is calibrated against')
  assert.equal(row.leaseAction, 'reuse')
  assert.equal(row.request.workerGeneration, undefined)

  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      polls += 1
      if (polls === 1) return RESET
      return polls === 2 ? { body: { accepted: true, payload: { work: [] } } } : HOLD
    },
    done: (seen) => seen.filter((entry) => entry.operation.kind === 'Poll').length >= 3,
    timeoutMs: 25_000,
  })
  assert.equal(run.timedOut, false, run.output)
  const sent = pollsOf(run)
  assert.ok(sent.length >= 2)
  assertWellFormed(sent[1], 'the resend')
  assert.equal(sent[1].workerId, sent[0].workerId,
    'the resend presented a second identity, so the endpoint would have had to fence two processes that are one')
  assert.equal(sent[1].workerGeneration, undefined,
    'the resend stated a generation, which would make it a different request from the one it is resending')
  assert.deepEqual(sent[1].tools, sent[0].tools, 'the resend advertised something else')
  assert.equal(run.of('ClaimWork').length, 0, 'the process claimed work while it still held no confirmed lease')
})

test('RT-WK-POLL-3 a refused poll drops the line and the next one takes it again', async () => {
  // Both refusal shapes the admission rule names, in one run. Stating a generation with no
  // valid lease is refused by name, so a process whose lease lapsed must stop stating one —
  // otherwise every poll from here on is refused for the same reason, forever.
  const named = Object.fromEntries(CONTRACT.fixture.pollLeaseAdmission.rows
    .filter((row) => row.refusal !== null).map((row) => [row.id, row.refusal]))
  assert.equal(named['stale-generation-without-a-valid-lease'], 'worker_lease_expired')
  assert.equal(named['held-lease-generation-stale'], 'worker_lease_superseded')

  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      polls += 1
      // 1 acquires at 7. 2 states 7 and is told the lease lapsed. 3 must acquire again, and
      // takes 8 — above the fence, never back to a generation already spent. 4 states 8 and
      // is told it was superseded. 5 must acquire again.
      if (polls === 2) return { body: { accepted: false, errorCode: 'worker_lease_expired', teaching: 'No lease is currently valid for this Connection.' } }
      if (polls === 4) return { body: { accepted: false, errorCode: 'worker_lease_superseded', teaching: 'The generation stated is not the one this lease holds.' } }
      if (polls >= 5) return HOLD
      return { body: {
        accepted: true,
        lease: { workerId: operation.workerId, workerGeneration: polls === 1 ? 7 : 8, ...leaseWindow() },
        payload: { work: [actionRow()] },
      } }
    },
    done: (seen) => seen.filter((entry) => entry.operation.kind === 'Poll').length >= 5,
    timeoutMs: 40_000,
  })
  assert.equal(run.timedOut, false, run.output)
  const sent = pollsOf(run)
  assert.ok(sent.length >= 5, `only ${sent.length} polls were sent: ${run.output.slice(-600)}`)
  for (const [index, poll] of sent.entries()) assertWellFormed(poll, `poll ${index + 1}`)

  assert.equal(sent[0].workerGeneration, undefined)
  assert.equal(sent[1].workerGeneration, 7, 'the poll under a live lease did not state the generation it held')
  assert.equal(sent[2].workerGeneration, undefined,
    'after being told no lease is valid, this process kept restating the generation it had been refused for')
  assert.equal(sent[3].workerGeneration, 8, 'the re-acquired generation was not stated on the next poll')
  assert.equal(sent[4].workerGeneration, undefined,
    'after being told it was superseded, this process kept restating the superseded generation')
  // One identity throughout: a refusal is not a reason to become somebody else.
  assert.equal(new Set(sent.map((poll) => poll.workerId)).size, 1)
  // The refusals are said in the operator's output, by the name they were refused with.
  assert.match(run.output, /worker_lease_expired|No lease is currently valid/)
  assert.match(run.output, /worker_lease_superseded|not the one this lease holds/)
})

test('RT-WK-POLL-4 a Source-free Tool is advertised, not refused by this machine', async () => {
  // The gate this replaces refused a Source-free declaration locally: an operator whose Tool
  // reads through no Source had nothing truthful to write in `sourceTypes`, and the nearest
  // untrue thing was to name a type the Tool never reads. The contract calls the empty array
  // a declaration, so the advertisement carries it as one — and the Connection is not
  // offered in the Source's place.
  let polls = 0
  const run = await driveWorker({
    extraTools: {
      'acme.calculate@1': { adapter: 'run', sourceTypes: [], entry: 'ship-adapter.mjs', kind: 'run', params: { value: 'number' }, returns: [] },
      'acme.ping@1': { adapter: 'run', sourceTypes: ['http'], entry: 'ship-adapter.mjs', kind: 'read', params: {}, returns: [{ predicate: 'acme.reachable', args: {} }] },
    },
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      return ++polls === 1 ? { body: { accepted: true, payload: { work: [] } } } : HOLD
    },
    done: (seen) => seen.filter((entry) => entry.operation.kind === 'Poll').length >= 1,
  })
  assert.equal(run.timedOut, false, run.output)
  const [poll] = pollsOf(run)
  assertWellFormed(poll, 'the poll carrying a Source-free Tool')

  const sourceFree = poll.tools.find((tool) => tool.id === 'acme.calculate@1')
  assert.ok(sourceFree, `the Source-free Tool never reached the wire: ${run.output.slice(0, 600)}`)
  assert.deepEqual(sourceFree.sourceTypes, [],
    'the Source-free Tool was advertised with a Source type it does not read')
  assert.deepEqual(sourceFree.returns, [], 'a Tool that attests nothing was given rows it does not produce')
  assert.equal(sourceFree.kind, 'run')

  // A row that lands a bare proposition, and a Tool that takes nothing: both are empty
  // declarations, and neither is an omission.
  const ping = poll.tools.find((tool) => tool.id === 'acme.ping@1')
  assert.deepEqual(ping.params, {})
  assert.deepEqual(ping.returns, [{ predicate: 'acme.reachable', args: {} }])
})

test('RT-WK-POLL-5 a process that stops gives the line back and never restates it', async () => {
  // The withdrawal branch, from this side of the wire. A release advances the fence with
  // nobody on it, so the generation this process held is spent; what the Worker owes is to
  // hand it back explicitly rather than going quiet, and never to state it again. The
  // Connection credential is refused on the second poll purely to end the loop the way a
  // real shutdown does — a signal is not portable enough to drive here.
  const row = CONTRACT.fixture.pollLeaseAdmission.rows.find((r) => r.id === 'acquire-after-withdrawal')
  assert.ok(row, 'the fixture no longer carries the withdrawal row this arm is calibrated against')
  assert.equal(row.fence.workerId, null, 'a withdrawal is supposed to leave the fence with nobody on it')

  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'ReleaseLease') return { body: { accepted: true } }
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      if (++polls === 1) return { body: { accepted: true, payload: { work: [] } } }
      return { status: 401, text: JSON.stringify({ teaching: 'This Connection key was rotated.' }) }
    },
    done: (seen) => seen.some((entry) => entry.operation.kind === 'ReleaseLease'),
    timeoutMs: 25_000,
  })
  assert.equal(run.timedOut, false, run.output)
  const [release] = run.of('ReleaseLease').map((entry) => JSON.parse(entry.raw).operation)
  assert.ok(release, 'the process went quiet instead of giving the line back')
  assert.equal(release.workerGeneration, 7, 'the release did not say which generation it was giving back')
  assert.equal(release.workerId, pollsOf(run)[0].workerId, 'the release came from a different instance than the poll')
  // Nothing is claimed after the credential is refused, and no poll follows the release.
  assert.equal(run.of('ClaimWork').length, 0)
  const afterRelease = run.seen.slice(run.seen.findIndex((entry) => entry.operation.kind === 'ReleaseLease') + 1)
  assert.deepEqual(afterRelease.map((entry) => entry.operation.kind), [],
    'this process kept talking to the endpoint after handing the line back')
})

/** A real window anchored on this machine's clock, since the contract requires a live one. */
function leaseWindow(windowMs = 60_000, heartbeatAfterMs = 10_000) {
  const serverTime = new Date().toISOString()
  return { serverTime, expiresAt: new Date(Date.parse(serverTime) + windowMs).toISOString(), heartbeatAfterMs }
}

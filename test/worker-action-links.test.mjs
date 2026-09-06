// SPDX-License-Identifier: Apache-2.0
/**
 * The committed action-row links, driven through this Runtime's own readers.
 *
 * `actionWorkLinks` is the cross-repository seam written down: for each dispatched action it
 * carries the row the Gateway emits, the grant it signs, the lease it signs under, the HMAC
 * key it signs with, and the request-vector digest that ties them together. Naming those
 * scenarios in an owner list would prove nothing, so every one of them is run here — parsed,
 * verified, digested and Source-selected by the same functions the receive path uses.
 *
 * One honest limitation, stated rather than papered over. The committed grants name
 * `wkr_action_row_fixture`, an instance no real process is. Two different things are
 * therefore checked, and they are kept apart on purpose:
 *
 *   · **Against the committed bytes, exactly.** The token, the signature, the decoded grant
 *     and the request digest are compared to the fixture's own values under the fixture's own
 *     HMAC key. Nothing is rebound; a byte out of place fails.
 *   · **Against a live instance, rebound.** An end-to-end arm cannot use a token issued to a
 *     fixture instance, so it re-signs the *same* grant with the running instance's id and
 *     this Connection's key. Only `workerId` moves, and the arm asserts that everything else —
 *     `requestDigest` included — is still the committed value, so the rebinding cannot hide a
 *     drift in what is being signed over.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadWorkerContract } from '../scripts/verify-worker-contract.mjs'
import {
  actionRowFaults, executionDigest, grantMismatch, parseLease, readExecutionGrant,
  requestVectorOf, resolveInvocationSource,
} from '../worker/rulith-worker.mjs'
import { CONNECTION_KEY, DONE, HOLD, driveWorker, signGrant, toolDigest } from './support/worker-harness.mjs'

const CONTRACT = loadWorkerContract()
const FIXTURE = CONTRACT.fixture
const LINKS = FIXTURE.actionWorkLinks
const ROWS = new Map(FIXTURE.boundaries.find((entry) => entry.id === 'worker-action-item').valid.map((row) => [row.work, row]))

/** What the row says this execution is, in the shape the grant is compared against. */
const expectationsFor = (row) => {
  const vector = requestVectorOf(row)
  return {
    connectionId: row.connectionId,
    boardId: vector.boardId,
    invocationId: vector.invocationId,
    actionId: vector.actionId,
    toolContractId: vector.toolContractId,
    sourceRecordId: vector.sourceRecordId,
    adapterDigest: `sha256:${row.toolDigest}`,
    requestDigest: executionDigest(vector),
  }
}

test('RT-WK-LINK-1 every committed link has a row, and the fixture carries both dispatch shapes', () => {
  assert.ok(LINKS.length >= 2, `only ${LINKS.length} committed action link(s)`)
  for (const link of LINKS) assert.ok(ROWS.has(link.work), `${link.work}: the fixture carries a link with no row`)
  assert.ok(LINKS.some((link) => ROWS.get(link.work).sourceRecordId !== ''), 'no sourced dispatch is linked')
  assert.ok(LINKS.some((link) => ROWS.get(link.work).sourceRecordId === ''), 'no Source-free dispatch is linked')
})

for (const link of LINKS) {
  test(`RT-WK-LINK-2 ${link.work}: the committed token is the one this Runtime signs and reads`, () => {
    const row = ROWS.get(link.work)
    // Signing the committed grant with the committed key must reproduce the committed token,
    // byte for byte. This is the half that cannot be rebound: if it needed rebinding, the
    // two implementations would not be signing the same document.
    assert.equal(signGrant(link.grant, link.fixtureHmacKey), row.executionGrant,
      'this Runtime signs the committed grant into different bytes than the committed token')
    const { grant, fault } = readExecutionGrant(row.executionGrant, link.fixtureHmacKey)
    assert.equal(fault, undefined, `the committed token was refused: ${fault}`)
    assert.deepEqual(grant, link.grant, 'the decoded token is not the committed grant')
    // And it is refused under any other key, so the check is a signature check.
    assert.match(readExecutionGrant(row.executionGrant, `${link.fixtureHmacKey}x`).fault, /signature does not verify/)
  })

  test(`RT-WK-LINK-3 ${link.work}: the row digests to the vector the grant covers`, () => {
    const row = ROWS.get(link.work)
    const vector = requestVectorOf(row)
    // The link records what *Core* served. Where it names `args`, the row must carry that
    // string exactly, spacing and all. Where it names none, Core produced none and the
    // Gateway materialized `"{}"` into both the row and the digest — which is why an empty
    // `args` string is a malformed dispatch rather than "no arguments": the absent case
    // already has a value, and it is not the empty string.
    if (link.coreFields.args === undefined) {
      assert.equal(vector.args, '{}',
        'Core served no args and the row does not carry the materialized empty object')
    } else {
      assert.equal(vector.args, link.coreFields.args, 'the row and the link disagree about the served args')
    }
    assert.equal(vector.toolSpec, link.coreFields.toolSpec)
    assert.equal(executionDigest(vector), link.requestVectorSha256,
      'this Runtime digests the committed row differently from the committed vector')
    assert.equal(link.grant.requestDigest, link.requestVectorSha256,
      'the committed grant covers a different request than the committed vector')
  })

  test(`RT-WK-LINK-4 ${link.work}: the committed row and grant pass this Runtime's receive path`, () => {
    const row = ROWS.get(link.work)
    assert.deepEqual(actionRowFaults(row, row.connectionId), [],
      'the committed row is refused by the shape this Runtime checks rows against')
    const held = parseLease(link.lease)
    assert.ok(held, 'the committed lease is not readable as an active lease')
    const { grant } = readExecutionGrant(row.executionGrant, link.fixtureHmacKey)
    assert.equal(grantMismatch(grant, expectationsFor(row), held), undefined,
      'the committed grant does not match the committed row under the committed lease')
  })
}

test('RT-WK-LINK-5 each committed Source invariant is the answer this Runtime gives', () => {
  // The row set is driven, not summarized. `resolvedSourceType` is what a Source table would
  // hand back for the record the row names — `null` meaning this Connection has no such
  // authorized Source — so it is built into the table each row is resolved against.
  const rows = FIXTURE.actionWorkSourceInvariants
  assert.ok(rows.length >= 7, `only ${rows.length} committed Source invariant(s)`)
  let refusals = 0
  for (const invariant of rows) {
    const row = { ...ROWS.get(invariant.work), ...invariant.change }
    assert.ok(row.work, `${invariant.id}: names a work item the fixture does not carry`)
    const spec = JSON.parse(row.toolSpec)
    const sources = invariant.resolvedSourceType === null || row.sourceRecordId === ''
      ? {} : { [row.sourceRecordId]: { type: invariant.resolvedSourceType } }
    const run = () => resolveInvocationSource(row.toolContractId, spec, row.args, row.sourceRecordId, sources)

    if (invariant.valid) {
      const resolved = run()
      assert.equal(resolved.source, invariant.resolvedSourceType === null ? undefined : row.sourceRecordId,
        `${invariant.id}: this Runtime resolved a different Source from the committed one`)
      assert.equal('source' in resolved.args, false, `${invariant.id}: the structural selector reached the Adapter`)
      continue
    }
    if (invariant.id === 'source-free-credentials') {
      // This row forbids a *state* rather than an input: a Source-free declaration for which
      // an implementation nonetheless resolved a Source. There is no input that makes this
      // Runtime enter it — the Source-free arm returns before any table is consulted — so
      // what is asserted is that it does not, with the same table the row names.
      const resolved = resolveInvocationSource(row.toolContractId, spec, row.args, row.sourceRecordId,
        { [invariant.work]: { type: invariant.resolvedSourceType } })
      assert.equal(resolved.source, undefined,
        `${invariant.id}: a Source was resolved for a Source-free declaration`)
      refusals += 1
      continue
    }
    assert.throws(run, new RegExp(invariant.refusal),
      `${invariant.id}: not refused under the committed name ${invariant.refusal}`)
    refusals += 1
  }
  assert.ok(refusals >= 6, `only ${refusals} committed refusal(s) were exercised`)
})

test('RT-WK-LINK-6 a committed dispatch runs end to end once its grant is rebound to this instance', async () => {
  // The rebinding is the whole caveat, so it is done explicitly and narrowly: the committed
  // grant, with `workerId` replaced by the running instance and re-signed with this
  // Connection's key. Everything else is the committed value, and the arm asserts that —
  // including `requestDigest`, which is what would hide a drift if the row were rebuilt
  // rather than reused.
  const link = LINKS.find((entry) => ROWS.get(entry.work).sourceRecordId !== '')
  const committed = ROWS.get(link.work)
  // The fixture's Tool pin is a placeholder; the local install has a real one, so the row's
  // pin and the grant's `adapterDigest` move together to the local Tool being run.
  const localPin = toolDigest({ adapter: 'run', sourceTypes: ['file'], entry: 'ship-adapter.mjs' })
  const rebound = {
    ...committed,
    connectionId: 'conn-p2',
    sourceRecordId: 'orders',
    toolContractId: 'acme.ship@1',
    toolDigest: localPin,
    args: committed.args.replace('"docs-a"', '"orders"'),
    toolSpec: committed.toolSpec.replace('rulith.workspace.read_text@1', 'acme.ship@1'),
  }
  const vector = requestVectorOf(rebound)
  let polls = 0
  let signedGrant
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      if (++polls !== 1) return HOLD
      signedGrant = {
        ...link.grant,
        connectionId: 'conn-p2',
        sourceRecordId: 'orders',
        toolContractId: 'acme.ship@1',
        workerId: operation.workerId,
        adapterDigest: `sha256:${localPin}`,
        requestDigest: executionDigest(vector),
      }
      return { body: { accepted: true, payload: { work: [{ ...rebound, executionGrant: signGrant(signedGrant, CONNECTION_KEY) }] } } }
    },
    done: (seen, output) => DONE.action.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('ship'), 1, 'the rebound committed dispatch did not execute')
  assert.equal(run.of('ClaimWork').length, 1)
  // What was rebound, and what was not. The version, board, invocation, action name,
  // generation and lease binding are all still the committed ones.
  for (const field of ['version', 'boardId', 'invocationId', 'actionId', 'workerGeneration']) {
    assert.deepEqual(signedGrant[field], link.grant[field], `${field} was quietly rebound too`)
  }
  assert.notEqual(signedGrant.workerId, link.grant.workerId, 'the arm claims to rebind the instance and did not')
})

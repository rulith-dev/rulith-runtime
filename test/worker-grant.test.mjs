// SPDX-License-Identifier: Apache-2.0
/**
 * The execution grant, as it actually arrives.
 *
 * The check this replaces was dead on the real wire. The Gateway sends `executionGrant` as a
 * signed **string**; the Worker read a structured `w.grant` that no Gateway has ever sent,
 * and its first line was `if (grant === undefined) return undefined` — pass. So every
 * comparison below it (instance, generation, request digest) was unreachable in production
 * while the tests around it were green, which is the worst shape a guard can have: it reads
 * like protection and is an open door.
 *
 * The token format is not invented here. `gateway/src/execution-grant.ts` signs
 * `base64url(JSON.stringify(grant)) . base64url(HMAC-SHA256(connectionKey, payload))` with the
 * Connection key the Worker already holds, and there is no second production format. The
 * payload's *shape* is the committed contract's `ExecutionGrant`, read out of the vendored
 * bundle rather than retyped.
 *
 * One consequence is deliberate and is asserted rather than hidden: the Gateway currently
 * signed a **v1** document carrying `caseId` and no `workerGeneration`. The candidate Gateway
 * signs v2 now, so that shape is history — and it is kept as a counter-example rather than
 * deleted, because "the retired shape is refused" stops being true the moment nobody checks.
 * Accepting it would mean executing under a licence that cannot say which fencing generation
 * it was issued to, which is the whole question a fence exists to answer.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadWorkerContract } from '../scripts/verify-worker-contract.mjs'
import { grantMismatch, readExecutionGrant } from '../worker/rulith-worker.mjs'
import {
  CONNECTION, CONNECTION_KEY, HOLD, actionRow, driveWorker, grantFor, signGrant,
} from './support/worker-harness.mjs'

const CONTRACT = loadWorkerContract()
const FIXTURE = CONTRACT.fixture
const GRANT = FIXTURE.grant
const HELD = { workerId: GRANT.workerId, workerGeneration: GRANT.workerGeneration }
/** What the Worker independently knows about the row this grant should cover. */
const EXPECTED = {
  connectionId: GRANT.connectionId,
  boardId: GRANT.boardId,
  invocationId: GRANT.invocationId,
  actionId: GRANT.actionId,
  toolContractId: GRANT.toolContractId,
  sourceRecordId: GRANT.sourceRecordId,
  adapterDigest: GRANT.adapterDigest,
  requestDigest: GRANT.requestDigest,
}
const KEY = 'connection-key-for-these-arms'

test('a signed grant for another Adapter pin cannot authorize the local Tool', async () => {
  let polls = 0
  const run = await driveWorker({
    reply: operation => {
      if (operation.kind !== 'Poll') return { body: { accepted: true } }
      if (++polls !== 1) return HOLD
      const row = actionRow()
      row.executionGrant = signGrant(grantFor(row, {
        workerId: operation.workerId,
        adapterDigest: `sha256:${'0'.repeat(64)}`,
      }))
      return { body: { accepted: true, payload: { work: [row] } } }
    },
    done: (seen, output) => /Not claiming|\| receipt (?:not )?committed/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('ship'), 0, 'a different signed Adapter pin still executed the local Tool')
  assert.equal(run.of('ClaimWork').length, 0, 'pin mismatch must be detected before dispatch')
})

test('RT-WK-GRANT-1 the committed grant, signed the way the Gateway signs it, reads and matches', () => {
  const { grant, fault } = readExecutionGrant(signGrant(GRANT, KEY), KEY)
  assert.equal(fault, undefined, `the contract's own grant was refused: ${fault}`)
  assert.deepEqual(grant, GRANT, 'the decoded grant is not the document that was signed')
  assert.equal(grantMismatch(grant, EXPECTED, HELD), undefined, 'the contract\'s own grant was not matched')
})

for (const [label, token, expected] of [
  ['nothing at all', undefined, /carries no execution grant/],
  ['an empty string', '', /carries no execution grant/],
  ['a structured object rather than a token', { version: 2 }, /carries no execution grant/],
  ['one part', 'onlypayload', /not a signed token of payload\.signature/],
  ['three parts', `${signGrant(GRANT, KEY)}.extra`, /not a signed token of payload\.signature/],
  ['an empty signature', `${signGrant(GRANT, KEY).split('.')[0]}.`, /not a signed token of payload\.signature/],
]) {
  test(`RT-WK-GRANT-2 a grant that is ${label} is refused`, () => {
    const { grant, fault } = readExecutionGrant(token, KEY)
    assert.equal(grant, undefined)
    assert.match(fault, expected)
    // And the refusal is total: nothing downstream may treat "unreadable" as "absent and fine".
    assert.match(grantMismatch(grant, EXPECTED, HELD), /no readable grant/)
  })
}

test('RT-WK-GRANT-3 a signature that does not verify under this Connection key is refused', () => {
  const signed = signGrant(GRANT, KEY)
  const [payload, signature] = signed.split('.')
  // Another key's signature over the same payload.
  assert.match(readExecutionGrant(signGrant(GRANT, 'some-other-key'), KEY).fault, /signature does not verify/)
  // The right signature over a payload someone edited afterwards.
  const edited = Buffer.from(JSON.stringify({ ...GRANT, workerGeneration: 8 })).toString('base64url')
  assert.match(readExecutionGrant(`${edited}.${signature}`, KEY).fault, /signature does not verify/)
  // A truncated signature is a length mismatch, not a timing-unsafe comparison.
  assert.match(readExecutionGrant(`${payload}.${signature.slice(0, -4)}`, KEY).fault, /signature does not verify/)
  // No Connection key means no verdict at all, rather than a pass.
  assert.match(readExecutionGrant(signed, '').fault, /no Connection key/)
})

test('RT-WK-GRANT-4 the retired v1 grant is refused, by name', () => {
  // The shape `execution-grant.ts` signed before the v2 cutover: version 1, a `caseId`, and
  // no `workerGeneration`. The candidate Gateway signs v2 now, so this is a retired shape
  // rather than a live gap — kept because a correctly signed token of the old shape is
  // exactly what a stale deployment would present, and a licence that cannot state which
  // fencing generation it was issued to cannot be checked against the lease this process
  // holds.
  const legacy = {
    version: 1,
    boardId: GRANT.boardId,
    caseId: 'case-1',
    invocationId: GRANT.invocationId,
    actionId: GRANT.actionId,
    toolContractId: GRANT.toolContractId,
    sourceRecordId: GRANT.sourceRecordId,
    connectionId: GRANT.connectionId,
    workerId: GRANT.workerId,
    adapterDigest: GRANT.adapterDigest,
    requestDigest: GRANT.requestDigest,
  }
  const { grant, fault } = readExecutionGrant(signGrant(legacy, KEY), KEY)
  assert.equal(grant, undefined)
  // The retired Case field is named first: it is the one that says which side has not moved.
  assert.match(fault, /carries caseId, which the contract does not define/)

  // And with the Case field removed it is still refused, now for the version and the missing
  // generation — so nobody can read the first refusal as "just drop caseId".
  const { fault: versionFault } = readExecutionGrant(signGrant({ ...legacy, caseId: undefined }, KEY), KEY)
  assert.match(versionFault, /field version is 1 and this Worker executes under 2/)
  const { fault: generationFault } = readExecutionGrant(signGrant({ ...legacy, caseId: undefined, version: 2 }, KEY), KEY)
  assert.match(generationFault, /field workerGeneration is undefined, which is not a fencing generation/)
})

test('RT-WK-GRANT-5 every invalid grant the contract carries is refused here too', () => {
  const boundary = FIXTURE.boundaries.find((entry) => entry.id === 'grant')
  assert.ok(boundary.invalid.length >= 3)
  for (const example of boundary.invalid) {
    const { grant, fault } = readExecutionGrant(signGrant(example.value, KEY), KEY)
    assert.equal(grant, undefined, `"${example.fault}" was accepted`)
    assert.ok(typeof fault === 'string' && fault !== '', `"${example.fault}" was refused without saying why`)
  }
  for (const example of boundary.valid) {
    assert.equal(readExecutionGrant(signGrant(example, KEY), KEY).fault, undefined,
      `a grant the contract calls valid was refused: ${JSON.stringify(example).slice(0, 200)}`)
  }
})

test('RT-WK-GRANT-6 a valid signature over somebody else\'s document is still somebody else\'s', () => {
  // Every field the grant carries is compared against something this Worker knows
  // independently. A signature says the Gateway wrote it; it does not say the Gateway wrote
  // it for this process, this line, this invocation and these bytes.
  const read = (overrides) => readExecutionGrant(signGrant({ ...GRANT, ...overrides }, KEY), KEY).grant
  const other = 'sha256:'.concat('0'.repeat(64))
  assert.match(grantMismatch(read({ workerId: 'wkr_someone_else_0000' }), EXPECTED, HELD), /names instance/)
  assert.match(grantMismatch(read({ workerGeneration: 6 }), EXPECTED, HELD), /a fenced generation does not execute/)
  assert.match(grantMismatch(read({ connectionId: 'conn-other' }), EXPECTED, HELD), /is for Connection/)
  assert.match(grantMismatch(read({ boardId: 'board-other' }), EXPECTED, HELD), /is for Board/)
  assert.match(grantMismatch(read({ invocationId: 'inv_other' }), EXPECTED, HELD), /is for invocation/)
  assert.match(grantMismatch(read({ actionId: 'other_action' }), EXPECTED, HELD), /is for action/)
  assert.match(grantMismatch(read({ toolContractId: 'other/v1' }), EXPECTED, HELD), /is for Tool contract/)
  assert.match(grantMismatch(read({ sourceRecordId: 'other-source' }), EXPECTED, HELD), /is for Source record/)
  assert.match(grantMismatch(read({ adapterDigest: other }), EXPECTED, HELD), /covers Adapter pin/)
  assert.match(grantMismatch(read({ requestDigest: other }), EXPECTED, HELD), /covers request/)
  // Holding no lease is not a reason to skip the comparison.
  assert.match(grantMismatch(read({}), EXPECTED, undefined), /holds no confirmed lease/)
  // Calibration: with none of those changed, it matches.
  assert.equal(grantMismatch(read({}), EXPECTED, HELD), undefined)
})

test('RT-WK-GRANT-6b a zero value in a grant is a value, and each one is judged as itself', () => {
  // `sourceRecordId` is the one field the contract lets be empty, and the empty value is a
  // *meaning*: this dispatch is Source-free. Every other string field is required non-empty,
  // so an empty one is a malformed licence rather than "unset". Reading emptiness as absence
  // anywhere here would make a Source-free grant and a grant missing its Source record the
  // same document.
  const read = (overrides) => readExecutionGrant(signGrant({ ...GRANT, ...overrides }, KEY), KEY)
  assert.equal(read({ sourceRecordId: '' }).fault, undefined,
    'an empty sourceRecordId is the Source-free declaration, not a missing field')
  for (const field of ['boardId', 'invocationId', 'actionId', 'toolContractId', 'connectionId']) {
    assert.match(read({ [field]: '' }).fault, new RegExp(`field ${field} is missing or empty`),
      `an empty ${field} was read as a value`)
  }
  assert.match(read({ adapterDigest: '' }).fault, /field adapterDigest is not a sha256 digest/)
  assert.match(read({ requestDigest: '' }).fault, /field requestDigest is not a sha256 digest/)
  assert.match(read({ workerGeneration: 0 }).fault, /field workerGeneration is 0, which is not a fencing generation/)
  assert.match(read({ workerId: '' }).fault, /field workerId is not a Worker instance id/)
  // And a Source-free grant must still be matched against a Source-free row: an empty record
  // on one side and a named record on the other is a mismatch, not a wildcard.
  const free = read({ sourceRecordId: '' }).grant
  assert.match(grantMismatch(free, EXPECTED, HELD), /is for Source record ""/)
  assert.equal(grantMismatch(free, { ...EXPECTED, sourceRecordId: '' }, HELD), undefined)
})

test('RT-WK-GRANT-7 a grant covering other bytes stops the work before the claim', async () => {
  // End to end, against the real Worker. The grant is signed for the row as dispatched and
  // then the row's `target` is changed — a field the request vector digests and the local
  // argument validator has no opinion about, so the only thing standing between the changed
  // bytes and the executor is the grant. Nothing is claimed and nothing runs: the claim is a
  // dispatch recorded on the Board, so it happens after the licence is matched, not before.
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      if (++polls !== 1) return HOLD
      const row = actionRow()
      const signed = signGrant(grantFor(row, { workerId: operation.workerId }))
      return { body: { accepted: true, payload: { work: [{ ...row, target: 'leaf-9', executionGrant: signed }] } } }
    },
    done: (seen, output) => /Not claiming/.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('ship'), 0, 'the executor ran under a grant for other bytes')
  assert.equal(run.of('ClaimWork').length, 0, 'a dispatch was recorded for an execution whose grant did not cover it')
  assert.match(run.output, /covers request .* and the bytes served with this work item digest to/)
  assert.match(run.output, /Nothing external has changed and no dispatch was recorded/)
})

test('RT-WK-GRANT-8 a work item with no verifiable grant is not acted on at all', async () => {
  for (const [label, executionGrant, expected, stops] of [
    ['an opaque placeholder', 'grant_p2', /not a signed token/, /Not claiming/],
    ['a token signed with another key', signGrant(grantFor(actionRow(), { workerId: 'wkr_placeholder_0000' }), 'not-the-connection-key'), /signature does not verify/, /Not claiming/],
    // A grant that is absent, or present and empty, never reaches the token reader: the row
    // shape requires a non-empty `executionGrant`, so the row is refused a step earlier. That
    // is the stronger refusal, and naming it here keeps the two apart.
    ['no grant at all', undefined, /states no executionGrant/, /Skipping/],
    ['an empty grant', '', /states an empty executionGrant/, /Skipping/],
  ]) {
    let polls = 0
    const run = await driveWorker({
      reply: (operation) => {
        if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
        return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow({ executionGrant })] } } } : HOLD
      },
      done: (seen, output) => stops.test(output),
      timeoutMs: 20_000,
    })
    assert.equal(run.timedOut, false, `${label}: ${run.output}`)
    assert.equal(run.ran('ship'), 0, `${label}: the executor ran`)
    assert.equal(run.of('ClaimWork').length, 0, `${label}: a dispatch was recorded`)
    assert.match(run.output, expected, `${label}: refused for the wrong reason`)
  }
})

test('RT-WK-GRANT-8b a grant naming another Connection is refused on the real wire', async () => {
  // Signed correctly, for this instance, over these bytes — and issued to another Connection.
  // The Connection this process authenticated as is the only authority for whose line this
  // is; a token that says otherwise is a document about somebody else's line.
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      if (++polls !== 1) return HOLD
      const row = actionRow()
      const grant = { ...grantFor(row, { workerId: operation.workerId }), connectionId: 'conn-somebody-else' }
      return { body: { accepted: true, payload: { work: [{ ...row, executionGrant: signGrant(grant) }] } } }
    },
    done: (seen, output) => /Not claiming/.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('ship'), 0, 'the executor ran under a grant issued to another Connection')
  assert.equal(run.of('ClaimWork').length, 0, 'a dispatch was recorded under another Connection\'s grant')
  assert.match(run.output, /is for Connection conn-somebody-else and this Worker serves conn-p2/)
})

test('RT-WK-GRANT-8c a grant covering another Adapter pin does not authorize the local Tool', async () => {
  // The pin the Connection lock holds is part of what the licence covers. A grant whose
  // `adapterDigest` names a different build is a licence for a different implementation, and
  // the row's own `toolDigest` agreeing with the local install is not a substitute: the two
  // are different claims by different parties, and both have to hold.
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      if (++polls !== 1) return HOLD
      const row = actionRow()
      const grant = { ...grantFor(row, { workerId: operation.workerId }), adapterDigest: `sha256:${'0'.repeat(64)}` }
      return { body: { accepted: true, payload: { work: [{ ...row, executionGrant: signGrant(grant) }] } } }
    },
    done: (seen, output) => /Not claiming/.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('ship'), 0, 'the executor ran under a grant for another Adapter pin')
  assert.equal(run.of('ClaimWork').length, 0)
  assert.match(run.output, /covers Adapter pin sha256:0{64} and the selected local Tool is pinned/)
})

test('RT-WK-GRANT-9 a conforming grant does let the work through (calibration)', async () => {
  // Without this arm, a Worker that refused every grant would satisfy all of the above.
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      return { body: { accepted: true, revision: 'b12' } }
    },
    done: (seen, output) => /receipt committed/.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('ship'), 1)
  const [claim] = run.of('ClaimWork')
  assert.equal(claim.operation.id, 'inv_p2')
  // The grant travelled unchanged: the Worker forwards the authority's own token rather than
  // re-emitting a document of its own.
  const [poll] = run.of('Poll')
  assert.ok(poll, 'no poll was recorded')
  assert.equal(typeof claim.operation.executionGrant, 'string')
  assert.equal(claim.operation.executionGrant.split('.').length, 2)
  assert.equal(CONNECTION, 'conn-p2')
  assert.equal(CONNECTION_KEY, 'key-p2')
})

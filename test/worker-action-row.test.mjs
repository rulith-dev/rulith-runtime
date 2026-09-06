// SPDX-License-Identifier: Apache-2.0
/**
 * The action work row: one name per thing, and a Source the invocation chose.
 *
 * Two shapes are retired here, and both were retired for the same reason — a value under two
 * names is a value two readers can disagree about while each believes it read the row.
 *
 *   · `invocationId` beside `work`, `actionId` beside `tool`, and a structured `grant` beside
 *     the signed `executionGrant`. The row states `work` and `tool`; the request vector is
 *     built from those and from nothing else. The old fallback (`invocationId ?? work`) meant
 *     a row could digest one way here and another way at the signer.
 *   · `toolSpec.source`, the Source *instance* a Tool package pinned into its own
 *     declaration. It made the governed Source record a decoration: what actually ran was
 *     chosen when the package was written rather than when the Action was governed. The
 *     declaration now states which Source *types* it accepts, and the invocation names the
 *     instance in its own `source` argument.
 *
 * The Source rules have three separate names because they are three separate mistakes, and
 * an operator meeting one of them should not be sent to look at another:
 * `source_free_has_source`, `source_selection_required`, `source_type_mismatch`.
 *
 * These arms drive the real Worker binary. The row shape is the committed
 * `WorkerActionWorkItem`, vendored here and projected into the Worker; the committed rows,
 * links and Source invariants are driven directly in `worker-action-links.test.mjs`, and what
 * this file adds is the behaviour of a live process against them.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DONE, HOLD, actionRow, driveWorker, grantFor, signGrant, sourceFreeActionRow, toolDigest,
} from './support/worker-harness.mjs'
import { requestVectorOf, resolveInvocationSource } from '../worker/rulith-worker.mjs'

/** The row's own spelling, and nothing else, reaches the vector. */
test('RT-WK-ROW-1 the request vector is built from work and tool alone', () => {
  const row = actionRow()
  const vector = requestVectorOf(row)
  assert.equal(vector.invocationId, row.work)
  assert.equal(vector.actionId, row.tool)
  // A row that also carried the retired spellings must not be able to change the vector:
  // whatever is in `invocationId` / `actionId` is ignored here and refused at the door.
  const shadowed = { ...row, invocationId: 'inv_other', actionId: 'other_action' }
  assert.deepEqual(requestVectorOf(shadowed), vector,
    'a shadow spelling changed the digested request, which is how a row and its grant come to disagree')
  // And a row missing `work` is told what it is missing in the name the row uses.
  assert.throws(() => requestVectorOf({ ...row, work: undefined }), /states no work\b/)
  assert.throws(() => requestVectorOf({ ...row, tool: undefined }), /states no tool\b/)
})

for (const [label, shadow] of [
  ['invocationId beside work', { invocationId: 'inv_p2' }],
  ['actionId beside tool', { actionId: 'acme.ship' }],
  ['a structured grant beside the signed token', { grant: { version: 2 } }],
]) {
  test(`RT-WK-ROW-2 a row carrying ${label} is refused before the hand moves`, async () => {
    let polls = 0
    const run = await driveWorker({
      reply: (operation) => {
        if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
        return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow(shadow)] } } } : HOLD
      },
      done: (seen, output) => /beside the field that already says it/.test(output),
      timeoutMs: 15_000,
    })
    assert.equal(run.timedOut, false, `${label} was never refused:\n${run.output}`)
    assert.equal(run.ran('ship'), 0, `${label}: the executor ran anyway`)
    assert.equal(run.of('ClaimWork').length, 0, `${label}: a dispatch was recorded`)
    assert.match(run.output, /the invocation is `work`, the Action is `tool`/)
  })
}

// ── Source selection ─────────────────────────────────────────────────────────

const SPEC = { impl: 'worker-tool', exec: 'acme.thing@1', kind: 'read', params: {}, sourceTypes: ['file'] }
const FREE = { ...SPEC, sourceTypes: [] }
const SOURCES = { docs: { type: 'file', access: '.' }, ledger: { type: 'db', dsn: 'postgres://x/y' } }
const resolve = (spec, args, record) =>
  resolveInvocationSource('acme.thing@1', spec, args, record, SOURCES)

test('RT-WK-SRC-1 the invocation names the Source, and it must be the record it was dispatched against', () => {
  // The selection is read out of the invocation's own arguments and checked against the row.
  assert.deepEqual(resolve(SPEC, '{"path":"a.txt","source":"docs"}', 'docs'),
    { source: 'docs', args: { path: 'a.txt' } })
  // The selector is structural: it is stripped from what the Adapter sees, because it says
  // *which* Source rather than being a business parameter the declaration lists.
  assert.equal('source' in resolve(SPEC, '{"path":"a.txt","source":"docs"}', 'docs').args, false)
})

for (const [id, spec, args, record, expected] of [
  ['source-free-record', FREE, '{}', 'docs', /source_free_has_source/],
  ['source-free-argument', FREE, '{"source":"docs"}', '', /source_free_has_source/],
  ['sourced-missing-selector', SPEC, '{"path":"a.txt"}', 'docs', /source_selection_required/],
  ['sourced-other-selector', SPEC, '{"source":"ledger","path":"a.txt"}', 'docs', /source_selection_required/],
  ['sourced-missing-record', SPEC, '{"source":"docs","path":"a.txt"}', '', /source_selection_required/],
  ['sourced-unauthorized-record', SPEC, '{"source":"absent","path":"a.txt"}', 'absent', /source_type_mismatch/],
  ['sourced-wrong-type', SPEC, '{"source":"ledger","path":"a.txt"}', 'ledger', /source_type_mismatch/],
]) {
  test(`RT-WK-SRC-2 ${id} is refused by its own name`, () => {
    assert.throws(() => resolve(spec, args, record), expected)
  })
}

test('RT-WK-SRC-3 a Source-free declaration resolves no Source at all', () => {
  const resolved = resolve(FREE, '{"value":7}', '')
  assert.deepEqual(resolved, { source: undefined, args: { value: 7 } },
    'a Source-free Tool was given a Source, which is a credential it was never granted')
})

test('RT-WK-SRC-4 a Source-free Tool runs as pure local compute, with no Source in its environment', async () => {
  // The authorization it already has is the Tool lock on this Connection; that is enough for
  // a local computation and it buys nothing else. What must not appear is a Source: no
  // access root, no type, and no `source` argument smuggled through to the Adapter.
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') {
        return ++polls === 1
          ? { body: { accepted: true, payload: { work: [sourceFreeActionRow({
              args: '{"value":7}',
              toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.compute@1', kind: 'read', params: { value: 'number' }, sourceTypes: [] }),
            })] } } }
          : HOLD
      }
      return { body: { accepted: true, revision: 'b12' } }
    },
    done: (seen, output) => DONE.action.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('compute'), 1, 'the Source-free Tool never ran')
  const [report] = run.of('ReportWork')
  assert.ok(report, `no receipt was filed:\n${run.output}`)
  const seen = JSON.parse(String(report.operation.result))
  assert.equal(seen.sourceAccess, null, 'a Source access root was manufactured for a Source-free Tool')
  assert.equal(seen.sourceType, null, 'a Source type was manufactured for a Source-free Tool')
  assert.deepEqual(JSON.parse(seen.args), { value: 7 })
})

test('RT-WK-SRC-4b a Source-free database dispatch is refused before the claim, on a host that has a DSN', async () => {
  // The Source-free arm above uses a `run` Adapter, which genuinely needs nothing. A database
  // Adapter is the opposite: it cannot run without a connection string, and the host has one
  // sitting in its environment. Before the fallback was removed this dispatch reached the
  // host's database under a declaration that said it touched no Source at all.
  //
  // Refused while the Tool is compiled, which is before the claim: a dispatch recorded on the
  // Board for an execution that was never possible is the one outcome that cannot be undone.
  let polls = 0
  const run = await driveWorker({
    env: { RULITH_DB_URL: 'postgres://ambient-host/ambient-db', DEMO_DB_URL: 'postgres://ambient-host/ambient-db' },
    extraTools: { 'acme.freequery@1': { adapter: 'db-query', sourceTypes: [], entry: 'SELECT status FROM orders WHERE id={order_id}' } },
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      return ++polls === 1
        ? { body: { accepted: true, payload: { work: [sourceFreeActionRow({
            work: 'inv_free_db', tool: 'acme.freequery', toolContractId: 'acme.freequery@1',
            toolDigest: toolDigest({ adapter: 'db-query', sourceTypes: [], entry: 'SELECT status FROM orders WHERE id={order_id}' }),
            args: '{"order_id":7}',
            toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.freequery@1', kind: 'read', params: { order_id: 'number' }, sourceTypes: [] }),
          })] } } }
        : HOLD
    },
    done: (seen, output) => /needs a located Source/.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').length, 0, 'a Source-free database dispatch was claimed')
  assert.equal(run.of('ReportWork').length, 0, 'a Source-free database dispatch produced a receipt')
  assert.match(run.output, /The host environment is not a Source/)
})

test('RT-WK-SRC-5 reading the selector never rewrites the bytes the grant covers', async () => {
  // `args` is one of the three strings the request digest is taken over, and the Gateway
  // signs it exactly as Core served it — leading space and all. The Worker parses it to find
  // the Source and hands the Adapter the rest; if it re-serialized on the way, the digest
  // would cover this Worker's JSON writer and the grant would stop matching.
  const spaced = ' {"path":"note.txt", "source":"orders"} '
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      if (++polls !== 1) return HOLD
      const row = actionRow({ args: spaced, toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.ship@1', kind: 'act', params: { path: 'string' }, sourceTypes: ['file'] }) })
      return { body: { accepted: true, payload: { work: [{ ...row, executionGrant: signGrant(grantFor(row, { workerId: operation.workerId })) }] } } }
    },
    done: (seen, output) => DONE.action.test(output),
    timeoutMs: 20_000,
  })
  // The grant was signed over the spaced string; the Worker matched it, which it can only do
  // by digesting the same bytes. If it had normalized them first, nothing would have run.
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('ship'), 1, 'the served bytes were re-serialized before being digested')
  assert.equal(run.of('ClaimWork').length, 1)
})

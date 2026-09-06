// SPDX-License-Identifier: Apache-2.0
/**
 * A tool call is identified by **(Agent, MCP session, JSON-RPC request id)**, and this host
 * holds at most one call whose outcome it does not know.
 *
 * The middle part of that key is the part an earlier version dropped. It kept a table of
 * unresolved submissions keyed by body, so after a session ended it re-sent the same body
 * under the old request id and told the model that this reached "the same identity". Under
 * a different session it is a different transport key, and a write that had already landed
 * could land again. The promise is gone, the table is gone, and what replaces them is one
 * record: calls are serial for the whole Agent, so there is only ever one thing to
 * remember, and remembering the session it was sent under is what lets this host say "this
 * cannot be re-presented" instead of pretending that it can.
 *
 * The arms below are on the wire — which ids the endpoint received, and whether anything
 * was sent at all. A ledger that "looked right" while sending a second call under a new
 * session would satisfy any assertion made on its own internal state.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HOP_FAILURE, callTool, freePort, runAgent } from './support/agent-harness.mjs'

/** Still executing, forever: the authority holds the call and never settles it. */
const stillWaiting = { state: 'waiting', callRef: 'call-1', tool: 'ApplyBatch', retryAfterMs: 120 }

test('RT-ID-1 while one call is unresolved the Agent sends nothing further, turn after turn', async () => {
  // The gate is Agent-wide and it does not reopen because a new user message arrived. Two
  // messages, one unresolved write, and exactly one call on the wire.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '4', RULITH_RECOVERY_WAIT_MS: '700' },
    chatLines: ['Record a fact.', 'Try again please.'],
    tool: (name) => (name === 'ApplyBatch' ? HOP_FAILURE : undefined),
    recovery: ({ pings }) => (pings === 0 ? { state: 'none' } : stillWaiting),
    model: (round) => (round === 1
      ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      : 'I will wait.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const sent = run.requests.filter((request) => request.method === 'tools/call')
  assert.equal(sent.length, 1, `a second call went out while the first was unresolved: ${run.verbs.join(', ')}`)
  assert.equal(run.modelRequests.length, 1,
    'the model was asked again while a call of its own was unresolved')
  // The second user message is answered honestly rather than by starting work.
  assert.match(run.stdout, /still executing at the authority/)
})

test('RT-ID-2 an answered call leaves nothing held, and the next call is a new identity', async () => {
  // Without this arm, a client that refused every second call would satisfy the one above.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '10' },
    chatLines: ['Write repeatedly.'],
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round <= 8) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: `F${round}`, predicate: 'x', args: {} }] })
      return 'Recorded.'
    },
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const sent = run.toolCalls.filter((call) => call.name === 'ApplyBatch')
  assert.ok(sent.length >= 7, `only ${sent.length} writes were carried`)
  assert.equal(new Set(sent.map((call) => call.id)).size, sent.length,
    'two different submissions shared one request identity')
  assert.doesNotMatch(run.stdout, /unresolved|call_gate_open/)
})

test('RT-ID-3 the one unresolved call is persisted, adopted at the next startup, and never re-sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-pending-'))
  const store = join(dir, 'agent-sessions.json')
  // The store is keyed on the endpoint, so both runs must address the same one.
  const listenPort = await freePort()
  try {
    const first = await runAgent({
      argv: [], sessionFile: store, listenPort, env: { RULITH_MAX_ROUNDS: '4', RULITH_RECOVERY_WAIT_MS: '500' },
      chatLines: ['Write through a broken upstream.'],
      tool: (name) => (name === 'ApplyBatch' ? HOP_FAILURE : undefined),
      recovery: ({ pings }) => (pings === 0 ? { state: 'none' } : stillWaiting),
      model: (round) => {
        if (round === 1) return callTool('OpenCase', {})
        if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
        return 'The outcome is unknown.'
      },
      timeoutMs: 25_000,
    })
    assert.notEqual(first.code, 'timeout', `${first.stdout}\n${first.stderr}`)
    const attempted = first.toolCalls.find((call) => call.name === 'ApplyBatch')
    assert.ok(attempted, 'the write never reached the endpoint, so nothing was left unresolved')

    assert.ok(existsSync(store))
    const record = JSON.parse(readFileSync(store, 'utf8'))
    const endpoint = Object.values(record.endpoints)[0]
    assert.equal(endpoint.unresolved.requestId, attempted.id,
      'the persisted identity is not the one that went on the wire')
    assert.equal(endpoint.unresolved.tool, 'ApplyBatch')
    assert.equal(endpoint.unresolved.sessionId, attempted.sessionId,
      'the session it was sent under is part of its identity and must be recorded with it')
    // One record, not a list: calls are serial, so there is one thing to remember.
    assert.equal(Array.isArray(endpoint.unresolved), false)

    // The next run adopts it rather than starting from zero, and does not act on it. The
    // authority reports nothing outstanding, so the two disagree — and disagreement stops
    // the work instead of being resolved by guessing.
    const second = await runAgent({
      argv: [], sessionFile: store, listenPort, chatLines: ['hello'],
      env: { RULITH_RECOVERY_WAIT_MS: '500' },
      model: () => 'Hello.', timeoutMs: 25_000,
    })
    assert.notEqual(second.code, 'timeout', `${second.stdout}\n${second.stderr}`)
    assert.match(second.stderr, /A ApplyBatch call from a previous run of this Agent has an unknown outcome/)
    assert.match(second.stderr, new RegExp(`request ${attempted.id}`))
    assert.match(second.stderr, /re-sending it would be a second logical call/)
    assert.match(second.stdout, /does not prove the command had no effect/)
    // Nothing was dispatched, and the model was never asked to decide anything.
    assert.deepEqual(second.verbs, [], `an inherited unresolved call was acted on: ${second.verbs.join(', ')}`)
    assert.equal(second.modelRequests.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('RT-ID-4 with the durable store off, the runtime says so instead of implying safe replay', async () => {
  const run = await runAgent({
    argv: [], sessionFile: 'off', chatLines: ['hello'], model: () => 'Hello.', timeoutMs: 20_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /The durable session store is off/)
  assert.match(run.stdout, /an interrupted write must be resolved in Console rather than retried here/)
})

test('RT-ID-5 the store is written atomically, so a reader never sees half a record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-atomic-'))
  const store = join(dir, 'agent-sessions.json')
  try {
    const run = await runAgent({
      argv: [], sessionFile: store, env: { RULITH_MAX_ROUNDS: '4', RULITH_RECOVERY_WAIT_MS: '500' },
      chatLines: ['Write once through a broken upstream.'],
      tool: (name) => (name === 'ApplyBatch' ? HOP_FAILURE : undefined),
      recovery: ({ pings }) => (pings === 0 ? { state: 'none' } : stillWaiting),
      model: (round) => {
        if (round === 1) return callTool('OpenCase', {})
        if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
        return 'Unknown.'
      },
      timeoutMs: 25_000,
    })
    assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
    // A truncated store reads back as "this endpoint has nothing outstanding", which is
    // exactly the state that turns an unknown outcome into a clean slate. Write-then-rename
    // means the reader sees either the old file or the new one, and no temporary is left.
    assert.doesNotThrow(() => JSON.parse(readFileSync(store, 'utf8')))
    assert.ok(readFileSync(store, 'utf8').length > 0)
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [],
      'a temporary store file survived the write')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

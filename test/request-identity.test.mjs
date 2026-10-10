// SPDX-License-Identifier: Apache-2.0
/**
 * A tool call is identified by **(Agent, MCP session, JSON-RPC request id)**, and this host
 * re-presents none of them.
 *
 * The middle part of that key is the part an earlier version dropped. It kept a table of
 * unresolved submissions keyed by body, so after a session ended it re-sent the same body
 * under the old request id and told the model that this reached "the same identity". Under
 * a different session it is a different transport key, and a write that had already landed
 * could land again. The promise is gone, the table is gone, and so is the one record Runtime
 * 0.9 kept in its place: the authority holds every call until its outcome and shows it on the
 * recent-operations strip, and its write gate keeps a second write from running before the
 * first outcome has been shown.
 *
 * The arms below are on the wire — which ids the endpoint received, and whether anything
 * was sent at all.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TEST_TOKEN, callTool, declareGoal, freePort, runAgent } from './support/agent-harness.mjs'

const running = [{ tool: 'ApplyBatch', label: 'ApplyBatch', state: 'running', stage: 'not_dispatched' }]

test('RT-ID-1 new user input never makes a second write run while the first is unresolved', async () => {
  // A new message reaches the model as usual. The write it proposes goes to the authority,
  // whose gate does not execute it and says so; the host neither blocks the model nor
  // pretends the write ran.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '4' },
    chatLines: ['Try again please.'],
    priorOperations: running,
    model: (round) => (round === 1
      ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      : 'The earlier batch is still in progress, so I will wait.'),
    timeoutMs: 25_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.operations.length, 1, 'a second write ran while the first was unresolved')
  const refused = JSON.parse(run.modelRequests.at(-1).messages.find((message) => message.role === 'tool').content)
  assert.equal(refused.errorCode, 'operation_running')
  assert.equal(refused.requestExecuted, false)
  assert.equal(refused.operations[0].state, 'running')
  assert.match(run.stdout, /ApplyBatch was not executed \(operation_running\)/)
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
  assert.doesNotMatch(run.stdout, /not executed|No answer arrived/)
})

/** The endpoint key Runtime 0.9 filed its record under: the URL and a fingerprint of the token. */
const endpointKey = (port) => `http://127.0.0.1:${port}#${createHash('sha256').update(TEST_TOKEN, 'utf8').digest('hex').slice(0, 16)}`

test('RT-ID-3 a record Runtime 0.9 left is named once, removed, and never acted on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-legacy-'))
  const store = join(dir, 'agent-sessions.json')
  const listenPort = await freePort()
  try {
    writeFileSync(store, JSON.stringify({ schema: 'rulith-agent-sessions/1', endpoints: {
      [endpointKey(listenPort)]: { unresolved: { requestId: 'req-legacy-1', sessionId: 'mcp-old', tool: 'ApplyBatch', since: 1 } },
      'https://elsewhere.example#0123456789abcdef': { unresolved: { requestId: 'req-other', tool: 'ApplyAction', since: 2 } },
    } }))
    const first = await runAgent({
      argv: [], sessionFile: store, listenPort, chatLines: ['hello'],
      priorOperations: running,
      model: () => 'Hello.', timeoutMs: 25_000,
    })
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`)
    assert.match(first.stderr, /Rulith Runtime 0\.9 recorded an ApplyBatch call from a previous run whose answer it never received \(request req-legacy-1\)/)
    assert.match(first.stderr, /nothing is re-sent/)
    // What the authority shows about it is said beside it, from the strip initialize carried.
    assert.match(first.stderr, /ApplyBatch is still running at the authority/)
    assert.deepEqual(first.verbs, [], 'an inherited record was acted on')
    assert.equal(first.modelRequests.length, 1, 'an ordinary greeting was held back by the old record')
    const after = JSON.parse(readFileSync(store, 'utf8'))
    assert.equal(after.endpoints[endpointKey(listenPort)], undefined, 'the record was not retired')
    assert.equal(after.endpoints['https://elsewhere.example#0123456789abcdef'].unresolved.requestId, 'req-other',
      'a record for another endpoint was touched')

    const second = await runAgent({
      argv: [], sessionFile: store, listenPort, chatLines: ['hello again'], model: () => 'Hello again.', timeoutMs: 25_000,
    })
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`)
    assert.doesNotMatch(second.stderr, /Runtime 0\.9 recorded/, 'the notice repeated after the record was retired')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('RT-ID-4 with the store off, a 0.9 record is not read at all', async () => {
  const run = await runAgent({
    argv: [], sessionFile: 'off', chatLines: ['hello'], model: () => 'Hello.', timeoutMs: 20_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.doesNotMatch(run.stdout + run.stderr, /Runtime 0\.9 recorded|session store/)
})

test('RT-ID-5 nothing is written for a call whose answer was lost, and a retired record leaves no temporary behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-atomic-'))
  const store = join(dir, 'agent-sessions.json')
  const listenPort = await freePort()
  try {
    writeFileSync(store, JSON.stringify({ schema: 'rulith-agent-sessions/1', endpoints: {
      [endpointKey(listenPort)]: { unresolved: { requestId: 'req-legacy-2', tool: 'OpenCase', since: 1 } } } }))
    const run = await runAgent({
      argv: [], sessionFile: store, listenPort, env: { RULITH_MAX_ROUNDS: '4' },
      chatLines: ['Write once through a broken stream.'],
      sseResults: true, breakStreamOnCall: 2, refuseResume: true,
      model: (round) => {
        if (round === 1) return callTool('ApplyBatch', declareGoal())
        if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
        return 'The answer was lost.'
      },
      timeoutMs: 25_000,
    })
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
    assert.match(run.stdout, /No answer arrived for ApplyBatch/)
    // The store now holds nothing for this endpoint: no record of the lost call is kept.
    assert.ok(existsSync(store))
    const record = JSON.parse(readFileSync(store, 'utf8'))
    assert.deepEqual(record, { schema: 'rulith-agent-sessions/1', endpoints: {} })
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [],
      'a temporary store file survived the write')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

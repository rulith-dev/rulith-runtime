// SPDX-License-Identifier: Apache-2.0
/**
 * What this client accepts as an answer, and what it accepts as a surface.
 *
 * Two defects reached the model in the parent's live probe against the real Agent process:
 * a JSON-RPC response carrying a **different id** was consumed as the answer to the
 * handshake, and a **sixth advertised tool** was silently filtered down to five and the run
 * continued. Both are the same failure wearing different clothes — the client deciding on
 * its own what the server must have meant — and both are checked here on the real wire, by
 * spawning the real binary against an endpoint that deviates in exactly one way.
 *
 * Every arm asserts on `modelCalls`: the model is the thing downstream of the handshake, so
 * "did the model get asked anything" is the one observation that cannot be satisfied by a
 * client that logged a complaint and carried on regardless.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { MCP_PROTOCOL_VERSION, MODEL_TOOLS, callTool, runAgent } from './support/agent-harness.mjs'

// ── Protocol baseline: the version is a contract, not a greeting ─────────────

test('RT-PROTO-1 a version this client does not speak stops the run before any business', async () => {
  // The session, streaming, resumption and serial-recovery rules this Runtime depends on
  // are defined by the version it negotiated. An endpoint speaking an earlier one may list
  // tools perfectly well and then differ exactly where it matters — so the refusal is at
  // the handshake, not at the first write that behaves unexpectedly.
  const run = await runAgent({
    argv: ['do the work'], protocolVersion: '2025-06-18',
    model: () => 'The model should never be asked.',
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.notEqual(run.code, 0)
  assert.equal(run.modelRequests.length, 0, 'business began against an endpoint speaking another version')
  assert.deepEqual(run.methods, ['initialize'], `the client went on past the handshake: ${run.methods.join(', ')}`)
  assert.match(run.stderr, /negotiated protocol version "2025-06-18", and this Runtime speaks 2025-11-25/)
  assert.match(run.stderr, /stops here rather than listing tools/)
})

test('RT-PROTO-2 the negotiated version and the declared capability travel on every request (calibration)', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Open a Case.'],
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Opened.'),
    timeoutMs: 20_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.initializes[0].protocolVersion, MCP_PROTOCOL_VERSION)
  assert.deepEqual(run.initializes[0].capabilities?.experimental?.['rulith/v1'], { serialRecovery: 1 })
  for (const request of run.requests) {
    assert.equal(request.protocolHeader, MCP_PROTOCOL_VERSION,
      `a ${request.httpMethod} ${request.method} request carried protocol version ${request.protocolHeader}`)
  }
})

// ── Connection replacement is not session expiry ─────────────────────────────

test('RT-CONN-1 a replaced connection ends the run and does not reconnect', async () => {
  // One Agent has one effective client. When another takes over, the losing host stops —
  // it does not re-initialize, because two hosts that both reconnect on this signal are two
  // clients fighting over one Agent, and the fight reads as flapping rather than as a fault.
  const run = await runAgent({
    argv: ['do the work'], env: { RULITH_MAX_ROUNDS: '4' },
    replaceAfter: 4, // initialize, initialized, tools/list, then the first tools/call
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Nothing further.'),
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 4, `a replaced connection must have its own exit status: ${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /replaced by a newer authenticated client/)
  assert.match(run.stderr, /keeps its identity at the authority and is not cancelled by the replacement/)
  // Nothing after the refusal. An initialize here would be this host taking the Agent back.
  const after = run.requests.slice(4)
  assert.deepEqual(after, [], `the host kept talking after being replaced: ${JSON.stringify(after)}`)
})

test('RT-CONN-2 a 409 that is not connection_replaced is not read as a takeover', async () => {
  // The reason string is load-bearing. A bare `-32000`, or a 409 raised for anything else,
  // must not put this host into the one state it cannot leave on its own.
  const run = await runAgent({
    argv: ['do the work'], env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '600' },
    replaceAfter: 4,
    conflictBody: { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'a different conflict', data: { reason: 'quota_exceeded' } } },
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'The outcome was not known.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.notEqual(run.code, 4, 'an unrelated 409 was read as a connection takeover')
  assert.doesNotMatch(run.stderr, /replaced by a newer authenticated client/)
  assert.match(run.stdout, /Board outcome unknown for OpenCase/,
    'a conflict this client cannot interpret leaves the outcome unknown, which is what it is')
})

test('RT-CONN-3 an expired session is re-established rather than treated as a takeover', async () => {
  // 404 says the transport session is gone, and the base protocol answer is to initialize a
  // new one. What it does not say is whether the call made under the old session executed,
  // so the new session's recovery state is what answers that — never a re-send.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '4', RULITH_RECOVERY_WAIT_MS: '800' },
    chatLines: ['Open a Case.'], captureLocalEvents: true,
    expireSessionAfter: 4, // the first tools/call only
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'I will wait for the outcome.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.notEqual(run.code, 4, 'an expired session was reported as a connection replacement')
  assert.ok(run.initializes.length >= 2, `the client did not establish a new session: ${run.methods.join(', ')}`)
  assert.match(run.stdout, /Board outcome unknown for OpenCase/)
  const verdict = run.localEvents.filter((event) => event.type === 'verdict' && event.cmd === 'OpenCase').at(-1)
  assert.match(verdict.teaching, /session_expired|transport session ended/)
  assert.match(verdict.teaching, /may well have been applied/,
    'a lost session was reported as though the command had certainly not run')
  // The call is not re-sent under the new session: its transport key belonged to the old one.
  // (The 404 is answered before the endpoint records the call, so the count is taken from
  // the request log rather than from the calls the Board saw.)
  const attempts = run.requests.filter((request) => request.method === 'tools/call')
  assert.equal(attempts.length, 1, `the call was re-sent under a new session: ${attempts.length} attempts`)
})

// ── Resumption: the answer comes back, the decision is not made twice ────────

test('RT-RESUME-1 a broken response stream is resumed from its event id, not re-decided', async () => {
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '4' },
    chatLines: ['Open a Case.'],
    sseResults: true, breakStreamOnCall: 1,
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Opened.'),
    timeoutMs: 20_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.toolCalls.length, 1,
    `the call was issued again instead of its answer being recovered: ${run.verbs.join(', ')}`)
  const resumed = run.requests.filter((request) => request.httpMethod === 'GET')
  assert.equal(resumed.length, 1, 'the client did not reopen the stream')
  assert.equal(resumed[0].lastEventId, 'e1', 'the resume carried no cursor, so the server had nothing to replay from')
  assert.match(run.stdout, /Case Context in focus/, 'the recovered answer was not used as the answer')
})

test('RT-RESUME-2 an unrecoverable stream is an unknown outcome, never an empty answer', async () => {
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '600' },
    chatLines: ['Open a Case.'], captureLocalEvents: true,
    sseResults: true, breakStreamOnCall: 1, refuseResume: true,
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'The outcome was not known.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.toolCalls.length, 1, 'an unrecovered answer was answered by asking again')
  const verdict = run.localEvents.filter((event) => event.type === 'verdict' && event.cmd === 'OpenCase').at(-1)
  assert.match(verdict.teaching, /response_not_correlated|never carried a response/)
  assert.match(verdict.teaching, /resuming from the last event id did not recover it/)
  assert.equal(verdict.accepted, false, 'a stream that carried nothing was read as a successful answer')
})

// ── Correlation: an answer is an answer to one request ───────────────────────

for (const [label, corruptResponse, expected] of [
  ['a response under a different JSON-RPC id', 'id', /id "a-different-request" rather than the requested/],
  ['a response tagged jsonrpc 1.0', 'jsonrpc', /jsonrpc="1.0" rather than "2.0"/],
  ['an event stream carrying only somebody else\'s response', 'sse-other', /never carried a response to request id/],
]) {
  test(`RT-RPC-1 ${label} is not accepted as this request's answer`, async () => {
    const run = await runAgent({
      argv: ['hello'], corruptResponse,
      model: () => 'The model should never be asked.',
      timeoutMs: 20_000,
    })
    assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
    assert.notEqual(run.code, 0, 'a mis-addressed answer ended the run successfully')
    assert.equal(run.modelRequests.length, 0,
      `the handshake was accepted from a response that was not its answer, and the model was asked anyway:\n${run.stdout}\n${run.stderr}`)
    assert.match(run.stderr, expected)
    assert.match(run.stderr, /Cannot establish an authenticated MCP session/)
  })
}

test('RT-RPC-2 the same endpoint answering correctly reaches the model (calibration)', async () => {
  // Without this arm, a client that refused every response would satisfy all of RT-RPC-1.
  const run = await runAgent({ argv: ['hello'], model: () => 'Hello.', timeoutMs: 20_000 })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 1, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.methods, ['initialize', 'notifications/initialized', 'tools/list'])
})

// ── SSE framing: Streamable HTTP, read as specified ─────────────────────────

for (const [label, corruptResponse] of [
  ['server messages ahead of the response', 'sse-preamble'],
  ['one event whose data spans several data: lines', 'sse-split'],
  ['a stream held open after the response', 'sse-open'],
]) {
  test(`RT-RPC-3 an SSE answer with ${label} is read correctly`, async () => {
    // All three are conforming server behaviour. Closing the stream after the response is a
    // SHOULD, not a MUST, so a client that waited for EOF would hang against the third; and
    // a client that took the first frame with a `result` would take the wrong one in the
    // first. The timeout is deliberately far below the 45s RPC deadline: a hang shows up
    // here as a timeout rather than as a slow pass.
    const run = await runAgent({
      argv: [], chatLines: ['hello'], corruptResponse,
      model: () => 'Hello.',
      timeoutMs: 20_000,
    })
    assert.notEqual(run.code, 'timeout', `the client did not finish on the matched event:\n${run.stdout}\n${run.stderr}`)
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
    assert.equal(run.modelRequests.length, 1, `${run.stdout}\n${run.stderr}`)
    assert.deepEqual(run.methods, ['initialize', 'notifications/initialized', 'tools/list'])
  })
}

// ── Session identity is not refreshable metadata ─────────────────────────────

test('RT-RPC-4 a write answered under a different session is an unknown outcome, not a refresh', async () => {
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '4', RULITH_RECOVERY_WAIT_MS: '600' },
    chatLines: ['Open a Case.'], captureLocalEvents: true,
    swapSessionOnCall: 1,
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'That did not resolve.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  // The command was sent under one authenticated session and answered under another, so what
  // happened to it is not known. Adopting the new identity and calling it a metadata refresh
  // would have made an unresolved write look settled.
  const verdict = run.localEvents.filter((event) => event.type === 'verdict' && event.cmd === 'OpenCase').at(-1)
  assert.match(verdict.teaching, /response_not_correlated|answered under/)
  assert.match(verdict.teaching, /outcome of this step is unknown/)
  assert.match(run.stdout, /Board outcome unknown for OpenCase/)
  // And no focus was created from an answer this client would not attribute to its session.
  assert.doesNotMatch(run.stdout, /Case Context in focus/)
})

// ── Tool membership is a contract, not a menu ────────────────────────────────

test('RT-SURFACE-1 an extra advertised tool is a refused protocol mismatch, not a silent filter', async () => {
  const run = await runAgent({
    argv: ['hello'],
    extraTools: [{ name: 'UnexpectedTool', description: 'Not in the approved surface', inputSchema: { type: 'object', properties: {} } }],
    model: () => 'The model should never be asked.',
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.notEqual(run.code, 0)
  assert.equal(run.modelRequests.length, 0,
    `an incompatible advertised surface was filtered into a valid one and the run continued:\n${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /advertises a tool surface this Runtime cannot speak/)
  assert.match(run.stderr, /advertises UnexpectedTool, which is not part of the approved six-tool surface/)
  assert.match(run.stderr, /This is a protocol mismatch, not a filtering decision/)
  // The refusal names both sides, so a reader can see which one to move.
  assert.match(run.stderr, new RegExp(`Contract:\\s+${MODEL_TOOLS.join(', ')}`))
  // The refusal names the contract this Runtime was generated from, so a reader can tell
  // which side is behind rather than guessing.
  assert.match(run.stderr, /speaks the public MCP contract at commit [0-9a-f]{40}/)
})

test('RT-SURFACE-2 a retired host tool advertised again names itself in the refusal', async () => {
  // `agent_protocol` and `GetCompletion` are the retired host surface. Both are extra names, but only one of them
  // means "this endpoint has not been cut over", and the message says which.
  const run = await runAgent({
    argv: ['hello'],
    extraTools: [
      { name: 'agent_protocol', description: 'retired', inputSchema: { type: 'object', properties: {} } },
      { name: 'GetCompletion', description: 'retired', inputSchema: { type: 'object', properties: {} } },
    ],
    model: () => 'The model should never be asked.',
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.notEqual(run.code, 0)
  assert.equal(run.modelRequests.length, 0)
  assert.match(run.stderr, /still advertises the retired host surface agent_protocol, GetCompletion/)
  assert.match(run.stderr, /has not been cut over to the single-MCP contract/)
})

test('RT-SURFACE-3 a duplicated approved tool is refused rather than de-duplicated', async () => {
  const run = await runAgent({
    argv: ['hello'], duplicateTool: 'ApplyBatch',
    model: () => 'The model should never be asked.',
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.notEqual(run.code, 0)
  assert.equal(run.modelRequests.length, 0)
  assert.match(run.stderr, /advertises ApplyBatch more than once/)
})

test('RT-SURFACE-4 a missing approved tool is refused and named', async () => {
  const run = await runAgent({
    argv: ['hello'], advertise: ['OpenCase', 'ApplyBatch', 'ApplyAction', 'CloseCase'],
    model: () => 'The model should never be asked.',
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.notEqual(run.code, 0)
  assert.equal(run.modelRequests.length, 0)
  assert.match(run.stderr, /does not advertise QueryBoard/)
})

test('RT-SURFACE-5 the approved five, exactly, reach the model (calibration)', async () => {
  const run = await runAgent({ argv: [], chatLines: ['hello'], model: () => 'Hello.', timeoutMs: 20_000 })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const offered = (run.modelRequests[0].tools ?? []).map((tool) => tool.function?.name ?? tool.name)
  assert.deepEqual([...offered].sort(), [...MODEL_TOOLS].sort())
  assert.doesNotMatch(run.stderr, /cannot speak/)
})

// ── A local read limit is not the same as no answer ──────────────────────────

test('RT-RPC-5 a response too large to read is an unknown outcome that says which unknown it is', async () => {
  const oversized = 'x'.repeat(1_200_000)
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '4', RULITH_RECOVERY_WAIT_MS: '600' },
    chatLines: ['Open a Case.'], captureLocalEvents: true,
    tool: (name, args, board, session, meta) => {
      if (name !== 'OpenCase') return undefined
      const core = board.tool(name, args, session, meta)
      return { ...core, teaching: oversized }
    },
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'The outcome was not readable.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const verdict = run.localEvents.filter((event) => event.type === 'verdict' && event.cmd === 'OpenCase').at(-1)
  assert.match(verdict.teaching, /response_too_large|exceeded the/)
  assert.match(verdict.teaching, /The hop succeeded, but the answer exceeded this client's local response limit/,
    'a local read limit was reported as though the authority had never answered')
  assert.match(verdict.teaching, /The command may well have been applied/)
  assert.match(verdict.teaching, /outcome of this step is unknown/)
})

// ── Housekeeping the base protocol defines ───────────────────────────────────

test('RT-SURFACE-6 a paged tools/list is read to the end before membership is judged', async () => {
  // The base protocol lets `tools/list` answer in pages with a `nextCursor`. A client that
  // read only the first page would refuse a conforming endpoint for "not advertising
  // QueryBoard" — and would point the reader at the wrong side of the mismatch.
  const run = await runAgent({
    argv: [], chatLines: ['hello'], pageTools: 2,
    model: () => 'Hello.',
    timeoutMs: 20_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const pages = run.requests.filter((request) => request.method === 'tools/list')
  assert.equal(pages.length, 3, `six tools in pages of two is three pages: ${pages.length}`)
  const offered = (run.modelRequests[0].tools ?? []).map((tool) => tool.function?.name ?? tool.name)
  assert.deepEqual([...offered].sort(), [...MODEL_TOOLS].sort())
  assert.doesNotMatch(run.stderr, /does not advertise/)
})

test('RT-SESSION-5 the client gives its session back when it is finished with it', async () => {
  // A session left open is a Gateway that cannot tell "the client is gone" from "the client
  // is quiet". Terminating is the client's half of the single-connection rule.
  const run = await runAgent({
    argv: [], chatLines: ['hello'], model: () => 'Hello.', timeoutMs: 20_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const deletes = run.requests.filter((request) => request.httpMethod === 'DELETE')
  assert.equal(deletes.length, 1, `the session was not terminated: ${run.requests.map((r) => r.httpMethod).join(', ')}`)
  assert.equal(deletes[0].sessionId, run.initializes[0].issuedSession,
    'the client terminated a session other than its own')
})

test('RT-RESUME-3 resumption lives inside the call\'s own deadline, not beside it', async () => {
  // Two resume attempts with windows of their own turned a 45s call into 75s of wall clock:
  // a client quietly deciding how long the operator's configured limit really is. The
  // attempts share the call's budget, so an unrecoverable stream ends within it.
  const started = Date.now()
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '400', RULITH_MCP_TIMEOUT_MS: '2000' },
    chatLines: ['Open a Case.'],
    sseResults: true, breakStreamOnCall: 1, refuseResume: true,
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'The outcome was not known.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.ok(Date.now() - started < 20_000, 'the resumption attempts outlived the call they belonged to')
  assert.equal(run.requests.filter((request) => request.method === 'tools/call').length, 1,
    'the call was re-issued rather than resumed')
})

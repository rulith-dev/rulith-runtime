// SPDX-License-Identifier: Apache-2.0
/**
 * What one model turn is allowed to make this Agent Runtime do.
 *
 * The defects these arms close share a shape: the runtime treated a model turn as an
 * instruction rather than as a proposal, or treated one task's failure as the process's.
 * Each arm therefore asserts on the wire — what reached the scripted Board, and what the
 * process did afterwards — rather than on a message the Agent printed.
 *
 * The allow-list is now the tool list itself: five names, and nothing else can be reached.
 * That is a stronger guard than the refusal table it replaced, so these arms enumerate the
 * family anyway: a guard written against one name passes while the sibling that matters
 * walks through. The list deliberately includes the operations the retired `agent_protocol`
 * host path used to carry — `RunDischarge`, `GetBoardManifest`, `ResumeCase` — because
 * those are the ones a first-party client could reach and nobody else could audit.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { MODEL_TOOLS, callTool, defaultGateway, runAgent } from './support/agent-harness.mjs'

// ── D. The model may not speak governance, lifecycle selection, or receipts ──

for (const forbidden of [
  { name: 'SealBoard', input: {} },
  { name: 'RegisterPack', input: { packType: 'domain', pack: {} } },
  { name: 'RemovePack', input: { packType: 'domain', name: 'verified-calculation' } },
  { name: 'SetBoardSuspended', input: { suspended: true, reason: 'r' } },
  { name: 'MaintainBoardShared', input: { operations: [] } },
  { name: 'PauseCase', input: {} },
  { name: 'ResumeCase', input: { caseId: 'CASE_1' } },
  { name: 'RunDischarge', input: { root: 'ROOT_1' } },
  { name: 'GetBoardManifest', input: {} },
  { name: 'GetCompletion', input: {} },
  { name: 'agent_protocol', input: { mode: 'board', operation: { kind: 'SealBoard' } } },
  { name: 'GetProjection', input: {} },
  { name: 'ReportWork', input: { workType: 'action', id: 'inv_1', ok: true, result: 'shipped' } },
  { name: 'ClaimWork', input: { workType: 'action', id: 'inv_1' } },
  { name: 'GrantClearance', input: { norm: 'sql:destructive' } },
  { name: 'DefineRole', input: { role: 'admin' } },
]) {
  test(`the model cannot call ${forbidden.name}`, async () => {
    const run = await runAgent({
      argv: ['do the thing'],
      model: (round) => (round === 1 ? callTool(forbidden.name, forbidden.input) : 'I could not do that.'),
    })
    assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
    assert.equal(run.verbs.includes(forbidden.name), false,
      `${forbidden.name} was forwarded to the authority under the Agent's own credential: ${run.verbs.join(', ')}`)
    assert.match(run.stdout, /Refused locally/)
  })
}

test('the five Board tools the tool list advertises are still forwarded (calibration)', async () => {
  // Without this arm, an allow-list that refused everything would make every assertion
  // above green while breaking the runtime.
  const run = await runAgent({
    argv: ['apply an action'],
    env: { RULITH_MAX_ROUNDS: '7' },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'scratch.demo.value', args: { n: 1 } }] })
      if (round === 3) return callTool('ApplyAction', { action: 'acme.ship', target: 'L1' })
      if (round === 4) return callTool('QueryBoard', { include: ['cases'] })
      if (round === 5) return callTool('CloseCase', { disposition: 'abandoned', reason: 'demonstration only' })
      return 'Done.'
    },
  })
  assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
  assert.deepEqual(run.verbs.filter((verb) => MODEL_TOOLS.includes(verb)),
    ['OpenCase', 'ApplyBatch', 'ApplyAction', 'QueryBoard', 'CloseCase'])
  assert.doesNotMatch(run.stdout, /Refused locally/)
})

test('a Cloud endpoint that advertises fewer tools than the contract names stops startup instead of inventing them', async () => {
  const run = await runAgent({ advertise: ['OpenCase', 'ApplyBatch', 'ApplyAction', 'CloseCase'] })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.notEqual(run.code, 0)
  assert.match(run.stderr, /does not advertise QueryBoard/)
  assert.doesNotMatch(run.stderr, /could not resolve this opaque Agent MCP token/i,
    'a surface that cannot serve this client must not be reported as a credential failure')
})

// An advertised sixth tool used to be filtered away in silence and the run continued. It is
// now an explicit protocol mismatch, and every arm of that behaviour — extra, retired,
// duplicated, missing — lives in test/mcp-protocol.test.mjs beside the correlation arms,
// because both families are the same defect: the client deciding for itself what the server
// must have meant.

test('an oversized public MCP response is refused before the Agent buffers it without bound', async () => {
  const run = await runAgent({ oversizeMcpResponse: true })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.notEqual(run.code, 0, 'an oversized tools/list response must stop startup')
  assert.match(run.stderr, /MCP response exceeded the 8454144-byte local limit/)
})

// ── E. One task's failure is not the process's ───────────────────────────────

test('an Agent credential rejection terminates the process and never invents a pending Case id', async () => {
  const probe = createServer()
  let servePort
  await new Promise((ready) => probe.listen(0, '127.0.0.1', () => { servePort = probe.address().port; ready() }))
  await new Promise((closed) => probe.close(closed))
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(servePort), RULITH_SERVE_KEY: 'credential-test-key' },
    // The credential is rejected on the first model tool call, which is the first thing a
    // governed turn does and the surface every client crosses.
    model: () => callTool('OpenCase', {}),
    rejectToolAfter: 1,
    serveTasks: ['first accepted task', 'second accepted task'],
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 3, `credential rejection must stop the host, not only one task:\n${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /Task endpoint ready/, 'the test never entered --serve, so it proved only startup failure')
  assert.deepEqual(run.serveStatuses, [202, 202], 'both tasks must have crossed admission before the credential failure')
  assert.match(`${run.stdout}\n${run.stderr}`, /Agent MCP token rejected \(401\)/)
  assert.match(run.stdout, /Task never started: Agent credential rejected/,
    'the already-accepted queued task vanished without a terminal run record')
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /pending_case_id|Case remains open/,
    'no Case was opened, so the failure must not manufacture a resumable Case identity')
})

test('a token rejected by the MCP handshake exits 3 instead of masquerading as an identity parse failure', async () => {
  const run = await runAgent({ rejectAllCredential: true })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 3, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /Agent MCP token rejected \(401\)/)
  assert.doesNotMatch(run.stderr, /could not resolve this opaque Agent MCP token/i)
})

test('interactive mode reports a mid-session credential rejection without an unhandled stack', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['do the work'],
    model: () => callTool('OpenCase', {}),
    rejectToolAfter: 1,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 3, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /Agent MCP token rejected \(401\)/)
  assert.doesNotMatch(run.stderr, /at mcpRpc|AgentCredentialRejectedError:/,
    'interactive credential failure leaked an unhandled exception stack')
  assert.match(run.stdout, /Stopped\./)
})

test('a one-shot run whose Case never opened exits non-zero', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    tool: (name) => (name === 'OpenCase'
      ? { accepted: false, errorCode: 'case_admission_refused', teaching: 'the Capability Release is not installed on this Board' }
      : undefined),
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'The Case could not be opened, so nothing ran.'),
  })
  assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
  assert.equal(run.code, 1,
    `a task that never opened a Case must not report success; exit was ${run.code}:\n${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /No Case Context was opened, so this task never started/)
})

test('a one-shot run that the model closes as completed exits zero (calibration)', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '5' },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      if (round === 3) return callTool('CloseCase', { disposition: 'completed' })
      return 'Finished.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /Closed Case .* with disposition "completed"/)
})

test('autopilot nudges once with the lifecycle the Board reported, then stops rather than looping', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '8' },
    gateway: defaultGateway({ settleAfterBatch: false }),
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'I have nothing further to add.'),
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 3,
    `the host must nudge exactly once and then stop; it made ${run.modelRequests.length} model calls`)
  assert.match(JSON.stringify(run.modelRequests[2]), /still running on the Board/)
  assert.match(run.stdout, /The model stopped while "CASE_1" is still running on the Board/)
  assert.match(run.stdout, /remain in focus/)
  assert.equal(run.verbs.includes('CloseCase'), false, 'the host closed a Case the model never closed')
  // The nudge reuses what the Board already said. A host read here would be an implicit
  // Board query in the middle of a conversation the model had already ended.
  assert.deepEqual(run.verbs, ['OpenCase'])
})

test('autopilot stops when no focused root is still running, without another model turn', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '8' },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      if (round === 3) return callTool('CloseCase', { disposition: 'completed' })
      return 'The Board has what it needs.'
    },
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 3, 'an explicit close must not be followed by another model turn')
  assert.match(run.stdout, /The Board accepted closure and the Case is completed/)
})

test('a stopped model turn is not a paused Case', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '8' },
    captureLocalEvents: true,
    gateway: defaultGateway({ settleAfterBatch: false }),
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'I have nothing further to add.'),
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const observations = run.localEvents.filter((event) => event.type === 'case-state')
  assert.ok(observations.length > 0)
  assert.ok(observations.every((event) => event.caseStatus === 'running'),
    `the host reported a lifecycle the Board never did: ${JSON.stringify(observations)}`)
  assert.equal(run.verbs.includes('PauseCase'), false)
  assert.doesNotMatch(run.stdout, /paused/i)
})

test('a void disposition ends the autopilot run as an explicit stop', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '8' },
    gateway: defaultGateway({ settleAfterBatch: false }),
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('CloseCase', { disposition: 'abandoned', reason: 'the required Source is not configured' })
      return 'unreachable'
    },
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 2, 'an explicit stop must not be followed by another model turn')
  assert.match(run.stdout, /The Case was closed as abandoned/)
  const closed = run.toolCalls.find((call) => call.name === 'CloseCase')
  assert.equal(closed.args.reason, 'the required Source is not configured')
})

// ── J. A numeric knob with a typo falls back loudly ──────────────────────────

test('a non-numeric RULITH_MAX_ROUNDS warns and falls back instead of becoming NaN', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: 'twelve' },
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Nothing further.'),
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /RULITH_MAX_ROUNDS="twelve" is not an integer between 1 and 1000; using the default 12/)
  // NaN made every `round <= MAX_ROUNDS` false, so the loop ran zero rounds and the
  // segment ended without ever asking the model anything.
  assert.match(run.stdout, /— Round 1 —/, `the bound was not restored; the loop never ran:\n${run.stdout}`)
})

test('an out-of-range numeric knob is refused the same way', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_KEEP_MESSAGES: '1' },
    model: () => 'Nothing further.',
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /RULITH_KEEP_MESSAGES="1" is not an integer between 2 and 10000; using the default 24/)
})

test('a valid numeric knob is used and produces no warning (calibration)', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '5' },
    model: () => 'Nothing further.',
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.doesNotMatch(run.stderr, /RULITH_MAX_ROUNDS/)
})

// ── K. Nothing is reported to a second cloud feed ────────────────────────────

test('the runtime uploads no trace and opens no second cloud channel', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '4' },
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Nothing further.'),
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  // Every request the endpoint saw was either the model service or an approved tool
  // over the MCP handshake. A client-side trace uploader would appear here as a method or
  // a tool name that is neither.
  assert.deepEqual([...new Set(run.methods)].sort(),
    ['initialize', 'notifications/initialized', 'tools/call', 'tools/list'])
  assert.ok(run.verbs.every((verb) => MODEL_TOOLS.includes(verb)), `an unexpected tool was called: ${run.verbs.join(', ')}`)
})

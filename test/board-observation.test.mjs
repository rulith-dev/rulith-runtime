// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HOP_FAILURE, RULITH_META, callTool, runAgent } from './support/agent-harness.mjs'
import { projectRecovery } from '../local/local-ui.mjs'

const WAITING = { state: 'waiting', callRef: 'call-9', tool: 'ApplyAction', retryAfterMs: 100 }

test('RT-OBS-1 a new user message can ask the model for one QueryBoard observation while an operation waits', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['What can you see now?'], serverBoardObservation: true,
    env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '550' },
    recovery: WAITING, captureLocalEvents: true,
    model: round => round === 1 ? callTool('QueryBoard', {}) : 'The earlier action is still pending.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['QueryBoard'])
  assert.deepEqual(run.initializes[0].capabilities.experimental[RULITH_META], { operationRecovery: 1 })
  assert.equal(run.modelRequests.length, 2)
  assert.ok(run.pings >= 1)
  assert.equal(run.toolCalls[0].args && Object.keys(run.toolCalls[0].args).length, 0)
  const observed = JSON.parse(run.modelRequests[1].messages.find(message => message.role === 'tool').content)
  assert.deepEqual(observed.observation, { consistency: 'committed',
    operationAtAdmission: { state: 'waiting', originalTool: 'ApplyAction' } })
  assert.equal(run.localEvents.some(event => event.type === 'recovery' && event.state === 'none'), false)
})

test('RT-OBS-2 without the server capability, waiting still blocks before the model', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['What can you see now?'], serverBoardObservation: false,
    env: { RULITH_RECOVERY_WAIT_MS: '550' }, recovery: WAITING,
    model: () => callTool('QueryBoard', {}),
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 0)
  assert.deepEqual(run.verbs, [])
})

test('RT-OBS-3 reconciliation may be observed, but its original result is not invented', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Show the committed Board state.'], serverBoardObservation: true,
    recovery: { state: 'reconciliation_required', callRef: 'call-9', tool: 'ApplyAction', teaching: 'Worker lost.' },
    captureLocalEvents: true,
    model: round => round === 1 ? callTool('QueryBoard', {}) : 'The action still needs reconciliation.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['QueryBoard'])
  assert.equal(run.modelRequests.length, 2)
  const read = JSON.parse(run.modelRequests[1].messages.find(message => message.role === 'tool').content)
  assert.deepEqual(read.observation.operationAtAdmission,
    { state: 'reconciliation_required', originalTool: 'ApplyAction' })
  const projected = projectRecovery(run.localEvents.map(event => ({ ...event, src: 'agent' })))
  assert.equal(projected.state, 'reconciliation_required')
})

test('RT-OBS-4 one QueryBoard in a batch runs while writes, artifact reads and Case focus stay unsent', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Inspect and decide.'], serverBoardObservation: true, recovery: WAITING,
    model: round => round === 1 ? { text: '', toolCalls: [
      { name: 'QueryBoard', input: {} },
      { name: 'ApplyBatch', input: { operations: [{ op: 'assert_fact', id: 'BLIND', predicate: 'x', args: {} }] } },
      { name: 'ReadArtifact', input: { ref: `art_${'a'.repeat(32)}` } },
      { name: 'OpenCase', input: { caseId: 'CASE_X' } },
    ] } : 'I cannot change the pending operation.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['QueryBoard'])
  const results = run.modelRequests[1].messages.filter(message => message.role === 'tool')
  assert.equal(results.length, 4)
  assert.equal(results.slice(1).every(message => JSON.parse(message.content).errorCode === 'call_queue_suspended'), true)
})

test('RT-OBS-5 a failed independent query is read unavailable and leaves the original pending', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Inspect.'], serverBoardObservation: true, recovery: WAITING,
    tool: name => name === 'QueryBoard' ? HOP_FAILURE : undefined,
    captureLocalEvents: true,
    model: round => round === 1 ? callTool('QueryBoard', {}) : 'The current snapshot was unavailable.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['QueryBoard'])
  assert.equal(run.modelRequests.length, 2)
  const read = JSON.parse(run.modelRequests[1].messages.find(message => message.role === 'tool').content)
  assert.equal(read.errorCode, 'board_observation_unavailable')
  assert.doesNotMatch(read.teaching, /may well have been applied|outcome of this step is unknown/)
  assert.equal(run.localEvents.find(event => event.type === 'tool-result')?.readUnavailable, true)
  assert.equal(projectRecovery(run.localEvents.map(event => ({ ...event, src: 'agent' }))).state, 'waiting')
})

test('RT-OBS-6 a failed ordinary query is read unavailable, not a new unresolved business call', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Inspect.'], serverBoardObservation: true, recovery: { state: 'none' },
    tool: name => name === 'QueryBoard' ? HOP_FAILURE : undefined,
    model: round => round === 1 ? callTool('QueryBoard', {}) : 'The current snapshot was unavailable.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['QueryBoard'])
  const read = JSON.parse(run.modelRequests[1].messages.find(message => message.role === 'tool').content)
  assert.equal(read.errorCode, 'board_observation_unavailable')
  assert.doesNotMatch(run.stdout, /unreconciled conflict|unknown outcome/)
})

test('RT-OBS-7 mechanical recovery after a failed business call never wakes the model for a query', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Dispatch.'], serverBoardObservation: true,
    env: { RULITH_RECOVERY_WAIT_MS: '550' },
    recovery: ({ pings }) => pings === 0 ? { state: 'none' } : WAITING,
    tool: name => name === 'ApplyAction' ? HOP_FAILURE : undefined,
    model: () => callTool('ApplyAction', { action: 'demo.ship' }),
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['ApplyAction'])
  assert.equal(run.modelRequests.length, 1)
  assert.ok(run.pings >= 1)
})

test('RT-OBS-8 a model proposal does not clear the unresolved-call panel', () => {
  const prior = projectRecovery([{ src: 'agent', type: 'recovery', state: 'waiting',
    tool: 'ApplyAction', callRef: 'call-9' }])
  assert.equal(projectRecovery([{ src: 'agent', type: 'propose', say: 'I will inspect.' },
    { src: 'agent', type: 'verdict', cmd: 'QueryBoard', accepted: true }], prior).state, 'waiting')
})

test('RT-OBS-9 a new-turn observation preserves the original unresolved request on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-observation-'))
  try {
    const sessionFile = join(dir, 'sessions.json')
    const run = await runAgent({
      argv: [], chatLines: ['Dispatch.', 'Inspect.'], serverBoardObservation: true, sessionFile,
      env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '550' },
      recovery: ({ pings }) => pings === 0 ? { state: 'none' } : WAITING,
      tool: name => name === 'ApplyAction' ? HOP_FAILURE : undefined,
      model: round => round === 1 ? callTool('ApplyAction', { action: 'demo.ship' })
        : round === 2 ? callTool('QueryBoard', {}) : 'The earlier action is still pending.',
    })
    assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
    assert.deepEqual(run.verbs, ['ApplyAction', 'QueryBoard'])
    assert.equal(existsSync(sessionFile), true, `${run.stdout}\n${run.stderr}`)
    const store = JSON.stringify(JSON.parse(readFileSync(sessionFile, 'utf8')))
    assert.match(store, /ApplyAction/)
    assert.ok(store.includes(run.toolCalls[0].id), 'the original request identity was erased by QueryBoard')
    assert.equal(store.includes(run.toolCalls[1].id), false, 'the observation replaced the business request')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('RT-OBS-10 if the original becomes ready during observation, Host claims it before another model decision', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Inspect.'], serverBoardObservation: true,
    recovery: ({ toolCalls, readsDelivered }) => readsDelivered > 0 ? { state: 'none' }
      : toolCalls === 0 ? WAITING : { state: 'result_ready', callRef: 'call-9', tool: 'ApplyAction' },
    readRecord: { state: 'result_ready', originalTool: 'ApplyAction', originalResult: {
      content: [{ type: 'text', text: JSON.stringify({ accepted: true, revision: 'r9' }) }], isError: false,
    } },
    model: round => round === 1 ? callTool('QueryBoard', {}) : 'The original outcome was recovered.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['QueryBoard', 'ReadOperation'])
  assert.equal(run.modelRequests.length, 2)
  const messages = run.modelRequests[1].messages
  assert.ok(messages.some(message => String(message.content ?? '').includes('[Host recovery data')
    && String(message.content).includes('r9')))
})

test('RT-OBS-11 malformed QueryBoard denial cannot disclose a stray view or erase the pending call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-observation-leak-'))
  try {
    const sessionFile = join(dir, 'sessions.json')
    const run = await runAgent({
      argv: [], chatLines: ['Dispatch.', 'Inspect.'], serverBoardObservation: true, sessionFile,
      env: { RULITH_RECOVERY_WAIT_MS: '550' },
      recovery: ({ pings }) => pings === 0 ? { state: 'none' } : WAITING,
      captureLocalEvents: true,
      tool: name => name === 'ApplyAction' ? HOP_FAILURE : name === 'QueryBoard'
        ? { errorCode: 'not_authorized', view: { secret: 'LEAK' } } : undefined,
      model: round => round === 1 ? callTool('ApplyAction', { action: 'demo.ship' })
        : round === 2 ? callTool('QueryBoard', {}) : 'No snapshot was available.',
    })
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
    assert.deepEqual(run.verbs, ['ApplyAction', 'QueryBoard'])
    assert.equal(run.modelRequests.length, 3)
    assert.doesNotMatch(JSON.stringify(run.modelRequests), /LEAK/)
    assert.doesNotMatch(JSON.stringify(run.localEvents), /LEAK/)
    const read = JSON.parse(run.modelRequests[2].messages.filter(message => message.role === 'tool').at(-1).content)
    assert.equal(read.errorCode, 'board_observation_unavailable')
    assert.equal(projectRecovery(run.localEvents.map(event => ({ ...event, src: 'agent' }))).state, 'waiting')
    const store = JSON.stringify(JSON.parse(readFileSync(sessionFile, 'utf8')))
    assert.ok(store.includes(run.toolCalls[0].id), 'the malicious read cleared the original unknown submission')
    assert.equal(store.includes(run.toolCalls[1].id), false, 'the malicious read replaced the original submission')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('RT-OBS-12 a conforming QueryBoard denial reaches the model without changing original recovery', async () => {
  const denied = { accepted: false, requestExecuted: false, errorCode: 'not_authorized',
    teaching: 'This Agent cannot read that slice.' }
  const run = await runAgent({
    argv: [], chatLines: ['Inspect.'], serverBoardObservation: true, recovery: WAITING,
    captureLocalEvents: true,
    tool: name => name === 'QueryBoard' ? denied : undefined,
    model: round => round === 1 ? callTool('QueryBoard', {}) : 'Access was refused.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const read = JSON.parse(run.modelRequests[1].messages.find(message => message.role === 'tool').content)
  assert.deepEqual(read, denied)
  assert.equal(projectRecovery(run.localEvents.map(event => ({ ...event, src: 'agent' }))).state, 'waiting')
})

test('RT-OBS-12b a disclosure refusal may omit requestExecuted under the canonical schema', async () => {
  const denied = { accepted: false, errorCode: 'result_unavailable',
    teaching: 'Current Board disclosure could not be confirmed.' }
  const run = await runAgent({
    argv: [], chatLines: ['Inspect.'], serverBoardObservation: true, recovery: WAITING,
    captureLocalEvents: true,
    tool: name => name === 'QueryBoard' ? denied : undefined,
    model: round => round === 1 ? callTool('QueryBoard', {}) : 'The current disclosure was refused.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const read = JSON.parse(run.modelRequests[1].messages.find(message => message.role === 'tool').content)
  assert.deepEqual(read, denied)
  assert.equal(projectRecovery(run.localEvents.map(event => ({ ...event, src: 'agent' }))).state, 'waiting')
})

for (const [label, malformed] of [
  ['denial with a hidden view', { accepted: false, errorCode: 'not_authorized', requestExecuted: false,
    view: { secret: 'LEAK' } }],
  ['denial claiming execution', { accepted: false, errorCode: 'not_authorized', requestExecuted: true }],
  ['denial with a null execution flag', { accepted: false, errorCode: 'not_authorized', requestExecuted: null }],
  ['extra top-level content', { accepted: true, view: {}, observation: {
    consistency: 'committed', operationAtAdmission: { state: 'waiting', originalTool: 'ApplyAction' } }, secret: 'LEAK' }],
  ['none with an original tool', { accepted: true, view: {}, observation: {
    consistency: 'committed', operationAtAdmission: { state: 'none', originalTool: 'ApplyAction' } } }],
  ['unknown original tool', { accepted: true, view: {}, observation: {
    consistency: 'committed', operationAtAdmission: { state: 'waiting', originalTool: 'PrivilegedWrite' } } }],
]) test(`RT-OBS-13 ${label} is not delivered as a committed snapshot`, async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Inspect.'], serverBoardObservation: true, recovery: WAITING,
    tool: name => name === 'QueryBoard' ? malformed : undefined,
    model: round => round === 1 ? callTool('QueryBoard', {}) : 'No usable snapshot.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const read = JSON.parse(run.modelRequests[1].messages.find(message => message.role === 'tool').content)
  assert.equal(read.errorCode, 'board_observation_unavailable')
  assert.doesNotMatch(JSON.stringify(run.modelRequests), /LEAK|PrivilegedWrite/)
})

test('RT-OBS-14 an expired observation session rechecks recovery and claims ready original before the model', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Inspect.'], serverBoardObservation: true, expireSessionAfter: 5,
    recovery: ({ requests, readsDelivered }) => readsDelivered > 0 ? { state: 'none' }
      : requests < 5 ? WAITING : { state: 'result_ready', callRef: 'call-9', tool: 'ApplyAction' },
    readRecord: { state: 'result_ready', originalTool: 'ApplyAction', originalResult: {
      content: [{ type: 'text', text: '{"accepted":true}' }], isError: false,
    } },
    model: round => round === 1 ? callTool('QueryBoard', {}) : 'The original outcome was recovered.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['ReadOperation'], `${run.stdout}\n${run.stderr}\n${JSON.stringify(run.requests)}`)
  assert.equal(run.requests.filter(request => request.method === 'tools/call').length, 2)
  assert.equal(run.modelRequests.length, 2)
  assert.ok(run.initializes.length >= 2)
  assert.ok(run.modelRequests[1].messages.some(message => String(message.content ?? '').includes('[Host recovery data')))
})

test('RT-OBS-15 an expired observation session that is still waiting does not start another model turn', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Inspect.'], serverBoardObservation: true, expireSessionAfter: 5,
    env: { RULITH_RECOVERY_WAIT_MS: '550' }, recovery: WAITING,
    model: round => round === 1 ? callTool('QueryBoard', {}) : 'This turn must stop until a new message.',
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 1)
  assert.equal(run.requests.filter(request => request.method === 'tools/call').length, 1)
  assert.ok(run.initializes.length >= 2)
  assert.match(run.stdout, /still unresolved|still live/)
})

// SPDX-License-Identifier: Apache-2.0
/**
 * Get without artifact, the call the authority never holds.
 *
 * A committed observation reads the Board as it stands and answers its own request, whatever
 * else is in progress: it takes no execution slot, it is not an operation, and its strip shows
 * what the Agent's operations are doing. It never proves an earlier call's effect, and a read
 * that failed changes nothing but itself.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { HOP_FAILURE, RULITH_META, callTool, runAgent, declareGoal } from './support/agent-harness.mjs'
import { projectOperations } from '../local/operations.mjs'

const RUNNING = [{ tool: 'Execute', label: 'Execute demo.ship', state: 'running', stage: 'at_worker' }]
const toolAnswers = (request) => request.messages.filter((message) => message.role === 'tool')
  .map((message) => JSON.parse(message.content))

test('D-1012e acknowledged writes leave an empty strip without blocking writes or losing goal endings', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Start, inspect, then cancel the goal.'], captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '6' },
    priorOperations: [{ tool: 'Set', label: 'Set', state: 'done', acked: true,
      core: { accepted: true } }],
    model: round => round === 1 || round === 3 || round === 5 ? callTool('Get', {})
      : round === 2 ? callTool('Set', declareGoal())
        : round === 4 ? callTool('Set', { operations: [
          { op: 'end_goal', goal: 'GOAL_1', disposition: 'cancelled', reason: 'Withdrawn.' },
        ] }) : 'Cancelled.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['Get', 'Set', 'Get', 'Set', 'Get'])
  const answers = toolAnswers(run.modelRequests.at(-1))
  assert.deepEqual(answers.filter((_, i) => i % 2 === 0).map(answer => answer.operations), [[], [], []])
  assert.ok(answers.filter((_, i) => i % 2 === 1).every(answer => answer.accepted === true))
  assert.equal(run.pings, 0, 'an empty strip started a wait or an acknowledgement loop')
  const end = run.localEvents.findLast(event => event.type === 'segment-end')
  assert.deepEqual(end.endedGoals, [{ goal: 'GOAL_1', disposition: 'cancelled' }])
  assert.ok(run.localEvents.some(event => event.type === 'operations' && event.operations.length === 0))
})

test('RT-OBS-1 a new user message can read the Board while an operation runs, and sees it running', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['What can you see now?'], priorOperations: RUNNING, captureLocalEvents: true,
    model: round => round === 1 ? callTool('Get', {}) : 'The earlier action is still running.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['Get'])
  assert.deepEqual(run.initializes[0].capabilities.experimental[RULITH_META], { heldCalls: 1 })
  assert.equal(run.modelRequests.length, 2)
  assert.equal(run.pings, 0, 'an observation is not a reason to watch anything')
  const [observed] = toolAnswers(run.modelRequests[1])
  assert.deepEqual(observed.observation, { consistency: 'committed' })
  assert.equal(observed.operations[0].state, 'running')
  assert.equal(observed.operations[0].stage, 'at_worker')
  assert.equal(Object.hasOwn(observed.operations[0], 'ordinal'), false, 'the host-only ordinal reached the model')
  assert.equal(projectOperations(run.localEvents.map(event => ({ ...event, src: 'agent' }))).entries[0].state, 'running')
})

test('RT-OBS-2 a server that does not promise held calls is refused at initialize without observing anything', async () => {
  const run = await runAgent({
    argv: ['Inspect pending work.'], serverCapabilities: false, priorOperations: RUNNING,
    model: () => callTool('Get', {}),
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 1)
  assert.deepEqual(run.methods, ['initialize'])
  assert.match(run.stderr, /requires rulith\/v4 server capabilities \{"heldCalls":1\}/)
  assert.equal(run.modelRequests.length, 0)
  assert.deepEqual(run.verbs, [])
})

test('RT-OBS-2b a Gateway without rulith/v4 fails the generic capability check', async () => {
  // Package A is a one-shot cutover (A-2, A-22): this Runtime declares rulith/v4 only, and a
  // Gateway that answers with the C1 rulith/v3 capability has not been cut over. It is refused
  // before tools/list, before the model, and is not read as a credential fault.
  const run = await runAgent({
    argv: ['Inspect pending work.'], serverCapabilities: false,
    extraServerCapabilities: { 'rulith/v3': { heldCalls: 1 } },
    model: () => callTool('Get', {}),
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 1)
  assert.deepEqual(run.methods, ['initialize'])
  assert.deepEqual(run.initializes[0].capabilities.experimental, { 'rulith/v4': { heldCalls: 1 } },
    'this Runtime declared something besides rulith/v4')
  assert.match(run.stderr, /requires rulith\/v4 server capabilities \{"heldCalls":1\}\. This endpoint did not advertise that contract\./)
  assert.doesNotMatch(run.stderr, /it advertises rulith\/v3|an earlier Rulith contract/)
  assert.match(run.stderr, /Do not replace credentials/)
  assert.doesNotMatch(run.stderr, /token rejected|rotate the Agent token/)
  assert.equal(run.modelRequests.length, 0)
})

test('RT-OBS-2c retired tools beside a v4 capability fail the generic membership check', async () => {
  const v4 = (await import('./support/agent-harness.mjs')).advertisedTools()
  const run = await runAgent({
    argv: ['Inspect pending work.'],
    toolSchemas: v4.filter((tool) => tool.name !== 'Execute'),
    extraTools: [{ name: 'OpenCase', description: 'Rulith OpenCase', inputSchema: { type: 'object' } },
      { name: 'CloseCase', description: 'Rulith CloseCase', inputSchema: { type: 'object' } }],
    model: () => callTool('Get', {}),
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 1)
  assert.match(run.stderr, /it does not advertise Execute/)
  assert.match(run.stderr, /it advertises OpenCase, CloseCase, which is not part of the approved surface/)
  assert.doesNotMatch(run.stderr, /which rulith\/v4 removed|has not been cut over/)
  assert.equal(run.modelRequests.length, 0)
  assert.deepEqual(run.verbs, [])
})

test('RT-OBS-3 an operation that needs reconciliation can be observed; nothing is invented about its effect', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Show the committed Board state.'], captureLocalEvents: true,
    priorOperations: [{ tool: 'Execute', label: 'Execute demo.ship', state: 'needs_person' }],
    model: round => round === 1 ? callTool('Get', {}) : 'The action still needs reconciliation.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['Get'])
  const [read] = toolAnswers(run.modelRequests[1])
  assert.equal(read.operations[0].state, 'needs_person')
  assert.equal(Object.hasOwn(read.operations[0], 'result'), false)
  const projected = projectOperations(run.localEvents.map(event => ({ ...event, src: 'agent' })))
  assert.equal(projected.entries[0].needsPerson, true)
})

test('end_goal inside Set is guarded while another operation is unresolved', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Cancel it.'], priorOperations: RUNNING,
    model: round => round === 1 ? callTool('Set', { operations: [
      { op: 'end_goal', goal: 'GOAL_1', disposition: 'cancelled', reason: 'Withdrawn.' },
    ] }) : 'The running operation prevents this write.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const [refused] = toolAnswers(run.modelRequests[1])
  assert.equal(refused.accepted, false)
  assert.equal(refused.requestExecuted, false)
  assert.equal(refused.errorCode, 'operation_running')
  assert.deepEqual(run.verbs, ['Set'])
  assert.equal(run.operations.length, 1, 'the guarded write was admitted as an operation')
})

test('RT-OBS-4 beside a running operation a read runs, a write is not executed, and the rest waits for the model', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Inspect and decide.'], priorOperations: RUNNING,
    model: round => round === 1 ? { text: '', toolCalls: [
      { name: 'Get', input: {} },
      { name: 'Set', input: { operations: [{ op: 'assert_fact', id: 'BLIND', predicate: 'x', args: {} }] } },
      { name: 'Get', input: { artifact: { ref: `art_${'a'.repeat(32)}` } } },
      { name: 'OpenCase', input: { caseId: 'CASE_X' } },
    ] } : 'I cannot change the running operation.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['Get', 'Set'])
  const results = toolAnswers(run.modelRequests[1])
  assert.equal(results.length, 4)
  assert.equal(results[0].accepted, true)
  assert.equal(results[1].errorCode, 'operation_running')
  assert.equal(results[1].requestExecuted, false)
  assert.equal(results.slice(2).every(result => result.errorCode === 'call_queue_suspended'), true)
  assert.equal(run.operations.length, 1, 'something beside the running operation was executed')
})

test('RT-OBS-5 a failed read is reported unavailable and leaves the running operation as it was', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Inspect.'], priorOperations: RUNNING, captureLocalEvents: true,
    tool: name => name === 'Get' ? HOP_FAILURE : undefined,
    model: round => round === 1 ? callTool('Get', {}) : 'The current snapshot was unavailable.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['Get'])
  const [read] = toolAnswers(run.modelRequests[1])
  assert.equal(read.errorCode, 'board_observation_unavailable')
  assert.doesNotMatch(read.teaching, /may or may not have run|transport failure/,
    'a read that failed was taught as though it might have changed something')
  assert.equal(run.localEvents.find(event => event.type === 'tool-result')?.readUnavailable, true)
  assert.equal(run.operations[0].state, 'running')
})

test('RT-OBS-8 a model proposal or a read verdict does not change the operations panel', () => {
  const prior = projectOperations([{ src: 'agent', type: 'operations', operations: [
    { tool: 'Execute', label: 'Execute demo.ship', state: 'running', stage: 'at_worker', at: 'a', since: 'b' }] }])
  const after = projectOperations([{ src: 'agent', type: 'propose', say: 'I will inspect.' },
    { src: 'agent', type: 'verdict', cmd: 'Get', accepted: true }], prior)
  assert.deepEqual(after, prior)
})

test('RT-OBS-12 a conforming Get refusal reaches the model as the authority wrote it', async () => {
  for (const denied of [
    { accepted: false, requestExecuted: false, errorCode: 'invalid_params', teaching: 'That selector is not allowed.',
      operations: [], view: { cases: { directory: [], total: 0 } } },
    { accepted: false, errorCode: 'not_authorized', teaching: 'This Agent cannot read that slice.', operations: [] },
    { accepted: false, errorCode: 'result_unavailable', teaching: 'Current Board disclosure could not be confirmed.', operations: [] },
  ]) {
    const run = await runAgent({
      argv: [], chatLines: ['Inspect.'],
      tool: name => name === 'Get' ? denied : undefined,
      model: round => round === 1 ? callTool('Get', {}) : 'Access was refused.',
    })
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
    const [read] = toolAnswers(run.modelRequests[1])
    assert.deepEqual(read, denied)
  }
})

for (const [label, malformed] of [
  ['a disclosure refusal with a hidden view', { accepted: false, errorCode: 'not_authorized', operations: [],
    view: { secret: 'LEAK' } }],
  ['a refusal claiming execution', { accepted: false, errorCode: 'invalid_params', requestExecuted: true, operations: [], view: {} }],
  ['a refusal that is not a disclosure refusal and says nothing of execution', { accepted: false,
    errorCode: 'invalid_params', operations: [], view: {} }],
  ['a refusal without the strip', { accepted: false, errorCode: 'not_authorized' }],
  ['extra top-level content', { accepted: true, view: {}, observation: { consistency: 'committed' }, operations: [], secret: 'LEAK' }],
  ['the retired admission-time operation', { accepted: true, view: {}, operations: [], observation: {
    consistency: 'committed', operationAtAdmission: { state: 'waiting', originalTool: 'Execute' } } }],
  // Get is now also an Artifact operation; the retired Board-read name remains invalid.
  ['a strip entry for a tool that is never an operation', { accepted: true, view: {}, observation: { consistency: 'committed' },
    operations: [{ tool: 'QueryBoard', label: 'QueryBoard', state: 'done', summary: 'read', at: 'a', since: 'b' }] }],
  ['a strip entry in a state the contract does not have', { accepted: true, view: {}, observation: { consistency: 'committed' },
    operations: [{ tool: 'Execute', label: 'Execute x', state: 'withheld', at: 'a', since: 'b' }] }],
]) test(`RT-OBS-13 ${label} is not delivered as a committed snapshot`, async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Inspect.'],
    tool: name => name === 'Get' ? malformed : undefined,
    model: round => round === 1 ? callTool('Get', {}) : 'No usable snapshot.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const [read] = toolAnswers(run.modelRequests[1])
  assert.equal(read.errorCode, 'board_observation_unavailable')
  assert.doesNotMatch(JSON.stringify(run.modelRequests), /LEAK|operationAtAdmission|withheld/)
})

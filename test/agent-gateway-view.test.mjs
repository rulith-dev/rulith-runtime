import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { callTool, runAgent, declareGoal, defaultGateway } from './support/agent-harness.mjs'

/**
 * The Board as the Java Gateway projects it: the business view in `view`, never the model's prose
 * read as lifecycle. A batch asserting `certified_by_test(goal)` stands in for the evidence that
 * makes the Board certify that goal: Core then completes it in the same commit (rulith/v4, A-13),
 * and it leaves focus with `status:"completed"` in the goal directory.
 */
const gatewayView = (name, args, board, session) => {
  const certify = name === 'ApplyBatch' ? (args.operations ?? []).find((operation) => operation.predicate === 'certified_by_test') : undefined
  const { payload, ...result } = board.tool(name, args, session)
  if (certify !== undefined && result.accepted === true) {
    const goal = board.state.goals.get(String(certify.args?.goal ?? ''))
    goal.status = 'completed'
    session.focus.delete(goal.goal)
    return { ...result, view: board.peek(session) }
  }
  return { ...result, view: payload }
}
const certify = (goal) => callTool('ApplyBatch', { operations: [{ op: 'assert_fact', predicate: 'certified_by_test', args: { goal } }] })
/** End GOAL_n the way a disposition says: completed by the Board, or ended by end_goal. */
const endWith = (goal, disposition) => (disposition === 'completed' ? certify(goal)
  : callTool('ApplyBatch', { operations: [{ op: 'end_goal', goal, disposition, reason: `The work was ${disposition}.` }] }))

test('Gateway view keeps the remaining goal running after another goal ends', async () => {
  const run = await runAgent({
    captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '5' },
    tool: gatewayView,
    model: (round) => {
      if (round <= 2) return callTool('ApplyBatch', declareGoal(round === 1 ? 'task_a' : 'task_b'))
      if (round === 3) return callTool('ApplyBatch', { operations: [{ op: 'end_goal', goal: 'GOAL_1', disposition: 'abandoned', reason: 'Not needed.' }] })
      if (round === 4) return callTool('ApplyBatch', { operations: [{ op: 'end_goal', goal: 'GOAL_2', disposition: 'abandoned', reason: 'Not needed.' }] })
      return 'Both goals were abandoned.'
    },
  })
  assert.equal(run.code, 0, run.stdout + run.stderr)
  assert.deepEqual(run.toolCalls.filter(call => call.name === 'ApplyBatch' && call.args.operations?.[0]?.op === 'end_goal').map(call => call.args.operations[0].goal), ['GOAL_1', 'GOAL_2'])
  assert.deepEqual(run.operations.slice(-2).map(({ tool, label }) => ({ tool, label })), [
    { tool: 'ApplyBatch', label: 'ApplyBatch end_goal GOAL_1' },
    { tool: 'ApplyBatch', label: 'ApplyBatch end_goal GOAL_2' },
  ])
  assert.ok(run.localEvents.some(event => event.type === 'focus' && event.goals.length === 1 && event.goals[0].goal === 'GOAL_2' && event.goals[0].status === 'running'))
  assert.ok(run.localEvents.some(event => event.type === 'case-closed' && event.goal === 'GOAL_2' && event.disposition === 'abandoned'))
  assert.doesNotMatch(run.stdout, /No Board View was observed/)
})

for (const dispositions of [['completed', 'cancelled'], ['cancelled', 'completed'], ['completed', 'completed']]) {
test(`one-shot reports every ended goal in order: ${dispositions.join(', ')}`, async () => {
  const run = await runAgent({
    captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '6' },
    tool: gatewayView,
    model: round => {
      if (round <= 2) return callTool('ApplyBatch', declareGoal(round === 1 ? 'task_a' : 'task_b'))
      if (round <= 4) return endWith(`GOAL_${round - 2}`, dispositions[round - 3])
      return 'unreachable'
    },
  })
  assert.equal(run.code, 0, run.stderr)
  assert.equal(run.modelRequests.length, 4)
  const end = run.localEvents.findLast(event => event.type === 'end')
  assert.deepEqual(end.endedGoals, dispositions.map((disposition, i) => ({ goal: `GOAL_${i + 1}`, disposition })))
  assert.equal(end.goal, 'GOAL_2')
  assert.equal(end.ok, dispositions.every(value => value === 'completed'))
  for (const [i, disposition] of dispositions.entries()) assert.ok(end.note.includes(`GOAL_${i + 1}=${disposition}`))
  assert.equal(run.toolCalls.length, 4, 'Summary must not read the Board again')
})
}

test('one-shot ends as completed when the Board completes the goal it certifies, with no closing call', async () => {
  const run = await runAgent({
    captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '6' },
    tool: gatewayView,
    model: round => (round === 1 ? callTool('ApplyBatch', declareGoal()) : round === 2 ? certify('GOAL_1') : 'unreachable'),
  })
  assert.equal(run.code, 0, run.stderr)
  assert.equal(run.modelRequests.length, 2)
  assert.deepEqual(run.verbs, ['ApplyBatch', 'ApplyBatch'], 'completion needed a call of its own')
  const end = run.localEvents.findLast(event => event.type === 'end')
  assert.equal(end.ok, true)
  assert.equal(end.outcome, 'completed')
  assert.match(end.note, /^The Board certified the goal and it is completed\. Goal outcomes this turn: GOAL_1=completed\.$/)
  assert.match(run.stdout, /Goal "GOAL_1" completed: the Board certified it/)
})

for (const mode of ['chat', 'serve']) {
test(`${mode} returns per-goal outcomes only for the current turn`, async () => {
  let serveEnv = {}
  if (mode === 'serve') {
    const reservation = createServer()
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const port = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
    serveEnv = { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'isolated-outcomes-test' }
  }
  const run = await runAgent({
    argv: mode === 'chat' ? [] : ['--serve'],
    ...(mode === 'chat' ? { chatLines: ['Do both jobs.', 'Hello.'] }
      : { serveTasks: ['Do both jobs.', 'Hello.'], waitForServeCompletion: true }),
    captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '6', ...serveEnv },
    timeoutMs: mode === 'serve' ? 3000 : 20000,
    tool: gatewayView,
    model: round => {
      if (round <= 2) return callTool('ApplyBatch', declareGoal(round === 1 ? 'task_a' : 'task_b'))
      if (round <= 4) return endWith(`GOAL_${round - 2}`, round === 3 ? 'completed' : 'cancelled')
      return 'Response delivered.'
    },
  })
  if (mode === 'chat') assert.equal(run.code, 0, run.stderr)
  else assert.deepEqual(run.serveStatuses, [202, 202], run.stderr)
  const results = run.localEvents.filter(event => event.type === (mode === 'chat' ? 'segment-end' : 'task-done'))
  assert.equal(results.length, 2)
  assert.deepEqual(results[0].endedGoals.map(row => row.disposition), ['completed', 'cancelled'])
  assert.ok(results[0].note.includes('GOAL_1=completed'))
  assert.ok(results[0].note.includes('GOAL_2=cancelled'))
  assert.equal(results[1].endedGoals, undefined)
  assert.doesNotMatch(results[1].note, /Goal outcomes this turn/)
})
}

test('a refused end_goal batch cannot enter the terminal outcome summary', async () => {
  const run = await runAgent({
    captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '5' },
    tool: gatewayView,
    model: round => {
      if (round <= 2) return callTool('ApplyBatch', declareGoal(round === 1 ? 'task_a' : 'task_b'))
      if (round === 3) return callTool('ApplyBatch', { operations: [{ op: 'end_goal', goal: 'GOAL_9', disposition: 'failed', reason: 'No such work.' }] })
      return callTool('ApplyBatch', { operations: [{ op: 'end_goal', goal: `GOAL_${round - 3}`, disposition: 'cancelled', reason: 'Withdrawn.' }] })
    },
  })
  assert.equal(run.code, 0, run.stderr)
  const end = run.localEvents.findLast(event => event.type === 'end')
  assert.deepEqual(end.endedGoals.map(row => row.disposition), ['cancelled', 'cancelled'])
  assert.equal(end.ok, false)
  assert.ok(run.localEvents.some(event => event.type === 'verdict' && event.accepted === false))
})

test('a mixed end_goal batch is refused without ending its goal or applying its other operation', async () => {
  const gateway = defaultGateway()
  const run = await runAgent({
    argv: [], chatLines: ['Try the mixed batch.'], gateway, captureLocalEvents: true,
    model: round => round === 1 ? callTool('ApplyBatch', declareGoal())
      : round === 2 ? callTool('ApplyBatch', { operations: [
        { op: 'assert_fact', predicate: 'x', args: {} },
        { op: 'end_goal', goal: 'GOAL_1', disposition: 'cancelled', reason: 'Withdrawn.' },
      ] }) : 'The mixed batch was refused.',
  })
  assert.equal(run.code, 0, run.stderr)
  assert.equal(gateway.state.goals.get('GOAL_1').status, 'running')
  assert.equal(gateway.state.revision, 1, 'the refused mixed batch changed the Board')
  assert.equal(run.localEvents.some(event => event.type === 'case-closed'), false)
  assert.equal(run.operations.at(-1).state, 'refused')
  assert.equal(run.operations.at(-1).core.errorCode, 'end_goal_mixed_batch')
})

test('an accepted end_goal reports the disposition this host sent rather than one returned in the result', async () => {
  const run = await runAgent({ argv: [], chatLines: ['Cancel it.'], captureLocalEvents: true,
    tool: (name, args, board, session) => {
      if (name !== 'ApplyBatch' || args.operations?.[0]?.op !== 'end_goal') return undefined
      const { payload, ...answer } = board.tool(name, args, session)
      return { ...answer, view: payload, result: { ...answer.result, disposition: 'failed' } }
    },
    model: round => round === 1 ? callTool('ApplyBatch', declareGoal())
      : round === 2 ? callTool('ApplyBatch', { operations: [
        { op: 'end_goal', goal: 'GOAL_1', disposition: 'cancelled', reason: 'Withdrawn.' },
      ] }) : 'Cancelled.',
  })
  assert.equal(run.code, 0, run.stderr)
  assert.match(run.stdout, /Goal "GOAL_1" ended as "cancelled"/)
  assert.equal(run.localEvents.find(event => event.type === 'case-closed').disposition, 'cancelled')
})

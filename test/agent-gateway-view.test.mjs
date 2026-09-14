import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { callTool, runAgent } from './support/agent-harness.mjs'

test('Gateway view keeps the remaining Case running after another Case closes', async () => {
  const run = await runAgent({
    captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '5' },
    // 与 Java Gateway 的投影一致：业务视图在 view，不把模型正文当作生命周期。
    tool: (name, args, board, session) => {
      const { payload, ...result } = board.tool(name, args, session)
      return { ...result, view: payload }
    },
    model: (round) => {
      if (round <= 2) return callTool('OpenCase', {})
      if (round === 3) return callTool('CloseCase', { root: 'ROOT_1', disposition: 'abandoned' })
      if (round === 4) return callTool('CloseCase', { root: 'ROOT_2', disposition: 'abandoned' })
      return 'Both Cases were abandoned.'
    },
  })
  assert.equal(run.code, 0, run.stdout + run.stderr)
  assert.deepEqual(run.toolCalls.filter(call => call.name === 'CloseCase').map(call => call.args.root), ['ROOT_1', 'ROOT_2'])
  assert.ok(run.localEvents.some(event => event.type === 'focus' && event.roots.length === 1 && event.roots[0].caseId === 'CASE_2' && event.roots[0].status === 'running'))
  assert.ok(run.localEvents.some(event => event.type === 'case-closed' && event.caseId === 'CASE_2'))
  assert.doesNotMatch(run.stdout, /No Board View was observed/)
})

for (const dispositions of [['completed', 'cancelled'], ['cancelled', 'completed'], ['completed', 'completed']]) {
test(`one-shot reports every closed Case in order: ${dispositions.join(', ')}`, async () => {
  const run = await runAgent({
    captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '6' },
    tool: (name, args, board, session) => {
      const { payload, ...result } = board.tool(name, args, session)
      return { ...result, view: payload }
    },
    model: round => {
      if (round <= 2) return callTool('OpenCase', {})
      if (round === 3) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', predicate: 'ready', args: {} }] })
      if (round <= 5) return callTool('CloseCase', { root: `ROOT_${round - 3}`, disposition: dispositions[round - 4] })
      return 'unreachable'
    },
  })
  assert.equal(run.code, 0, run.stderr)
  assert.equal(run.modelRequests.length, 5)
  const end = run.localEvents.findLast(event => event.type === 'end')
  assert.deepEqual(end.closedCases, dispositions.map((disposition, i) => ({ caseId: `CASE_${i + 1}`, root: `ROOT_${i + 1}`, disposition })))
  assert.equal(end.caseId, 'CASE_2')
  assert.equal(end.ok, dispositions.every(value => value === 'completed'))
  for (const [i, disposition] of dispositions.entries()) assert.ok(end.note.includes(`CASE_${i + 1} (ROOT_${i + 1})=${disposition}`))
  assert.equal(run.toolCalls.length, 5, 'Summary must not read the Board again')
})
}

for (const mode of ['chat', 'serve']) {
test(`${mode} returns per-Case outcomes only for the current turn`, async () => {
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
    model: round => {
      if (round <= 2) return callTool('OpenCase', {})
      if (round === 3) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', predicate: 'ready', args: {} }] })
      if (round <= 5) return callTool('CloseCase', { root: `ROOT_${round - 3}`, disposition: round === 4 ? 'completed' : 'cancelled' })
      return 'Response delivered.'
    },
  })
  if (mode === 'chat') assert.equal(run.code, 0, run.stderr)
  else assert.deepEqual(run.serveStatuses, [202, 202], run.stderr)
  const results = run.localEvents.filter(event => event.type === (mode === 'chat' ? 'segment-end' : 'task-done'))
  assert.equal(results.length, 2)
  assert.deepEqual(results[0].closedCases.map(row => row.disposition), ['completed', 'cancelled'])
  assert.ok(results[0].note.includes('CASE_1 (ROOT_1)=completed'))
  assert.ok(results[0].note.includes('CASE_2 (ROOT_2)=cancelled'))
  assert.equal(results[1].closedCases, undefined)
  assert.doesNotMatch(results[1].note, /Case outcomes this turn/)
})
}

test('a refused close cannot enter the terminal outcome summary', async () => {
  const run = await runAgent({
    captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '5' },
    model: round => {
      if (round <= 2) return callTool('OpenCase', {})
      if (round === 3) return callTool('CloseCase', { root: 'ROOT_1', disposition: 'completed' })
      return callTool('CloseCase', { root: `ROOT_${round - 3}`, disposition: 'cancelled' })
    },
  })
  assert.equal(run.code, 0, run.stderr)
  const end = run.localEvents.findLast(event => event.type === 'end')
  assert.deepEqual(end.closedCases.map(row => row.disposition), ['cancelled', 'cancelled'])
  assert.equal(end.ok, false)
  assert.ok(run.localEvents.some(event => event.type === 'verdict' && event.accepted === false))
})

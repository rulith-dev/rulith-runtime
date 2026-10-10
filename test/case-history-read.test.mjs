// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { callTool, runAgent } from './support/agent-harness.mjs'

// rulith/v4 (A-19): view.history, keyed by goal, as of goal_end, with no Case identity.
const history = { goal: 'goal-old', status: 'available', asOf: 'goal_end',
  disposition: 'completed', certified: true,
  // Compact public facts fit the history budget; the pretty-printed trace does not.
  facts: Array.from({ length: 800 }, () => ({ a: { b: 1 } })), truncated: true }
const result = { accepted: true, view: { history }, observation: { consistency: 'committed' }, operations: [] }
const expected = { observed: true, history: { goal: 'goal-old', status: 'available',
  disposition: 'completed', certified: true, factsOnPage: 800, morePages: true } }

test('a historical read reaches Local independently of the truncated trace preview, without changing focus', async () => {
  const run = await runAgent({ argv: [], chatLines: ['Read recorded history.'], captureLocalEvents: true,
    model: round => round === 1 ? callTool('QueryBoard', { include: ['history'], selector: { goals: ['goal-old'] } }) : 'Read.',
    tool: name => name === 'QueryBoard' ? result : undefined })
  assert.equal(run.code, 0, run.stderr)
  const observed = run.localEvents.find(event => event.type === 'tool-result' && event.cmd === 'QueryBoard')
  assert.deepEqual(observed.boardRead, expected)
  assert.equal(observed.output.truncated, true)
  assert.equal(run.localEvents.some(event => event.type === 'case-open' || event.type === 'case-state'), false)
})

test('a history page in the retired v3 shape is not read as a goal history', async () => {
  const retired = { accepted: true, view: { caseHistory: { root: 'root-old', caseId: 'case-old', status: 'available',
    asOf: 'case_close', disposition: 'completed', certified: true, facts: [], truncated: false } },
  observation: { consistency: 'committed' }, operations: [] }
  const run = await runAgent({ argv: [], chatLines: ['Read recorded history.'], captureLocalEvents: true,
    model: round => round === 1 ? callTool('QueryBoard', { include: ['history'], selector: { goals: ['goal-old'] } }) : 'Read.',
    tool: name => name === 'QueryBoard' ? retired : undefined })
  assert.equal(run.code, 0, run.stderr)
  assert.deepEqual(run.localEvents.find(event => event.type === 'tool-result' && event.cmd === 'QueryBoard')?.boardRead,
    { observed: true })
})

test('a refused history read does not retain a successful history summary from its payload', async () => {
  const run = await runAgent({ argv: [], chatLines: ['Read recorded history.'], captureLocalEvents: true,
    model: round => round === 1 ? callTool('QueryBoard', { include: ['history'], selector: { goals: ['goal-old'] } }) : 'Unavailable.',
    tool: name => name === 'QueryBoard' ? { accepted: false, errorCode: 'stale_revision', requestExecuted: false,
      teaching: 'Restart at the first page.', operations: [], view: { history } } : undefined })
  assert.equal(run.code, 0, run.stderr)
  assert.equal(run.localEvents.find(event => event.type === 'tool-result')?.boardRead, undefined)
})

test('a historical read is never an operation: it is not held, waited for or replayed from the strip', async () => {
  const run = await runAgent({ argv: [], chatLines: ['Read recorded history twice.'], captureLocalEvents: true,
    model: round => round <= 2 ? callTool('QueryBoard', { include: ['history'], selector: { goals: ['goal-old'] } }) : 'Reviewed.',
    tool: name => name === 'QueryBoard' ? result : undefined })
  assert.equal(run.code, 0, run.stderr)
  assert.deepEqual(run.verbs, ['QueryBoard', 'QueryBoard'], 'each read answers its own request')
  assert.equal(run.operations.length, 0, 'a read became an operation')
  assert.equal(run.toolCalls.every(call => call.progressToken === undefined), true, 'a read asked to be held')
  assert.equal(run.pings, 0)
})

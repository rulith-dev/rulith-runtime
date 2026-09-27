// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { callTool, runAgent } from './support/agent-harness.mjs'

const history = { root: 'root-old', caseId: 'case-old', status: 'available', asOf: 'case_close',
  disposition: 'completed', certified: true,
  // Compact public facts fit the history budget; the pretty-printed trace does not.
  facts: Array.from({ length: 800 }, () => ({ a: { b: 1 } })), truncated: true }
const result = { accepted: true, view: { caseHistory: history },
  observation: { consistency: 'committed', operationAtAdmission: { state: 'none' } } }
const expected = { observed: true, history: { root: 'root-old', caseId: 'case-old', status: 'available',
  disposition: 'completed', certified: true, factsOnPage: 800, morePages: true } }

test('a historical read reaches Local independently of the truncated trace preview, without changing focus', async () => {
  const run = await runAgent({ argv: [], chatLines: ['Read recorded history.'], captureLocalEvents: true,
    model: round => round === 1 ? callTool('QueryBoard', { include: ['caseHistory'], selector: { roots: ['root-old'] } }) : 'Read.',
    tool: name => name === 'QueryBoard' ? result : undefined })
  assert.equal(run.code, 0, run.stderr)
  const observed = run.localEvents.find(event => event.type === 'tool-result' && event.cmd === 'QueryBoard')
  assert.deepEqual(observed.boardRead, expected)
  assert.equal(observed.output.truncated, true)
  assert.equal(run.localEvents.some(event => event.type === 'case-open' || event.type === 'case-state'), false)
})

test('a refused history read does not retain a successful history summary from its payload', async () => {
  const run = await runAgent({ argv: [], chatLines: ['Read recorded history.'], captureLocalEvents: true,
    model: round => round === 1 ? callTool('QueryBoard', { include: ['caseHistory'], selector: { roots: ['root-old'] } }) : 'Unavailable.',
    tool: name => name === 'QueryBoard' ? { ...result, accepted: false, errorCode: 'access_denied' } : undefined })
  assert.equal(run.code, 0, run.stderr)
  assert.equal(run.localEvents.find(event => event.type === 'tool-result')?.boardRead, undefined)
})

test('ReadOperation delivers the original historical page summary without replaying QueryBoard', async () => {
  const run = await runAgent({ argv: [], chatLines: ['Continue reviewing.'], captureLocalEvents: true,
    recovery: ({ readsDelivered }) => readsDelivered === 0
      ? { state: 'result_ready', callRef: 'call-history', tool: 'QueryBoard' } : { state: 'none' },
    readRecord: { state: 'result_ready', originalTool: 'QueryBoard',
      originalResult: { isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] } },
    model: () => 'Reviewed.' })
  assert.equal(run.code, 0, run.stderr)
  assert.deepEqual(run.verbs, ['ReadOperation'])
  assert.deepEqual(run.localEvents.find(event => event.type === 'operation-read')?.boardRead, expected)
  assert.equal(run.localEvents.some(event => event.type === 'case-open' || event.type === 'case-state'), false)
})

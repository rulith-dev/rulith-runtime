// SPDX-License-Identifier: Apache-2.0
/**
 * A stale revision is the model's to re-judge, not the host's to replay (Codex 2026-09-04 P1).
 *
 * The runtime used to read the current revision out of a `stale_case_revision` refusal and
 * resend the same step against it. The Case moved under the model — a receipt landed, a
 * discharge ran, another session wrote — and the step it chose was formed against a view
 * that no longer holds; replaying it is the host judging on the model's behalf. The
 * refusal already carries the current view, so it goes back to the model as the tool
 * result and the model decides again. Only a transport failure with no authoritative
 * answer is retried, unchanged.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgent, callTool } from './support/agent-harness.mjs'

test('RT-AG-STALE-1: a stale revision is handed back to the model and never replayed by the host', async () => {
  const seen = []
  const result = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '4' },
    tool: (name) => (name === 'ApplyBatch'
      ? {
          accepted: false,
          errorCode: 'stale_case_revision',
          teaching: 'Case revision is stale: expected c1, current c2 — re-pull this Case and retry.',
          case: { id: 'C1', revision: 'c2', status: 'open' },
          view: { goal: 'C1', state: 'open', actions: [] },
        }
      : undefined),
    model: (round, body) => {
      seen.push(body)
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'I will re-read the Case and decide again.'
    },
  })
  assert.notEqual(result.code, 'timeout', `${result.stdout}\n${result.stderr}`)
  assert.equal(result.verbs.filter((verb) => verb === 'ApplyBatch').length, 1,
    `the host replayed the stale step instead of returning it: ${result.verbs.join(', ')}`)
  const third = JSON.stringify(seen[2] ?? {})
  assert.match(third, /stale_case_revision/, 'the refusal must reach the model as the tool result of its own step')
  assert.match(result.stdout, /Board rejected ApplyBatch: Case revision is stale/)
})

// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgent, callTool } from './support/agent-harness.mjs'

for (const thinking of ['enabled', 'disabled']) test(`Messages endpoints refuse unsupported explicit thinking: ${thinking}`, async () => {
  const run = await runAgent({ argv: ['Hello'], provider: 'anthropic', captureLocalEvents: true,
    env: { RULITH_MODEL_THINKING: thinking }, model: () => 'Must not run' })
  assert.equal(run.modelRequests.length, 0)
  assert.equal(run.code, 1)
  assert.match(run.stderr, /Choose Provider default/)
  assert.equal(run.initializes.length, 0, 'invalid configuration must fail before the MCP session starts')
})

for (const thinking of ['enabled', 'disabled', '']) test(`OpenAI model thinking setting is preserved: ${thinking || 'provider default'}`, async () => {
  const run = await runAgent({ argv: [], provider: 'openai', chatLines: ['Hello'],
    env: { RULITH_MODEL_THINKING: thinking }, model: () => 'Hello' })
  assert.equal(run.code, 0, run.stderr)
  assert.deepEqual(run.modelRequests[0].thinking, thinking ? { type: thinking } : undefined)
})

test('provider reasoning continuation survives tool results and later conversation turns without entering user output or Board requests', async () => {
  const first = 'opaque-provider-continuation-α', second = 'opaque-provider-continuation-β'
  const run = await runAgent({ argv: [], provider: 'openai', captureLocalEvents: true, chatLines: ['Check the board.', 'Thanks.'],
    model: round => round === 1 ? { ...callTool('QueryBoard', {}), reasoningContent: first }
      : round === 2 ? { text: 'Board read.', reasoningContent: second } : 'You are welcome.' })
  assert.equal(run.code, 0, run.stderr)
  assert.equal(run.modelRequests.length, 3)
  assert.equal(run.modelRequests[1].messages.find(row => row.role === 'assistant').reasoning_content, first)
  assert.deepEqual(run.modelRequests[2].messages.filter(row => row.role === 'assistant').map(row => row.reasoning_content), [first, second])
  assert.ok(run.localEvents.length)
  assert.doesNotMatch(run.stdout + run.stderr + JSON.stringify(run.toolCalls) + JSON.stringify(run.localEvents), /opaque-provider-continuation/)
})

test('a malformed reasoning/tool conversation is not retried by disabling native tools', async () => {
  const run = await runAgent({ argv: [], provider: 'openai', chatLines: ['Check.'],
    model: () => ({ status: 400, body: { error: { message: 'Missing reasoning_content for an assistant tool call' } } }) })
  assert.notEqual(run.code, 0)
  assert.equal(run.modelRequests.length, 1)
  assert.ok(run.modelRequests[0].tools.length)
  assert.doesNotMatch(run.stdout, /same six tools are now described/)
})

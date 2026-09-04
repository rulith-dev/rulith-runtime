// SPDX-License-Identifier: Apache-2.0
/**
 * Exact-or-fail at the first membrane a literal crosses (Codex 2026-09-04 P0).
 *
 * `JSON.parse` rounds 9007199254740993 to 9007199254740992 before any code can look at
 * it, so a runtime that forwards parsed tool arguments sends the Board a number the model
 * never wrote — and the Board's value grounding may then vouch for it. The look has to
 * happen on the text: the Chat Completions `arguments` string, the Messages response body,
 * and the emulated reply. Each arm proves the call never reached the gateway and that the
 * model was told to write the identifier as a string. The calibration arm proves the
 * largest exact integer still passes, so the scanner is not a blanket refusal of big numbers.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgent, callTool } from './support/agent-harness.mjs'

const BEYOND = '9007199254740993'
const EXACT_MAX = '9007199254740991'
const rawArgs = (n) => `{"action":"tally","args":{"path":"reports/tally.txt","count":${n}}}`

/** Open a Case first, then make the call under test, then stop. */
const script = (second) => (round) => {
  if (round === 1) return callTool('OpenCase', {})
  if (round === 2) return second
  return 'Understood.'
}

async function run(options) {
  const result = await runAgent({ argv: ['do the work'], env: { RULITH_MAX_ROUNDS: '4', ...(options.env ?? {}) }, ...options })
  assert.notEqual(result.code, 'timeout', `${result.stdout}\n${result.stderr}`)
  return result
}

test('RT-AG-EXACT-1: a Chat Completions tool call carrying an integer beyond 2^53-1 is refused on the arguments text', async () => {
  const result = await run({ provider: 'openai', model: script(callTool('ApplyAction', {}, { rawArguments: rawArgs(BEYOND) })) })
  assert.ok(!result.verbs.includes('ApplyAction'), `the inexact call reached the gateway: ${result.verbs.join(', ')}`)
  assert.match(result.stdout, /outside the exact number domain/)
  assert.match(result.stdout, new RegExp(BEYOND), 'the refusal must quote the literal the model wrote')
})

test('RT-AG-EXACT-2: a Messages tool_use carrying the same literal is refused on the response text', async () => {
  const result = await run({ provider: 'anthropic', model: script(callTool('ApplyAction', {}, { rawInput: rawArgs(BEYOND) })) })
  assert.ok(!result.verbs.includes('ApplyAction'), `the inexact call reached the gateway: ${result.verbs.join(', ')}`)
  assert.match(result.stdout, /outside the exact number domain/)
})

test('RT-AG-EXACT-3: the emulated transport refuses the literal in the model\'s JSON reply', async () => {
  // Emulated transport: the model answers with one JSON object per call, so the whole
  // script is text — a tool_calls block would be ignored on this transport.
  const result = await run({
    env: { RULITH_MODEL_TOOLS: 'emulated' },
    model: (round) => {
      if (round === 1) return '{"tool":"OpenCase","input":{}}'
      if (round === 2) return `{"tool":"ApplyAction","input":${rawArgs(BEYOND)}}`
      return 'Understood.'
    },
  })
  assert.ok(!result.verbs.includes('ApplyAction'), `the inexact call reached the gateway: ${result.verbs.join(', ')}`)
  assert.match(result.stdout, /outside the exact number domain/)
})

test('RT-AG-EXACT-4: the largest exact integer passes through unchanged (calibration)', async () => {
  const result = await run({ provider: 'openai', model: script(callTool('ApplyAction', {}, { rawArguments: rawArgs(EXACT_MAX) })) })
  assert.ok(result.verbs.includes('ApplyAction'), `the exact call never reached the gateway: ${result.verbs.join(', ')}\n${result.stdout}\n${result.stderr}`)
  const sent = result.toolCalls.find((call) => call.name === 'ApplyAction')
  assert.equal(sent?.args?.args?.count, 9007199254740991)
  assert.doesNotMatch(result.stdout, /outside the exact number domain/)
})

// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { readWorkerReviewContract, loadWorkerReviewContract } from '../scripts/verify-worker-review-contract.mjs'
import { readWorkerContract } from '../scripts/verify-worker-contract.mjs'
import { askPreExecutionReviewer, createPreExecutionReviewHandler, parsePreExecutionReply, reviewerAnswer,
  reviewerAdvertisement, reviewerMaxTokens, reviewerRequestExtra, REVIEWER_REQUEST_RESERVED_KEYS } from '../worker/rulith-worker.mjs'
import { reviewerMaxTokens as reviewerBudget, reviewerRoute } from '../local/model-settings.mjs'
import { shapeFaults } from './support/contract-shape.mjs'
import { DONE, HOLD, RESET, activeLease, driveWorker } from './support/worker-harness.mjs'

const bundle = JSON.parse(readFileSync(new URL('../protocol/worker-review-contract.json', import.meta.url), 'utf8'))
const contract = readWorkerReviewContract(bundle)
const workerContract = readWorkerContract(JSON.parse(readFileSync(new URL('../protocol/worker-contract.json', import.meta.url), 'utf8')))
const material = {
  boardView: { nodes: [{ nodeId: 'F1', args: { id: 'business-id' } }], goals: { directory: [{ goal: 'G1' }] } },
  focusedGoalNodes: [{ id: 'G2' }], focusedTheory: { facts: [], rules: [] }, delta: {}, priorSuggestions: [],
  priorNotes: [{ verdict: 'note', node: 'old-node', advice: 'old advice' }],
  call: { tool: 'Set', kind: 'Set', arguments: { z: 1, a: { y: 2, b: 3 } },
    result: { accepted: true, status: 'accepted', summary: 'Recorded the goal.' } },
}
const offer = (overrides = {}) => ({ workType: 'review', purpose: 'pre_execution', id: 'review-1',
  materialDigest: `sha256:${'a'.repeat(64)}`, systemPrompt: contract.defs.WorkerPreExecutionReviewOffer.properties.systemPrompt.const,
  material, remainingMs: 5000, ...overrides })
const replyResponse = reply => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: reply } }] }))
const lengthResponse = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] }))
// D-1013f: post-call advice only; the contract's replies are allow and note, and block is malformed.
const valid = [{ verdict: 'allow' }, { verdict: 'note', node: 'F1', advice: 'Check the premise.' }]
const malformed = {
  block: '{"verdict":"block","node":"G2","advice":"The criterion is too weak."}',
  fence: '```json\n{"verdict":"allow"}\n```',
  extra: '{"verdict":"allow","reason":"extra"}',
  two: '{"verdict":"allow"}{"verdict":"allow"}',
  unknown: '{"verdict":"note","node":"F9","advice":"A defect."}',
  multiline: '{"verdict":"note","node":"F1","advice":"First\\nsecond"}',
  trailingNewline: '{"verdict":"note","node":"F1","advice":"First\\n"}',
  carriageReturn: '{"verdict":"note","node":"F1","advice":"First\\r"}',
  empty: '{"verdict":"note","node":"F1","advice":""}',
  whitespace: '{"verdict":"note","node":"F1","advice":"  "}',
  long: JSON.stringify({ verdict: 'note', node: 'F1', advice: 'x'.repeat(501) }),
  duplicate: '{"verdict":"note","verdict":"allow"}',
  escapedDuplicate: '{"verdict":"note","\\u0076erdict":"allow"}',
  array: '[{"verdict":"allow"}]',
  businessId: '{"verdict":"note","node":"business-id","advice":"A defect."}',
  priorOnly: '{"verdict":"note","node":"old-node","advice":"A defect."}',
}

function handler({ fetchReviewer, retryMs = [], ...options } = {}) {
  const sent = [], logs = [], calls = []
  let generation = 7
  const handle = createPreExecutionReviewHandler({
    identityOf: () => ({ workerId: 'wkr_test_123', workerGeneration: generation }),
    alive: () => true, keepAlive: () => async () => {}, retryMs,
    ask: (w, settings) => askPreExecutionReviewer(w, { ...settings, url: 'http://reviewer.invalid', model: 'review-test',
      fetchReviewer: async (url, request) => { calls.push(JSON.parse(request.body)); return fetchReviewer(url, request) } }),
    report: async (body, identity) => { sent.push(JSON.parse(JSON.stringify({ ...body, ...identity }))); return { accepted: true } },
    log: event => logs.push(event), ...options,
  })
  return { handle, sent, logs, calls, generation: value => { generation = value } }
}

test('in-process reviewer capability on/off follows the closed Poll schema', () => {
  for (const [url, model, enabled] of [['', '', false], ['http://reviewer.invalid', '', false], ['', 'model', false], ['http://reviewer.invalid', 'model', true]]) {
    const advertisement = reviewerAdvertisement(url, model)
    assert.deepEqual(advertisement, enabled ? { reviewer: { preExecution: true } } : {})
    const poll = { kind: 'Poll', tools: [], workerId: 'wkr_test_123', ...advertisement }
    assert.deepEqual(shapeFaults(poll, workerContract.defs.PollRequest, workerContract.defs), [])
    assert.doesNotMatch(JSON.stringify(poll), /reviewer.invalid|model/)
  }
})

for (const reply of valid) test(`in-process offer -> model -> ${reply.verdict} report is schema-valid`, async () => {
  // The sample offer is a D-1013f offer: `call` carries the executed call's result and no intent.
  assert.deepEqual(shapeFaults(offer(), contract.defs.WorkerPreExecutionReviewOffer, contract.defs), [])
  const run = handler({ fetchReviewer: async () => replyResponse(JSON.stringify(reply)) })
  await run.handle(offer())
  assert.deepEqual(run.sent[0], { kind: 'ReportWork', workType: 'review', purpose: 'pre_execution',
    id: 'review-1', materialDigest: offer().materialDigest, workerId: 'wkr_test_123', workerGeneration: 7, reply })
  assert.deepEqual(shapeFaults(run.sent[0], contract.defs.ReportWorkPreExecutionReview, contract.defs), [])
  const body = run.calls[0]
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'temperature'])
  assert.equal(body.messages.length, 2)
  assert.deepEqual(body.messages[0], { role: 'system', content: offer().systemPrompt })
  assert.deepEqual(JSON.parse(body.messages[1].content), material)
  assert.match(body.messages[1].content, /"arguments":\{"a":\{"b":3,"y":2\},"z":1\}/)
  assert.equal(run.logs[0].accepted, true)
  assert.equal(run.logs[0].workerGeneration, 7)
  assert.equal(run.logs[0].verdict, reply.verdict)
  assert.equal(run.logs[0].tool, 'Set')
  assert.ok(run.logs[0].elapsedMs >= 0)
  assert.doesNotMatch(JSON.stringify(run.logs), /criterion|premise|Recorded the goal|SHADOW/)
})

for (const [name, text] of Object.entries(malformed)) test(`in-process malformed ${name} returns a bounded error report`, async () => {
  const run = handler({ fetchReviewer: async () => replyResponse(text) })
  await run.handle(offer())
  assert.equal(run.sent[0].reply, undefined)
  assert.equal(run.sent[0].errorCode, 'review_invalid_reply')
  // An answered but malformed reply fails closed: time remains, yet the model is not asked again.
  assert.equal(run.calls.length, 1)
  assert.deepEqual(shapeFaults(run.sent[0], contract.defs.ReportWorkPreExecutionReview, contract.defs), [])
})

const cutOffReplies = {
  'length finish': lengthResponse,
  'empty content': () => replyResponse(''),
  'absent content': () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {} }] })),
}
for (const [name, first] of Object.entries(cutOffReplies)) test(`in-process ${name} is asked once more and the second reply is reported`, async () => {
  let n = 0
  const run = handler({ fetchReviewer: async () => ++n === 1 ? first() : replyResponse('{"verdict":"allow"}') })
  await run.handle(offer())
  assert.equal(run.calls.length, 2)
  assert.deepEqual(run.calls[0], run.calls[1])
  assert.deepEqual(run.sent[0].reply, { verdict: 'allow' })
  assert.equal(run.sent[0].errorCode, undefined)
})

test('in-process two cut-off replies report review_invalid_reply after exactly two model calls', async () => {
  for (const second of [lengthResponse, cutOffReplies['empty content'], () => replyResponse('{"verdict":"allow"}{')]) {
    let n = 0
    const run = handler({ fetchReviewer: async () => ++n === 1 ? lengthResponse() : second() })
    await run.handle(offer())
    assert.equal(run.calls.length, 2)
    assert.equal(run.sent[0].errorCode, 'review_invalid_reply')
  }
})

test('in-process no retry when the deadline leaves less than the first call plus the margin', async () => {
  const slow = delayMs => {
    let calls = 0
    return { calls: () => calls, fetchReviewer: async () => {
      calls++
      await new Promise(resolve => setTimeout(resolve, delayMs))
      return lengthResponse()
    } }
  }
  const settings = { url: 'http://reviewer.invalid', model: 'review-test', timeoutMs: 2000 }
  // About 600 ms used and 1400 ms left, less than 600 + 1000: the first error stands.
  const tight = slow(600)
  assert.deepEqual(await askPreExecutionReviewer(offer(), { ...settings, fetchReviewer: tight.fetchReviewer }),
    { errorCode: 'review_invalid_reply' })
  assert.equal(tight.calls(), 1)
  // About 200 ms used and 1800 ms left, at least 200 + 1000: one more call, never a third.
  const roomy = slow(200)
  assert.deepEqual(await askPreExecutionReviewer(offer(), { ...settings, fetchReviewer: roomy.fetchReviewer }),
    { errorCode: 'review_invalid_reply' })
  assert.equal(roomy.calls(), 2)
})

test('in-process reviewer max_tokens defaults to 8000 and accepts only a positive integer override', async () => {
  assert.equal(reviewerMaxTokens(undefined), 8000)
  for (const value of ['', '0', '-1', 'abc', '1.5', '1e4', '0x10', '9007199254740993']) {
    assert.equal(reviewerMaxTokens(value), 8000, value)
  }
  assert.equal(reviewerMaxTokens('12000'), 12000)
  assert.equal(reviewerMaxTokens(' 4096 '), 4096)
  let body
  const result = await askPreExecutionReviewer(offer(), { url: 'http://reviewer.invalid', model: 'review-test',
    timeoutMs: 1000, maxTokens: 1234,
    fetchReviewer: async (_url, request) => { body = JSON.parse(request.body); return replyResponse('{"verdict":"allow"}') } })
  assert.deepEqual(result, { reply: { verdict: 'allow' } })
  assert.equal(body.max_tokens, 1234)
})

test('in-process RULITH_REVIEWER_REQUEST_EXTRA reads a JSON object and refuses anything else without echoing it', () => {
  assert.deepEqual(reviewerRequestExtra(undefined), {})
  assert.deepEqual(reviewerRequestExtra('  '), {})
  assert.deepEqual(reviewerRequestExtra('{"chat_template_kwargs":{"enable_thinking":true},"reasoning_effort":"high"}'),
    { chat_template_kwargs: { enable_thinking: true }, reasoning_effort: 'high' })
  assert.deepEqual(REVIEWER_REQUEST_RESERVED_KEYS,
    ['model', 'messages', 'max_tokens', 'temperature', 'stream', 'tools', 'tool_choice', 'n'])
  for (const [value, message] of [
    ['{"secret-value-1":', /is not valid JSON$/],
    ['secret-value-2', /is not valid JSON$/],
    ['["secret-value-3"]', /must be a JSON object$/],
    ['null', /must be a JSON object$/],
    ['"secret-value-4"', /must be a JSON object$/],
    ['42', /must be a JSON object$/],
  ]) assert.throws(() => reviewerRequestExtra(value), error => message.test(error.message) && !/secret-value/.test(error.message), value)
  for (const key of REVIEWER_REQUEST_RESERVED_KEYS) {
    assert.throws(() => reviewerRequestExtra(JSON.stringify({ [key]: 'secret-value-5', chat_template_kwargs: {} })),
      error => error.message === `RULITH_REVIEWER_REQUEST_EXTRA may not set ${key}; the Worker controls it`, key)
  }
  assert.throws(() => reviewerRequestExtra('{"stream":true,"n":2}'),
    { message: 'RULITH_REVIEWER_REQUEST_EXTRA may not set stream, n; the Worker controls them' })
})

test('in-process request extra is merged into the post-call model request beside the Worker keys', async () => {
  let body
  const extra = reviewerRequestExtra('{"chat_template_kwargs":{"enable_thinking":true},"reasoning_effort":"low"}')
  const result = await askPreExecutionReviewer(offer(), { url: 'http://reviewer.invalid', model: 'review-test',
    timeoutMs: 1000, maxTokens: 1234, extra,
    fetchReviewer: async (_url, request) => { body = JSON.parse(request.body); return replyResponse('{"verdict":"allow"}') } })
  assert.deepEqual(result, { reply: { verdict: 'allow' } })
  assert.deepEqual(Object.keys(body).sort(), ['chat_template_kwargs', 'max_tokens', 'messages', 'model', 'reasoning_effort', 'temperature'])
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true })
  assert.equal(body.reasoning_effort, 'low')
  assert.equal(body.model, 'review-test')
  assert.equal(body.max_tokens, 1234)
  assert.equal(body.temperature, 0)
})

// 0.19.2 (D-1026a): a reviewer Connection reviews with its Agent's own model, so the reviewer speaks that model's wire.
// An endpoint ending in /messages is Anthropic Messages; the system prompt and the user content are the same bytes as on
// the Chat Completions wire, only the envelope and the key's header differ.
const messagesResponse = (text, stop = 'end_turn', extra = []) => new Response(JSON.stringify({ type: 'message', role: 'assistant',
  content: [{ type: 'thinking', thinking: '{"verdict":"allow"} perhaps' }, ...(text === null ? [] : [{ type: 'text', text }]), ...extra],
  stop_reason: stop }))
test('in-process reviewer speaks Anthropic Messages for an endpoint ending in /messages, with the same prompt and content', async () => {
  const seen = []
  const capture = respond => async (url, request) => { seen.push({ url, headers: request.headers, body: JSON.parse(request.body) }); return respond() }
  const note = '{"verdict":"note","node":"F1","advice":"Check the premise."}'
  const settings = { timeoutMs: 5000, maxTokens: 1234, extra: {}, key: 'k-review', model: 'review-test' }
  assert.deepEqual(await askPreExecutionReviewer(offer(), { ...settings, url: 'http://reviewer.invalid/v1',
    fetchReviewer: capture(() => replyResponse(note)) }), { reply: { verdict: 'note', node: 'F1', advice: 'Check the premise.' } })
  assert.deepEqual(await askPreExecutionReviewer(offer(), { ...settings, url: 'http://reviewer.invalid/v1/messages',
    fetchReviewer: capture(() => messagesResponse(note)) }), { reply: { verdict: 'note', node: 'F1', advice: 'Check the premise.' } })
  const [chat, messages] = seen
  assert.deepEqual(chat.headers, { 'content-type': 'application/json', authorization: 'Bearer k-review' })
  assert.deepEqual(messages.headers, { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'k-review' })
  // No temperature on Messages: current Claude models refuse sampling parameters (HTTP 400).
  assert.deepEqual(messages.body, { model: 'review-test', max_tokens: 1234, system: chat.body.messages[0].content,
    messages: [{ role: 'user', content: chat.body.messages[1].content }] })
  assert.equal(chat.body.temperature, 0, 'Chat Completions keeps temperature 0')
  // RULITH_REVIEWER_REQUEST_EXTRA is OpenAI-shaped: it reaches the Chat Completions wire only.
  const extra = reviewerRequestExtra('{"chat_template_kwargs":{"enable_thinking":true},"reasoning_effort":"low"}')
  await askPreExecutionReviewer(offer(), { ...settings, extra, url: 'http://reviewer.invalid/v1/messages', fetchReviewer: capture(() => messagesResponse(note)) })
  await askPreExecutionReviewer(offer(), { ...settings, extra, url: 'http://reviewer.invalid/v1', fetchReviewer: capture(() => replyResponse(note)) })
  assert.deepEqual(Object.keys(seen[2].body).sort(), ['max_tokens', 'messages', 'model', 'system'])
  assert.deepEqual(Object.keys(seen[3].body).sort(), ['chat_template_kwargs', 'max_tokens', 'messages', 'model', 'reasoning_effort', 'temperature'])
  assert.equal(chat.body.messages[0].content, offer().systemPrompt, 'the reviewer prompt is the contract\'s, unchanged')
  // Only text parts are the answer (never a thinking part); a cut-off or empty answer is asked once more; a tool call or
  // another stop reason is malformed.
  assert.deepEqual(reviewerAnswer({ content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }], stop_reason: 'end_turn' }),
    { content: 'ab', finish: 'stop', toolUse: false })
  assert.deepEqual(reviewerAnswer({ choices: [{ finish_reason: 'stop', message: { content: 'c' } }] }), { content: 'c', finish: 'stop', toolUse: false })
  let calls = 0
  assert.deepEqual(await askPreExecutionReviewer(offer(), { ...settings, url: 'http://reviewer.invalid/v1/messages',
    fetchReviewer: async () => (++calls === 1 ? messagesResponse(null, 'max_tokens') : messagesResponse('{"verdict":"allow"}')) }),
  { reply: { verdict: 'allow' } })
  assert.equal(calls, 2, 'a cut-off answer is asked once more')
  for (const [response, why] of [[() => messagesResponse(null, 'tool_use', [{ type: 'tool_use', id: 't', name: 'x', input: {} }]), 'tool'],
    [() => messagesResponse('{"verdict":"allow"}', 'refusal'), 'refusal'], [() => messagesResponse('```json\n{"verdict":"allow"}\n```'), 'fence']]) {
    assert.deepEqual(await askPreExecutionReviewer(offer(), { ...settings, url: 'http://reviewer.invalid/v1/messages', fetchReviewer: async () => response() }),
      { errorCode: 'review_invalid_reply' }, why)
  }
})

test('in-process the Agent\'s own model is its Worker\'s reviewer route on either wire, and no model leaves none', () => {
  assert.deepEqual(reviewerRoute({ url: 'https://api.anthropic.com/v1/messages', name: 'claude-test', key: 'k' }),
    { RULITH_REVIEWER_URL: 'https://api.anthropic.com/v1/messages', RULITH_REVIEWER_MODEL: 'claude-test', RULITH_REVIEWER_KEY: 'k' })
  assert.deepEqual(reviewerRoute({ url: 'https://api.deepseek.com/v1', name: 'deepseek-chat', key: 'k' }),
    { RULITH_REVIEWER_URL: 'https://api.deepseek.com/v1/chat/completions', RULITH_REVIEWER_MODEL: 'deepseek-chat', RULITH_REVIEWER_KEY: 'k' })
  for (const model of [{}, { url: 'https://api.deepseek.com/v1', name: '' }, { url: '', name: 'm' }])
    assert.deepEqual(reviewerRoute(model), { RULITH_REVIEWER_URL: '', RULITH_REVIEWER_MODEL: '', RULITH_REVIEWER_KEY: '' }, JSON.stringify(model))
  // Its output budget: the Agent's effective maximum output (saved, else the route's default 6000), at most 16000.
  assert.deepEqual([undefined, '', '6000', ' 9000 ', '16000', '20000', 'abc', '100'].map(reviewerBudget),
    ['6000', '6000', '6000', '9000', '16000', '16000', '6000', '6000'])
})

test('in-process single-line advice may contain quoted JSON and Unicode at the schema limit', () => {
  for (const advice of ['Check {"node":"F1"}.', '🙂'.repeat(500)]) {
    const reply = { verdict: 'note', node: 'G1', advice }
    assert.deepEqual(parsePreExecutionReply(JSON.stringify(reply), material), reply)
  }
})

test('in-process anchors include public fact, goal-node and Board action rows', () => {
  const boardMaterial = { ...material, boardView: {
    facts: [{ nodeId: 'F2', args: { id: 'business-id' } }],
    goalNodes: [{ id: 'G3' }], actions: [{ actionNodeId: 'A1', action: 'Board action' }],
  } }
  for (const node of ['F2', 'G3', 'A1']) {
    const reply = { verdict: 'note', node, advice: 'Check the premise.' }
    assert.deepEqual(parsePreExecutionReply(JSON.stringify(reply), boardMaterial), reply)
  }
})

// PSC 0.2.10 (review-material-bounds, Worker half): a note anchored on a focusedTheory row,
// such as the rule that derives a warrant, is a note on a node the material actually gives.
const theoryMaterial = { ...material, focusedTheory: {
  facts: [{ nodeId: 'F7', label: 'design_ok(path=src/a.txt)' },
    { nodeId: 'D3', label: 'warrant(action=write_file, path=src/a.txt)', derived: true }],
  rules: [{ nodeId: 'R2', label: 'design permits writing its file',
    when: [{ predicate: 'design_ok', args: { path: '?p', id: 'rule-arg' } }],
    then: [{ predicate: 'warrant', args: { action: 'write_file', path: '?p' } }], createdBy: 'agent' }],
  truncated: true, omitted: 4 },
priorSuggestions: [{ nodeId: 'S1', label: 'suggestion(id=s1, node=G1, advice=advice 1)' }] }

test('in-process anchors include focusedTheory fact and rule rows', async () => {
  assert.deepEqual(shapeFaults(offer({ material: theoryMaterial }), contract.defs.WorkerPreExecutionReviewOffer, contract.defs), [])
  for (const node of ['F7', 'D3', 'R2', 'F1', 'G2']) {
    const reply = { verdict: 'note', node, advice: 'The warrant rule admits writes the design does not justify.' }
    assert.deepEqual(parsePreExecutionReply(JSON.stringify(reply), theoryMaterial), reply)
  }
  // The same reply is reported, not refused, on the whole offer -> model -> report path.
  const reply = { verdict: 'note', node: 'R2', advice: 'The warrant rule admits writes the design does not justify.' }
  const run = handler({ fetchReviewer: async () => replyResponse(JSON.stringify(reply)) })
  await run.handle(offer({ material: theoryMaterial }))
  assert.deepEqual(run.sent[0].reply, reply)
  assert.equal(run.sent[0].errorCode, undefined)
  assert.deepEqual(JSON.parse(run.calls[0].messages[1].content).focusedTheory, theoryMaterial.focusedTheory)
})

test('in-process anchors include the node of each boardView.userRequests row', async () => {
  // PSC 0.2.9 (D-1013e): the reviewer prompt tells it to name the user_request node a goal drops.
  const requestMaterial = { ...theoryMaterial, boardView: { ...material.boardView,
    userRequests: [{ node: 'HREQ_1', text: 'Load 10,000 rows in under a minute.' },
      { node: 'HREQ_2', text: 'Keep the import idempotent.' }] } }
  assert.deepEqual(shapeFaults(offer({ material: requestMaterial }), contract.defs.WorkerPreExecutionReviewOffer, contract.defs), [])
  const reply = { verdict: 'note', node: 'HREQ_2', advice: 'The acceptance criterion drops the idempotency the person asked for.' }
  assert.deepEqual(parsePreExecutionReply(JSON.stringify(reply), requestMaterial), reply)
  const run = handler({ fetchReviewer: async () => replyResponse(JSON.stringify(reply)) })
  await run.handle(offer({ material: requestMaterial }))
  assert.deepEqual(run.sent[0].reply, reply)
  // The request text, a rule's condition argument and a request absent from this view are not anchors.
  for (const node of ['Keep the import idempotent.', 'rule-arg', 'HREQ_3']) {
    assert.equal(parsePreExecutionReply(JSON.stringify({ verdict: 'note', node, advice: 'A defect.' }), requestMaterial), undefined, node)
  }
  assert.equal(parsePreExecutionReply('{"verdict":"note","node":"HREQ_1","advice":"A defect."}', theoryMaterial), undefined)
})

test('in-process anchors outside the material still fail with a focusedTheory present', async () => {
  // A rule's condition arguments, a prior suggestion, a prior note and an unknown node are not
  // anchors; neither is a theory row in a material that does not carry it.
  for (const node of ['rule-arg', 'S1', 'old-node', 'F9', '?p', 'warrant']) {
    assert.equal(parsePreExecutionReply(JSON.stringify({ verdict: 'note', node, advice: 'A defect.' }), theoryMaterial), undefined, node)
  }
  assert.equal(parsePreExecutionReply('{"verdict":"note","node":"R2","advice":"A defect."}', material), undefined)
  const run = handler({ fetchReviewer: async () => replyResponse('{"verdict":"note","node":"rule-arg","advice":"A defect."}') })
  await run.handle(offer({ material: theoryMaterial }))
  assert.equal(run.sent[0].reply, undefined)
  assert.equal(run.sent[0].errorCode, 'review_invalid_reply')
  assert.equal(run.calls.length, 1)
})

test('in-process post-call budget comes from the offer remainingMs alone (0.16.3)', async () => {
  const budgets = []
  // A timeoutMs option is no longer read: before 0.16.3 the budget was min(RULITH_REVIEWER_TIMEOUT_MS, remainingMs).
  const run = handler({ timeoutMs: 30, ask: async (_w, settings) => {
    budgets.push(settings.timeoutMs)
    return { reply: { verdict: 'allow' } }
  } })
  await run.handle(offer({ remainingMs: 200_000 }))
  assert.equal(budgets.length, 1)
  // 200 s offered, above the 120 s clearance default: the whole remainder less the 100 ms report margin.
  assert.ok(budgets[0] > 199_000 && budgets[0] <= 199_900, String(budgets[0]))
  assert.deepEqual(run.sent[0].reply, { verdict: 'allow' })
})

test('in-process timeout aborts the HTTP request and keeps the report margin', async () => {
  let aborted = false
  const run = handler({ fetchReviewer: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('abort')) }, { once: true })
  }) })
  const started = performance.now()
  await run.handle(offer({ remainingMs: 180 }))
  assert.equal(run.sent[0].errorCode, 'review_timeout')
  assert.equal(aborted, true)
  assert.equal(run.calls.length, 1)
  assert.ok(performance.now() - started < 400)
})

test('in-process queue time consumes remainingMs before calling the model', async () => {
  const run = handler({ fetchReviewer: async () => replyResponse('{"verdict":"allow"}') })
  await run.handle(offer({ remainingMs: 1000 }), performance.now() - 1100)
  assert.equal(run.calls.length, 0)
  assert.equal(run.sent[0].errorCode, 'review_timeout')
})

for (const reason of ['review_shutdown', 'review_lease_lost']) test(`in-process ${reason} aborts and reports under the original generation`, async () => {
  let live = true, aborted = false
  const run = handler({
    alive: () => live ? true : reason,
    fetchReviewer: (_url, { signal }) => new Promise((_resolve, reject) => {
      setTimeout(() => { live = false; run.generation(8) }, 5)
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('abort')) }, { once: true })
    }),
  })
  await run.handle(offer())
  assert.equal(aborted, true)
  assert.equal(run.sent[0].errorCode, reason)
  assert.equal(run.sent[0].workerGeneration, 7)
})

for (const [name, response, code] of [
  ['HTTP', () => new Response('private provider body', { status: 503 }), 'review_model_http_error'],
  ['transport', () => { throw new Error('private provider body') }, 'review_model_error'],
  ['envelope', () => new Response('not JSON'), 'review_model_error'],
  ['truncated', () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"verdict":"allow"}' } }] })), 'review_invalid_reply'],
  ['tool call', () => new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"allow"}', tool_calls: [] } }] })), 'review_invalid_reply'],
]) test(`in-process model ${name} failure reports only a machine code`, async () => {
  const run = handler({ fetchReviewer: async () => response() })
  await run.handle(offer())
  assert.equal(run.sent[0].errorCode, code)
  // Only a truncated reply is asked once more; HTTP, transport, envelope and tool-call failures are not.
  assert.equal(run.calls.length, name === 'truncated' ? 2 : 1)
  assert.doesNotMatch(JSON.stringify([run.logs, run.sent]), /private provider/)
})

test('in-process cache and transport retries resend byte-identical reports with the original identity', async () => {
  const reports = []
  let attempts = 0
  const run = handler({ retryMs: [0, 0], fetchReviewer: async () => replyResponse('{"verdict":"allow"}'),
    report: async (body, identity) => {
      reports.push(JSON.stringify({ ...body, ...identity }))
      if (++attempts === 1) throw new Error('connection reset')
      if (attempts === 2) return { accepted: false }
      return { accepted: true }
    },
  })
  await run.handle(offer())
  run.generation(8)
  await run.handle(offer({ remainingMs: 1 }))
  assert.equal(run.calls.length, 1)
  assert.equal(reports.length, 4)
  assert.equal(new Set(reports).size, 1)
  await run.handle(offer({ materialDigest: `sha256:${'b'.repeat(64)}` }))
  assert.equal(run.calls.length, 2)
})

test('in-process failed model result is cached and semantic report refusals stop retries', async () => {
  let reports = 0
  const run = handler({ retryMs: [0, 0], fetchReviewer: async () => new Response('private', { status: 500 }),
    report: async () => { reports++; return { accepted: false, errorCode: 'review_expired' } } })
  await run.handle(offer())
  await run.handle(offer())
  assert.equal(run.calls.length, 1)
  assert.equal(reports, 2)
  assert.equal(run.logs[0].accepted, false)
})

for (const reply of valid.slice(1)) test(`in-process completed ${reply.verdict} replay keeps the original report`, async () => {
  const run = handler({ fetchReviewer: async () => replyResponse(JSON.stringify(reply)) })
  await run.handle(offer())
  await run.handle(offer())
  assert.equal(run.calls.length, 1)
  assert.equal(run.sent.length, 2)
  assert.deepEqual(run.sent[0], run.sent[1])
})

test('in-process material previews pass through unchanged and absent anchors fail', async () => {
  const preview = { preview: '🙂'.repeat(4096), characters: 4097, truncated: true }
  const offered = offer({ material: { ...material,
    call: { ...material.call, arguments: { content: preview } } } })
  const before = JSON.stringify(offered)
  const run = handler({ fetchReviewer: async () => replyResponse('{"verdict":"allow"}') })
  await run.handle(offered)
  assert.equal(JSON.stringify(offered), before)
  assert.deepEqual(JSON.parse(run.calls[0].messages[1].content).call.arguments.content, preview)
  assert.equal(parsePreExecutionReply('{"verdict":"note","node":"F9","advice":"Missing."}', offered.material), undefined)
})

test('in-process review bundle detects changed bytes, pins and projected definitions', () => {
  assert.equal(contract.sourceCommit, '3b53a055e8b1986da2bd479100ff2f6af00c40dd')
  for (const mutate of [copy => { copy.files[Object.keys(copy.files)[0]].content += '\n' },
    copy => { copy.files[Object.keys(copy.files)[0]].gitBlobOid = '0'.repeat(40) },
    copy => { copy.contract.$defs.ReviewerCapability.properties.preExecution.const = false }]) {
    const copy = structuredClone(bundle)
    mutate(copy)
    assert.throws(() => readWorkerReviewContract(copy))
  }
})

test('runtime vendored review contract verifies byte-exact against the committed spec', () => {
  assert.equal(loadWorkerReviewContract().sourceCommit, contract.sourceCommit)
})

for (const reply of valid) test(`runtime Poll offer takes pre-execution ${reply.verdict} path without ClaimWork`, async () => {
  let polls = 0
  const run = await driveWorker({ reviewer: reply,
    reply: operation => operation.kind === 'Poll'
      ? ++polls === 1 ? { body: { accepted: true, payload: { work: [offer()] } } } : HOLD
      : operation.kind === 'ReportWork' ? { body: { accepted: true } } : undefined,
    done: (_seen, output) => /Pre-execution review.*report accepted=true/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.deepEqual(run.of('Poll')[0].operation.reviewer, { preExecution: true })
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(run.modelRequests.length, 1)
  assert.equal(run.modelRequests[0].body.max_tokens, 8000)
  assert.deepEqual(run.of('ReportWork')[0].operation.reply, reply)
  assert.deepEqual(shapeFaults(run.of('ReportWork')[0].operation, contract.defs.ReportWorkPreExecutionReview, contract.defs), [])
  assert.equal(run.of('ReportWork')[0].headers['x-rulith-worker-generation'], '7')
  assert.doesNotMatch(run.output, /SHADOW|Recorded the goal|criterion|premise/)
})

test('runtime RULITH_REVIEWER_MAX_TOKENS sets the pre-execution max_tokens; an invalid value keeps 8000', async () => {
  for (const [value, expected] of [['12345', 12345], ['lots', 8000]]) {
    let polls = 0
    const run = await driveWorker({ reviewer: valid[0], env: { RULITH_REVIEWER_MAX_TOKENS: value },
      reply: operation => operation.kind === 'Poll'
        ? ++polls === 1 ? { body: { accepted: true, payload: { work: [offer()] } } } : HOLD
        : operation.kind === 'ReportWork' ? { body: { accepted: true } } : undefined,
      done: (_seen, output) => /Pre-execution review.*report accepted=true/.test(output),
    })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(run.modelRequests[0].body.max_tokens, expected)
  }
})

test('runtime cache replays original reports after a reset and repeated Poll offer', async () => {
  let polls = 0, reports = 0
  const run = await driveWorker({ reviewer: valid[0],
    reply: operation => operation.kind === 'Poll'
      ? ++polls <= 2 ? { body: { accepted: true, payload: { work: [offer()] } } } : HOLD
      : operation.kind === 'ReportWork' ? ++reports === 1 ? RESET : { body: { accepted: true } } : undefined,
    done: (_seen, output) => output.split('\n').filter(line => /Pre-execution review.*report accepted=true/.test(line)).length === 2,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.modelRequests.length, 1)
  assert.equal(run.of('ReportWork').length, 3)
  assert.equal(new Set(run.of('ReportWork').map(entry => entry.raw)).size, 1)
})

test('runtime review report with no answer is resent unchanged after its deadline', async () => {
  let polls = 0, reports = 0
  const run = await driveWorker({ reviewer: valid[0], env: { RULITH_WORK_CALL_DEADLINE_MS: '1500' },
    reply: operation => operation.kind === 'Poll'
      ? ++polls === 1 ? { body: { accepted: true, payload: { work: [offer()] } } } : HOLD
      : operation.kind === 'ReportWork' ? ++reports === 1 ? HOLD : { body: { accepted: true } } : undefined,
    done: (_seen, output) => /Pre-execution review.*report accepted=(?:true|false)/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.match(run.output, /Pre-execution review.*report accepted=true/)
  assert.equal(run.modelRequests.length, 1)
  assert.equal(run.of('ReportWork').length, 2)
  assert.equal(new Set(run.of('ReportWork').map(entry => entry.raw)).size, 1)
})

test('runtime constitution offers without purpose still use the old path', async () => {
  let polls = 0
  const w = { workType: 'review', tool: 'acme.ship', norm: 'n1', invocation: 'inv-1',
    requestDigest: `sha256:${'a'.repeat(64)}`, expectedPolicyFingerprint: `sha256:${'b'.repeat(64)}`,
    caseFile: { rendered: 'Frozen constitution case.' } }
  const run = await driveWorker({ reviewer: { verdict: 'allow', citedClause: 'n1', reason: 'Reviewed clause.' },
    reply: operation => operation.kind === 'Poll'
      ? ++polls === 1 ? { body: { accepted: true, payload: { work: [w] } } } : HOLD
      : operation.kind === 'ReportWork' ? { body: { accepted: true } } : undefined,
    done: (_seen, output) => DONE.review.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  const report = run.of('ReportWork')[0].operation
  assert.equal(report.purpose, undefined)
  assert.equal(report.verdict, 'allow')
  assert.equal(report.invocation, 'inv-1')
  assert.equal(run.modelRequests[0].body.messages[1].content, 'Frozen constitution case.')
})

const clearanceOffer = () => ({ workType: 'review', tool: 'acme.ship', norm: 'n1', invocation: 'inv-1',
  requestDigest: `sha256:${'a'.repeat(64)}`, expectedPolicyFingerprint: `sha256:${'b'.repeat(64)}`,
  caseFile: { rendered: 'Frozen constitution case.' } })

test('runtime RULITH_REVIEWER_TIMEOUT_MS caps only the clearance review, never the post-call review (0.16.3)', async () => {
  let polls = 0
  const post = await driveWorker({ reviewer: valid[0], env: { RULITH_REVIEWER_TIMEOUT_MS: '1' },
    reply: operation => operation.kind === 'Poll'
      ? ++polls === 1 ? { body: { accepted: true, payload: { work: [offer()] } } } : HOLD
      : operation.kind === 'ReportWork' ? { body: { accepted: true } } : undefined,
    done: (_seen, output) => /Pre-execution review.*report accepted=/.test(output),
  })
  assert.equal(post.timedOut, false, post.output)
  assert.equal(post.of('ReportWork')[0].operation.errorCode, undefined)
  assert.deepEqual(post.of('ReportWork')[0].operation.reply, valid[0])
  polls = 0
  const clearance = await driveWorker({ reviewerReply: () => HOLD, env: { RULITH_REVIEWER_TIMEOUT_MS: '200' },
    reply: operation => operation.kind === 'Poll'
      ? ++polls === 1 ? { body: { accepted: true, payload: { work: [clearanceOffer()] } } } : HOLD
      : operation.kind === 'ReportWork' ? { body: { accepted: true } } : undefined,
    done: (_seen, output) => DONE.review.test(output),
  })
  assert.equal(clearance.timedOut, false, clearance.output)
  assert.equal(clearance.of('ReportWork')[0].operation.verdict, 'uncertain')
  assert.match(clearance.of('ReportWork')[0].operation.reason, /timed out after 200ms/)
})

test('runtime RULITH_REVIEWER_REQUEST_EXTRA reaches the post-call and the clearance model requests', async () => {
  const extra = { chat_template_kwargs: { enable_thinking: false } }
  let polls = 0
  const post = await driveWorker({ reviewer: valid[0], env: { RULITH_REVIEWER_REQUEST_EXTRA: JSON.stringify(extra) },
    reply: operation => operation.kind === 'Poll'
      ? ++polls === 1 ? { body: { accepted: true, payload: { work: [offer()] } } } : HOLD
      : operation.kind === 'ReportWork' ? { body: { accepted: true } } : undefined,
    done: (_seen, output) => /Pre-execution review.*report accepted=true/.test(output),
  })
  assert.equal(post.timedOut, false, post.output)
  assert.deepEqual(post.modelRequests[0].body.chat_template_kwargs, extra.chat_template_kwargs)
  assert.equal(post.modelRequests[0].body.model, 'p2-reviewer')
  assert.equal(post.modelRequests[0].body.max_tokens, 8000)
  polls = 0
  const clearance = await driveWorker({ reviewer: { verdict: 'allow', citedClause: 'n1', reason: 'Reviewed clause.' },
    env: { RULITH_REVIEWER_REQUEST_EXTRA: JSON.stringify(extra) },
    reply: operation => operation.kind === 'Poll'
      ? ++polls === 1 ? { body: { accepted: true, payload: { work: [clearanceOffer()] } } } : HOLD
      : operation.kind === 'ReportWork' ? { body: { accepted: true } } : undefined,
    done: (_seen, output) => DONE.review.test(output),
  })
  assert.equal(clearance.timedOut, false, clearance.output)
  assert.deepEqual(clearance.modelRequests[0].body.chat_template_kwargs, extra.chat_template_kwargs)
  // The clearance review has the post-call review's output budget (0.19.2; it was a fixed 2000).
  assert.equal(clearance.modelRequests[0].body.max_tokens, 8000)
  assert.equal(clearance.of('ReportWork')[0].operation.verdict, 'allow')
})

test('runtime an invalid RULITH_REVIEWER_REQUEST_EXTRA leaves the Worker without a reviewer and never logs the value', async () => {
  for (const [value, reason] of [
    ['{"enable_thinking": secret-value', /RULITH_REVIEWER_REQUEST_EXTRA is not valid JSON/],
    ['["secret-value"]', /RULITH_REVIEWER_REQUEST_EXTRA must be a JSON object/],
    ['{"model":"secret-value","max_tokens":1}', /RULITH_REVIEWER_REQUEST_EXTRA may not set model, max_tokens; the Worker controls them/],
  ]) {
    let polls = 0
    const run = await driveWorker({ reviewer: valid[0], env: { RULITH_REVIEWER_REQUEST_EXTRA: value },
      reply: operation => operation.kind === 'Poll'
        ? ++polls === 1 ? { body: { accepted: true, payload: { work: [offer()] } } } : HOLD
        : operation.kind === 'ReportWork' ? { body: { accepted: true } } : undefined,
      done: (_seen, output) => /Pre-execution review.*report accepted=/.test(output),
    })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(run.of('Poll')[0].operation.reviewer, undefined)
    assert.equal(run.modelRequests.length, 0)
    assert.equal(run.of('ReportWork')[0].operation.errorCode, 'reviewer_unconfigured')
    assert.match(run.output, reason)
    assert.match(run.output, /Reviewer disabled: /)
    assert.doesNotMatch(run.output, /secret-value/)
  }
})

test('runtime capability disappears when either reviewer setting is missing', async () => {
  for (const env of [{ RULITH_REVIEWER_URL: '', RULITH_REVIEWER_MODEL: 'review-test' },
    { RULITH_REVIEWER_URL: 'http://127.0.0.1:1/chat', RULITH_REVIEWER_MODEL: '' }]) {
    const run = await driveWorker({ env,
      reply: operation => operation.kind === 'Poll' ? HOLD : undefined,
      done: seen => seen.some(entry => entry.operation.kind === 'Poll'),
    })
    assert.equal(run.of('Poll')[0].operation.reviewer, undefined)
  }
})

test('runtime lease loss cancels reviewer HTTP and reports its original generation', async () => {
  let polls = 0
  const run = await driveWorker({ reviewerReply: () => HOLD,
    lease: operation => activeLease({ workerId: operation.workerId, windowMs: 5000, heartbeatAfterMs: 100 }),
    reply: operation => operation.kind === 'Poll'
      ? ++polls === 1 ? { body: { accepted: true, payload: { work: [offer()] } } } : HOLD
      : operation.kind === 'RenewLease' ? { body: { accepted: false, errorCode: 'worker_lease_lost' } }
        : operation.kind === 'ReportWork' ? { body: { accepted: false, errorCode: 'review_unavailable' } } : undefined,
    done: (_seen, output) => /Pre-execution review.*report accepted=false/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ReportWork')[0].operation.errorCode, 'review_lease_lost')
  assert.equal(run.of('ReportWork')[0].operation.workerGeneration, 7)
})

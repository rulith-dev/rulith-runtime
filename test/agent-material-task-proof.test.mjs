// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { conversationFile, readConversations } from '../agent/conversation-store.mjs'
import { TEST_AGENT_ID, callTool, declareGoal, freePort, runAgent } from './support/agent-harness.mjs'

const PROOF = 'ab'.repeat(32)
const ATTACHMENT = { id: 'mat_' + 'a'.repeat(32), name: 'notes.txt',
  mediaType: 'text/plain', totalBytes: 5, digest: 'sha256:' + 'b'.repeat(64) }
const OWNER = { origin: 'http://127.0.0.1', accountId: 'account-a', agentId: TEST_AGENT_ID }

test('real Agent sends the private proof only on the first ApplyBatch that declares a goal without parent, and never persists it', async t => {
  // rulith/v4 opens new work where a goal without parent is declared (AIS §4); that ApplyBatch is
  // the successor of the create form of OpenCase, so the Host proof rides on it and on nothing else.
  const dir = mkdtempSync(join(tmpdir(), 'rulith-task-proof-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const run = await runAgent({ argv: ['--serve'], captureLocalEvents: true,
    env: { RULITH_SERVE_PORT: String(await freePort()), RULITH_SERVE_KEY: 'task-proof-key',
      RULITH_CONVERSATION_DIR: dir, RULITH_CONVERSATION_OWNER: JSON.stringify(OWNER), RULITH_MAX_ROUNDS: '6' },
    serveTaskHeaders: { 'x-rulith-material-task-proof': PROOF },
    serveTasks: [{ text: 'Start new work for this attachment.', requestId: 'proof-task-request-1',
      sessionKey: 'proof-session', attachments: [ATTACHMENT] }],
    waitForServeCompletion: true,
    model: round => round === 1 ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', predicate: 'note', args: {} }] })
      : round === 2 ? callTool('ApplyBatch', declareGoal('step_done', {}, { parent: 'GOAL_0' }))
        : round === 3 ? callTool('ApplyBatch', declareGoal())
          : round === 4 ? callTool('ApplyBatch', declareGoal('other_done'))
            : 'Declared.',
    timeoutMs: 800,
  })
  assert.deepEqual(run.serveStatuses, [202], run.stdout + '\n' + run.stderr)
  const calls = run.requests.filter(row => row.method === 'tools/call')
  assert.equal(calls.length, 4, run.verbs.join(', '))
  assert.deepEqual(calls.map(call => call.headers['x-rulith-material-task-proof']), [undefined, undefined, PROOF, undefined],
    'the proof rides on the first declaration without parent, once')
  assert.deepEqual(run.verbs, ['ApplyBatch', 'ApplyBatch', 'ApplyBatch', 'ApplyBatch'])
  for (const projection of [run.toolCalls, run.modelRequests, run.localEvents, run.serveResponses,
    run.serveSnapshot, run.stdout, run.stderr, readFileSync(conversationFile(dir, OWNER), 'utf8')]) {
    assert.doesNotMatch(JSON.stringify(projection), new RegExp(PROOF, 'u'))
  }
  const saved = readConversations(conversationFile(dir, OWNER), OWNER)
  assert.equal(saved.turns.length, 1)
})

test('an explicit pre-admission proof refusal stops the attached task before another model decision', async () => {
  const run = await runAgent({ argv: ['--serve'], captureLocalEvents: true,
    env: { RULITH_SERVE_PORT: String(await freePort()), RULITH_SERVE_KEY: 'task-proof-key',
      RULITH_MAX_ROUNDS: '4' },
    serveTaskHeaders: { 'x-rulith-material-task-proof': PROOF },
    serveTasks: [{ text: 'Open a Case and use this attachment.', requestId: 'proof-denied-task-1',
      sessionKey: 'proof-denied-session', attachments: [ATTACHMENT] }],
    waitForServeCompletion: true, replaceAfter: 4,
    conflictBody: input => ({ jsonrpc: '2.0', id: input.id,
      error: { code: -32000, message: 'The proof was not registered for this Agent credential.',
        data: { reason: 'material_proof_unavailable', requestExecuted: false } } }),
    model: round => round === 1 ? callTool('ApplyBatch', declareGoal())
      : callTool('ApplyBatch', declareGoal()),
    timeoutMs: 1200,
  })
  assert.deepEqual(run.serveStatuses, [202], run.stdout + '\n' + run.stderr)
  assert.equal(run.modelRequests.length, 1, 'no second model decision may declare an unbound goal')
  assert.equal(run.requests.filter(row => row.method === 'tools/call').length, 1)
  assert.ok(run.localEvents.some(event => event.type === 'blocked'
    && event.reason === 'material_binding_refused'), 'Local receives a definite material refusal')
  assert.match(run.localEvents.find(event => event.type === 'blocked').teaching,
    /refused before the goal was declared: The proof was not registered.*No goal was declared for these files/)
  assert.doesNotMatch(run.stdout, /No answer arrived for ApplyBatch/)
})

test('real Agent refuses attached tasks without a valid Host proof before MCP egress', async () => {
  for (const [name, proof] of [
    ['missing proof', undefined], ['malformed proof', 'not-a-proof'],
  ]) {
    const run = await runAgent({ argv: ['--serve'],
      env: { RULITH_SERVE_PORT: String(await freePort()), RULITH_SERVE_KEY: 'task-proof-key' },
      serveTaskHeaders: proof ? { 'x-rulith-material-task-proof': proof } : {},
      serveTasks: [{ text: 'Open', requestId: 'refused-proof-task-1', attachments: [ATTACHMENT] }], timeoutMs: 150 })
    assert.deepEqual(run.serveStatuses, [400], `${name}: ${run.stdout}\n${run.stderr}`)
    assert.equal(run.requests.filter(row => row.method === 'tools/call').length, 0, name)
    assert.equal(run.modelRequests.length, 0, name)
  }
})

test('a supplement naming an existing Case is refused before any MCP call, because rulith/v4 has no focus call', async () => {
  // OpenCase({caseId}) was the one call that bound files to an existing Case. rulith/v4 retired it
  // with no successor, so a task naming one is refused whole rather than bound to something else.
  const run = await runAgent({ argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(await freePort()), RULITH_SERVE_KEY: 'task-proof-key' },
    serveTaskHeaders: { 'x-rulith-material-task-proof': PROOF },
    serveTasks: [{ text: 'Add these notes to the selected Case.', requestId: 'supplement-proof-task-1',
      sessionKey: 'supplement-session', caseId: 'CASE_1', attachments: [ATTACHMENT] }],
    timeoutMs: 300,
  })
  assert.deepEqual(run.serveStatuses, [400], run.stdout + '\n' + run.stderr)
  assert.match(run.serveResponses[0].body.teaching, /caseId was retired with rulith\/v4 \(Runtime 0\.13\.0\), and nothing was queued/)
  assert.equal(run.requests.filter(row => row.method === 'tools/call').length, 0)
  assert.equal(run.modelRequests.length, 0, 'a retired Case binding must not reach the model')
})

test('same task request accepts the same proof once and refuses a changed proof without egress', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-task-proof-retry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const different = 'cd'.repeat(32)
  const task = { text: 'Open for this attachment.', requestId: 'proof-retry-request-1',
    sessionKey: 'proof-retry-session', attachments: [ATTACHMENT] }
  const run = await runAgent({ argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(await freePort()), RULITH_SERVE_KEY: 'task-proof-key',
      RULITH_CONVERSATION_DIR: dir, RULITH_CONVERSATION_OWNER: JSON.stringify(OWNER) },
    serveTasks: [task, task, task],
    serveTaskHeaders: index => ({ 'x-rulith-material-task-proof': index === 2 ? different : PROOF }),
    waitForServeCompletion: true,
    model: round => round === 1 ? callTool('ApplyBatch', declareGoal()) : 'Declared.',
    timeoutMs: 800,
  })
  assert.deepEqual(run.serveStatuses, [202, 202, 409], run.stdout + '\n' + run.stderr)
  assert.equal(run.serveResponses[0].body.id, run.serveResponses[1].body.id)
  assert.equal(run.requests.filter(row => row.method === 'tools/call').length, 1)
  assert.equal(run.modelRequests.length, 2)
  for (const projection of [run.serveResponses, run.serveSnapshot,
    readFileSync(conversationFile(dir, OWNER), 'utf8')]) {
    assert.doesNotMatch(JSON.stringify(projection), new RegExp(`${PROOF}|${different}`, 'u'))
  }
})

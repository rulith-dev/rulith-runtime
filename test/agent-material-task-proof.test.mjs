// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { conversationFile, readConversations } from '../agent/conversation-store.mjs'
import { TEST_AGENT_ID, callTool, freePort, runAgent } from './support/agent-harness.mjs'

const PROOF = 'ab'.repeat(32)
const ATTACHMENT = { id: 'mat_' + 'a'.repeat(32), name: 'notes.txt',
  mediaType: 'text/plain', totalBytes: 5, digest: 'sha256:' + 'b'.repeat(64) }
const OWNER = { origin: 'http://127.0.0.1', accountId: 'account-a', agentId: TEST_AGENT_ID }

test('real Agent sends private proof only on create-form OpenCase MCP header and never persists it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-task-proof-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const run = await runAgent({ argv: ['--serve'], captureLocalEvents: true,
    env: { RULITH_SERVE_PORT: String(await freePort()), RULITH_SERVE_KEY: 'task-proof-key',
      RULITH_CONVERSATION_DIR: dir, RULITH_CONVERSATION_OWNER: JSON.stringify(OWNER), RULITH_MAX_ROUNDS: '4' },
    serveTaskHeaders: { 'x-rulith-material-task-proof': PROOF },
    serveTasks: [{ text: 'Open a new case for this attachment.', requestId: 'proof-task-request-1',
      sessionKey: 'proof-session', attachments: [ATTACHMENT] }],
    waitForServeCompletion: true,
    model: round => round === 1 ? callTool('OpenCase', { caseType: 'exploration' }) : 'Opened.',
    timeoutMs: 800,
  })
  assert.deepEqual(run.serveStatuses, [202], run.stdout + '\n' + run.stderr)
  const calls = run.requests.filter(row => row.method === 'tools/call')
  assert.equal(calls.length, 1, run.verbs.join(', '))
  assert.equal(calls[0].headers['x-rulith-material-task-proof'], PROOF)
  assert.equal(run.toolCalls[0].name, 'OpenCase')
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
    model: round => round === 1 ? callTool('OpenCase', { caseType: 'exploration' })
      : callTool('OpenCase', { caseType: 'exploration' }),
    timeoutMs: 1200,
  })
  assert.deepEqual(run.serveStatuses, [202], run.stdout + '\n' + run.stderr)
  assert.equal(run.modelRequests.length, 1, 'no second model decision may create an unbound Case')
  assert.equal(run.requests.filter(row => row.method === 'tools/call').length, 1)
  assert.ok(run.localEvents.some(event => event.type === 'blocked'
    && event.reason === 'material_binding_refused'), 'Local receives a definite material refusal')
  assert.doesNotMatch(run.stdout, /Board outcome unknown for OpenCase/)
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

test('a supplement focuses its exact Case with the Host proof before asking the model', async () => {
  const run = await runAgent({ argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(await freePort()), RULITH_SERVE_KEY: 'task-proof-key' },
    serveTaskHeaders: { 'x-rulith-material-task-proof': PROOF },
    serveTasks: [{ text: 'Add these notes to the selected Case.', requestId: 'supplement-proof-task-1',
      sessionKey: 'supplement-session', caseId: 'CASE_1', attachments: [ATTACHMENT] }],
    waitForServeCompletion: true, timeoutMs: 800,
  })
  assert.deepEqual(run.serveStatuses, [202], run.stdout + '\n' + run.stderr)
  const calls = run.requests.filter(row => row.method === 'tools/call')
  assert.equal(calls.length, 1)
  assert.equal(run.toolCalls[0].name, 'OpenCase')
  assert.deepEqual(run.toolCalls[0].args, { caseId: 'CASE_1' })
  assert.equal(calls[0].headers['x-rulith-material-task-proof'], PROOF)
  assert.equal(run.modelRequests.length, 0, 'unconfirmed Case binding stops before material enters the model')
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
    model: round => round === 1 ? callTool('OpenCase', { caseType: 'exploration' }) : 'Opened.',
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

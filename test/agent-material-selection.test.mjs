// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { conversationFile } from '../agent/conversation-store.mjs'
import { TEST_AGENT_ID, callTool, freePort, runAgent } from './support/agent-harness.mjs'

const PROOF = 'ab'.repeat(32)
const SECRET = 'cd'.repeat(32)
const OTHER = 'ef'.repeat(32)
const A = { id: 'mat_' + 'a'.repeat(32), name: 'a.txt', mediaType: 'text/plain', totalBytes: 5,
  digest: 'sha256:' + '1'.repeat(64) }
const B = { id: 'mat_' + 'b'.repeat(32), name: 'b.txt', mediaType: 'text/plain', totalBytes: 6,
  digest: 'sha256:' + '2'.repeat(64) }
const OWNER = { origin: 'http://127.0.0.1', accountId: 'account-a', agentId: TEST_AGENT_ID }

const execute = async (args, { selection = SECRET, attachments = [A, B], proof = PROOF,
  tool = 'ApplyAction' } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-selection-'))
  try {
    const run = await runAgent({ argv: ['--serve'], captureLocalEvents: true,
      env: { RULITH_SERVE_PORT: String(await freePort()), RULITH_SERVE_KEY: 'selection-test-key',
        RULITH_CONVERSATION_DIR: dir, RULITH_CONVERSATION_OWNER: JSON.stringify(OWNER), RULITH_MAX_ROUNDS: '4' },
      serveTaskHeaders: { ...(proof ? { 'x-rulith-material-task-proof': proof } : {}),
        ...(selection ? { 'x-rulith-material-selection-key': selection } : {}) },
      serveTasks: [{ text: 'Use the selected material.', requestId: 'selection-task-request-1',
        sessionKey: 'selection-session', attachments }], waitForServeCompletion: true,
      model: round => round === 1 ? callTool('OpenCase', { caseType: 'exploration' })
        : round === 2 ? callTool(tool, args) : 'Done.', timeoutMs: 800 })
    const projections = [run.toolCalls, run.modelRequests, run.localEvents, run.serveResponses,
      run.serveSnapshot, run.stdout, run.stderr]
    if (run.serveStatuses[0] === 202) projections.push(readFileSync(conversationFile(dir, OWNER), 'utf8'))
    for (const projection of projections) {
      assert.doesNotMatch(JSON.stringify(projection), new RegExp(`${PROOF}|${SECRET}|${OTHER}`, 'u'))
    }
    return run
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('real Agent forwards private selection on exact attached ApplyAction only', async () => {
  const run = await execute({ action: 'read', args: { material: { ref: A.id, digest: A.digest } } })
  assert.deepEqual(run.serveStatuses, [202], run.stdout + run.stderr)
  const calls = run.requests.filter(row => row.method === 'tools/call')
  assert.deepEqual(run.toolCalls.map(row => row.name), ['OpenCase', 'ApplyAction'])
  assert.equal(calls[0].headers['x-rulith-material-selection-key'], undefined)
  assert.equal(calls[1].headers['x-rulith-material-selection-key'], SECRET)
  assert.equal(calls[0].headers['x-rulith-material-task-proof'], PROOF)
  assert.equal(calls[1].headers['x-rulith-material-task-proof'], undefined)
})

test('real Agent withholds selection on unrelated MCP tools', async () => {
  const run = await execute({ args: { material: { ref: A.id, digest: A.digest } } }, { tool: 'QueryBoard' })
  assert.deepEqual(run.serveStatuses, [202], run.stdout + run.stderr)
  assert.equal(run.requests.filter(row => row.method === 'tools/call').find(row =>
    row.headers['x-rulith-material-selection-key'] !== undefined), undefined)
})

test('real Agent withholds selection for cross-attachment, mismatched, nested, and multiple references', async () => {
  for (const args of [
    { action: 'read', material: { ref: A.id, digest: A.digest } },
    { action: 'read' },
    { action: 'read', args: null },
    { action: 'read', args: { material: { ref: A.id, digest: B.digest } } },
    { action: 'read', args: { material: { ref: 'mat_' + 'c'.repeat(32), digest: A.digest } } },
    { action: 'read', args: { material: { ref: A.id, digest: A.digest, extra: true } } },
    { action: 'read', args: { nested: { material: { ref: A.id, digest: A.digest } } } },
    { action: 'read', args: { material: { ref: A.id, digest: A.digest }, nested: { other: { ref: B.id } } } },
    { action: 'read', args: { first: { ref: A.id, digest: A.digest }, second: { ref: B.id, digest: B.digest } } },
    { action: 'read', args: { first: { ref: A.id, digest: A.digest }, second: { ref: B.id, digest: A.digest } } },
  ]) {
    const run = await execute(args)
    assert.deepEqual(run.serveStatuses, [202], run.stdout + run.stderr)
    assert.equal(run.requests.filter(row => row.method === 'tools/call')[1]?.headers['x-rulith-material-selection-key'], undefined)
  }
})

test('real Agent rejects malformed or unattached selection before model and MCP calls', async () => {
  for (const options of [
    { selection: 'BAD' }, { selection: PROOF }, { attachments: [] }, { proof: null },
    { attachments: [{ ...A, digest: undefined }] },
  ]) {
    const run = await execute({}, options)
    assert.deepEqual(run.serveStatuses, [400], run.stdout + run.stderr)
    assert.equal(run.modelRequests.length, 0)
    assert.equal(run.requests.filter(row => row.method === 'tools/call').length, 0)
  }
})

test('changed private selection changes retry fingerprint without revealing either key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-selection-retry-'))
  try {
    const task = { text: 'Use selected material.', requestId: 'selection-retry-request-1',
      sessionKey: 'selection-retry-session', attachments: [A] }
    const run = await runAgent({ argv: ['--serve'],
      env: { RULITH_SERVE_PORT: String(await freePort()), RULITH_SERVE_KEY: 'selection-test-key',
        RULITH_CONVERSATION_DIR: dir, RULITH_CONVERSATION_OWNER: JSON.stringify(OWNER) },
      serveTasks: [task, task, task], serveTaskHeaders: index => ({
        'x-rulith-material-task-proof': PROOF, 'x-rulith-material-selection-key': index === 2 ? OTHER : SECRET }),
      waitForServeCompletion: true, model: round => round === 1 ? callTool('OpenCase') : 'Done.', timeoutMs: 800 })
    assert.deepEqual(run.serveStatuses, [202, 202, 409], run.stdout + run.stderr)
    assert.equal(run.serveResponses[0].body.id, run.serveResponses[1].body.id)
    for (const projection of [run.serveResponses, run.serveSnapshot,
      readFileSync(conversationFile(dir, OWNER), 'utf8')]) {
      assert.doesNotMatch(JSON.stringify(projection), new RegExp(`${PROOF}|${SECRET}|${OTHER}`, 'u'))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

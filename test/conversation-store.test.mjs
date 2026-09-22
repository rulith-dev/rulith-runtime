import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { conversationFile, openConversations, readConversations, conversationEvents } from '../agent/conversation-store.mjs'
import { runAgent, freePort, TEST_AGENT_ID } from './support/agent-harness.mjs'
import { createLocalHost, defaultLocalConfig } from '../local/rulith-local.mjs'
const owner = { origin: 'https://console.example.test', accountId: 'account-a', agentId: TEST_AGENT_ID }
const fixture = t => { const dir = mkdtempSync(join(tmpdir(), 'rulith-history-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
const item = { id: 'turn-1', sessionKey: 'chat-1', text: 'Remember blue', attachments: [], at: 1 }

test('restart preserves visible history and turns unfinished work into an interruption without a replay queue', t => {
  const dir = fixture(t), store = openConversations(dir, owner)
  store.accept({ ...item, token: 'secret', reasoning: 'hidden', toolResult: 'private' }, { ok: true, id: item.id }, 'request-1234567890', 'same')
  store.start(item.id); store.reply(item.id, 'Blue remembered.')
  const second = openConversations(dir, owner)
  assert.equal(second.snapshot().turns[0].state, 'interrupted')
  assert.match(second.messages('chat-1', 10)[0].text, /not current observations/)
  assert.equal(second.messages('other', 10).length, 0)
  assert.equal(conversationEvents(second.snapshot()).at(-1).outcome, 'interrupted')
  const raw = readFileSync(second.file, 'utf8')
  assert.doesNotMatch(raw, /secret|hidden|private|toolResult/)
  assert.equal(second.find('request-1234567890', 'same').id, item.id)
  assert.equal(second.find('request-1234567890', 'same').ok, false)
  assert.match(second.find('request-1234567890', 'same').teaching, /has not been replayed/)
  assert.throws(() => second.find('request-1234567890', 'different'), /different content/)
})

test('account, Agent and origin isolate local history; a damaged file is preserved and blocks writes', t => {
  const dir = fixture(t), first = openConversations(dir, owner)
  first.accept(item, { ok: true }, '', '')
  for (const other of [{ ...owner, accountId: 'b' }, { ...owner, agentId: 'b' }, { ...owner, origin: 'https://other.test' }]) {
    assert.equal(openConversations(dir, other).snapshot().turns.length, 0)
    assert.throws(() => readConversations(first.file, other), /owner/)
  }
  writeFileSync(first.file, '{truncated')
  assert.throws(() => openConversations(dir, owner), /preserved/)
  assert.equal(readFileSync(first.file, 'utf8'), '{truncated')
})

test('real Agent deduplicates accepted messages and restores only conversational text after process restart', async t => {
  const dir = fixture(t)
  const env = { RULITH_CONVERSATION_DIR: dir, RULITH_CONVERSATION_OWNER: JSON.stringify(owner), RULITH_SERVE_KEY: 'test-history', RULITH_SERVE_PORT: String(await freePort()) }
  const body = { text: 'Remember blue', sessionKey: 'chat-1', requestId: 'request-history-0001' }
  const first = await runAgent({ argv: ['--serve'], env, serveTasks: [body, body, { ...body, text: 'changed' }], waitForServeCompletion: true, model: () => 'Blue remembered.', timeoutMs: 100 })
  assert.deepEqual(first.serveStatuses, [202, 202, 409], first.stderr)
  assert.equal(first.modelRequests.length, 1)
  assert.equal(first.serveResponses[0].body.id, first.serveResponses[1].body.id)
  const second = await runAgent({ argv: ['--serve'], env: { ...env, RULITH_SERVE_PORT: String(await freePort()) }, serveTasks: [{ text: 'What color?', sessionKey: 'chat-1', requestId: 'request-history-0002' }], waitForServeCompletion: true, model: () => 'Blue.', timeoutMs: 100 })
  assert.equal(second.modelRequests.length, 1)
  const context = JSON.stringify(second.modelRequests[0].messages)
  assert.match(context, /Remember blue/); assert.match(context, /Blue remembered/)
  assert.match(context, /historical statements/)
  assert.equal(readConversations(conversationFile(dir, owner), owner).turns.length, 2)
})

test('real Agent rejects a mismatched authenticated identity before reading conversation history', async t => {
  const dir = fixture(t)
  const run = await runAgent({ argv: ['test'], env: { RULITH_CONVERSATION_DIR: dir, RULITH_CONVERSATION_OWNER: JSON.stringify({ ...owner, agentId: 'wrong' }) }, model: () => 'should not run' })
  assert.equal(run.modelRequests.length, 0)
  assert.match(run.stderr, /does not match/)
  assert.equal(run.code, 5)
  assert.match(run.stderr, /Local conversation history needs attention/)
  assert.doesNotMatch(run.stderr, /Cannot establish an authenticated MCP session/)
})

test('a history write failure refuses admission before any model or Board tool executes', async t => {
  const dir = fixture(t), blocked = join(dir, 'not-a-directory')
  writeFileSync(blocked, 'preserve me')
  const run = await runAgent({ argv: ['--serve'], env: { RULITH_CONVERSATION_DIR: blocked, RULITH_CONVERSATION_OWNER: JSON.stringify(owner), RULITH_SERVE_KEY: 'store-failure', RULITH_SERVE_PORT: String(await freePort()) }, serveTasks: [{ text: 'must not execute', sessionKey: 'failed-chat' }], model: () => 'wrong', timeoutMs: 100 })
  assert.deepEqual(run.serveStatuses, [507])
  assert.equal(run.modelRequests.length, 0)
  assert.equal(run.toolCalls.length, 0)
  assert.equal(readFileSync(blocked, 'utf8'), 'preserve me')
})

test('starting the real Agent with an unfinished saved turn makes no model or Board tool call', async t => {
  const dir = fixture(t), store = openConversations(dir, owner)
  store.accept(item, { ok: true, id: item.id }, '', '')
  const run = await runAgent({ argv: ['--serve'], env: { RULITH_CONVERSATION_DIR: dir, RULITH_CONVERSATION_OWNER: JSON.stringify(owner), RULITH_SERVE_KEY: 'no-replay', RULITH_SERVE_PORT: String(await freePort()) }, model: () => 'wrong', timeoutMs: 600 })
  assert.equal(run.modelRequests.length, 0)
  assert.equal(run.toolCalls.length, 0)
  assert.equal(readConversations(store.file, owner).turns[0].state, 'interrupted')
})

test('the workbench reads stopped Agent history through its authenticated event stream', async t => {
  const dir = fixture(t), store = openConversations(join(dir, 'conversations'), owner)
  store.accept(item, { ok: true }, '', '')
  store.start(item.id); store.reply(item.id, 'Saved before shutdown')
  const host = createLocalHost({ configFile: join(dir, 'local.json'), config: defaultLocalConfig(), roles: ['agent'], port: 0, key: 'history-test', autoStart: false, conversationOwner: owner })
  await host.listen(); t.after(() => host.close())
  assert.equal((await fetch(`http://127.0.0.1:${host.port}/events?k=wrong`)).status, 401)
  const abort = new AbortController()
  const response = await fetch(`http://127.0.0.1:${host.port}/events?k=history-test`, { signal: abort.signal })
  const chunk = await response.body.getReader().read()
  abort.abort()
  const text = new TextDecoder().decode(chunk.value)
  assert.match(text, /Saved before shutdown/)
  assert.match(text, /interrupted/)
  assert.doesNotMatch(text, /activeCaseId|focused/)
})

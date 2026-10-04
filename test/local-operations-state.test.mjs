import test from 'node:test'
import assert from 'node:assert/strict'
import { startFixtureRoles } from './support/local-role-controls.mjs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost, defaultLocalConfig } from '../local/rulith-local.mjs'
import { projectOperations } from '../local/local-ui.mjs'

const RUNNING = { tool: 'ApplyAction', label: 'ApplyAction demo.ship', state: 'running', stage: 'at_worker',
  at: '2026-10-01T08:00:00Z', since: '2026-10-01T08:00:01Z' }

for (const settled of [false, true]) test(`new SSE clients receive the operations after the source events were evicted; settled=${settled}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulith-operations-snapshot-'))
  const agent = join(directory, 'agent.mjs')
  await writeFile(agent, `
    const send = event => new Promise(resolve => process.send({ protocol: 'rulith-local-event', event }, resolve));
    await send({ type: 'start', agentId: 'test-operations' });
    await send({ type: 'operations', operations: [${JSON.stringify(RUNNING)}] });
    ${settled ? `await send({ type: 'operations', operations: [${JSON.stringify({ ...RUNNING, state: 'done', stage: undefined })}] });` : ''}
    for (let i = 0; i < 2100; i++) await send({ type: 'log', note: 'unrelated event ' + i });
    await send({ type: 'operations', operations: [], historical: true });
    await send({ type: 'snapshot-test-ready' });
    setInterval(() => {}, 1000);
  `)
  const config = defaultLocalConfig()
  config.paths = { agent }
  config.agent.env = { RULITH_TOKEN: 'fixture-token', RULITH_MODEL_KEY: 'fixture-model-key' }
  const host = createLocalHost({ configFile: join(directory, 'local.json'), config, roles: ['agent'], port: 0,
    key: 'operations-test', isolateEnvironment: true,
    conversationOwner: { origin: 'https://api.rulith.ai', accountId: 'acct-1', agentId: 'test-operations' } })
  try {
    await host.listen(); await startFixtureRoles(host)
    const until = Date.now() + 10_000
    while (!host.events().some(e => e.type === 'snapshot-test-ready') && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(host.events().some(e => e.type === 'snapshot-test-ready'))
    const status = await fetch(`http://127.0.0.1:${host.port}/status?k=operations-test`).then(r => r.json())
    assert.deepEqual(status.runtime.console,
      { origin: 'https://console.rulith.ai', accountId: 'acct-1', agentId: 'test-operations' })
    assert.ok(!host.events().some(e => e.type === 'operations' && !e.historical), 'fixture did not evict the original events')
    const response = await fetch(`http://127.0.0.1:${host.port}/events?k=operations-test&history=paged`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    let text = '', snapshot
    try {
      while (!snapshot) {
        const { done, value } = await reader.read()
        if (done) break
        text += Buffer.from(value).toString('utf8')
        for (const line of text.split('\n').filter(line => line.startsWith('data: '))) {
          try { const event = JSON.parse(line.slice(6)); if (event.type === 'runtime-operations') snapshot = event.operations } catch { /* chunk boundary */ }
        }
      }
    } finally { await reader.cancel() }
    assert.ok(snapshot)
    assert.equal(snapshot.reported, true)
    assert.equal(snapshot.entries[0].state, settled ? 'done' : 'running')
    assert.match(snapshot.entries[0].words, settled ? /^Done/ : /^Running · at the Worker/)
    // Reported under the account and Agent this host serves, for the Console link.
    assert.deepEqual([snapshot.accountId, snapshot.agentId], ['acct-1', 'test-operations'])
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
})

test('an Agent process change marks the operations as reported before it', () => {
  const prior = projectOperations([{ src: 'agent', type: 'operations', operations: [RUNNING] }])
  assert.equal(prior.stale, false)
  const stopped = projectOperations([{ src: 'agent', type: 'exit' }], prior)
  assert.equal(stopped.stale, true)
  assert.equal(stopped.entries[0].state, 'running', 'the last report was dropped instead of labelled')
  const restarted = projectOperations([{ src: 'agent', type: 'spawn' }], stopped)
  assert.equal(restarted.stale, true)
  const reported = projectOperations([{ src: 'agent', type: 'operations', operations: [] }], restarted)
  assert.deepEqual([reported.stale, reported.entries], [false, []])
})

test('an operation that waits for a person is marked for Console, and a held call has its own line', () => {
  const owner = { accountId: 'acct-1', agentId: 'agent-1' }
  const waiting = projectOperations([
    { src: 'agent', type: 'operations', ...owner, operations: [
      { ...RUNNING, state: 'waiting_for_decision', stage: undefined },
      { tool: 'ApplyBatch', label: 'ApplyBatch', state: 'done', contentWithheld: true, at: 'a', since: 'b' },
    ] },
    { src: 'agent', type: 'held-call', phase: 'waiting', tool: 'ApplyAction', label: 'ApplyAction demo.ship' },
  ])
  assert.equal(waiting.entries[0].needsPerson, true)
  assert.match(waiting.entries[0].words, /Waiting for a decision in Console/)
  assert.match(waiting.entries[1].words, /Done · content withheld/)
  assert.equal(waiting.entries[1].needsPerson, false)
  assert.deepEqual([waiting.accountId, waiting.agentId], ['acct-1', 'agent-1'])
  assert.deepEqual(waiting.held, { tool: 'ApplyAction', label: 'ApplyAction demo.ship' })
  const answered = projectOperations([{ src: 'agent', type: 'held-call', phase: 'answered', tool: 'ApplyAction' }], waiting)
  assert.equal(answered.held, null)
})

test('an entry in a state the contract does not have is not shown as one it does', () => {
  const projected = projectOperations([{ src: 'agent', type: 'operations', operations: [
    { ...RUNNING, state: 'withheld' }, { ...RUNNING, state: 'result_ready' }, RUNNING] }])
  assert.deepEqual(projected.entries.map(entry => entry.state), ['running'])
})

test('a malformed Console origin leaves status readable without a link', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulith-operations-origin-'))
  const owner = { origin: 'https://console.example', accountId: 'acct-1', agentId: 'unconfigured' }
  const host = createLocalHost({ configFile: join(directory, 'local.json'), config: defaultLocalConfig(),
    roles: ['agent'], port: 0, key: 'origin-test', autoStart: false, isolateEnvironment: true,
    conversationOwner: owner })
  try {
    await host.listen(); await startFixtureRoles(host)
    const status = () => fetch(`http://127.0.0.1:${host.port}/status?k=origin-test`).then(r => r.json())
    assert.equal((await status()).runtime.console.origin, 'https://console.example')
    owner.origin = 'https://[invalid'
    const malformed = await status()
    assert.equal(malformed.ok, true)
    assert.equal(malformed.runtime.console, undefined)
    owner.origin = 'javascript:alert(1)'
    const unsupported = await status()
    assert.equal(unsupported.ok, true)
    assert.equal(unsupported.runtime.console, undefined)
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
})

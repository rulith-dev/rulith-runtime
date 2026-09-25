import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost, defaultLocalConfig } from '../local/rulith-local.mjs'
import { projectRecovery } from '../local/local-ui.mjs'

for (const settled of [false, true]) test(`new SSE clients receive recovery after the source events were evicted; settled=${settled}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulith-recovery-snapshot-'))
  const agent = join(directory, 'agent.mjs')
  await writeFile(agent, `
    const send = event => new Promise(resolve => process.send({ protocol: 'rulith-local-event', event }, resolve));
    await send({ type: 'start', agentId: 'test-recovery' });
    await send({ type: 'pending-inherited', tool: 'ApplyAction', requestId: 'prior' });
    ${settled ? "await send({ type: 'operation-read', tool: 'ApplyAction' });" : ''}
    for (let i = 0; i < 2100; i++) await send({ type: 'log', note: 'unrelated event ' + i });
    await send({ type: 'recovery', state: 'none', historical: true });
    await send({ type: 'snapshot-test-ready' });
    setInterval(() => {}, 1000);
  `)
  const config = defaultLocalConfig()
  config.paths = { agent }
  config.agent.env = { RULITH_TOKEN: 'fixture-token', RULITH_MODEL_KEY: 'fixture-model-key' }
  const host = createLocalHost({ configFile: join(directory, 'local.json'), config, roles: ['agent'], port: 0,
    key: 'recovery-test', isolateEnvironment: true,
    conversationOwner: { origin: 'https://api.rulith.ai', accountId: 'acct-1', agentId: 'test-recovery' } })
  try {
    await host.listen()
    const until = Date.now() + 10_000
    while (!host.events().some(e => e.type === 'snapshot-test-ready') && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(host.events().some(e => e.type === 'snapshot-test-ready'))
    const status = await fetch(`http://127.0.0.1:${host.port}/status?k=recovery-test`).then(r => r.json())
    assert.deepEqual(status.runtime.console,
      { origin: 'https://console.rulith.ai', accountId: 'acct-1', agentId: 'test-recovery' })
    assert.ok(!host.events().some(e => ['pending-inherited', 'operation-read'].includes(e.type)), 'fixture did not evict the original event')
    const response = await fetch(`http://127.0.0.1:${host.port}/events?k=recovery-test&history=paged`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    let text = '', snapshot
    try {
      while (!snapshot) {
        const { done, value } = await reader.read()
        if (done) break
        text += Buffer.from(value).toString('utf8')
        for (const line of text.split('\n').filter(line => line.startsWith('data: '))) {
          try { const event = JSON.parse(line.slice(6)); if (event.type === 'runtime-recovery') snapshot = event.recovery } catch { /* chunk boundary */ }
        }
      }
    } finally { await reader.cancel() }
    assert.ok(snapshot)
    assert.equal(snapshot.state, settled ? 'none' : 'inherited')
    assert.match(snapshot.label, settled ? /No unresolved call/ : /Earlier ApplyAction outcome is unknown/)
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
})

test('an Agent process change makes earlier recovery observations explicitly unconfirmed', () => {
  const prior = projectRecovery([{ src: 'agent', type: 'recovery', state: 'waiting', tool: 'ApplyAction' }])
  const stopped = projectRecovery([{ src: 'agent', type: 'exit' }], prior)
  assert.equal(stopped.state, 'unconfirmed')
  assert.doesNotMatch(stopped.detail, /still executing/)
  const restarted = projectRecovery([{ src: 'agent', type: 'spawn' }], stopped)
  assert.equal(restarted.state, 'unconfirmed')
  assert.equal(projectRecovery([{ src: 'agent', type: 'recovery', state: 'none' }], restarted).state, 'none')
})

test('recovery projection retains only the authority published original call and Case', () => {
  const owner = { accountId: 'acct-1', agentId: 'agent-1' }
  const observed = projectRecovery([{ src: 'agent', type: 'recovery', state: 'reconciliation_required',
    tool: 'ApplyAction', callRef: 'call-1', caseId: 'CASE-1', ...owner }])
  assert.equal(observed.callRef, 'call-1')
  assert.equal(observed.caseId, 'CASE-1')
  assert.deepEqual([observed.accountId, observed.agentId], ['acct-1', 'agent-1'])
  const stale = projectRecovery([{ src: 'agent', type: 'exit' }], observed)
  assert.equal(stale.state, 'unconfirmed')
  assert.equal(stale.callRef, 'call-1')
  const replaced = projectRecovery([{ src: 'agent', type: 'recovery', state: 'waiting',
    tool: 'ApplyBatch', ...owner }], stale)
  assert.equal(replaced.callRef, '')
  assert.equal(replaced.caseId, '')
  const cleared = projectRecovery([{ src: 'agent', type: 'recovery', state: 'none', ...owner }], replaced)
  assert.equal(cleared.callRef, undefined)
})

test('an unknown recovery state does not reuse an earlier call or owner', () => {
  const prior = projectRecovery([{ src: 'agent', type: 'recovery', state: 'waiting', tool: 'ApplyAction',
    callRef: 'old-call', accountId: 'old-account', agentId: 'old-agent' }])
  const unknown = projectRecovery([{ src: 'agent', type: 'recovery', state: 'future-state',
    callRef: 'new-call', accountId: 'new-account', agentId: 'new-agent' }], prior)
  assert.equal(unknown.state, 'unreadable')
  assert.match(unknown.label, /unknown recovery state/)
  assert.equal(unknown.callRef, undefined)
  assert.equal(unknown.accountId, undefined)
  assert.equal(unknown.agentId, undefined)
})

test('a malformed Console origin leaves status readable without a link', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulith-recovery-origin-'))
  const owner = { origin: 'https://console.example', accountId: 'acct-1', agentId: 'unconfigured' }
  const host = createLocalHost({ configFile: join(directory, 'local.json'), config: defaultLocalConfig(),
    roles: ['agent'], port: 0, key: 'origin-test', autoStart: false, isolateEnvironment: true,
    conversationOwner: owner })
  try {
    await host.listen()
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

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
    ${settled ? "await send({ type: 'handoff', tool: 'ApplyAction' });" : ''}
    for (let i = 0; i < 2100; i++) await send({ type: 'log', note: 'unrelated event ' + i });
    await send({ type: 'recovery', state: 'none', historical: true });
    await send({ type: 'snapshot-test-ready' });
    setInterval(() => {}, 1000);
  `)
  const config = defaultLocalConfig()
  config.paths = { agent }
  config.agent.env = { RULITH_TOKEN: 'fixture-token', RULITH_MODEL_KEY: 'fixture-model-key' }
  const host = createLocalHost({ configFile: join(directory, 'local.json'), config, roles: ['agent'], port: 0, key: 'recovery-test', isolateEnvironment: true })
  try {
    await host.listen()
    const until = Date.now() + 10_000
    while (!host.events().some(e => e.type === 'snapshot-test-ready') && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(host.events().some(e => e.type === 'snapshot-test-ready'))
    assert.ok(!host.events().some(e => ['pending-inherited', 'handoff'].includes(e.type)), 'fixture did not evict the original event')
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

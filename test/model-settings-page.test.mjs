// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { managerPage } from '../local/manager-ui.mjs'
import { checkedModelInput, modelView } from '../local/model-settings.mjs'
import { runPageScript } from './support/mini-dom.mjs'

const origin = 'https://console.example', accountId = 'account-a'
const defaults = (extra = {}) => ({ available: true, origin, accountId, url: '', name: '',
  thinking: 'standard', keyConfigured: false, configured: false, ...extra })
const instance = (extra = {}) => ({ id: 'inst-one', name: 'Research', mode: 'local_agent',
  origin, accountId, agentId: 'agent-one', agentName: 'Research', directory: '/isolated/one',
  paired: true, roles: ['agent', 'worker'], agent: false, worker: false, open: false,
  blocked: '', hostPort: 0, pendingAgentId: '', model: { source: 'default', configured: false,
    ready: false, reason: 'Choose a model.', url: '', name: '', keyConfigured: false }, ...extra })
const snapshot = (extra = {}) => ({ device: { state: 'linked', origin, account: { id: accountId, name: 'Account A' },
  agents: [{ id: 'agent-one', name: 'Research' }] }, instances: [instance()], modelDefaults: defaults(), ...extra })
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)) }

test('model settings reject malformed and persisted output budgets visibly', () => {
  for (const value of [true, [], 255, 65537, 12000.5]) {
    assert.throws(() => checkedModelInput({ url: 'http://localhost:8080/v1', name: 'model', maxOutputTokens: value }),
      /Maximum output tokens/)
    const view = modelView({ url: 'http://localhost:8080/v1', name: 'model', maxOutputTokens: value })
    assert.equal(view.ready, false)
    assert.equal(view.maxOutputTokens, null)
    assert.match(view.reason, /Maximum output tokens/)
  }
  assert.throws(() => checkedModelInput({ url: 'http://localhost:8080/v1', name: 'model', maxOutputTokens: '12000' }),
    /Maximum output tokens/)
  assert.equal(modelView({ url: 'http://localhost:8080/v1', name: 'model', maxOutputTokens: '12000' }).maxOutputTokens,
    12000, 'the persisted Agent environment uses a decimal string')
  assert.equal(modelView({ url: 'http://localhost:8080/v1', name: 'model' }).maxOutputTokens, 6000)
})

test('model form preserves and submits explicit thinking off', async () => {
  const state = snapshot({ modelDefaults: defaults({ url: 'https://model.example/v1', name: 'model', thinking: 'disabled', maxOutputTokens: 12000, keyConfigured: true, configured: true }) })
  const page = await runPageScript(managerPage, { respond: async () => ({ body: state }) })
  page.$('default-model-open').onclick()
  assert.equal(page.$('model-thinking').value, 'disabled')
  assert.equal(page.$('model-max-output-tokens').value, '12000')
  await page.$('model-save').onclick(); await settle()
  const write = page.calls.find(call => call.path === '/manager/model/default')
  assert.equal(write.body.thinking, 'disabled')
  assert.equal(write.body.maxOutputTokens, 12000)
})

test('missing model opens a bound settings form instead of attempting to start a child', async () => {
  const state = snapshot()
  const page = await runPageScript(managerPage, { respond: async () => ({ body: state }) })
  await page.choose('inst-one'); await settle()
  await page.$('agent-toggle').onclick()
  assert.equal(page.$('dlg-model').hidden, false)
  assert.equal(page.$('model-source').value, 'default')
  assert.equal(page.$('model-fields').hidden, false)
  assert.match(page.$('model-explanation').textContent, /Agents set to use the default/)
  assert.equal(page.calls.some(call => call.path === '/manager/instances/control'), false)
})

test('default model edits survive refresh and send only the captured account scope', async () => {
  const state = snapshot()
  const page = await runPageScript(managerPage, { respond: async () => ({ body: state }) })
  page.$('default-model-open').onclick()
  page.$('model-url').value = 'https://model.example/v1'
  page.$('model-name').value = 'chosen-model'
  page.$('model-key').value = 'user-entered-secret'
  page.render(structuredClone(state))
  assert.equal(page.$('model-name').value, 'chosen-model')
  assert.equal(page.$('model-key').value, 'user-entered-secret')
  await page.$('model-save').onclick(); await settle()
  const writes = page.calls.filter(call => call.method === 'POST')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/manager/model/default')
  assert.deepEqual(writes[0].body, { expectedOrigin: origin, expectedAccountId: accountId,
    url: 'https://model.example/v1', name: 'chosen-model', key: 'user-entered-secret', clearKey: false,
    thinking: 'standard', maxOutputTokens: 6000 })
  assert.equal(page.$('model-key').value, '', 'closing the editor forgets the entered key')
})

test('an account change clears entered secrets and prevents stale model writes', async () => {
  const state = snapshot()
  const page = await runPageScript(managerPage, { respond: async () => ({ body: state }) })
  page.$('default-model-open').onclick()
  page.$('model-key').value = 'account-a-secret'
  page.render(snapshot({ device: { state: 'linked', origin, account: { id: 'account-b' }, agents: [] },
    modelDefaults: defaults({ accountId: 'account-b' }) }))
  assert.equal(page.$('model-key').value, '')
  assert.equal(page.$('model-save').disabled, true)
  await page.$('model-save').onclick(); await settle()
  assert.equal(page.calls.some(call => call.method === 'POST'), false)
})

test('saving an override addresses its original Agent and never starts without the start action', async () => {
  const state = snapshot({ instances: [instance({ worker: true })] })
  const page = await runPageScript(managerPage, { respond: async () => ({ body: state }) })
  await page.choose('inst-one'); await settle()
  page.$('agent-model-open').onclick()
  page.$('model-source').value = 'custom'; page.$('model-source').onchange()
  page.$('model-url').value = 'http://127.0.0.1:8080/v1'
  page.$('model-name').value = 'local-model'
  assert.equal(page.$('model-save').disabled, false, 'an independent Worker need not be stopped')
  await page.$('model-save').onclick(); await settle()
  const write = page.calls.find(call => call.path === '/manager/instances/model')
  assert.equal(write.body.instanceId, 'inst-one')
  assert.equal(write.body.source, 'custom')
  assert.equal(write.body.expectedAccountId, accountId)
  assert.equal(page.calls.some(call => call.path === '/manager/instances/control'), false)
})

test('running Agents cannot change their own model while the account default remains editable', async () => {
  const state = snapshot({ instances: [instance({ agent: true })] })
  const page = await runPageScript(managerPage, { respond: async () => ({ body: state }) })
  await page.choose('inst-one'); await settle()
  page.$('agent-model-open').onclick()
  assert.equal(page.$('model-save').disabled, true)
  assert.match(page.$('model-blocked').textContent, /Stop this Agent/)
  page.$('model-close').onclick()
  page.$('default-model-open').onclick()
  assert.equal(page.$('model-save').disabled, false)
  assert.match(page.$('model-effect').textContent, /until restarted/)
})

for (const delayedPath of ['/manager/model/default', '/manager/instances/model']) {
  test('a stale ' + delayedPath + ' response cannot resume writes or start after switching accounts', async () => {
    const readyModel = { source: 'default', url: 'http://127.0.0.1:8080/v1', name: 'model',
      keyConfigured: false, configured: true, ready: true }
    let release
    const wait = new Promise(resolve => { release = resolve })
    const initial = snapshot({ modelDefaults: defaults(delayedPath.endsWith('/default') ? {} : readyModel) })
    const page = await runPageScript(managerPage, { respond: async path => {
      if (path === delayedPath) {
        await wait
        return { body: snapshot({ instances: [instance({ model: readyModel })], modelDefaults: defaults(readyModel) }) }
      }
      return { body: initial }
    } })
    await page.choose('inst-one'); await settle()
    page.$('agent-model-open').onclick()
    page.$('model-key').value = 'entered-secret'
    const saving = page.$('model-save-start').onclick()
    await settle()
    assert.equal(page.calls.filter(call => call.path === delayedPath).length, 1)
    page.render(snapshot({ device: { state: 'linked', origin, account: { id: 'account-b' }, agents: [] },
      instances: [], modelDefaults: defaults({ accountId: 'account-b' }) }))
    assert.equal(page.$('model-key').value, '')
    release(); await saving; await settle()
    assert.equal(page.calls.some(call => call.path === '/manager/instances/control'), false)
    assert.equal(page.calls.filter(call => call.path === '/manager/model/default' || call.path === '/manager/instances/model').length, 1)
    assert.equal(page.$('model-save').disabled, true, 'an old response cannot revive an invalidated editor')
  })
}

test('a delayed override save keeps its original Agent when another Agent is selected', async () => {
  const model = { source: 'custom', configured: true, ready: true, url: 'http://127.0.0.1:8080/v1', name: 'model' }
  const other = instance({ id: 'inst-two', agentId: 'agent-two', name: 'Writing', model })
  const state = snapshot({ instances: [instance({ model }), other] })
  let release
  const wait = new Promise(resolve => { release = resolve })
  const page = await runPageScript(managerPage, { respond: async path => {
    if (path === '/manager/instances/model') await wait
    return { body: state }
  } })
  await page.choose('inst-one'); await settle()
  page.$('agent-model-open').onclick()
  const saving = page.$('model-save').onclick(); await settle()
  await page.choose('inst-two'); await settle()
  release(); await saving; await settle()
  assert.equal(page.calls.find(call => call.path === '/manager/instances/model').body.instanceId, 'inst-one')
  assert.equal(page.calls.some(call => call.path === '/manager/instances/control'), false)
})

test('removing a saved key sends an explicit clear request without reading the secret', async () => {
  const state = snapshot({ modelDefaults: defaults({ configured: true, keyConfigured: true,
    url: 'https://model.example/v1', name: 'model' }) })
  const page = await runPageScript(managerPage, { respond: async () => ({ body: state }) })
  page.$('default-model-open').onclick()
  assert.equal(page.$('model-key').value, '')
  assert.equal(page.$('model-clear-label').hidden, false)
  page.$('model-clear-key').checked = true
  await page.$('model-save').onclick(); await settle()
  const request = page.calls.find(call => call.path === '/manager/model/default')
  assert.equal(request.body.key, '')
  assert.equal(request.body.clearKey, true)
})

test('a Worker bound to the prior model service explains how to use new attachments', async () => {
  const row = instance({ worker: true, model: { source: 'default', configured: true, ready: true, workerRestartRequired: true } })
  const page = await runPageScript(managerPage, { respond: async () => ({ body: snapshot({ instances: [row] }) }) })
  await page.choose(row.id); await settle()
  assert.match(page.$('worker-note').textContent, /Stop and start this Worker before using new attachments/)
  assert.equal(page.$('worker-toggle').textContent, 'Stop Worker')
  assert.equal(page.calls.some(call => call.path === '/manager/instances/control'), false, 'a model change cannot interrupt a Worker on its own')
})

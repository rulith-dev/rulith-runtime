// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { environmentToolsPage, workerToolsPage } from '../local/worker-tools-ui.mjs'
import { loadLocalPage } from './support/local-dom.mjs'
import { http } from './support/tool-library-fixture.mjs'

const inventory = () => ({ tools: [], services: [], keys: [], usedBy: ['Alpha', 'Beta'], revision: 'initial',
  manifestFile: 'fixture/library/worker-tools.json', vaultFile: 'fixture/library/worker-secrets.json',
  presets: [{ package: 'fixture-filesystem', version: '1.0.0', installed: true }] })
const open = async (view = inventory()) => {
  const page = await loadLocalPage(environmentToolsPage, { respond: async (path, request) => {
    if (path === '/manager/tools/state') return { body: { ok: true, ...view } }
    if (request.method === 'POST') return { body: { ok: true, teaching: 'Saved.', affected: ['Alpha', 'Beta'] } }
  } })
  return page
}

test('the environment page hides Agent settings and scripts and sends its manager header', async () => {
  const markup = environmentToolsPage.split('<script>')[0]
  assert.doesNotMatch(markup, /id="runtime"|id="workspace-mode"|<option value="run"|\bWorker\b|\bConnection\b/)
  assert.match(markup, /Keys in this environment/)
  const page = await open()
  assert.deepEqual(page.calls.map(call => call.path), ['/manager/tools/state'])
  assert.equal(page.calls[0].headers['x-rulith-manager'], 'page-test-key')
  assert.equal(page.calls[0].headers['x-rulith-local'], undefined)
  assert.equal(page.$('used-by').textContent, 'Used by: Alpha, Beta.')
})

test('a tool edit is reviewed, cancelled without saving, then confirmed once with the reviewed bytes', async () => {
  const page = await open()
  await page.click('[data-add="manual"]')
  page.$('tool-id').value = 'acme.lookup@1'
  page.$('tool-definition').value = JSON.stringify(http)
  page.document.dispatch(page.$('manual-form'), 'submit')
  await page.flush()
  assert.equal(page.$('change-review').hidden, false)
  assert.equal(page.activeId(), 'change-confirm')
  assert.deepEqual(JSON.parse(page.$('change-details').textContent), http)
  assert.equal(page.calls.filter(call => call.method === 'POST').length, 0)
  await page.click('change-cancel')
  assert.equal(page.$('change-review').hidden, true)
  assert.equal(page.calls.filter(call => call.method === 'POST').length, 0)
  page.document.dispatch(page.$('manual-form'), 'submit')
  await page.flush()
  page.$('tool-definition').value = JSON.stringify({ ...http, entry: '/not-reviewed' })
  await page.click('change-confirm')
  await page.click('change-confirm')
  const writes = page.calls.filter(call => call.method === 'POST')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/manager/tools/save')
  assert.deepEqual(writes[0].body, { id: 'acme.lookup@1', definition: http, revision: 'initial', confirmed: true })
  assert.match(page.$('result').textContent, /Alpha, Beta/)
})

test('a removal also has one cancellable confirmation and keeps the shown revision', async () => {
  const view = inventory()
  view.tools = [{ id: 'acme.lookup@1', origin: 'manifest', definition: http, adapter: 'http', kind: 'read', configured: true }]
  const page = await open(view)
  await page.click(page.$('tool-rows').querySelector('button'))
  await page.click('remove-tool')
  assert.equal(page.calls.filter(call => call.method === 'POST').length, 0)
  await page.click('change-confirm')
  assert.deepEqual(page.calls.find(call => call.method === 'POST').body,
    { id: 'acme.lookup@1', revision: 'initial', confirmed: true })
})

test('an Agent on the library sees its banner and shared inventory without an Add panel', async () => {
  const page = await loadLocalPage(workerToolsPage, { respond: async path => {
    if (path === '/worker-tools/state') return { body: { ok: true, ...inventory(), workspaceMode: 'read', library: { notice: '' } } }
    if (path === '/status') return { body: { ok: true, workerSetting: { enabled: true, state: 'online' } } }
  } })
  assert.equal(page.$('library-banner').hidden, false)
  assert.match(page.$('library-banner').textContent, /This Agent uses this environment’s tools/)
  assert.equal(page.all('[data-panel="add"]')[0].hidden, true)
  assert.equal(page.$('workspace-mode').value, 'read')
})

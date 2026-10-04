// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { localPage } from '../local/local-ui.mjs'
import { deferred, loadLocalPage } from './support/local-dom.mjs'

test('first send shows Starting while admission is pending; Stop retains the draft and scopes its request', async () => {
  const admission = deferred()
  const page = await loadLocalPage(localPage, { respond: (path) => {
    if (path.startsWith('/conversations')) return { body: { ok: true, available: false, items: [] } }
    if (path.startsWith('/cases')) return admission.promise
    if (path === '/turn/stop') return { body: { ok: true, state: 'stopping' } }
  } })
  await page.type('first message')
  await page.submit()
  assert.match(page.$('stream').textContent, /Starting…/)
  assert.equal(page.$('send').disabled, true)
  const session = page.calls.find(c => c.path.startsWith('/cases')).body.sessionKey
  await page.emit({ src: 'agent', type: 'task-start', id: 'turn-one', session, text: 'first message' })
  admission.resolve({ body: { ok: true, sessionKey: session, id: 'turn-one' } })
  await page.flush()
  assert.equal(page.$('send').getAttribute('aria-label'), 'Stop this turn')
  assert.equal(page.$('send').title, 'Stops this turn. Work already handed to Rulith is not withdrawn.')
  await page.type('keep this draft')
  await page.submit()
  const stop = page.calls.find(c => c.path === '/turn/stop')
  assert.deepEqual(stop.body, { sessionKey: session, id: 'turn-one' })
  assert.equal(stop.headers['x-rulith-local'], 'page-test-key')
  assert.equal(page.$('prompt').value, 'keep this draft')
  assert.equal(page.calls.filter(c => c.path.startsWith('/cases')).length, 1)
  await page.emit({ src: 'agent', type: 'task-done', id: 'turn-one', session, outcome: 'user-stopped', note: 'Stopped by the user.' })
  assert.equal(page.$('send').getAttribute('aria-label'), 'Send message')
  assert.equal(page.$('send').disabled, false)
  assert.match(page.$('stream').textContent, /Stopped by the user/)
  assert.equal(page.$('prompt').value, 'keep this draft')
})

test('the Send/Stop control follows the selected conversation and keeps late Stop refusals with their draft', async () => {
  const stopping = deferred()
  const page = await loadLocalPage(localPage, { respond: path => {
    if (path.startsWith('/conversations')) return { body: { ok: true, available: false, items: [] } }
    if (path === '/turn/stop') return stopping.promise
  } })
  await page.emit({ src: 'agent', type: 'task-start', id: 'turn-one', session: 'one', text: 'one' })
  await page.emit({ src: 'agent', type: 'task-start', id: 'turn-two', session: 'two', text: 'two' })
  await page.click('[data-case="one"]')
  await page.type('draft one')
  await page.submit()
  await page.click('[data-case="two"]')
  assert.equal(page.$('send').disabled, false, 'another conversation has its own Stop control')
  await page.type('draft two')
  stopping.resolve({ status: 400, body: { ok: false, teaching: 'fixture Stop refused' } })
  await page.flush()
  assert.equal(page.$('prompt').value, 'draft two')
  assert.doesNotMatch(page.$('composererr').textContent, /fixture Stop refused/)
  await page.click('[data-case="one"]')
  assert.equal(page.$('prompt').value, 'draft one')
  assert.match(page.$('composererr').textContent, /fixture Stop refused/)
  assert.deepEqual(page.calls.find(c => c.path === '/turn/stop').body, { sessionKey: 'one', id: 'turn-one' })
})

test('archiving a running conversation defers the archive and leaves Stop available', async () => {
  const page = await loadLocalPage(localPage, { respond: path => {
    if (path.startsWith('/conversations')) return { body: { ok: true, available: false, items: [] } }
    if (path.startsWith('/conversation/archive')) return { body: { ok: true, state: 'pending',
      teaching: 'This conversation will be archived after its accepted turns finish.' } }
    if (path === '/turn/stop') return { body: { ok: true, state: 'stopping' } }
  } })
  await page.emit({ src: 'agent', type: 'task-start', id: 'turn-one', session: 'one', text: 'one' })
  await page.click('[data-case="one"]')
  await page.click('archivehistory')
  assert.match(page.$('composererr').textContent, /after its accepted turns finish/)
  assert.equal(page.$('send').getAttribute('aria-label'), 'Stop this turn')
  await page.submit()
  assert.deepEqual(page.calls.find(c => c.path === '/turn/stop').body, { sessionKey: 'one', id: 'turn-one' })
})

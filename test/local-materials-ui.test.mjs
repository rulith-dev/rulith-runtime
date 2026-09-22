// SPDX-License-Identifier: Apache-2.0
/**
 * Adding a file to a message, as the page actually does it.
 *
 * A file a person adds here is a material: bytes this computer keeps, named by a local
 * material id. It is never an attestation that anyone verified anything, never clearance for
 * any use, and never something the conversation carries a path or a payload for — the message
 * carries the id and nothing else, and what may read the bytes is the Agent's authorized
 * tools. These arms are about the ways that goes wrong quietly.
 *
 * The failures they exist for are the ones nobody sees until it has already happened: a
 * message sent while its file was still being stored, so the Agent is asked about something
 * that is not there; a file removed while its upload was in flight that reappears when the
 * upload lands; a file added in one conversation that arrives in a different one because the
 * person switched while the request was open; a refused send that threw away both the typed
 * text and the files, so the retry costs the whole composition again.
 *
 * They run the shipped page against a document with a real shape (`support/local-dom.mjs`),
 * so what is asserted is which handler ran, what the page then sent, and what it left on
 * screen. The browser-only parts — a real drag, a real file input, real focus — are in
 * `test/browser/materials-ui.browser.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { localPage } from '../local/local-ui.mjs'
import { deferred, fileOf, loadLocalPage } from './support/local-dom.mjs'

/**
 * The page, with a material service and a host under the test's control.
 *
 * `control.material` decides each POST /materials — a test replaces it to fail, or to hand
 * back a promise it settles itself. `control.cases` decides the send.
 *
 * An `ok: true` from either is this local host accepting a request and nothing more. No arm
 * below reads it as a Board decision or as Gateway acceptance of anything: what is under test
 * is the page, and the page's claims end where its own request does.
 */
function harness({ material, cases } = {}) {
  let stored = 0
  const control = {
    material: material ?? ((body) => ({ body: { ok: true, material: { id: 'mat-' + (stored += 1), name: body.name, mediaType: body.mediaType, totalBytes: 5, digest: 'sha256:' + 'ab'.repeat(32) } } })),
    cases: cases ?? (() => ({ body: { ok: true, sessionKey: 's-1' } })),
  }
  const page = loadLocalPage(localPage, {
    respond: async (path, request) => {
      if (path.startsWith('/materials')) return control.material(request.body, request)
      if (path.startsWith('/cases')) return control.cases(request.body, request)
      return undefined
    },
  })
  return Object.assign(page, { control })
}
const load = async (options) => {
  const pending = harness(options)
  const page = await pending
  return Object.assign(page, { control: pending.control })
}
const sent = (page, route) => page.calls.filter((call) => call.path.startsWith(route))
/** Choose files through the dialog, the way the primary entry point does. */
const addThroughDialog = async (page, files) => {
  await page.click('caseoptions')
  await page.click('attachfiles')
  await page.choose(files)
}

// ── The two entry points ─────────────────────────────────────────────────────

test('the composer plus opens an attachment menu whose primary action is adding files', async () => {
  const page = await load()
  assert.equal(page.$('attachmenu').hidden, true, 'the menu is closed until it is opened')
  assert.equal(page.$('caseoptions').getAttribute('aria-expanded'), 'false')

  await page.click('caseoptions')
  assert.equal(page.$('attachmenu').hidden, false)
  assert.equal(page.$('caseoptions').getAttribute('aria-expanded'), 'true')
  assert.equal(page.activeId(), 'attachfiles', 'a keyboard lands on the primary action')
  // Add files is first and plain; Case preferences is still here, named as the advanced option.
  const items = page.$('attachmenu').querySelectorAll('[role="menuitem"]')
  assert.deepEqual(items.map((item) => item.id), ['attachfiles', 'attachprefs'])
  assert.match(items[0].textContent, /Add files/)
  assert.match(items[1].textContent, /Advanced · Case preferences/)
  assert.ok(items[1].classList.contains('advanced'))
})

test('Case preferences still opens the same popover, from its place in the menu', async () => {
  const page = await load()
  await page.click('caseoptions')
  await page.click('attachprefs')
  assert.equal(page.$('attachmenu').hidden, true, 'choosing an item closes the menu')
  assert.equal(page.$('casepopover').hidden, false)
  assert.equal(page.activeId(), 'casetype', 'the field it opens for is where the keyboard continues')
  assert.equal(page.$('casetype').value, '', 'no Case Type is pinned unless the user chooses one')
})

test('Add files opens a dialog that can be opened again during a turn', async () => {
  const page = await load()
  await addThroughDialog(page, [fileOf('first.txt')])
  await page.click('filesclose')
  assert.equal(page.$('filesmodal').hidden, true)

  // A turn is under way; the dialog opens again and adds to the same draft. No model tool is
  // invoked and no request event is fabricated to justify it — the only route is the material
  // service, and the only other route this page has ever called is the send.
  await page.emit({ src: 'agent', type: 'task-start', session: 's-1', at: '2026-09-20T15:30:00.000Z', text: 'first.txt please' })
  await page.click('caseoptions')
  await page.click('attachfiles')
  assert.equal(page.$('filesmodal').hidden, false)
  await page.choose([fileOf('second.txt')])
  assert.deepEqual(page.chips().map((chip) => chip.name), ['first.txt', 'second.txt'])
  assert.deepEqual([...new Set(page.calls.map((call) => call.path.split('?')[0]))], ['/status', '/materials'])
})

test('dropping files on the composer is the same act as choosing them', async () => {
  const page = await load()
  await page.dragOver('composer')
  assert.ok(page.$('composer').classList.contains('dragging'), 'the drop target says it is one')
  await page.dropOn('composer', [fileOf('dropped.csv', { type: 'text/csv' })])
  assert.equal(page.$('composer').classList.contains('dragging'), false)
  assert.deepEqual(page.chips().map((chip) => chip.name), ['dropped.csv'])
  assert.equal(sent(page, '/materials')[0].body.mediaType, 'text/csv')
})

// ── What goes to the material service, and what goes with the message ────────

test('several files each become one material, and the message carries only their ids', async () => {
  const page = await load()
  await addThroughDialog(page, [fileOf('one.txt', { bytes: 'alpha' }), fileOf('two.bin', { type: 'application/octet-stream', bytes: 'beta' })])
  assert.deepEqual(page.chips().map((chip) => chip.name + ' · ' + chip.said), ['one.txt · Ready', 'two.bin · Ready'])

  const uploads = sent(page, '/materials')
  assert.equal(uploads.length, 2)
  for (const upload of uploads) {
    assert.equal(upload.method, 'POST')
    assert.match(upload.path, /^\/materials\?k=page-test-key$/, 'the material service is reached with the page key, as every other route is')
    // A mutating route is asked the way Setup and Worker tools ask: the key in the header too.
    assert.equal(upload.headers['x-rulith-local'], 'page-test-key')
    assert.equal(upload.headers['content-type'], 'application/json')
    assert.deepEqual(Object.keys(upload.body).sort(), ['bytes', 'mediaType', 'name'])
  }
  assert.equal(uploads[0].body.bytes, Buffer.from('alpha').toString('base64'))
  assert.equal(uploads[1].body.bytes, Buffer.from('beta').toString('base64'))

  await page.type('What do these say?')
  await page.submit()
  const send = sent(page, '/cases')[0]
  assert.deepEqual(send.body.attachments, ['mat-1', 'mat-2'])
  const body = JSON.stringify(send.body)
  assert.doesNotMatch(body, /YWxwaGE|bytes/, 'the bytes went to the material service, not into the message')
  assert.doesNotMatch(body, /one\.txt|two\.bin|[A-Za-z]:\\|\/tmp\//, 'a filename is not a path and neither belongs in the send')
})

test('a text-only message is sent exactly as it was before', async () => {
  const page = await load()
  await page.type('No files here')
  await page.submit()
  assert.deepEqual(sent(page, '/cases')[0].body, { text: 'No files here' })
})

test('only an explicit Case preference pins the model, and clearing it restores automatic choice', async () => {
  const page = await load()
  page.$('casetype').value = 'official_authoring'
  await page.type('Use my chosen Case Type')
  await page.submit()
  assert.equal(sent(page, '/cases')[0].body.caseType, 'official_authoring')
  page.$('casetype').value = '  '
  await page.type('Choose the next Case Type from the installed capabilities')
  await page.submit()
  assert.equal(Object.hasOwn(sent(page, '/cases')[1].body, 'caseType'), false)
})

test('a message with only files is allowed once one of them is stored', async () => {
  const page = await load()
  await page.submit()
  assert.equal(sent(page, '/cases').length, 0, 'an empty composer with nothing added still sends nothing')

  await addThroughDialog(page, [fileOf('only.pdf', { type: 'application/pdf' })])
  await page.submit()
  const send = sent(page, '/cases')[0]
  assert.equal(send.body.text, '')
  assert.deepEqual(send.body.attachments, ['mat-1'])
  assert.equal(page.chips().length, 0, 'a sent draft is cleared')
  assert.match(page.$('attachsent').textContent, /only\.pdf/, 'the turn just sent says which file went with it')
})

// ── The states that must stop a send ─────────────────────────────────────────

test('a file that is still being added stops the send and says which one', async () => {
  const page = await load()
  const open = deferred()
  page.control.material = () => open.promise
  await addThroughDialog(page, [fileOf('slow.txt')])
  assert.deepEqual(page.chips().map((chip) => chip.said), ['Adding…'])

  await page.type('Here it is')
  await page.submit()
  assert.equal(sent(page, '/cases').length, 0, 'nothing may be sent while a file has no id')
  assert.match(page.$('composererr').textContent, /Still adding slow\.txt/)
  assert.equal(page.$('prompt').value, 'Here it is', 'a refused send keeps what was typed')

  open.resolve({ body: { ok: true, material: { id: 'mat-9', name: 'slow.txt', mediaType: 'text/plain', totalBytes: 5, digest: 'sha256:cc' } } })
  await page.flush()
  assert.deepEqual(page.chips().map((chip) => chip.said), ['Ready'])
  await page.submit()
  assert.deepEqual(sent(page, '/cases')[0].body.attachments, ['mat-9'])
})

test('a file the material service refused stops the send until it is removed', async () => {
  const page = await load({ material: () => ({ status: 413, body: { ok: false, teaching: 'The material service could not store this file.' } }) })
  await addThroughDialog(page, [fileOf('refused.bin')])
  const chip = page.chips()[0]
  assert.equal(chip.said, 'The material service could not store this file.')
  assert.ok(page.find('.chip').classList.contains('bad'), 'a file that failed is visibly the one that failed')

  await page.type('Please read it')
  await page.submit()
  assert.equal(sent(page, '/cases').length, 0)
  assert.match(page.$('composererr').textContent, /refused\.bin could not be added/)

  await page.click(chip.remove)
  assert.equal(page.chips().length, 0)
  await page.submit()
  assert.equal(sent(page, '/cases').length, 1, 'with the failure removed the message goes')
  assert.equal(sent(page, '/cases')[0].body.attachments, undefined)
})

test('a network failure while storing is a state on the chip, not a silent drop', async () => {
  const page = await load({ material: () => { throw new Error('connection reset') } })
  await addThroughDialog(page, [fileOf('lost.txt')])
  assert.deepEqual(page.chips().map((chip) => chip.name + ' · ' + chip.said), ['lost.txt · Could not be added'])
})

test('a refused send keeps both the text and the files', async () => {
  const page = await load({ cases: () => ({ status: 409, body: { ok: false, teaching: 'This Agent is not started, so the message was not sent.' } }) })
  await addThroughDialog(page, [fileOf('invoice.pdf', { type: 'application/pdf' })])
  await page.type('Check this invoice')
  await page.submit()

  assert.equal(page.$('composererr').textContent, 'This Agent is not started, so the message was not sent.')
  assert.equal(page.$('prompt').value, 'Check this invoice')
  assert.deepEqual(page.chips().map((chip) => chip.name + ' · ' + chip.said), ['invoice.pdf · Ready'])
  assert.equal(page.$('attachsent').textContent, '', 'nothing was sent, so nothing is confirmed as sent')

  // The retry uses the same material: a refused send must not cost the upload again.
  page.control.cases = () => ({ body: { ok: true, sessionKey: 's-1' } })
  await page.submit()
  assert.equal(sent(page, '/materials').length, 1)
  assert.deepEqual(sent(page, '/cases')[1].body.attachments, ['mat-1'])
  assert.equal(page.chips().length, 0)
})

// ── Removing, limits, and answers that arrive late ───────────────────────────

test('a file removed while it is still uploading does not come back when the upload lands', async () => {
  const page = await load()
  const open = deferred()
  page.control.material = () => open.promise
  await addThroughDialog(page, [fileOf('gone.txt')])
  assert.deepEqual(page.chips().map((chip) => chip.said), ['Adding…'])

  await page.click(page.chips()[0].remove)
  assert.equal(page.chips().length, 0)
  assert.equal(page.activeId(), 'filespick', 'removing a chip leaves the keyboard somewhere it can continue')

  open.resolve({ body: { ok: true, material: { id: 'mat-late', name: 'gone.txt', mediaType: 'text/plain', totalBytes: 5, digest: 'sha256:dd' } } })
  await page.flush()
  assert.equal(page.chips().length, 0, 'a removed file stays removed')
  await page.type('Nothing attached')
  await page.submit()
  assert.equal(sent(page, '/cases')[0].body.attachments, undefined)
})

test('eight files is the limit, and a file over 8 MiB is refused by name', async () => {
  const page = await load()
  const nine = Array.from({ length: 9 }, (_, at) => fileOf('file-' + at + '.txt'))
  await addThroughDialog(page, nine)
  assert.equal(page.chips().length, 8)
  assert.equal(sent(page, '/materials').length, 8, 'the ninth file was never read or sent anywhere')
  assert.match(page.$('filesnote').textContent, /Up to 8 files/)

  await page.click(page.chips()[0].remove)
  await page.choose([fileOf('huge.bin', { size: 8 * 1024 * 1024 + 1 }), fileOf('small.bin')])
  assert.match(page.$('filesnote').textContent, /huge\.bin is larger than 8 MiB/)
  assert.equal(page.chips().some((chip) => chip.name === 'huge.bin'), false)
  assert.equal(page.chips().some((chip) => chip.name === 'small.bin'), true, 'one refused file does not refuse the rest')
  assert.equal(sent(page, '/materials').some((call) => call.body.name === 'huge.bin'), false)
})

test('a file added in one conversation never follows the person to another', async () => {
  const page = await load()
  await page.emit({ src: 'agent', type: 'task-start', session: 's-alpha', at: '2026-09-20T15:30:00.000Z', text: 'Alpha' })
  await page.emit({ src: 'agent', type: 'task-start', session: 's-beta', at: '2026-09-20T15:31:00.000Z', text: 'Beta' })
  const caseOf = (session) => page.all('.case').find((row) => row.dataset.case === session)

  await page.click(caseOf('s-alpha'))
  const open = deferred()
  page.control.material = () => open.promise
  await addThroughDialog(page, [fileOf('alpha-ledger.csv', { type: 'text/csv' })])
  await page.click('filesclose')
  assert.deepEqual(page.chips().map((chip) => chip.name), ['alpha-ledger.csv'])

  // Switching conversation while the upload is open: the other conversation has its own draft.
  await page.click(caseOf('s-beta'))
  assert.equal(page.chips().length, 0)
  assert.equal(page.$('attachlist').hidden, true)
  open.resolve({ body: { ok: true, material: { id: 'mat-alpha', name: 'alpha-ledger.csv', mediaType: 'text/csv', totalBytes: 5, digest: 'sha256:ee' } } })
  await page.flush()
  assert.equal(page.chips().length, 0, 'an answer that lands after the switch belongs to the conversation it was added in')

  await page.type('Beta has no files')
  await page.submit()
  const beta = sent(page, '/cases')[0]
  assert.equal(beta.body.sessionKey, 's-beta')
  assert.equal(beta.body.attachments, undefined)

  // And it is still there, stored, in the conversation it was added to.
  await page.click(caseOf('s-alpha'))
  assert.deepEqual(page.chips().map((chip) => chip.name + ' · ' + chip.said), ['alpha-ledger.csv · Ready'])
  await page.submit()
  const alpha = sent(page, '/cases')[1]
  assert.equal(alpha.body.sessionKey, 's-alpha')
  assert.deepEqual(alpha.body.attachments, ['mat-alpha'])
})

test('starting a new conversation does not carry the files of the one left behind', async () => {
  const page = await load()
  await page.emit({ src: 'agent', type: 'task-start', session: 's-alpha', at: '2026-09-20T15:30:00.000Z', text: 'Alpha' })
  await page.click(page.all('.case').find((row) => row.dataset.case === 's-alpha'))
  await addThroughDialog(page, [fileOf('kept.txt')])
  await page.click('filesclose')

  await page.click('newcase')
  assert.equal(page.chips().length, 0, 'a new conversation starts with nothing attached')
  await page.type('A fresh start')
  await page.submit()
  assert.equal(sent(page, '/cases')[0].body.attachments, undefined)
  assert.equal(sent(page, '/cases')[0].body.sessionKey, undefined)
})

// ── A send that is still open while the person carries on ────────────────────
//
// Everything a send does when it lands is about the draft it came from, which may not be the
// one on screen by then. A request cannot empty the box of a conversation it was not typed in,
// move the selection out from under a person reading something else, throw away a file added
// after it left, or answer in a composer that is now showing another conversation's answer.

/** Two conversations the sidebar knows about, so a test can move between them. */
const withConversations = async (page, sessions) => {
  let minute = 30
  for (const session of sessions) {
    await page.emit({ src: 'agent', type: 'task-start', session, at: '2026-09-20T15:' + (minute += 1) + ':00.000Z', text: 'In ' + session })
  }
  return (session) => page.all('.case').find((row) => row.dataset.case === session)
}

test('a send that lands after the person moved on leaves the conversation they moved to alone', async () => {
  const page = await load()
  const caseOf = await withConversations(page, ['s-beta'])
  const open = deferred()

  // Composed in a new conversation: a file, some text, and a send that does not come back yet.
  await addThroughDialog(page, [fileOf('alpha.csv', { type: 'text/csv' })])
  await page.click('filesclose')
  await page.type('Please read alpha.csv')
  page.control.cases = () => open.promise
  await page.submit()

  // The person does not wait: another conversation, another message, another file.
  await page.click(caseOf('s-beta'))
  await page.type('Something else entirely')
  await addThroughDialog(page, [fileOf('beta.txt')])
  await page.click('filesclose')

  open.resolve({ body: { ok: true, sessionKey: 's-1' } })
  await page.flush()

  assert.equal(page.state.active, 's-beta', 'the answer must not move the selection')
  assert.equal(page.state.session, 's-beta', 'nor the conversation the next message goes to')
  assert.equal(page.$('prompt').value, 'Something else entirely', 'nor empty a box it did not fill')
  assert.deepEqual(page.chips().map((chip) => chip.name), ['beta.txt'], 'nor take a file it never sent')
  assert.equal(page.$('composererr').textContent, '')
  assert.equal(page.$('attachsent').textContent, '', 'the confirmation belongs to the conversation that sent it')

  // It is all there, in the conversation it was composed in, under the key the host gave it.
  const back = await withConversations(page, ['s-1'])
  await page.click(back('s-1'))
  assert.equal(page.chips().length, 0, 'the file that went is no longer waiting to be sent')
  assert.match(page.$('attachsent').textContent, /Sent with 1 file: alpha\.csv/)
})

test('a file added while the send is open is not swept away with the one that went', async () => {
  const page = await load()
  const open = deferred()
  await addThroughDialog(page, [fileOf('went.csv', { type: 'text/csv' })])
  await page.type('The first one')
  page.control.cases = () => open.promise
  await page.submit()

  await page.choose([fileOf('after.txt')])
  assert.deepEqual(page.chips().map((chip) => chip.name), ['went.csv', 'after.txt'])
  open.resolve({ body: { ok: true, sessionKey: 's-1' } })
  await page.flush()

  assert.deepEqual(sent(page, '/cases')[0].body.attachments, ['mat-1'], 'only what was ready when it was sent')
  assert.deepEqual(page.chips().map((chip) => chip.name + ' · ' + chip.said), ['after.txt · Ready'],
    'the file added while the request was open is still waiting to be sent')
  assert.match(page.$('attachsent').textContent, /Sent with 1 file: went\.csv/)
  assert.equal(page.$('prompt').value, '', 'the message that went is out of the box')

  // And it sends as itself, in the conversation that now has a key.
  await page.submit()
  assert.deepEqual(sent(page, '/cases')[1].body, { text: '', sessionKey: 's-1', attachments: ['mat-2'] })
})

test('a file still uploading when the conversation is given its key stays with it', async () => {
  const page = await load()
  const send = deferred(), store = deferred()
  await page.type('A new conversation')
  page.control.cases = () => send.promise
  await page.submit()

  page.control.material = () => store.promise
  await page.choose([fileOf('late.txt')])
  assert.deepEqual(page.chips().map((chip) => chip.said), ['Adding…'])

  send.resolve({ body: { ok: true, sessionKey: 's-1' } })
  await page.flush()
  assert.equal(page.state.session, 's-1')
  assert.deepEqual(page.chips().map((chip) => chip.said), ['Adding…'], 'the draft kept its file when it was given a key')

  store.resolve({ body: { ok: true, material: { id: 'mat-late', name: 'late.txt', mediaType: 'text/plain', totalBytes: 5, digest: 'sha256:ff' } } })
  await page.flush()
  assert.deepEqual(page.chips().map((chip) => chip.name + ' · ' + chip.said), ['late.txt · Ready'],
    'and the upload that was in flight the whole time still finds the draft it belongs to')
  await page.submit()
  assert.deepEqual(sent(page, '/cases')[1].body.attachments, ['mat-late'])
})

test('text typed while the send is open is the next message, not the one that went', async () => {
  const page = await load()
  const open = deferred()
  await page.type('First message')
  page.control.cases = () => open.promise
  await page.submit()
  await page.type('Second message, typed while waiting')
  open.resolve({ body: { ok: true, sessionKey: 's-1' } })
  await page.flush()

  assert.equal(page.$('prompt').value, 'Second message, typed while waiting', 'a box that changed is not the box that was sent')
  assert.equal(sent(page, '/cases')[0].body.text, 'First message')
})

test('a send that lands after the selection changed does not change it back', async () => {
  const page = await load()
  const caseOf = await withConversations(page, ['s-alpha'])
  await page.click(caseOf('s-alpha'))
  const open = deferred()
  await page.type('Still in s-alpha')
  page.control.cases = () => open.promise
  await page.submit()

  // Same draft, different view: All activity is a filter, not another conversation.
  await page.click(page.all('.case').find((row) => row.dataset.case === ''))
  assert.equal(page.state.active, '')
  open.resolve({ body: { ok: true, sessionKey: 's-alpha' } })
  await page.flush()

  assert.equal(page.state.active, '', 'the view the person chose is the view they keep')
  assert.equal(page.state.session, 's-alpha', 'the next message still goes to the conversation they are composing in')
  assert.equal(page.$('prompt').value, '')
})

test('a late failure answers in the conversation it was sent from, not over another one', async () => {
  const page = await load()
  const caseOf = await withConversations(page, ['s-alpha', 's-beta'])
  const open = deferred()
  await page.click(caseOf('s-alpha'))
  await page.type('This one will be refused')
  page.control.cases = () => open.promise
  await page.submit()

  // Meanwhile, in another conversation, the composer is saying something of its own.
  await page.click(caseOf('s-beta'))
  page.$('businesskey').value = '{not json'
  await page.submit()
  assert.equal(page.$('composererr').textContent, 'Business key must be valid JSON.')

  open.resolve({ status: 409, body: { ok: false, teaching: 'This Agent is not started, so the message was not sent.' } })
  await page.flush()
  assert.equal(page.$('composererr').textContent, 'Business key must be valid JSON.',
    'a refusal from another conversation must not overwrite what this one is saying')

  page.$('businesskey').value = ''
  await page.click(caseOf('s-alpha'))
  assert.equal(page.$('composererr').textContent, 'This Agent is not started, so the message was not sent.',
    'and it is waiting in the conversation it belongs to')
})

// ── What a person is told, and what they are not ─────────────────────────────

test('the chip says the filename and how far along it is, and nothing technical', async () => {
  const page = await load()
  await addThroughDialog(page, [fileOf('report.pdf', { type: 'application/pdf' })])
  const chip = page.find('.chip')
  assert.equal(chip.textContent.includes('report.pdf'), true)
  for (const technical of ['sha256', 'mat-1', 'application/pdf', 'base64'])
    assert.equal(chip.textContent.includes(technical), false, 'the default view keeps ' + technical + ' out of the way')
  assert.equal(page.$('attachlist').textContent.includes('sha256'), false)
  assert.equal(page.$('fileslist').textContent.includes('sha256'), false)
})

test('the page says where the files are and what reading them takes', async () => {
  const copy = 'Files are kept on this computer. Reading them requires the Agent’s authorized tools. Content sent to your selected model follows its data permissions.'
  assert.ok(localPage.includes(copy), 'the disclosure is the one that was agreed')
  const page = await load()
  assert.equal(page.$('attachnote').hidden, true, 'it appears where files are, not as permanent furniture')
  await addThroughDialog(page, [fileOf('a.txt')])
  assert.equal(page.$('attachnote').hidden, false)
  assert.equal(page.$('attachnote').textContent, copy)
  // What it must not say: that nothing ever leaves, or that the model is local.
  assert.doesNotMatch(localPage, /never leaves? (your|this) (computer|machine)/i)
  assert.doesNotMatch(localPage, /offline model|runs offline|no data is sent/i)
})

test('a past message shows the files it carried, when the event says what they were', async () => {
  const page = await load()
  await page.emit({ src: 'agent', type: 'task-start', session: 's-1', at: '2026-09-20T15:30:00.000Z', text: 'Read these',
    attachments: [{ id: 'mat-1', name: 'ledger.csv' }, { id: 'mat-2', name: 'notes<b>.txt' }] })
  const stream = page.$('stream').innerHTML
  assert.match(stream, /<div class="bubble-files">Attached · ledger\.csv · notes&lt;b&gt;\.txt<\/div>/)
  assert.equal(stream.includes('mat-1'), false, 'a material id is a local handle, not something a reader needs')

  // An event that names no file still says how many there were rather than inventing one.
  await page.emit({ src: 'agent', type: 'task-start', session: 's-2', at: '2026-09-20T15:31:00.000Z', text: 'And this', attachments: ['mat-3'] })
  assert.match(page.$('stream').innerHTML, /<div class="bubble-files">1 file attached<\/div>/)
  // A message with no attachments is exactly what it was.
  await page.emit({ src: 'agent', type: 'task-start', session: 's-3', at: '2026-09-20T15:32:00.000Z', text: 'Plain' })
  assert.match(page.$('stream').innerHTML, /<div class="bubble">Plain<\/div>/)
})

// ── Keyboard and focus ───────────────────────────────────────────────────────

test('Escape closes the menu and the dialog, and focus comes back each time', async () => {
  const page = await load()
  page.$('caseoptions').focus()
  await page.click('caseoptions')
  assert.equal(page.activeId(), 'attachfiles')
  await page.press('Escape')
  assert.equal(page.$('attachmenu').hidden, true)
  assert.equal(page.activeId(), 'caseoptions', 'the keyboard is back where it opened the menu')

  await page.click('caseoptions')
  await page.click('attachfiles')
  assert.equal(page.$('filesmodal').hidden, false)
  assert.equal(page.activeId(), 'filespick')
  assert.equal(page.$('app').inert, true, 'the rest of the document is not there while the dialog is')
  await page.press('Escape')
  assert.equal(page.$('filesmodal').hidden, true)
  assert.equal(page.$('app').inert, false)
  assert.equal(page.activeId(), 'caseoptions')
})

test('clicking away closes the menu without touching the draft', async () => {
  const page = await load()
  await addThroughDialog(page, [fileOf('kept.txt')])
  await page.click('filesclose')
  await page.click('caseoptions')
  await page.click('prompt')
  assert.equal(page.$('attachmenu').hidden, true)
  assert.deepEqual(page.chips().map((chip) => chip.name), ['kept.txt'])
})

test('the dialog is a dialog: named, closable, and Tab stays inside it', async () => {
  assert.match(localPage, /id="filesmodal" role="dialog" aria-modal="true" aria-labelledby="filestitle"/)
  assert.match(localPage, /aria-label="Close Add files"/)
  assert.match(localPage, /id="attachmenu" role="menu"/)
  assert.match(localPage, /id="caseoptions"[^>]*aria-haspopup="menu"/)
  const page = await load()
  await page.click('caseoptions')
  await page.click('attachfiles')
  page.$('filesclose').focus()
  await page.press('Tab', { shiftKey: true })
  assert.notEqual(page.activeId(), '', 'Shift+Tab from the first control stays in the dialog')
  assert.ok(page.$('filesmodal').contains(page.document.activeElement))
})

test('new conversation is empty while All activity still retains previous messages', async () => {
  const page = await load()
  await page.emit({ src: 'agent', type: 'task-start', session: 'existing', text: 'Previous conversation content' })
  assert.match(page.$('stream').textContent, /Previous conversation content/)
  await page.click('newcase')
  assert.doesNotMatch(page.$('stream').textContent, /Previous conversation content/)
  assert.match(page.$('stream').textContent, /What would you like/)
  await page.click(page.all('.case').find(row => row.dataset.case === ''))
  assert.match(page.$('stream').textContent, /Previous conversation content/)
})


test('unconfirmed readiness does not permanently block a custom running Agent', async () => {
  const page = await loadLocalPage(localPage, { respond: async path => {
    if (path.startsWith('/status')) return { body: { ok:true, mode:'agent', roles:['agent'], agent:true, worker:false, ready:{agent:false,worker:false}, runtime:{} } }
    if (path.startsWith('/cases')) return { body:{ok:true,sessionKey:'custom-agent'} }
  } })
  assert.match(page.$('stream').textContent, /readiness is not confirmed/)
  page.$('prompt').value = 'Try the running task endpoint'
  await page.submit()
  assert.equal(page.calls.filter(call => call.path.startsWith('/cases')).length, 1)
})

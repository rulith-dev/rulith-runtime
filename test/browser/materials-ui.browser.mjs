// SPDX-License-Identifier: Apache-2.0
/**
 * Adding a file to a message, in a browser.
 *
 * The DOM arms in `test/local-materials-ui.test.mjs` decide which handler ran and what the
 * page then sent. Four things they cannot decide belong here, because only a browser has
 * them: a real `<input type="file">` carrying real bytes, a real drag carrying a real
 * `DataTransfer`, real focus moving between a control and a dialog, and a real `FileReader`
 * path through the page's own base64 encoding. A shim that agreed with the page about any of
 * those would be agreeing with it about something neither of them had checked.
 *
 * Not part of `npm test` on purpose — outside the `test/*.test.mjs` glob, and it needs a
 * Playwright install that is not a dependency of this package. Run it directly:
 *
 *   node --test test/browser/materials-ui.browser.mjs
 *
 * It resolves Playwright and a Chromium the same way `workbench-ui.browser.mjs` does, and
 * every arm skips with a reason rather than failing when neither is there.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { localPage } from '../../local/local-ui.mjs'

const PLAYWRIGHT = 'D:/Work/rulith-java/console-web/node_modules/playwright/index.js'

function chromiumExecutable() {
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  if (!existsSync(root)) return ''
  const candidates = []
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('chromium_headless_shell-')) candidates.push(join(root, entry, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'))
    if (entry.startsWith('chromium-')) candidates.push(join(root, entry, 'chrome-win64', 'chrome.exe'))
  }
  return candidates.find((path) => existsSync(path)) ?? ''
}

let chromium = null, executablePath = ''
try {
  if (existsSync(PLAYWRIGHT)) {
    const loaded = await import(pathToFileURL(PLAYWRIGHT).href)
    chromium = loaded.chromium ?? loaded.default?.chromium ?? null
  }
  executablePath = chromiumExecutable()
} catch { chromium = null }
const SKIP = chromium === null ? 'Playwright is not resolvable from this tree'
  : executablePath === '' ? 'no Chromium build in the shared ms-playwright cache' : false

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
const readBody = (req) => new Promise((accept) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => { try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { accept({}) } })
})

/**
 * One conversation host, answering what the real one answers — plus the material service the
 * page posts to. It stores the decoded bytes so an arm can assert that what arrived is what
 * was on disk, which is the whole claim the base64 body makes.
 *
 * What `ok: true` means here is exactly what it means from the real host: this local process
 * accepted the request. It is not a Board decision, not Gateway acceptance, and no arm below
 * reads it as one — these arms are about the page, and stop at the page's own boundary.
 */
async function startHost() {
  const KEY = 'host-browser-key-0001'
  const stored = []
  const streams = new Set()
  const control = { materialDelay: 0, materialStatus: 200, casesDelay: 0, cases: { ok: true, sessionKey: 's-1' }, sends: [], extraEvents: [],
    emit(event) { this.extraEvents.push(event);for (const stream of streams) stream.write('data: ' + JSON.stringify(event) + '\n\n') } }
  /** Two conversations the sidebar knows about, replayed as the real host replays its buffer. */
  const REPLAY = ['s-alpha', 's-beta'].map((session, at) => ({ src: 'agent', type: 'task-start', session,
    at: '2026-09-20T15:3' + at + ':00.000Z', text: 'Working in ' + session }))
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return void res.end(localPage)
    }
    if (path === '/status') {
      return void json(res, 200, { ok: true, mode: 'agent', roles: ['agent'], agent: true, worker: false,
        runtime: { configFile: 'D:/instances/inst-1/local.json',
          agent: { id: 'agent-alpha', credentialConfigured: true, modelService: 'http://127.0.0.1:8080/v1', model: 'test-model', modelKeyConfigured: true, thinking: 'standard' },
          worker: { connection: '', credentialConfigured: false, workspaceTools: 'read', toolsFile: '', sourcesFile: '' } } })
    }
    if (path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(': open\n\n')
      streams.add(res);res.on('close', () => streams.delete(res))
      for (const event of REPLAY) res.write('data: ' + JSON.stringify(event) + '\n\n')
      for (const event of control.extraEvents) res.write('data: ' + JSON.stringify(event) + '\n\n')
      return
    }
    if (path === '/materials' && req.method === 'POST') {
      const body = await readBody(req)
      // The gate the real host puts on a mutating route: the key in the header, and this page's
      // own origin. An arm that skipped these would pass against a host that refuses the page.
      if (req.headers['x-rulith-local'] !== KEY) return void json(res, 403, { ok: false, teaching: 'Storing a file requires the Local page key.' })
      if (req.headers.origin !== undefined && req.headers.origin !== 'http://' + req.headers.host) return void json(res, 403, { ok: false, teaching: 'Cross-origin request rejected.' })
      if (url.searchParams.get('k') !== KEY) return void json(res, 401, { ok: false, teaching: 'Missing or invalid Rulith key.' })
      if (control.materialDelay) await new Promise((done) => setTimeout(done, control.materialDelay))
      if (control.materialStatus >= 400) return void json(res, control.materialStatus, { ok: false, teaching: 'The material service could not store this file.' })
      const bytes = Buffer.from(String(body.bytes ?? ''), 'base64')
      stored.push({ name: body.name, mediaType: body.mediaType, text: bytes.toString('utf8'), totalBytes: bytes.length })
      return void json(res, 200, { ok: true, material: { id: 'mat-' + stored.length, name: body.name, mediaType: body.mediaType, totalBytes: bytes.length, digest: 'sha256:' + 'ab'.repeat(32) } })
    }
    if (path === '/cases' && req.method === 'POST') {
      control.sends.push(await readBody(req))
      if (control.casesDelay) await new Promise((done) => setTimeout(done, control.casesDelay))
      return void json(res, 200, control.cases)
    }
    json(res, 404, { ok: false, teaching: 'Not in this fixture.' })
  })
  const port = await new Promise((accept) => server.listen(0, '127.0.0.1', () => accept(server.address().port)))
  return {
    url: 'http://127.0.0.1:' + port + '/?k=' + KEY,
    stored, control,
    stop: async () => { server.closeAllConnections?.(); await new Promise((done) => server.close(() => done())) },
  }
}

let browser = null
test.before(async () => { if (!SKIP) browser = await chromium.launch({ headless: true, executablePath }) })
test.after(async () => { if (browser) await browser.close() })

const arm = (name, body) => test(name, { skip: SKIP }, async () => {
  const host = await startHost()
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  const failures = []
  page.on('pageerror', (error) => failures.push(String(error)))
  page.on('dialog', (dialog) => { failures.push('a browser dialog was opened: ' + dialog.message()); dialog.dismiss() })
  try {
    await page.goto(host.url)
    await page.waitForSelector('#composer')
    await body({ page, host })
    assert.deepEqual(failures, [], 'the page raised something while this arm ran')
  } finally {
    await context.close()
    await host.stop()
  }
})

/** A real file for the real input, without touching the disk this test runs on. */
const upload = (name, mimeType, text) => ({ name, mimeType, buffer: Buffer.from(text, 'utf8') })

arm('a file in an existing conversation is sent to its one observed running Case', async ({ page, host }) => {
  host.control.emit({ src: 'agent', type: 'focus', session: 's-alpha',
    roots: [{ caseId: 'CASE-A', status: 'running', contact: 'observed', root: 'ROOT-A' }] })
  await page.click('[data-case="s-alpha"]')
  await page.click('#caseoptions');await page.click('#attachfiles')
  await page.setInputFiles('#fileinput', [upload('supplement.txt', 'text/plain', 'new fact')])
  await page.waitForFunction(() => document.querySelector('#attachlist .chip-state')?.textContent === 'Ready')
  await page.click('#filesclose')
  assert.equal(await page.inputValue('#materialtarget'), 'CASE-A')
  await page.fill('#prompt', 'Use this additional file')
  await page.click('#send')
  await page.waitForFunction(() => document.getElementById('prompt').value === '')
  assert.equal(host.control.sends[0].caseId, 'CASE-A')
  assert.deepEqual(host.control.sends[0].attachments, ['mat-1'])
})

arm('several focused Cases require choosing the exact material target', async ({ page, host }) => {
  host.control.emit({ src: 'agent', type: 'focus', session: 's-alpha',
    roots: [{ caseId: 'CASE-A', status: 'running', contact: 'observed', root: 'ROOT-A' },
      { caseId: 'CASE-B', status: 'running', contact: 'observed', root: 'ROOT-B' }] })
  await page.click('[data-case="s-alpha"]')
  await page.click('#caseoptions');await page.click('#attachfiles')
  await page.setInputFiles('#fileinput', [upload('supplement.txt', 'text/plain', 'new fact')])
  await page.waitForFunction(() => document.querySelector('#attachlist .chip-state')?.textContent === 'Ready')
  await page.click('#filesclose')
  await page.fill('#prompt', 'Use this additional file')
  await page.click('#send')
  assert.equal(host.control.sends.length, 0)
  assert.match(await page.textContent('#composererr'), /Choose which Case/)
  await page.selectOption('#materialtarget', 'CASE-B')
  await page.click('#send')
  await page.waitForFunction(() => document.getElementById('prompt').value === '')
  assert.equal(host.control.sends[0].caseId, 'CASE-B')
})

arm('a Case whose running status was not refreshed is never preselected for files', async ({ page, host }) => {
  host.control.emit({ src: 'agent', type: 'focus', session: 's-alpha',
    roots: [{ caseId: 'CASE-A', status: 'running', contact: 'not-refreshed', root: 'ROOT-A' }] })
  await page.click('[data-case="s-alpha"]')
  await page.click('#caseoptions');await page.click('#attachfiles')
  await page.setInputFiles('#fileinput', [upload('supplement.txt', 'text/plain', 'new fact')])
  await page.waitForFunction(() => document.querySelector('#attachlist .chip-state')?.textContent === 'Ready')
  await page.click('#filesclose')
  assert.equal(await page.inputValue('#materialtarget'), '__choose__')
  await page.fill('#prompt', 'Use this file')
  await page.click('#send')
  assert.equal(host.control.sends.length, 0)
  await page.selectOption('#materialtarget', 'CASE-A')
  await page.click('#send')
  await page.waitForFunction(() => document.getElementById('prompt').value === '')
  assert.equal(host.control.sends[0].caseId, 'CASE-A')
})

arm('files chosen in the dialog arrive byte for byte, and the message carries only their ids',
  async ({ page, host }) => {
    await page.click('#caseoptions')
    await page.click('#attachfiles')
    await page.waitForSelector('#filesmodal:not([hidden])')
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      page.click('#filespick'),
    ])
    await chooser.setFiles([
      upload('ledger.csv', 'text/csv', 'id,total\n1,42\n'),
      upload('notes.txt', 'text/plain', 'Ünïcode stays intact'),
    ])
    await page.waitForFunction(() => document.querySelectorAll('#attachlist .chip').length === 2)
    await page.waitForFunction(() => [...document.querySelectorAll('#attachlist .chip-state')].every((node) => node.textContent === 'Ready'))

    assert.deepEqual(host.stored.map((entry) => entry.name), ['ledger.csv', 'notes.txt'])
    assert.equal(host.stored[0].text, 'id,total\n1,42\n', 'the bytes the browser read are the bytes that arrived')
    assert.equal(host.stored[1].text, 'Ünïcode stays intact', 'the page must not corrupt what is not ASCII')
    assert.equal(host.stored[0].mediaType, 'text/csv')

    await page.click('#filesclose')
    await page.fill('#prompt', 'What do these say?')
    await page.click('#send')
    await page.waitForFunction(() => document.getElementById('prompt').value === '')
    assert.deepEqual(host.control.sends[0].attachments, ['mat-1', 'mat-2'])
    assert.equal(JSON.stringify(host.control.sends[0]).includes('id,total'), false, 'no bytes ride along with the message')
    assert.match(await page.textContent('#attachsent'), /ledger\.csv/)
  })

arm('a real drag onto the composer adds the file it carried', async ({ page, host }) => {
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['dropped bytes'], 'dropped.txt', { type: 'text/plain' }))
    const composer = document.getElementById('composer')
    composer.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }))
    composer.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(() => document.querySelector('#attachlist .chip-state')?.textContent === 'Ready')
  assert.deepEqual(host.stored.map((entry) => entry.text), ['dropped bytes'])
  assert.equal(await page.isVisible('#attachnote'), true, 'where the files are is said where they were added')
  assert.equal(await page.evaluate(() => document.getElementById('composer').classList.contains('dragging')), false)
})

arm('the whole flow is reachable from the keyboard, and focus comes back', async ({ page }) => {
  await page.focus('#caseoptions')
  await page.keyboard.press('Enter')
  await page.waitForSelector('#attachmenu:not([hidden])')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'attachfiles')

  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.getElementById('attachmenu').hidden === true)
  assert.equal(await page.evaluate(() => document.activeElement.id), 'caseoptions')

  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.waitForSelector('#filesmodal:not([hidden])')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'filespick')
  // aria-modal is a claim about the rest of the document; inert is what makes it true.
  assert.equal(await page.evaluate(() => document.getElementById('app').inert), true)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.getElementById('filesmodal').hidden === true)
  assert.equal(await page.evaluate(() => document.activeElement.id), 'caseoptions')
  assert.equal(await page.evaluate(() => document.getElementById('app').inert), false)
})

arm('a send still in flight does not empty, re-select or take a file from the conversation opened after it',
  async ({ page, host }) => {
    await page.waitForSelector('.case[data-case="s-alpha"]')
    await page.click('.case[data-case="s-alpha"]')
    await page.setInputFiles('#fileinput', [upload('alpha.csv', 'text/csv', 'id,total\n1,42\n')])
    await page.waitForFunction(() => document.querySelector('#attachlist .chip-state')?.textContent === 'Ready')
    await page.fill('#prompt', 'Read alpha.csv please')

    host.control.casesDelay = 1200
    host.control.cases = { ok: true, sessionKey: 's-alpha' }
    await page.click('#send')
    await page.waitForFunction(() => document.getElementById('send').disabled === true)

    // The person does not wait for it: another conversation, another message, another file.
    await page.click('.case[data-case="s-beta"]')
    await page.fill('#prompt', 'Something else entirely')
    await page.setInputFiles('#fileinput', [upload('beta.txt', 'text/plain', 'beta')])
    await page.waitForFunction(() => document.querySelectorAll('#attachlist .chip').length === 1)

    await page.waitForFunction(() => document.getElementById('send').disabled === false, null, { timeout: 15000 })
    await page.waitForTimeout(250)
    assert.equal(await page.inputValue('#prompt'), 'Something else entirely', 'the answer emptied a box it did not fill')
    assert.equal(await page.evaluate(() => document.querySelector('.case.active')?.dataset.case), 's-beta',
      'the answer moved the selection out from under the person')
    assert.deepEqual(await page.$$eval('#attachlist .chip-name', (nodes) => nodes.map((node) => node.textContent)), ['beta.txt'])
    assert.equal(await page.textContent('#attachsent'), '', 'the confirmation belongs to the conversation that sent it')
    assert.deepEqual(host.control.sends[0].attachments, ['mat-1'])

    // Back where it was sent from: the file that went is gone, and the confirmation is there.
    await page.click('.case[data-case="s-alpha"]')
    assert.equal(await page.evaluate(() => document.querySelectorAll('#attachlist .chip').length), 0)
    assert.match(await page.textContent('#attachsent'), /Sent with 1 file: alpha\.csv/)
  })

arm('a file removed while it is still being stored does not return, and the send is honest about what it has',
  async ({ page, host }) => {
    host.control.materialDelay = 900
    await page.click('#caseoptions')
    await page.click('#attachfiles')
    await page.setInputFiles('#fileinput', [upload('slow.txt', 'text/plain', 'still uploading')])
    await page.waitForFunction(() => document.querySelector('#fileslist .chip-state')?.textContent === 'Adding…')
    await page.click('#filesclose')

    // Sending now would ask the Agent about a file that has no id yet.
    await page.fill('#prompt', 'Look at this')
    await page.click('#send')
    await page.waitForFunction(() => document.getElementById('composererr').textContent.includes('Still adding slow.txt'))
    assert.equal(host.control.sends.length, 0)

    await page.click('#attachlist .chip-drop')
    assert.equal(await page.evaluate(() => document.querySelectorAll('#attachlist .chip').length), 0)
    assert.equal(await page.evaluate(() => document.activeElement.id), 'caseoptions',
      'removing the last chip leaves the keyboard on the control that adds another')
    await page.waitForTimeout(1200)
    assert.equal(await page.evaluate(() => document.querySelectorAll('#attachlist .chip').length), 0, 'the answer landed after the removal and stayed gone')

    await page.click('#send')
    await page.waitForFunction(() => document.getElementById('prompt').value === '')
    assert.equal(host.control.sends[0].attachments, undefined)
  })

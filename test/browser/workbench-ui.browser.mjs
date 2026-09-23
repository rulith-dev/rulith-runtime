// SPDX-License-Identifier: Apache-2.0
/**
 * The workbench in a browser, against the pages this package actually ships.
 *
 * Every arm here is one a shim cannot decide. A sandboxed frame discarding `alert()`, a
 * header clipped at 415px inside a column that never scrolls sideways, a drawer that is
 * off-screen but still in the tab order, a `<select>` losing a value that had to be escaped,
 * a frame keeping its unsent text across A → B → A: these are browser behaviours, and the
 * only honest way to check them is to ask a browser.
 *
 * Not part of `npm test` on purpose — it is outside the `test/*.test.mjs` glob and needs a
 * Playwright install that is not a dependency of this package. Run it directly:
 *
 *   node --test test/browser/workbench-ui.browser.mjs
 *
 * It resolves Playwright from the console workspace and a Chromium from the shared
 * ms-playwright cache; if neither is there, every arm skips with a reason rather than failing.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startMockWorkbench } from './mock-manager.mjs'

const PLAYWRIGHT = process.env.RULITH_PLAYWRIGHT_MODULE || 'D:/Work/rulith-java/console-web/node_modules/playwright/index.js'

/** A Chromium from the shared cache; the installed package may expect a newer build than is there. */
function chromiumExecutable() {
  if (process.env.RULITH_CHROMIUM_EXECUTABLE) return process.env.RULITH_CHROMIUM_EXECUTABLE
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
    // A CommonJS package: the named export may or may not be detected, so both are tried.
    const loaded = await import(pathToFileURL(PLAYWRIGHT).href)
    chromium = loaded.chromium ?? loaded.default?.chromium ?? null
  }
  executablePath = chromiumExecutable()
} catch { chromium = null }
const SKIP = chromium === null ? 'Playwright is not resolvable from this tree'
  : executablePath === '' ? 'no Chromium build in the shared ms-playwright cache' : false

/** One browser for the file; one fixture and one page per arm, so no arm inherits state. */
let browser = null
test.before(async () => { if (!SKIP) browser = await chromium.launch({ headless: true, executablePath }) })
test.after(async () => { if (browser) await browser.close() })

const arm = (name, viewport, body, options) => test(name, { skip: SKIP }, async () => {
  const fixture = await startMockWorkbench(options)
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  const failures = []
  page.on('pageerror', (error) => failures.push(String(error)))
  page.on('dialog', (dialog) => { failures.push('a browser dialog was opened: ' + dialog.message()); dialog.dismiss() })
  try {
    await page.goto(fixture.managerUrl)
    await page.waitForSelector('button[data-instance="inst-1"]')
    await body({ page, context, fixture })
    assert.deepEqual(failures, [], 'the page raised something while this arm ran')
  } finally {
    await context.close()
    await fixture.stop()
  }
})

/**
 * Two Agents whose transcripts have nothing in common, and one of them with two conversations.
 *
 * The inspector is a projection of the events the conversation is reading, so the only honest
 * way to show that the right-hand column follows the selection is to give each Agent — and
 * each conversation inside one Agent — Cases, a frontier and Worker activity that could not
 * have come from the other.
 */
const at = (minute) => '2026-09-20T15:' + String(minute).padStart(2, '0') + ':00.000Z'
const conversation = (session, caseId, root, predicate, source, lease) => [
  { src: 'agent', type: 'task-start', session, at: at(30), text: 'Work on ' + caseId },
  { src: 'agent', type: 'case-open', session, caseId, at: at(31), caseType: 'exploration', ok: true },
  { src: 'agent', type: 'case-state', session, caseId, root, at: at(31), caseStatus: 'running', gaps: 1 },
  { src: 'agent', type: 'focus', session, at: at(31), roots: [{ caseId, status: 'running' }] },
  { src: 'agent', type: 'source-plan', session, at: at(32), plans: [{ action: 'read', source, predicate }] },
  ...(lease ? [{ src: 'worker', type: 'claimed', session, at: at(33), kind: 'lease', id: lease }] : []),
  { src: 'agent', type: 'propose', session, at: at(34), say: 'Answer for ' + caseId + '.' },
]
const TRANSCRIPTS = {
  'inst-1': [
    ...conversation('s-alpha', 'CASE-ALPHA', 'ROOT-ALPHA', 'alpha.total', 'file:alpha-ledger', 'lease-alpha'),
    ...conversation('s-beta', 'CASE-BETA', 'ROOT-BETA', 'beta.marker', 'db:beta-book', ''),
  ],
  'inst-2': conversation('s-gamma', 'CASE-GAMMA', 'ROOT-GAMMA', 'gamma.invoice', 'http:gamma-rates', 'lease-gamma'),
}
/** What the Agent's own inspector is showing right now, wherever its sections currently live. */
const inspectorText = (child) => child.evaluate(() => ['roots', 'recovery', 'frontier', 'workers']
  .map((id) => document.getElementById(id).textContent).join(' ⟂ '))

/** Choose an Agent and wait for its workspace to report that it loaded. */
const workspaceShown = (page) => page.waitForFunction(() => document.getElementById('stage-note').hidden === true, null, { timeout: 15000 })
const openAgent = async (page, id) => {
  await page.click('button[data-instance="' + id + '"]')
  await workspaceShown(page)
  const src = await page.getAttribute('#stage iframe:not([hidden])', 'src')
  return page.frames().find((frame) => frame.url() === src)
}

arm('local authoring review shows the checked program and keeps Save disabled for questions',
  { width: 1400, height: 900 }, async ({ page }) => {
    await openAgent(page, 'inst-1')
    await page.click('#authoring-open')
    await page.click('#authoring-review-open')
    await page.getByText('Local policy', { exact: true }).waitFor()
    await page.getByText('Check invoices', { exact: true }).waitFor()
    await page.getByText('Which exception applies?', { exact: true }).waitFor()
    await page.getByText('Resolve failed checks and questions in the local conversation before saving.', { exact: true }).waitFor()
    assert.equal(await page.locator('#authoring-save').isDisabled(), true)
    await page.selectOption('#authoring-case', 'CASE-SECOND')
    await page.waitForTimeout(3200)
    assert.equal(await page.inputValue('#authoring-case'), 'CASE-SECOND', 'a refresh preserves the chosen certified Case')
    await page.click('#authoring-close')
    await openAgent(page, 'inst-2')
    await page.click('#authoring-open')
    assert.equal(await page.locator('#authoring-review').isHidden(), true)
  })

arm('local authoring review explains compilation failures without interpreting checker text as HTML',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    fixture.control.authoringQuestions = false
    fixture.control.authoringCompileErrors = ['Rule check: <img src=x onerror=alert(1)> is not defined']
    await openAgent(page, 'inst-1')
    await page.click('#authoring-open')
    await page.click('#authoring-review-open')
    await page.getByText('Compile errors', { exact: true }).waitFor()
    await page.getByText(fixture.control.authoringCompileErrors[0], { exact: true }).waitFor()
    assert.equal(await page.locator('#authoring-result img').count(), 0)
    assert.equal(await page.locator('#authoring-save').isDisabled(), true)
  })

arm('failed local assistant preparation keeps the selected Agent and permissions for retry',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    await openAgent(page, 'inst-1')
    await page.click('#authoring-open')
    await page.locator('#authoring-prepare').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#authoring-prepare').isEnabled(), true)
    fixture.control.authoringPrepareRefusal = 'The local checker is unavailable. Retry preparation.'
    await page.click('#authoring-prepare')
    await page.locator('#authoring-notice').filter({ hasText: fixture.control.authoringPrepareRefusal }).waitFor()
    assert.equal(await page.locator('#authoring-prepare').isEnabled(), true)
    assert.equal(await page.locator('#authoring-local-read').isChecked(), true)
    assert.equal(await page.locator('#authoring-off-machine').isChecked(), true)
    assert.equal(fixture.control.authoringPrepareRequests.length, 1)
    assert.equal(fixture.control.authoringPrepareRequests[0].instanceId, 'inst-1')
    fixture.control.authoringPrepareRefusal = ''
    await page.click('#authoring-prepare')
    await page.locator('#authoring-notice').filter({ hasText: 'Local assistant prepared for this Agent.' }).waitFor()
    assert.equal(fixture.control.authoringPrepareRequests.length, 2)
  })

arm('refused private save keeps the certified Case and checked draft for an explicit retry',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    fixture.control.authoringQuestions = false
    fixture.control.authoringSaveRefusal = 'The private draft was not saved. Retry when Console is available.'
    await openAgent(page, 'inst-1')
    await page.click('#authoring-open')
    await page.click('#authoring-review-open')
    await page.selectOption('#authoring-case', 'CASE-SECOND')
    await page.click('#authoring-save')
    await page.locator('#authoring-notice').filter({ hasText: fixture.control.authoringSaveRefusal }).waitFor()
    assert.equal(await page.inputValue('#authoring-case'), 'CASE-SECOND')
    assert.equal(await page.locator('#authoring-save').isEnabled(), true)
    assert.equal(await page.locator('#authoring-publication').isHidden(), true)
    assert.equal(fixture.control.authoringSaves.length, 0)
    assert.deepEqual(fixture.control.authoringSaveRequests.map(request => request.caseId), ['CASE-SECOND'])
    fixture.control.authoringSaveRefusal = ''
    await page.click('#authoring-save')
    await page.getByText('Private draft saved', { exact: true }).waitFor()
    assert.equal(fixture.control.authoringSaves.length, 1)
    assert.equal(await page.locator('#authoring-save').isDisabled(), true)
  })

arm('a lost private-save reply reconciles the committed result without sending a second save',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    fixture.control.authoringQuestions = false
    fixture.control.authoringSaveDropResponse = true
    await openAgent(page, 'inst-1')
    await page.click('#authoring-open')
    await page.click('#authoring-review-open')
    await page.selectOption('#authoring-case', 'CASE-SECOND')
    await page.click('#authoring-save')
    await page.getByText('Private draft saved', { exact: true }).waitFor({ timeout: 15000 })
    const requestsBeforeReload = fixture.control.authoringSaveRequests.length
    assert.ok(requestsBeforeReload >= 1, 'the first save did not reach the manager')
    assert.equal(fixture.control.authoringSaves.length, 1)
    assert.equal(await page.inputValue('#authoring-case'), 'CASE-SECOND')
    assert.equal(await page.locator('#authoring-save').isDisabled(), true)
    await page.reload()
    await openAgent(page, 'inst-1')
    await page.click('#authoring-open')
    await page.click('#authoring-review-open')
    await page.getByText('Private draft saved', { exact: true }).waitFor()
    assert.equal(fixture.control.authoringSaveRequests.length, requestsBeforeReload, 'reload sent the uncertain save again')
  })

arm('an unconfirmed save stays disabled until Review can establish its outcome',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    fixture.control.authoringQuestions = false
    await openAgent(page, 'inst-1')
    await page.click('#authoring-open')
    await page.click('#authoring-review-open')
    await page.selectOption('#authoring-case', 'CASE-SECOND')
    fixture.control.authoringSaveDropResponse = true
    fixture.control.authoringReviewRefusal = 'Review is temporarily unavailable.'
    await page.click('#authoring-save')
    await page.locator('#authoring-notice').filter({ hasText: 'Save outcome is unknown' }).waitFor()
    const sent = fixture.control.authoringSaveRequests.length
    assert.ok(sent >= 1)
    assert.equal(await page.locator('#authoring-save').isDisabled(), true)
    assert.equal(await page.locator('#authoring-save').innerText(), 'Check save outcome')
    fixture.control.authoringReviewRefusal = ''
    await page.click('#authoring-review-open')
    await page.getByText('Private draft saved', { exact: true }).waitFor()
    assert.equal(fixture.control.authoringSaveRequests.length, sent, 'Review retried the uncertain save')
    assert.equal(fixture.control.authoringSaves.length, 1)
  })

arm('saving a locally checked draft exposes only the scoped Console publication link',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    fixture.control.authoringQuestions = false
    await openAgent(page, 'inst-1')
    await page.click('#authoring-open')
    await page.click('#authoring-review-open')
    await page.getByText('Local policy', { exact: true }).waitFor()
    await page.selectOption('#authoring-case', 'CASE-SECOND')
    await page.click('#authoring-save')
    const publication = page.locator('#authoring-publication')
    await publication.waitFor({ state: 'visible' })
    assert.equal(await publication.getAttribute('href'), 'https://console.example/console/#/studio?localAuthoringDraft=local_policy&publish=1')
    assert.equal(await publication.getAttribute('target'), '_blank')
    assert.equal(page.url(), fixture.managerUrl, 'saving does not navigate to or publish through Console')
    assert.deepEqual(fixture.control.authoringSaves, [{ instanceId: 'inst-1', resultId: 'res_' + '1'.repeat(32), caseId: 'CASE-SECOND' }])
    await page.click('#authoring-close')
    await openAgent(page, 'inst-2')
    await page.click('#authoring-open')
    assert.equal(await publication.isHidden(), true, 'switching Agent clears the saved publication receipt')
    assert.equal(await publication.getAttribute('href'), null)
  })

arm('a saved authoring receipt is still selected and cannot be saved twice after reloading the workbench',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    fixture.control.authoringQuestions = false
    await openAgent(page, 'inst-1')
    await page.click('#authoring-open')
    await page.click('#authoring-review-open')
    await page.selectOption('#authoring-case', 'CASE-SECOND')
    await page.click('#authoring-save')
    await page.getByText('Private draft saved', { exact: true }).waitFor()
    assert.equal(fixture.control.authoringSaves.length, 1)

    await page.reload()
    await page.waitForSelector('button[data-instance="inst-1"]')
    await openAgent(page, 'inst-1')
    await page.click('#authoring-open')
    await page.click('#authoring-review-open')
    await page.getByText('Private draft saved', { exact: true }).waitFor()
    assert.equal(await page.inputValue('#authoring-case'), 'CASE-SECOND')
    assert.equal(await page.locator('#authoring-save').isDisabled(), true)
    assert.equal(fixture.control.authoringSaves.length, 1, 'reloading retried a completed private save')
  })

arm('embedded runtime details never expose a second set of role controls',
  { width: 1400, height: 900 }, async ({ page }) => {
    const child = await openAgent(page, 'inst-1')
    await child.click('#modelbadge')
    await child.waitForSelector('#runtimemodal')
    assert.equal(await child.locator('[data-control]:visible').count(), 0)
    assert.equal(await child.locator('.runtimecontrols:visible').count(), 0)
    await page.waitForResponse(response => response.url().startsWith(new URL(child.url()).origin + '/status?'))
    assert.equal(await child.locator('[data-control]:visible').count(), 0, 'refresh cannot restore duplicate controls')
  })

arm('an HTTP refusal cannot masquerade as a loaded conversation',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    fixture.control.pageStatus['/'] = 401
    await page.click('button[data-instance="inst-1"]')
    await page.waitForFunction(() => document.getElementById('stage-action').textContent === 'Try again', null, { timeout: 12000 })
    assert.equal(await page.isVisible('#stage-note'), true)
    delete fixture.control.pageStatus['/']
    await page.click('#stage-action')
    await workspaceShown(page)
  })

arm('settings explain a missing document and recover without replacing the conversation',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    await openAgent(page, 'inst-1')
    const conversation = await page.getAttribute('#stage iframe', 'src')
    fixture.control.pageStatus['/worker-tools'] = 503
    await page.click('#tools-open')
    await page.waitForSelector('#page-retry:not([hidden])', { timeout: 12000 })
    assert.match(await page.textContent('#page-loading'), /not confirmed/)
    fixture.control.openRefusal = 'This Agent cannot be opened while its previous process is stopping.'
    await page.click('#page-retry')
    await page.waitForFunction(() => document.getElementById('page-notice').textContent.includes('previous process'))
    assert.equal(await page.isVisible('#page-notice'), true, 'a refusal is visible in the panel receiving the retry')
    delete fixture.control.openRefusal
    delete fixture.control.pageStatus['/worker-tools']
    await page.click('#page-retry')
    await page.waitForSelector('#page-loading', { state: 'hidden' })
    assert.equal(await page.getAttribute('#stage iframe', 'src'), conversation)
  })

arm('a failed settings panel disables retry when the manager disconnects',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    await openAgent(page, 'inst-1')
    fixture.control.pageStatus['/worker-tools'] = 503
    await page.click('#tools-open')
    await page.waitForSelector('#page-retry:not([hidden])', { timeout: 12000 })
    await fixture.silenceManager()
    await page.waitForFunction(() => document.getElementById('page-retry').disabled, null, { timeout: 15000 })
    assert.match(await page.textContent('#page-notice'), /did not answer/)
    assert.equal(await page.isVisible('#page-notice'), true)
  })

arm('removing an Agent explains the missing target inside its settings panel',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    await openAgent(page, 'inst-1')
    fixture.control.pageStatus['/worker-tools'] = 503
    await page.click('#tools-open')
    await page.waitForSelector('#dlg-page')
    fixture.rows.splice(fixture.rows.findIndex(row => row.id === 'inst-1'), 1)
    await page.waitForFunction(() => document.getElementById('page-loading').textContent.includes('no longer available'))
    assert.equal(await page.isDisabled('#page-retry'), true)
  })

arm('a send refusal is cleared when the user switches to a new conversation',
  { width: 1400, height: 900 }, async ({ page }) => {
    const child = await openAgent(page, 'inst-1')
    await child.fill('#prompt', 'A refused message')
    await child.click('#send')
    await child.waitForSelector('#composererr:not(:empty)')
    await child.click('#convopen')
    await child.click('#newcase')
    assert.equal(await child.textContent('#composererr'), '')
  })

arm('a refused send is answered inside the embedded conversation, not by a dialog nobody sees',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    const child = await openAgent(page, 'inst-1')
    await child.fill('#prompt', 'Please look at the invoice')
    await child.click('#send')
    await child.waitForSelector('#composererr:not(:empty)', { timeout: 10000 })
    assert.equal(await child.textContent('#composererr'), fixture.control.cases.teaching)
    assert.equal(await child.inputValue('#prompt'), 'Please look at the invoice',
      'a refused message must not be thrown away with the explanation')

    // And the same for validation, which never reaches the host at all.
    await child.click('#caseoptions')
    await child.click('#attachprefs')
    await child.fill('#businesskey', '{not json')
    await child.click('#send')
    await child.waitForFunction(() => document.getElementById('composererr').textContent.includes('valid JSON'))
    assert.equal(await child.isVisible('#casepopover'), true, 'the field that has to be corrected is on screen')

    // A successful send clears it and empties the box.
    fixture.control.cases = { ok: true, sessionKey: 'session-1' }
    await child.fill('#businesskey', '')
    await child.click('#send')
    await child.waitForFunction(() => document.getElementById('prompt').value === '')
    assert.equal(await child.textContent('#composererr'), '')
  })

arm('the manager browser key never crosses into the frame, nor into anything the frame links to',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    const child = await openAgent(page, 'inst-1')
    const src = await page.getAttribute('#stage iframe', 'src')
    assert.equal(src.includes(fixture.managerKey), false, 'the key that opens the workbench stayed in the workbench')
    assert.equal(src.includes('manager='), false)
    assert.equal(child.url().includes(fixture.managerKey), false)

    const hrefs = await child.$$eval('a[href]', (nodes) => nodes.map((node) => node.getAttribute('href')))
    assert.ok(hrefs.length > 0, 'the embedded page does link to its own settings pages')
    for (const href of hrefs) {
      assert.equal(href.includes('manager='), false, 'a link inside the frame would carry the key into a top-level tab: ' + href)
      assert.equal(href.includes(fixture.managerKey), false, href)
    }
    assert.equal(await child.$('#managerreturn'), null, 'the way back is the page this one is inside')
  })

arm('standalone, the way back still works and carries only the manager key',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    const alone = 'http://127.0.0.1:' + fixture.portOf('inst-1') + '/?k=' + fixture.hostKey
      + '&manager=' + encodeURIComponent(fixture.managerUrl)
    await page.goto(alone)
    await page.waitForSelector('#managerreturn')
    assert.equal(await page.getAttribute('#managerreturn', 'href'), fixture.managerUrl,
      'opened on its own, this page must still offer the way back the launcher gave it')
    await page.click('#managerreturn')
    await page.waitForSelector('button[data-instance="inst-1"]', { timeout: 15000 })
  })

arm('A → B → A keeps the conversation, and the words typed into it',
  { width: 1400, height: 900 }, async ({ page }) => {
    const first = await openAgent(page, 'inst-1')
    await first.fill('#prompt', 'half-written thought')
    await openAgent(page, 'inst-2')
    assert.equal(await page.locator('#stage iframe').count(), 2, 'one frame per Agent, kept')

    await page.click('button[data-instance="inst-1"]')
    await workspaceShown(page)
    const back = page.frames().find((frame) => frame.url().includes(':' + (new URL(first.url()).port)))
    assert.equal(await back.inputValue('#prompt'), 'half-written thought',
      'coming back must return to the same document, not a reload of it')
    const hidden = await page.$$eval('#stage iframe', (nodes) => nodes.map((node) => node.hidden))
    assert.deepEqual(hidden, [false, true])
  })

arm('nothing is clipped or scrolled sideways at a desk-sized window that still splits three ways',
  { width: 1000, height: 800 }, async ({ page }) => {
    const child = await openAgent(page, 'inst-1')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    assert.ok(overflow <= 0, 'the workbench scrolled sideways: ' + overflow + 'px')

    // The centre column here is ~415px, which is inside the conversation page's own narrow
    // rules — the width at which its header used to push Clear view past the right edge.
    const clipped = await child.evaluate(() => {
      const top = document.querySelector('.top'), box = top.getBoundingClientRect()
      return [...top.querySelectorAll('button')].filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.right > box.right + 0.5 || rect.left < box.left - 0.5 || rect.bottom > box.bottom + 0.5
      }).map((el) => el.id || el.textContent.trim())
    })
    assert.deepEqual(clipped, [], 'a control outside its own header is a control nobody can press')
    const childOverflow = await child.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    assert.ok(childOverflow <= 0, 'the conversation scrolled sideways: ' + childOverflow + 'px')
  })

arm('on a phone the centre stays usable and every header control is reachable',
  { width: 390, height: 780 }, async ({ page }) => {
    // The Agent list is a drawer at this width, which is the only way to reach an Agent here.
    await page.click('#rail-open')
    const child = await openAgent(page, 'inst-1')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0)
    assert.ok(await child.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0)

    for (const [frame, selector] of [[page, '.centerhead'], [child, '.top']]) {
      const clipped = await frame.evaluate((which) => {
        const head = document.querySelector(which), box = head.getBoundingClientRect()
        return [...head.querySelectorAll('button')].filter((el) => {
          const rect = el.getBoundingClientRect()
          return rect.width > 0 && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5 || rect.bottom > box.bottom + 0.5)
        }).map((el) => el.id || el.getAttribute('aria-label') || el.textContent.trim())
      }, selector)
      assert.deepEqual(clipped, [], selector + ' clipped its own controls at 390px')
    }
  })

arm('a closed drawer is out of the tab order, and a window that grows past the breakpoint has none',
  { width: 390, height: 780 }, async ({ page }) => {
    await page.waitForSelector('#rail')
    assert.equal(await page.evaluate(() => document.getElementById('rail').inert), true)
    // inert is what makes the claim true: focus cannot even be put there deliberately.
    const reached = await page.evaluate(() => {
      const row = document.querySelector('#rail .agentrow')
      row.focus()
      return document.activeElement.closest('#rail') !== null
    })
    assert.equal(reached, false, 'an off-screen drawer that can still be tabbed into is a trap')

    await page.click('#rail-open')
    assert.equal(await page.evaluate(() => document.getElementById('rail').inert), false)
    assert.equal(await page.isVisible('#scrim'), true)
    assert.equal(await page.getAttribute('#rail-open', 'aria-expanded'), 'true')
    // The per-Agent controls travel with the list they act on, so opening the drawer is also
    // how a phone reaches Start Agent, Tools and the settings dialog.
    await page.click('button[data-instance="inst-1"]')
    await page.click('#rail-open')
    for (const id of ['#agent-toggle', '#worker-toggle', '#tools-open', '#details-open'])
      assert.equal(await page.isVisible(id), true, id + ' is unreachable on a phone')

    await page.setViewportSize({ width: 1300, height: 900 })
    await page.waitForFunction(() => document.getElementById('scrim').hidden === true)
    assert.equal(await page.getAttribute('#rail-open', 'aria-expanded'), 'false')
    assert.equal(await page.getAttribute('#shell', 'class'), 'shell')
    assert.equal(await page.evaluate(() => document.getElementById('rail').inert), false,
      'a rail that is simply part of the page must not stay inert')
  })

arm('a dialog in the embedded conversation holds focus and shuts the rest of the document out',
  { width: 1400, height: 900 }, async ({ page }) => {
    const child = await openAgent(page, 'inst-1')
    await child.click('#convopen')
    await child.waitForSelector('#convmodal:not([hidden])')
    assert.equal(await child.evaluate(() => document.getElementById('app').inert), true,
      'aria-modal says the rest is not there; inert is what makes that true')

    for (let press = 0; press < 10; press += 1) {
      await page.keyboard.press('Tab')
      const inside = await child.evaluate(() => document.getElementById('convmodal').contains(document.activeElement))
      assert.equal(inside, true, 'Tab left the dialog after ' + (press + 1) + ' presses')
    }
    await page.keyboard.press('Escape')
    await child.waitForSelector('#convmodal', { state: 'hidden' })
    assert.equal(await child.evaluate(() => document.getElementById('app').inert), false)
  })

arm('settings open in the workbench, with a real link out, and no pop-up to be blocked',
  { width: 1400, height: 900 }, async ({ page, context, fixture }) => {
    await openAgent(page, 'inst-1')
    await page.click('#tools-open')
    await page.waitForSelector('#dlg-page:not([hidden])')
    assert.equal(context.pages().length, 1, 'a window opened after an await is a pop-up with no gesture behind it')

    const settings = await page.waitForSelector('#page-frame')
    const frame = await settings.contentFrame()
    await frame.waitForSelector('#tool-rows', { state: 'attached', timeout: 15000 })
    const href = await page.getAttribute('#page-tab', 'href')
    assert.equal(href.includes('manager='), false, 'a tab opened from here must not carry the workbench key')
    assert.equal(href.includes(fixture.hostKey), true, 'it is that Agent\'s own address')
    assert.equal(await page.isVisible('#page-tab'), true)

    // The settings page has to be reachable from the keyboard, so the trap has to be able to
    // tab into the frame rather than cycling two header controls forever.
    let reached = false
    for (let press = 0; press < 6 && !reached; press += 1) {
      await page.keyboard.press('Tab')
      reached = await page.evaluate(() => document.activeElement && document.activeElement.id === 'page-frame')
    }
    assert.equal(reached, true, 'Tab never reached the settings page inside the dialog')

    // The conversation underneath was never replaced.
    assert.equal(await page.locator('#stage iframe').count(), 1)
    // Escape belongs to whichever document has focus, and a cross-origin page does not hand
    // its keys to this one. Back on the dialog's own chrome — which Tab can always return to —
    // Escape closes it.
    await page.focus('#page-close')
    await page.keyboard.press('Escape')
    await page.waitForSelector('#dlg-page', { state: 'hidden' })
    assert.equal(await page.getAttribute('#page-frame', 'src'), 'about:blank',
      'a closed settings page must stop polling the host it was showing')
  })

arm('a value that had to be escaped survives the list being rebuilt',
  { width: 1400, height: 900 }, async ({ page }) => {
    // The Agent list and the option list are rebuilt on every poll; an id carrying a quote is
    // escaped on the way into the markup, and a substring search for it never matches again.
    const hostile = 'agent-"&<>-gamma'
    await page.evaluate((id) => {
      const select = document.getElementById('agent-select')
      select.innerHTML = '<option value="' + id.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) + '">Gamma</option>'
      select.value = id
    }, hostile)
    const read = await page.evaluate(() => document.getElementById('agent-select').value)
    assert.equal(read, hostile, 'the browser decodes what the page escaped; a comparison against markup would not')
  })

arm('a manager that stops answering says so, and nothing may be changed from the picture it left',
  { width: 1400, height: 900 }, async ({ page, fixture }) => {
    await openAgent(page, 'inst-1')
    assert.equal(await page.isVisible('#connection'), false)

    await fixture.silenceManager()
    await page.waitForSelector('#connection:not([hidden])', { timeout: 20000 })
    assert.match(await page.textContent('#connection'), /did not answer/)
    for (const control of ['#worker-toggle', '#agent-toggle', '#tools-open']) {
      assert.equal(await page.isDisabled(control), true, control + ' was still offered against a remembered state')
    }
    // The conversation that is already open is not torn down: it is a different server and it
    // is still answering. Only what this page could change is withheld.
    assert.equal(await page.locator('#stage iframe').count(), 1)
  })

/* The layout this product is actually for: the Agents on the left, and one document per Agent
   that owns both the conversation and the Case evidence beside it. The arms below are about
   the linkage — that choosing an Agent, or a conversation inside one, moves both halves —
   which is exactly what a shell drawing its own summary panel would get wrong silently. */

arm('Agent start refusal stays beside the controls in the mobile drawer',
  { width: 390, height: 780 }, async ({ page, fixture }) => {
    await page.click('#rail-open')
    await openAgent(page, 'inst-1')
    await page.click('#rail-open')
    fixture.control.roleRefusal = 'Reconnect this Agent before starting it.'
    await page.click('#agent-toggle')
    await page.waitForFunction(() => document.getElementById('worker-notice').textContent.includes('Reconnect'))
    assert.equal(await page.isVisible('#worker-notice'), true)
    assert.equal(await page.locator('#rail').evaluate(el => el.contains(document.getElementById('worker-notice'))), true)
    assert.equal(await page.textContent('#notice'), '', 'the answer must not sit behind the open drawer')
  })

arm('expanded role details cannot push the account off a short screen',
  { width: 390, height: 400 }, async ({ page }) => {
    await page.click('#rail-open')
    await openAgent(page, 'inst-1')
    await page.click('#rail-open')
    await page.locator('#worker-details').evaluate(el => { el.open = true })
    await page.locator('#worker-notice').evaluate(el => { el.textContent = 'The process is still stopping. '.repeat(60) })
    const box = await page.locator('#account-open').boundingBox()
    assert.ok(box.y >= 0 && box.y + box.height <= 400, 'account access must remain inside the visible rail')
    await page.click('#account-open')
    assert.equal(await page.isVisible('#dlg-account'), true)
  })

arm('choosing an Agent moves the conversation and its Case inspector together',
  { width: 1440, height: 960 }, async ({ page }) => {
    const first = await openAgent(page, 'inst-1')
    await first.waitForFunction(() => document.getElementById('roots').textContent.includes('CASE-'), null, { timeout: 15000 })
    // Opened on All activity, the inspector is this Agent's whole session: both its Cases,
    // the last frontier reported, and the Worker activity it has seen.
    const alpha = await inspectorText(first)
    assert.match(alpha, /CASE-ALPHA/, 'the Cases in focus are this Agent\'s own')
    assert.match(alpha, /CASE-BETA/, 'including the conversation that is not showing')
    assert.match(alpha, /beta\.marker|alpha\.total/, 'and a frontier that came from this Agent')
    assert.match(alpha, /lease-alpha/, 'so is the Worker activity')
    assert.match(await first.textContent('#stream'), /Answer for CASE-ALPHA/)

    const second = await openAgent(page, 'inst-2')
    await second.waitForFunction(() => document.getElementById('roots').textContent.includes('CASE-'), null, { timeout: 15000 })
    const gamma = await inspectorText(second)
    assert.match(gamma, /CASE-GAMMA/)
    assert.match(gamma, /gamma\.invoice/)
    assert.equal(/CASE-ALPHA|alpha\.total|lease-alpha/.test(gamma), false,
      'the second Agent must not be able to show the first Agent\'s evidence')
    assert.match(await second.textContent('#stream'), /Answer for CASE-GAMMA/)

    // Both documents are alive; only one is on the stage, and it is the one that was chosen.
    assert.equal(await page.locator('#stage iframe').count(), 2)
    const shown = await page.$$eval('#stage iframe', (nodes) => nodes.map((node) => node.hidden))
    assert.deepEqual(shown, [true, false])
  }, { events: TRANSCRIPTS })

arm('switching conversation rescopes the Cases, the frontier and the Worker activity',
  { width: 1440, height: 960 }, async ({ page }) => {
    const child = await openAgent(page, 'inst-1')
    await child.waitForFunction(() => document.getElementById('roots').textContent.includes('CASE-ALPHA'), null, { timeout: 15000 })

    // The conversation list lives in the workbench's dialog, because the Agent list beside it
    // is the shell's. The evidence does not: it is the column to the right of the stream.
    await child.click('#convopen')
    await child.waitForSelector('#convmodal:not([hidden])')
    await child.click('.case[data-case="s-beta"]')
    await child.waitForSelector('#convmodal', { state: 'hidden' })

    await child.waitForFunction(() => document.getElementById('roots').textContent.includes('CASE-BETA'), null, { timeout: 15000 })
    const beta = await inspectorText(child)
    assert.match(beta, /CASE-BETA/)
    assert.match(beta, /beta\.marker/, 'the frontier follows the conversation, not the Agent')
    assert.equal(/CASE-ALPHA|alpha\.total|lease-alpha/.test(beta), false,
      'the other conversation\'s evidence is not this conversation\'s evidence')
    assert.match(await child.textContent('#stream'), /Answer for CASE-BETA/)
    assert.doesNotMatch(await child.textContent('#stream'), /Answer for CASE-ALPHA/)

    // And back, which is the same projection run again rather than a second store.
    await child.click('#convopen')
    await child.click('.case[data-case="s-alpha"]')
    await child.waitForFunction(() => document.getElementById('roots').textContent.includes('CASE-ALPHA'), null, { timeout: 15000 })
    assert.match(await inspectorText(child), /lease-alpha/)
  }, { events: TRANSCRIPTS })

arm('A to B to A keeps the draft, the conversation and the evidence that belong to it',
  { width: 1440, height: 960 }, async ({ page }) => {
    const first = await openAgent(page, 'inst-1')
    await first.fill('#prompt', 'half-written thought for alpha')
    await openAgent(page, 'inst-2')

    await page.click('button[data-instance="inst-1"]')
    await workspaceShown(page)
    const back = page.frames().find((frame) => frame.url() === first.url())
    assert.equal(await back.inputValue('#prompt'), 'half-written thought for alpha',
      'coming back must return to the same document, not a reload of it')
    assert.match(await inspectorText(back), /CASE-ALPHA/, 'and to the evidence that document was showing')
    assert.equal(await page.locator('#stage iframe').count(), 2, 'no frame was re-created')
  }, { events: TRANSCRIPTS })

arm('on a desk there is one activity header and the Agent own inspector beside it',
  { width: 1440, height: 960 }, async ({ page }) => {
    const child = await openAgent(page, 'inst-1')
    assert.equal(await page.isVisible('.centerhead'), false, 'the shell adds no second activity header')
    assert.equal(await child.isVisible('.top'), true, 'the Agent own header is the one that is there')
    assert.equal(await child.isVisible('#inspector'), true, 'the Case inspector is the right-hand column')
    assert.equal(await child.isVisible('.sidebar'), false, 'its Agent list would be a second Agent list')
    assert.equal(await child.isVisible('#evidenceopen'), false,
      'a dialog for panels that are already on screen is a control with nothing to do')

    // The sections are where they were authored, not moved somewhere by the embedding.
    assert.equal(await child.evaluate(() => document.getElementById('roots').closest('#inspector') !== null), true)
    const boxes = await child.evaluate(() => {
      const stream = document.getElementById('stream').getBoundingClientRect()
      const inspector = document.getElementById('inspector').getBoundingClientRect()
      const composer = document.getElementById('composer').getBoundingClientRect()
      return { streamRight: stream.right, inspectorLeft: inspector.left, composerRight: composer.right }
    })
    assert.ok(boxes.inspectorLeft >= boxes.streamRight - 1, 'the inspector sits beside the conversation, not over it')
    assert.ok(boxes.composerRight <= boxes.inspectorLeft + 1, 'the composer must not run under the inspector')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0)
    assert.ok(await child.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0)
  }, { events: TRANSCRIPTS })

arm('on a phone the Agent switch and the evidence are both reachable, and the evidence comes back',
  { width: 390, height: 780 }, async ({ page }) => {
    await page.click('#rail-open')
    const child = await openAgent(page, 'inst-1')
    await child.waitForFunction(() => document.getElementById('roots').textContent.includes('CASE-ALPHA'), null, { timeout: 15000 })

    // The stage is the page here, so the shell's bar is the way back to the other Agents.
    assert.equal(await page.isVisible('.centerhead'), true)
    assert.equal(await page.isVisible('#rail-open'), true)
    assert.equal(await child.isVisible('#inspector'), false, 'there is no room for a column beside the stream')
    assert.equal(await child.isVisible('#evidenceopen'), true, 'so the evidence is offered as a dialog')

    await child.click('#evidenceopen')
    await child.waitForSelector('#evidencemodal:not([hidden])')
    assert.equal(await child.evaluate(() => document.getElementById('roots').closest('#evidencemodal') !== null), true,
      'the same sections moved, rather than a summary being drawn twice')
    assert.match(await inspectorText(child), /CASE-ALPHA/, 'and they are still the live ones')
    assert.equal(await child.evaluate(() => document.getElementById('app').inert), true)
    await page.keyboard.press('Escape')
    await child.waitForSelector('#evidencemodal', { state: 'hidden' })
    assert.equal(await child.evaluate(() => document.getElementById('app').inert), false)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0)
    assert.ok(await child.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0)

    // Widened, the very same nodes go back to the column they came from.
    await page.setViewportSize({ width: 1440, height: 960 })
    await child.waitForFunction(() => document.getElementById('roots').closest('#inspector') !== null, null, { timeout: 10000 })
    assert.equal(await child.isVisible('#inspector'), true)
    assert.equal(await child.isVisible('#evidenceopen'), false)
    assert.match(await inspectorText(child), /CASE-ALPHA/, 'restored live, not re-rendered from a copy')
    assert.equal(await page.isVisible('.centerhead'), false, 'and the shell stops adding a header again')
  }, { events: TRANSCRIPTS })

arm('the evidence dialog opened on a phone gives focus back when the window grows',
  { width: 390, height: 780 }, async ({ page }) => {
    await page.click('#rail-open')
    const child = await openAgent(page, 'inst-1')
    await child.click('#evidenceopen')
    await child.waitForSelector('#evidencemodal:not([hidden])')

    // Widening while it is open must close it the way a person would, not leave a dialog
    // hidden by CSS with the document behind it still inert.
    await page.setViewportSize({ width: 1440, height: 960 })
    await child.waitForSelector('#evidencemodal', { state: 'hidden' })
    assert.equal(await child.evaluate(() => document.getElementById('app').inert), false,
      'the document must be usable again')
    // The button that opened it does not exist at this width, so focus follows the evidence
    // into the column rather than being dropped on the document body.
    assert.equal(await child.evaluate(() => document.activeElement.id), 'inspector',
      'focus follows the evidence back to where it is now readable')
    assert.equal(await child.evaluate(() => document.getElementById('roots').closest('#inspector') !== null), true)
    await page.setViewportSize({ width: 390, height: 780 })
    await child.waitForFunction(() => document.activeElement.id === 'evidenceopen')
    assert.equal(await child.evaluate(() => document.getElementById('roots').closest('#evidencemodal') !== null), true)
  }, { events: TRANSCRIPTS })

arm('standalone Local keeps its evidence accessible when the inspector cannot fit',
  { width: 1000, height: 850 }, async ({ page, fixture }) => {
    await page.goto('http://127.0.0.1:' + fixture.portOf('inst-1') + '/?k=' + fixture.hostKey)
    await page.locator('#evidenceopen').waitFor()
    assert.equal(await page.isVisible('#inspector'), false)
    await page.click('#evidenceopen')
    await page.waitForFunction(() => document.getElementById('roots').textContent.includes('CASE-ALPHA'))
    assert.match(await page.textContent('#evidencebody'), /CASE-ALPHA/)
    assert.equal(await page.evaluate(() => document.getElementById('app').inert), true)
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.locator('#evidencemodal').waitFor({ state: 'hidden' })
    assert.equal(await page.isVisible('#inspector'), true)
    assert.equal(await page.evaluate(() => document.getElementById('app').inert), false)
    assert.equal(await page.evaluate(() => document.activeElement.id), 'inspector')
    await page.setViewportSize({ width: 1000, height: 850 })
    await page.waitForFunction(() => document.activeElement.id === 'evidenceopen')
  }, { events: TRANSCRIPTS })

/* The list is the account's directory of Agents, not a list of local profiles. These arms are
   about what a press does: opening an Agent that is configured here, and explaining first use
   for one that is authorized but has never run on this computer — without allocating anything
   until a person says so. */

/** Every manager write the page made, so an arm can prove that a press did nothing. */
const writesTo = (page) => {
  const seen = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/manager/')) {
      seen.push({ path: new URL(request.url()).pathname, body: JSON.parse(request.postData() || '{}') })
    }
  })
  return seen
}

arm('an incomplete device sign-in survives reload with an editable address and a working retry',
  { width: 1440, height: 960 }, async ({ page, fixture }) => {
    Object.assign(fixture.device, { state: 'pending', origin: 'http://127.0.0.1:45678',
      deviceName: 'Retry laptop', code: '', consoleUrl: '', teaching: 'Sign-in did not finish.' })
    await page.reload()
    await page.locator('#account-open').click()
    await page.locator('#sign-in').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#sign-in').innerText(), 'Retry sign-in')
    assert.equal(await page.locator('#check-approval').count(), 0)
    assert.equal(await page.locator('#console-link').getAttribute('href'), null)
    assert.equal(await page.locator('#console-url').inputValue(), 'http://127.0.0.1:45678')
    assert.equal(await page.locator('#device-name').inputValue(), 'Retry laptop')
    const writes = writesTo(page)
    await page.locator('#local-settings > summary').click()
    await page.locator('#console-url').fill('http://127.0.0.1:62017')
    await page.locator('#sign-in').click()
    assert.deepEqual(writes.find(row => row.path === '/manager/device/start')?.body,
      { consoleUrl: 'http://127.0.0.1:62017', name: 'Retry laptop' })
  })

for (const viewport of [{ width: 1440, height: 960 }, { width: 415, height: 800 }]) {
  arm('browser sign-in opens directly and returns the approved Agents at ' + viewport.width + 'px', viewport,
    async ({ page, context, fixture }) => {
      const linked = structuredClone(fixture.device)
      fixture.rows.splice(0)
      Object.assign(fixture.device, { state: 'none', code: '', consoleUrl: '' })
      await page.reload()
      if (viewport.width < 980) await page.click('#rail-open')
      await page.click('#account-open')
      assert.equal(await page.locator('#device-code').count(), 0)
      assert.equal(await page.locator('#check-approval').count(), 0)
      assert.equal(await page.locator('#console-url').isVisible(), false)
      assert.equal(await page.locator('#local-settings').isVisible(), true)
      await page.click('#local-settings > summary')
      assert.equal(await page.locator('#console-url').isVisible(), true, 'a clean installation can configure another Console')
      await page.click('#local-settings > summary')
      const url = 'https://console.example/console/#/devices?code=ABCD2345'
      let referrer = 'not checked', starts = 0
      await context.route('https://console.example/**', async route => {
        referrer = route.request().headers().referer || ''
        await route.fulfill({ contentType: 'text/html', body: '<h1>Sign in to Rulith</h1>' })
      })
      await page.route('**/manager/device/start', async route => {
        starts++
        Object.assign(fixture.device, { state: 'pending', code: 'ABCD2345', consoleUrl: url })
        await route.fulfill({ json: { ok: true, instances: fixture.rows, device: fixture.device } })
      })
      const opened = page.waitForEvent('popup')
      await page.click('#sign-in')
      const popup = await opened
      await popup.waitForURL(url)
      assert.equal(await popup.evaluate(() => window.opener), null)
      assert.equal(referrer, '', 'the local browser key must not reach Console in a Referer')
      assert.equal(starts, 1)
      assert.equal(await page.locator('#pending').isVisible(), true)
      assert.equal(await page.locator('#console-link').getAttribute('href'), url)
      Object.assign(fixture.device, linked)
      await popup.close()
      await page.bringToFront()
      await page.locator('#dlg-account').waitFor({ state: 'hidden', timeout: 15000 })
      assert.equal(await page.locator('#account-line').innerText(), 'Test Account')
      assert.equal(await page.locator('button[data-agent="agent-alpha"]').count(), 1)
      assert.equal(starts, 1, 'automatic approval checks must not create a second login')
    })
}

arm('blocked sign-in tabs have a working ordinary link and do not lose the request',
  { width: 1440, height: 960 }, async ({ page, context, fixture }) => {
    Object.assign(fixture.device, { state: 'none', code: '', consoleUrl: '' })
    await page.reload()
    await page.click('#account-open')
    await page.evaluate(() => { window.open = () => null })
    const url = 'https://console.example/console/#/devices?code=ABCD2345'
    let starts = 0
    await context.route('https://console.example/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Sign in</h1>' }))
    await page.route('**/manager/device/start', async route => {
      starts++
      Object.assign(fixture.device, { state: 'pending', code: 'ABCD2345', consoleUrl: url })
      await route.fulfill({ json: { ok: true, instances: fixture.rows, device: fixture.device } })
    })
    await page.click('#sign-in')
    await page.locator('#pending').waitFor({ state: 'visible' })
    assert.match(await page.locator('#account-notice').innerText(), /link below/)
    const opened = page.waitForEvent('popup')
    await page.click('#console-link')
    const popup = await opened
    await popup.waitForURL(url)
    assert.equal(await popup.evaluate(() => window.opener), null)
    assert.equal(starts, 1)
  })

arm('a running Agent can chat while its optional Worker is stopped',
  { width: 1440, height: 960 }, async ({ page, fixture }) => {
    fixture.rows[0].agent = true
    fixture.rows[0].worker = false
    const child = await openAgent(page, 'inst-1')
    await child.getByRole('heading', { name: 'What would you like to discuss or handle?', exact: true }).waitFor()
    assert.equal(await child.getByRole('heading', { name: 'Runtime is not ready', exact: true }).count(), 0)
    assert.equal(await child.locator('#prompt').isEnabled(), true)
  })

arm('the list names the account Agents, and one that is not set up here opens first use only',
  { width: 1440, height: 960 }, async ({ page }) => {
    const writes = writesTo(page)
    await page.waitForSelector('button[data-agent="agent-gamma"]')
    const markup = await page.innerHTML('#agents')
    // Configured here: the instance row the rest of the integration already knows.
    assert.ok(markup.includes('data-instance="inst-1"') && markup.includes('<b>Alpha</b>'))
    assert.ok(markup.includes('data-instance="inst-2"') && markup.includes('<b>Beta</b>'))
    // Authorized, never run here: offered as something to set up, and named by the account.
    assert.ok(markup.includes('<b>Gamma</b>') && markup.includes('Not set up on this computer'))
    assert.equal(await page.isVisible('#add-open'), false, 'adding an Agent is not an ordinary concept any more')

    await page.click('button[data-agent="agent-gamma"]')
    await page.waitForSelector('#dlg-setup:not([hidden])')
    assert.equal(await page.textContent('#setup-sub'), 'Gamma', 'the Agent is named once and not asked for again')
    assert.equal(await page.locator('#stage iframe').count(), 0, 'no host was opened for an Agent with no profile')
    assert.deepEqual(writes, [], 'choosing an Agent allocated a profile or asked for a credential')
  }, { agents: [{ id: 'agent-alpha', name: 'Alpha' }, { id: 'agent-beta', name: 'Beta' }, { id: 'agent-gamma', name: 'Gamma' }] })

arm('setting up from the directory makes one profile for that exact Agent and opens its workspace',
  { width: 1440, height: 960 }, async ({ page }) => {
    const writes = writesTo(page)
    await page.click('button[data-agent="agent-gamma"]')
    await page.waitForSelector('#dlg-setup:not([hidden])')
    await page.selectOption('#setup-mode', 'existing_client')
    await page.click('#setup-start')
    await page.waitForFunction(() => document.getElementById('stage-note').hidden === true, null, { timeout: 20000 })

    const creates = writes.filter((write) => write.path === '/manager/instances/create')
    const pairs = writes.filter((write) => write.path === '/manager/instances/pair')
    assert.equal(creates.length, 1, 'one press, one profile')
    assert.deepEqual(creates[0].body, { name: 'Gamma', mode: 'existing_client', setupTarget: { origin: 'https://console.example', accountId: 'acct-1', agentId: 'agent-gamma' } },
      'the name comes from the Agent, and the mode from the one question that was asked')
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].body.agentId, 'agent-gamma', 'the target captured when the dialog opened')
    assert.equal(pairs[0].body.replaceAgentToken, false, 'first use never replaces a credential')

    // It is a configured Agent now, so it is an instance row and its workspace is the stage.
    const markup = await page.innerHTML('#agents')
    assert.equal(markup.includes('data-agent="agent-gamma"'), false)
    assert.ok(/data-instance="inst-3"[^>]*>\s*<b>Gamma<\/b>/.test(markup), 'the row is the Agent, by its account name')
    assert.equal(await page.isVisible('#dlg-setup'), false)
    assert.equal(await page.locator('#stage iframe').count(), 1)
  }, { agents: [{ id: 'agent-alpha', name: 'Alpha' }, { id: 'agent-beta', name: 'Beta' }, { id: 'agent-gamma', name: 'Gamma' }] })

arm('an unconfirmed attachment is finished where its proof lives, and opens nothing meanwhile',
  { width: 1440, height: 960 }, async ({ page, fixture }) => {
    fixture.control.pairPending = true
    await page.click('button[data-agent="agent-gamma"]')
    await page.waitForSelector('#dlg-setup:not([hidden])')
    await page.click('#setup-start')
    await page.waitForSelector('#dlg-attach:not([hidden])', { timeout: 20000 })

    assert.equal(await page.isVisible('#attach-pending'), true)
    assert.match(await page.textContent('#pair-agent'), /Gamma/)
    assert.equal(await page.isDisabled('#pair-poll'), false, 'checking again finishes the same attempt')
    assert.equal(await page.isDisabled('#pair-cancel'), false)
    assert.equal(await page.locator('#stage iframe').count(), 0,
      'nothing is opened for an Agent whose attachment has not been confirmed')
    await page.keyboard.press('Escape')
    assert.ok((await page.innerHTML('#agents')).includes('Finishing setup'), 'the list says what state it is in')
  }, { agents: [{ id: 'agent-alpha', name: 'Alpha' }, { id: 'agent-beta', name: 'Beta' }, { id: 'agent-gamma', name: 'Gamma' }] })

arm('an existing runtime key requires an explicit confirmed replacement before the first workspace opens',
  { width: 1440, height: 960 }, async ({ page, fixture }) => {
    fixture.control.pairCredentialRefusal = 'This Agent already has a runtime credential on this computer.'
    await page.click('button[data-agent="agent-gamma"]')
    await page.waitForSelector('#dlg-setup:not([hidden])')
    await page.click('#setup-start')
    await page.waitForSelector('#dlg-attach:not([hidden])', { timeout: 20000 })
    await page.locator('#pair-conflict').waitFor({ state: 'visible' })
    assert.equal(await page.isDisabled('#pair-replace'), true, 'a visible warning is not replacement consent')
    assert.equal(fixture.control.pairRequests.length, 1)

    // An unconfirmed cancellation cannot be used to launch a replacement request.
    await page.check('#pair-replace-confirm')
    fixture.control.pairCancelUnknown = true
    await page.click('#pair-replace')
    await page.getByText('could not be confirmed as cancelled', { exact: false }).waitFor()
    assert.equal(fixture.control.pairRequests.length, 1, 'unknown cancellation leaves the original key untouched')
    assert.equal(await page.locator('#attach-pending').isVisible(), true)

    fixture.control.pairCancelUnknown = false
    await page.click('#pair-replace')
    await page.waitForFunction(() => document.getElementById('dlg-attach').hidden === true, null, { timeout: 20000 })
    await workspaceShown(page)
    assert.deepEqual(fixture.control.pairRequests.map((request) => request.replaceAgentToken), [false, true])
    assert.equal(fixture.control.pairRequests[1].agentId, 'agent-gamma')
    assert.ok((await page.innerHTML('#agents')).includes('Alpha'), 'other configured Agents remain visible')
    assert.ok((await page.innerHTML('#agents')).includes('Gamma'), 'the replaced Agent is selected as a usable workspace')
  }, { agents: [{ id: 'agent-alpha', name: 'Alpha' }, { id: 'agent-beta', name: 'Beta' }, { id: 'agent-gamma', name: 'Gamma' }] })

arm('the linked account directory adds a newly enabled Agent on refresh without signing out',
  { width: 1440, height: 960 }, async ({ page, fixture }) => {
    assert.equal(await page.locator('[data-agent="agent-gamma"]').count(), 0)
    fixture.control.refreshAgents = [...fixture.device.agents, { id: 'agent-gamma', name: 'Gamma' }]
    await page.waitForTimeout(3200)
    assert.equal(await page.locator('[data-agent="agent-gamma"]').count(), 0, 'ordinary state polls do not silently replace the enabled-Agent directory')
    await page.click('#account-open')
    await page.waitForSelector('#dlg-account:not([hidden])')
    await page.click('#refresh-account')
    await page.locator('[data-agent="agent-gamma"]').waitFor({ state: 'visible', timeout: 7000 })
    assert.deepEqual(fixture.control.refreshRequests, [{}])
    assert.equal(await page.locator('#account-line').textContent(), 'Test Account')
    assert.match(await page.locator('#account-dot').getAttribute('class'), /\bon\b/)
  })

arm('a local profile the directory does not claim stays in the account settings, not in the list',
  { width: 1440, height: 960 }, async ({ page }) => {
    const markup = await page.innerHTML('#agents')
    assert.ok(markup.includes('data-instance="inst-1"'))
    assert.equal(markup.includes('inst-loose'), false, 'an unattached profile is not one of the account Agents')
    assert.equal(markup.includes('Spare'), false)

    await page.click('#account-open')
    await page.waitForSelector('#dlg-account:not([hidden])')
    await page.locator('#local-settings > summary').click()
    const profiles = await page.innerHTML('#profiles')
    assert.ok(profiles.includes('data-profile="inst-loose"'), 'it has to stay recoverable')
    assert.match(profiles, /Not connected to an Agent yet/)
    // Selecting it opens its settings, where connecting, model settings and removal live.
    await page.click('[data-profile="inst-loose"]')
    await page.waitForSelector('#dlg-details:not([hidden])')
    assert.equal(await page.textContent('#details-sub'), 'Spare')
    assert.equal(await page.locator('#stage iframe').count(), 0, 'choosing a profile opened a host')
  }, { instances: [
    { id: 'inst-1', name: 'Research', mode: 'local_agent', directory: 'D:/instances/inst-1', origin: 'https://console.example',
      accountId: 'acct-1', agentId: 'agent-alpha', agentName: 'Alpha', connectionId: '', paired: true, open: false, roles: [],
      agent: false, worker: false, runningAgentId: '', pendingAgentId: '', blocked: '', orphaned: null, legacyImport: null,
      hostPort: 0, servePort: 0, signedOutAt: '', createdAt: '', importedFrom: '' },
    { id: 'inst-loose', name: 'Spare', mode: 'local_agent', directory: 'D:/instances/inst-loose', origin: '', accountId: '',
      agentId: '', agentName: '', connectionId: '', paired: false, open: false, roles: [], agent: false, worker: false,
      runningAgentId: '', pendingAgentId: '', blocked: '', orphaned: null, legacyImport: null, hostPort: 0, servePort: 0,
      signedOutAt: '', createdAt: '', importedFrom: '' },
  ] })

const modelFixture = { modelDefaults: { available: true, origin: 'https://console.example', accountId: 'acct-1',
  configured: false, url: '', name: '', thinking: 'standard', keyConfigured: false },
  instances: [{ id: 'inst-1', name: 'Research', mode: 'local_agent', directory: 'D:/instances/inst-1',
    origin: 'https://console.example', accountId: 'acct-1', agentId: 'agent-alpha', agentName: 'Alpha', paired: true,
    agent: false, worker: false,
    model: { source: 'default', configured: false, ready: false, url: '', name: '', keyConfigured: false } }] }

arm('missing model leads directly to default setup, then the explicit start action',
  { width: 1440, height: 960 }, async ({ page, fixture }) => {
    await page.click('[data-instance="inst-1"]')
    await page.locator('#agent-readiness-action').click()
    await page.locator('#dlg-model:not([hidden])').waitFor()
    assert.equal(await page.locator('#model-source').inputValue(), 'default')
    await page.fill('#model-url', 'https://model.example/v1')
    await page.fill('#model-name', 'chosen-model')
    await page.fill('#model-key', 'fixture-only-key')
    await page.click('#model-save-start')
    await page.locator('#dlg-model').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Stop Agent', exact: true }).waitFor()
    assert.equal(fixture.rows[0].agent, true)
    assert.equal(fixture.rows[0].worker, false, 'model setup cannot start an unrelated role')
    assert.equal(fixture.control.modelRequests.length, 2)
    assert.equal(fixture.control.modelRequests[0].expectedAccountId, 'acct-1')
    assert.equal(fixture.control.modelRequests[1].instanceId, 'inst-1')
    assert.equal(await page.locator('#model-key').inputValue(), '')
  }, modelFixture)

arm('model editor remains usable on a narrow screen and an error retains the typed configuration',
  { width: 390, height: 844 }, async ({ page, fixture }) => {
    await page.click('#rail-open')
    await page.click('#account-open')
    await page.click('#default-model-open')
    await page.fill('#model-url', 'https://model.example/v1')
    await page.fill('#model-name', 'typed-model')
    fixture.control.modelRefusal = 'The configuration was not saved. Try again.'
    await page.click('#model-save')
    await page.locator('#model-notice').filter({ hasText: 'not saved' }).waitFor()
    assert.equal(await page.inputValue('#model-name'), 'typed-model')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('#dlg-account').isVisible(), true)
    assert.equal(await page.evaluate(() => document.activeElement.id), 'default-model-open')
  }, modelFixture)

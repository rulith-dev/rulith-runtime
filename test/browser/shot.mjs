// SPDX-License-Identifier: Apache-2.0
/**
 * One desktop and one phone screenshot of the workbench, against the same fixture the browser
 * arms use. Not a test: a way to look at what the arms assert.
 *
 *   node test/browser/shot.mjs [output-directory]
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startMockWorkbench } from './mock-manager.mjs'

const PLAYWRIGHT = 'D:/Work/rulith-java/console-web/node_modules/playwright/index.js'
const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
const executablePath = (existsSync(root) ? readdirSync(root) : []).flatMap((entry) => [
  entry.startsWith('chromium_headless_shell-') ? join(root, entry, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe') : '',
  entry.startsWith('chromium-') ? join(root, entry, 'chrome-win64', 'chrome.exe') : '',
]).find((path) => path && existsSync(path))
if (!executablePath) { console.log('no Chromium in the shared ms-playwright cache; nothing rendered'); process.exit(0) }
const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href).then((m) => m.chromium ? m : m.default)

const at = (minute) => '2026-09-20T15:' + String(minute).padStart(2, '0') + ':00.000Z'
const conversation = (session, caseId, root_, predicate, source, lease, ask, answer) => [
  { src: 'agent', type: 'task-start', session, at: at(30), text: ask },
  { src: 'agent', type: 'tool-call', session, callId: session + '-1', cmd: 'OpenCase', at: at(31), input: { text: '{"caseType":"exploration"}' } },
  { src: 'agent', type: 'tool-result', session, callId: session + '-1', at: at(31), authoritative: true, accepted: true, output: { text: '{"caseId":"' + caseId + '"}' } },
  { src: 'agent', type: 'case-open', session, caseId, at: at(31), caseType: 'exploration', ok: true },
  { src: 'agent', type: 'case-state', session, caseId, root: root_, at: at(31), caseStatus: 'running', gaps: 1 },
  { src: 'agent', type: 'focus', session, at: at(31), roots: [{ caseId, status: 'running' }] },
  { src: 'agent', type: 'tool-call', session, callId: session + '-2', cmd: 'QueryBoard', at: at(32), input: { text: '{"predicate":"' + predicate + '"}' } },
  { src: 'agent', type: 'tool-result', session, callId: session + '-2', at: at(32), authoritative: true, accepted: true, output: { text: '{"rows":[{"' + predicate + '":1}]}' } },
  { src: 'agent', type: 'source-plan', session, at: at(32), plans: [{ action: 'read', source, predicate }] },
  ...(lease ? [{ src: 'worker', type: 'claimed', session, at: at(33), kind: 'lease', id: lease }] : []),
  { src: 'agent', type: 'propose', session, at: at(34), say: answer },
  { src: 'agent', type: 'task-done', session, at: at(34), activeCaseId: caseId, note: 'Response delivered; ' + caseId + ' remains in focus.' },
]
const events = {
  'inst-1': [
    ...conversation('s-alpha', 'CASE-ALPHA', 'ROOT-ALPHA', 'alpha.total', 'file:alpha-ledger', 'lease-alpha',
      'Check the alpha ledger and open a Case for it.',
      'The alpha ledger balances.\n\nOne marker was written and read back; the Case stays in focus for the follow-up.'),
    ...conversation('s-beta', 'CASE-BETA', 'ROOT-BETA', 'beta.marker', 'db:beta-book', '',
      'Draft the note for the beta marker.', 'Draft ready for review.'),
  ],
  'inst-2': conversation('s-gamma', 'CASE-GAMMA', 'ROOT-GAMMA', 'gamma.invoice', 'http:gamma-rates', 'lease-gamma',
    'Reconcile the invoice rates.', 'Rates reconciled against the published table.'),
}

const out = resolve(process.argv[2] ?? '.review-output')
mkdirSync(out, { recursive: true })
const fixture = await startMockWorkbench({ events })
const browser = await chromium.launch({ headless: true, executablePath })
for (const [name, width, height] of [['workbench-desktop-1440', 1440, 960], ['workbench-phone-390', 390, 780]]) {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.goto(fixture.managerUrl)
  await page.waitForSelector('button[data-instance="inst-1"]')
  if (width < 980) await page.click('#rail-open')
  await page.click('button[data-instance="inst-1"]')
  await page.waitForFunction(() => document.getElementById('stage-note').hidden === true, null, { timeout: 20000 })
  const child = page.frameLocator('#stage iframe:not([hidden])')
  await child.locator('#convopen').click()
  await child.locator('[data-case="s-alpha"]').click()
  await child.locator('#convmodal').waitFor({ state: 'hidden' })
  await page.screenshot({ path: join(out, name + '.png') })
  console.log('wrote', join(out, name + '.png'))
  await page.close()
}
await browser.close()
await fixture.stop()

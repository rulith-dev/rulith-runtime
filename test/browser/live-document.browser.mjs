// SPDX-License-Identifier: Apache-2.0
/** Opt-in real-account Chromium acceptance. Never runs in npm test. See docs/document-authoring-acceptance.md. */
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const step = process.env.RULITH_LIVE_STEP || 'inspect'
const agentName = process.env.RULITH_LIVE_AGENT || ''
const expectedCase = process.env.RULITH_LIVE_CASE || ''
const remoteMaterialDisclosure = process.env.RULITH_LIVE_MATERIAL_DISCLOSURE === 'remote'
if (process.env.RULITH_LIVE_RUN !== '1' || !agentName || !['inspect', 'inspect-recovery', 'start', 'prepare', 'upload', 'review', 'save', 'verify'].includes(step))
  throw new Error('Set RULITH_LIVE_RUN=1, RULITH_LIVE_AGENT and RULITH_LIVE_STEP=inspect|inspect-recovery|start|prepare|upload|review|save|verify.')
if (['save', 'verify'].includes(step) && !expectedCase)
  throw new Error('Set RULITH_LIVE_CASE to the certified Case shown by the review before saving or verifying.')
const packageRoot = process.env.RULITH_LIVE_PACKAGE_ROOT || (process.platform === 'win32' ? join(process.env.APPDATA || '', 'npm', 'node_modules', 'rulith') : '')
const require = createRequire(import.meta.url)
let playwrightFile = process.env.RULITH_PLAYWRIGHT_MODULE || ''
if (!playwrightFile) try { playwrightFile = require.resolve('playwright') } catch { /* optional dependency */ }
if (!packageRoot || !existsSync(join(packageRoot, 'package.json')) || !existsSync(playwrightFile))
  throw new Error('The installed rulith package or Playwright is missing; set RULITH_LIVE_PACKAGE_ROOT and RULITH_PLAYWRIGHT_MODULE.')
const { createManagerServer } = await import(pathToFileURL(join(packageRoot, 'local/manager-server.mjs')).href)
const loaded = await import(pathToFileURL(playwrightFile).href)
const chromium = loaded.chromium ?? loaded.default?.chromium
const cache = join(process.env.LOCALAPPDATA || '', 'ms-playwright')
const executablePath = process.env.RULITH_CHROMIUM_EXECUTABLE || (existsSync(cache) && readdirSync(cache).flatMap(entry => [
  join(cache, entry, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
  join(cache, entry, 'chrome-win64', 'chrome.exe'),
]).find(existsSync))
if (!chromium || !executablePath) throw new Error('Chromium unavailable; set RULITH_CHROMIUM_EXECUTABLE if needed.')
const fixture = fileURLToPath(new URL('../fixtures/authoring-shipping-policy.md', import.meta.url))

const manager = createManagerServer({ port: 0 })
let browser, page, started = false
try {
  await manager.listen()
  started = true
  const state = manager.state()
  const row = state.instances.find(item => item.name === agentName && item.paired)
  if (state.device.state !== 'linked' || !row) throw new Error('QA account or Agent unavailable')
  let modelHost = ''
  try { modelHost = new URL(row.model?.url || '').hostname.toLowerCase() } catch { /* unknown endpoint is treated as remote */ }
  const localModel = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(modelHost)
  if (step === 'upload' && !localModel && !remoteMaterialDisclosure)
    throw new Error('This Agent uses a remote model. Set RULITH_LIVE_MATERIAL_DISCLOSURE=remote to explicitly allow the synthetic fixture to reach it.')
  if (remoteMaterialDisclosure && localModel)
    throw new Error('Remote material disclosure was requested for a local model. Omit RULITH_LIVE_MATERIAL_DISCLOSURE instead.')
  browser = await chromium.launch({ headless: true, executablePath })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  // Observe only diagnostics already delivered to this browser; never intercept or replay
  // requests, and never collect model prompts, credentials, materials or tool arguments.
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource
    window.__rulithQaUsage = []
    window.EventSource = class extends NativeEventSource {
      constructor(...args) {
        super(...args)
        this.addEventListener('message', message => {
          let event
          try { event = JSON.parse(message.data) } catch { return }
          if (!event || typeof event !== 'object' || event.type !== 'model-usage') return
          const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'uncachedInputTokens', 'requestBytes', 'transcriptBytes', 'compactedViews', 'compactedTranscriptBytes']
          const sample = {}
          for (const field of fields) if (Number.isFinite(event[field])) sample[field] = event[field]
          window.__rulithQaUsage.push(sample)
        })
      }
    }
  })
  await page.goto(`http://127.0.0.1:${manager.port}/?k=${manager.key}`)
  await page.click(`button[data-instance="${row.id}"]`)
  await page.waitForFunction(id => document.querySelector('button.agentrow[aria-current="true"]')?.dataset.instance === id, row.id, { timeout: 15000 })
  const read = async id => ({ text: (await page.locator(id).innerText()).trim(), visible: await page.locator(id).isVisible(), enabled: await page.locator(id).isEnabled() })
  console.log(JSON.stringify({ packageVersion: (await import(pathToFileURL(join(packageRoot, 'package.json')).href, { with: { type: 'json' } })).default.version,
    account: state.device.account?.name, agent: row.name, agentControl: await read('#agent-toggle'),
    workerControl: await read('#worker-toggle'), documentAssistant: await read('#authoring-open') }))
  if (step === 'inspect') {
    const child = page.frameLocator('#stage iframe:not([hidden])')
    await child.locator('#stream').waitFor({ timeout: 30000 })
    console.log(JSON.stringify({ phase: 'conversation-inspect', tail: (await child.locator('#stream').innerText()).slice(-3500) }))
  }
  if (step === 'inspect-recovery') {
    // Inspect startup's local recovery marker. No Worker, message or business Tool
    // is started; server recovery is only checked when the runtime next contacts it.
    await page.click('#agent-toggle')
    await page.waitForFunction(() => document.getElementById('agent-toggle').textContent.includes('Stop Agent'), null, { timeout: 30000 })
    const child = page.frameLocator('#stage iframe:not([hidden])')
    await child.locator('#stream').waitFor({ timeout: 30000 })
    await page.waitForTimeout(5000)
    console.log(JSON.stringify({ phase: 'recovery-inspect', workerControl: await read('#worker-toggle'),
      tail: (await child.locator('body').innerText()).slice(-4500) }))
  }
  if (['start', 'prepare', 'upload', 'review', 'save', 'verify'].includes(step)) {
    await page.click('#agent-toggle')
    await page.waitForFunction(() => document.getElementById('agent-toggle').textContent.includes('Stop Agent'), null, { timeout: 30000 })
    await page.click('#worker-toggle')
    await page.waitForFunction(() => document.getElementById('worker-toggle').textContent.includes('Stop Worker'), null, { timeout: 30000 })
    console.log(JSON.stringify({ phase: 'roles-started', agentControl: await read('#agent-toggle'), workerControl: await read('#worker-toggle') }))
    if (step === 'start') {
      const child = page.frameLocator('#stage iframe:not([hidden])')
      await child.locator('#stream').waitFor({ timeout: 30000 })
      await page.waitForTimeout(5000)
      console.log(JSON.stringify({ phase: 'conversation-after-start', tail: (await child.locator('#stream').innerText()).slice(-3500) }))
    }
  }
  if (['prepare', 'upload'].includes(step)) {
    await page.click('#authoring-open')
    await page.waitForFunction(() => !document.getElementById('authoring-notice').textContent.includes('Reading this Agent'), null, { timeout: 30000 })
    console.log(JSON.stringify({ phase: 'authoring-before-prepare', notice: await read('#authoring-notice'), prepare: await read('#authoring-prepare'),
      localRead: await page.locator('#authoring-local-read').isChecked(), offMachine: await page.locator('#authoring-off-machine').isChecked() }))
    if (!await page.locator('#authoring-prepare').isEnabled())
      throw new Error(`Local authoring preparation is unavailable: ${(await page.locator('#authoring-notice').innerText()).trim()}`)
    await page.check('#authoring-local-read')
    if (remoteMaterialDisclosure && !localModel) await page.check('#authoring-off-machine')
    console.log(JSON.stringify({ phase: 'material-permissions-chosen', localRead: await page.locator('#authoring-local-read').isChecked(),
      offMachine: await page.locator('#authoring-off-machine').isChecked() }))
    let prepared = false
    for (let attempt = 1; attempt <= 12; attempt++) {
      await page.click('#authoring-prepare')
      await page.waitForFunction(() => !document.getElementById('authoring-prepare').disabled, null, { timeout: 180000 })
      const notice = (await page.locator('#authoring-notice').innerText()).trim()
      console.log(JSON.stringify({ phase: 'authoring-prepare', attempt, notice }))
      if (notice.includes('Agent program is current') || notice.includes('Local assistant prepared for this Agent.')) { prepared = true; break }
      if (!notice.includes('retry prepare')) throw new Error(`Local authoring preparation failed: ${notice}`)
      await page.waitForTimeout(6000)
    }
    if (!prepared) throw new Error('Local authoring Source and authenticated Worker tools did not become current after bounded retries.')
  }
  if (step === 'upload') {
    await page.click('#authoring-close')
    const child = page.frameLocator('#stage iframe:not([hidden])')
    await child.locator('#prompt').waitFor({ timeout: 30000 })
    await child.locator('#convopen').click()
    await child.locator('#newcase').click()
    await child.locator('#convmodal').waitFor({ state: 'hidden', timeout: 15000 })
    console.log(JSON.stringify({ phase: 'new-local-transcript', stream: (await child.locator('#stream').innerText()).slice(0,220), prompt: await child.locator('#prompt').inputValue() }))
    await child.locator('#stream .empty').waitFor({ timeout: 15000 })
    await child.locator('#caseoptions').click()
    await child.locator('#attachfiles').click()
    const chooserReady = page.waitForEvent('filechooser')
    await child.locator('#filespick').click()
    await (await chooserReady).setFiles(fixture)
    await child.locator('#attachlist .chip-state').getByText('Ready', { exact: true }).waitFor({ timeout: 30000 })
    console.log(JSON.stringify({ phase: 'attachment-ready', name: await child.locator('#attachlist .chip-name').innerText(), status: await child.locator('#attachlist .chip-state').innerText() }))
    await child.locator('#filesclose').click()
    await child.locator('#prompt').fill('Use the attached synthetic shipping policy to create a local capability draft. Read the material through the configured Source, run the official local checker, and close a certified Case only after the checks pass. Treat order ID as the business key. Cover amounts 0, 199, 200, 201, negative, fractional, and missing, including two independent order IDs. Do not publish or invent policy. Ask if a required business decision is missing.')
    const previousTurns = await child.locator('#stream').getByText(/Agent turn (finished|interrupted)/).count()
    const previousClosures = await child.locator('#stream').getByText(/Rulith Case closed/).count()
    await child.locator('#send').click()
    console.log(JSON.stringify({ phase: 'turn-running' }))
    await child.getByText('Sent with 1 file:', { exact: false }).waitFor({ timeout: 30000 })
    console.log(JSON.stringify({ phase: 'send-accepted', composerError: await child.locator('#composererr').innerText(), attachment: await child.locator('#attachsent').innerText() }))
    const terminal = child.locator('#stream').getByText(/Agent turn (finished|interrupted)/).nth(previousTurns)
    await terminal.waitFor({ timeout: 540000 })
    const closedCases = await child.locator('#stream').getByText(/Rulith Case closed/).count()
    const usage = await child.locator('body').evaluate(() => window.__rulithQaUsage || [])
    console.log(JSON.stringify({ phase: 'turn-finished', terminal: await terminal.innerText(), newCaseClosures: closedCases - previousClosures,
      modelCalls: usage.length, modelUsage: usage, conversationTail: (await child.locator('#stream').innerText()).slice(-4000) }))
    if ((await terminal.innerText()).includes('interrupted') || closedCases <= previousClosures) throw new Error('The UI did not show a completed Case for this turn.')
  }
  if (['review', 'save', 'verify'].includes(step)) {
    await page.click('#authoring-open')
    await page.click('#authoring-review-open')
    await page.waitForFunction(() => {
      const panel = document.getElementById('authoring-review')
      return !panel.hidden && document.getElementById('authoring-result').textContent.includes('Checks')
        && !document.getElementById('authoring-review-open').disabled
    }, null, { timeout: 30000 })
    const options = await page.locator('#authoring-case option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, title: node.textContent })))
    console.log(JSON.stringify({ phase: 'checked-review', summary: (await page.locator('#authoring-result').innerText()).slice(-2800), options,
      save: await read('#authoring-save'), publication: await read('#authoring-publication'), notice: await read('#authoring-notice') }))
    if (step === 'verify') {
      if (await page.locator('#authoring-save').isEnabled() || await page.locator('#authoring-save').innerText() !== 'Private draft saved')
        throw new Error('Saved result was offered for a second save after restart')
      if (await page.locator('#authoring-case').inputValue() !== expectedCase) throw new Error('Saved certified Case was not restored')
      if (!await page.locator('#authoring-publication').isVisible()) throw new Error('Private draft publication link was lost after restart')
      console.log(JSON.stringify({ phase: 'restart-receipt-verified', savedCase: await page.locator('#authoring-case').inputValue(), repeatSaveDisabled: true }))
    }
    if (step === 'save') {
      const chosen = options.find(option => option.value === expectedCase)
      if (!chosen) throw new Error('Expected certified Case not available')
      await page.selectOption('#authoring-case', chosen.value)
      if (!await page.locator('#authoring-save').isEnabled()) throw new Error('Save disabled despite certified passing review')
      await page.click('#authoring-save')
      await page.getByText('Private draft saved', { exact: true }).waitFor({ timeout: 30000 })
      console.log(JSON.stringify({ phase: 'private-draft-saved', save: await read('#authoring-save'), publication: await read('#authoring-publication'), notice: await read('#authoring-notice') }))
    }
  }
} finally {
  let cleanupError
  try {
    if (page && !page.isClosed()) {
      if (await page.locator('#authoring-close').isVisible()) await page.click('#authoring-close')
      for (const [selector, stoppedLabel] of [['#agent-toggle', 'Start Agent'], ['#worker-toggle', 'Start Worker']]) {
        if ((await page.locator(selector).innerText()).startsWith('Stop ')) {
          await page.click(selector)
          await page.waitForFunction(([id, label]) => document.querySelector(id)?.textContent.includes(label), [selector, stoppedLabel], { timeout: 30000 })
        }
      }
    }
  } catch (error) { cleanupError = error }
  try { await browser?.close() } catch (error) { cleanupError ??= error }
  if (started) {
    try {
      const shutdown = await manager.close()
      if (shutdown.unobserved.length || shutdown.failures.length)
        throw new Error('Workbench shutdown left live children or registry failures; inspect the local process state before another run.')
    } catch (error) { cleanupError ??= error }
  }
  if (cleanupError) throw cleanupError
}

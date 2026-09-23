// SPDX-License-Identifier: Apache-2.0
/** Opt-in real-account first-use setup through the shipped workbench UI. */
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const agentName = process.env.RULITH_LIVE_AGENT || ''
if (process.env.RULITH_LIVE_RUN !== '1' || !agentName)
  throw new Error('Set RULITH_LIVE_RUN=1 and RULITH_LIVE_AGENT to a dedicated enabled QA Agent.')
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

const manager = createManagerServer({ port: 0 })
let browser, page, started = false
try {
  await manager.listen()
  started = true
  const state = manager.state()
  if (state.device.state !== 'linked') throw new Error('Sign in to the QA account before this run.')
  console.log(JSON.stringify({ phase: 'account', account: state.device.account?.name, agent: agentName }))
  browser = await chromium.launch({ headless: true, executablePath })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(`http://127.0.0.1:${manager.port}/?k=${manager.key}`)
  await page.click('#account-open')
  await page.locator('#dlg-account').waitFor({ state: 'visible' })
  await page.click('#refresh-account')
  await page.waitForFunction(() => !document.getElementById('refresh-account').disabled, null, { timeout: 30000 })
  const fresh = manager.state()
  const agent = (fresh.device.agents || []).find(item => item.name === agentName)
  if (!agent) throw new Error(`The linked account does not authorize enabled Agent ${agentName}.`)
  await page.click('#account-close')
  const paired = fresh.instances.find(item => item.agentId === agent.id && item.paired)
  if (!paired) {
    await page.locator('#agents button[data-agent]').filter({ hasText: agentName }).click()
    await page.locator('#dlg-setup').waitFor({ state: 'visible' })
    await page.selectOption('#setup-mode', 'local_agent')
    await page.click('#setup-start')
    for (let attempt = 0; attempt < 8 && !manager.state().instances.some(item => item.agentId === agent.id && item.paired); attempt++) {
      await page.waitForTimeout(1500)
      if (await page.locator('#pair-conflict').isVisible())
        throw new Error('This Agent has an existing runtime key. Review the replacement choice in the UI; this script will not replace it.')
      if (await page.locator('#dlg-attach').isVisible() && await page.locator('#pair-poll').isEnabled())
        await page.click('#pair-poll')
    }
  }
  const result = manager.state().instances.find(item => item.agentId === agent.id && item.paired)
  if (!result) {
    const notice = await page.locator('#dlg-attach').isVisible() ? await page.locator('#attach-notice').innerText()
      : await page.locator('#setup-notice').innerText()
    throw new Error(`First-use setup did not finish: ${notice.trim()}`)
  }
  console.log(JSON.stringify({ phase: 'paired', agent: agentName, mode: result.mode, modelReady: result.model?.ready === true,
    agentRunning: result.agent === true, workerRunning: result.worker === true }))
} finally {
  try { await browser?.close() } finally {
    if (started) {
      const shutdown = await manager.close()
      if (shutdown.unobserved.length || shutdown.failures.length)
        throw new Error('Workbench shutdown left live children or registry failures; inspect the local process state before another run.')
    }
  }
}

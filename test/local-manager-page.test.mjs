// SPDX-License-Identifier: Apache-2.0
/**
 * The workbench page's own logic, run against the document its script actually touches.
 *
 * A page like this fails quietly: a mistyped element id attaches no handler, an unescaped
 * name becomes markup, a section that should be hidden is shown beside the one that replaced
 * it, a control is offered for something that cannot be done, and a button posts to a route
 * the server does not have. None of those raise anything in a browser either — they simply
 * look wrong to whoever happens to open it.
 *
 * The arms below are about behaviour rather than layout, because the layout is the part a
 * person can see. What a person cannot see is that choosing A after B returned to the same
 * live conversation rather than a reloaded one, that a slow action on one Agent did not take
 * the others away, or that a refreshed state did not quietly throw away what they had typed.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { managerPage } from '../local/manager-ui.mjs'
import { localThemeCss } from '../local/theme.mjs'
import { declaredIds, referencedIds, runPageScript } from './support/mini-dom.mjs'

const SERVER_SOURCE = readFileSync(join(import.meta.dirname, '..', 'local', 'manager-server.mjs'), 'utf8')

const deviceOf = (overrides = {}) => ({ state: 'none', agents: [], account: null, code: '', codeExpiresAt: '', consoleUrl: '', deviceName: '', teaching: '', signOut: null, ...overrides })
const instanceOf = (overrides = {}) => ({
  id: 'inst-000000000001', name: 'Research', mode: 'local_agent', directory: 'D:/instances/one',
  origin: '', accountId: '', agentId: '', agentName: '', connectionId: '', paired: false,
  open: false, roles: [], agent: false, worker: false, runningAgentId: '', pendingAgentId: '',
  workerSetting: { enabled: false, visible: true, state: 'offline' },
  blocked: '', orphaned: null, legacyImport: null,
  hostPort: 0, servePort: 0, signedOutAt: '', createdAt: '', importedFrom: '', ...overrides,
})
const stateOf = (overrides = {}) => ({ ok: true, root: 'D:/manager', device: deviceOf(), instances: [], ...overrides })
const ORIGIN = 'https://console.example', ACCOUNT = 'acct-1'
const linkedDevice = (agents = [{ id: 'agent-alpha', name: 'Alpha' }]) =>
  deviceOf({ state: 'linked', origin: ORIGIN, account: { id: ACCOUNT, name: 'Test Account' }, agents })
/**
 * A local profile that the directory will claim: attached to that Agent, for this account and
 * this Console. The three fields together are the join — a profile that matches only the
 * Agent id belongs to somebody else's account and must not appear as that Agent.
 */
const configuredOf = (agentId, overrides = {}) => instanceOf({
  paired: true, agentId, agentName: agentId, origin: ORIGIN, accountId: ACCOUNT, ...overrides,
})

/** Load the page with one canned `/manager/state`, which is what it asks for on open. */
const openPage = (state) => runPageScript(managerPage, { respond: async () => ({ body: state }) })
/** Let promises the page started settle before inspecting what it did. */
const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((done) => setImmediate(done)) }

for (const choice of ['conn-old', '']) {
  test('reconnect candidates require an explicit choice before Connect: ' + (choice || 'new'), async () => {
    const connection = { connectionId: 'conn-old', name: 'Fallback', displayName: '<Office & computer>', createdAt: '2026-10-01T00:00:00Z' }
    const device = linkedDevice([{ id: 'agent-alpha', name: 'Alpha', reconnectable: [connection] }])
    const row = instanceOf(), state = stateOf({ device, instances: [row] })
    const page = await openPage(state)
    await page.choose(row.id)
    page.$('attach-open').onclick()
    assert.equal(page.$('pair-connections').hidden, false)
    assert.equal(page.$('pair').disabled, true)
    const options = page.$('pair-connection-options').innerHTML
    assert.match(options, /type="radio".*required/)
    assert.equal(options.includes(' checked'), false, 'no Connection decision is made for the person')
    assert.match(options, /Reconnect “&lt;Office &amp; computer&gt;” \(created /)
    assert.match(options, /Create a new connection/)
    await page.$('pair').onclick(); await settle()
    assert.equal(page.calls.some(call => call.path === '/manager/instances/pair'), false)
    page.$('pair-connections').onchange({ target: { name: 'reconnect-choice', value: choice, checked: true } })
    assert.equal(page.$('pair').disabled, false)
    page.render(state)
    assert.equal(page.$('pair').disabled, false, 'an unchanged refresh preserves the explicit choice')
    await page.$('pair').onclick(); await settle()
    const body = page.calls.find(call => call.path === '/manager/instances/pair').body
    assert.deepEqual(body, { instanceId: row.id, agentId: 'agent-alpha', replaceAgentToken: false,
      ...(choice ? { reconnectConnectionId: choice } : {}) })
  })
}

test('Agents without reconnect candidates keep the ordinary attach dialog', async () => {
  const row = instanceOf(), page = await openPage(stateOf({ device: linkedDevice(), instances: [row] }))
  await page.choose(row.id)
  page.$('attach-open').onclick()
  assert.equal(page.$('pair-connections').hidden, true)
  assert.equal(page.$('pair-connection-options').innerHTML, '')
  assert.equal(page.$('pair').disabled, false)
  await page.$('pair').onclick(); await settle()
  assert.deepEqual(page.calls.find(call => call.path === '/manager/instances/pair').body,
    { instanceId: row.id, agentId: 'agent-alpha', replaceAgentToken: false })
})

test('reconnect consent resets when the Agent, profile, account or offered list changes', async () => {
  const connection = { connectionId: 'conn-old', name: 'Old computer', createdAt: '' }
  const device = linkedDevice(['agent-alpha', 'agent-beta'].map(id => ({ id, name: id, reconnectable: [connection] })))
  const rows = [instanceOf({ id: 'a' }), instanceOf({ id: 'b' })], state = stateOf({ device, instances: rows })
  for (const change of ['agent', 'profile', 'account', 'connections']) {
    const page = await openPage(state)
    await page.choose('a')
    page.$('pair-connections').onchange({ target: { name: 'reconnect-choice', value: 'conn-old', checked: true } })
    assert.equal(page.$('pair').disabled, false)
    if (change === 'agent') { page.$('agent-select').value = 'agent-beta'; page.$('agent-select').onchange() }
    if (change === 'profile') await page.choose('b')
    if (change === 'account') page.render({ ...state, device: { ...device, account: { id: 'another-account' } } })
    if (change === 'connections') page.render({ ...state, device: { ...device,
      agents: device.agents.map(agent => ({ ...agent, reconnectable: [{ ...connection, connectionId: 'conn-other' }] })) } })
    assert.equal(page.$('pair').disabled, true, change + ' cannot inherit another reconnect decision')
    assert.equal(page.$('pair-connection-options').innerHTML.includes(' checked'), false)
  }
})

test('first-use setup opens the explicit reconnect choice before asking to pair', async () => {
  const device = linkedDevice([{ id: 'agent-alpha', name: 'Alpha', reconnectable: [{ connectionId: 'conn-old', name: 'Old computer', createdAt: '' }] }])
  const rows = []
  const page = await runPageScript(managerPage, { respond: async path => {
    if (path === '/manager/instances/create') {
      rows.push(instanceOf())
      return { body: { ...stateOf({ device, instances: rows }), id: rows[0].id } }
    }
    return { body: stateOf({ device, instances: rows }) }
  } })
  await page.choose('agent-alpha')
  await page.$('setup-start').onclick(); await settle()
  assert.equal(page.$('dlg-setup').hidden, true)
  assert.equal(page.$('dlg-attach').hidden, false)
  assert.equal(page.$('pair-connections').hidden, false)
  assert.equal(page.$('pair').disabled, true)
  assert.equal(page.calls.some(call => call.path === '/manager/instances/pair'), false)
})

test('the environment library opens without an Agent host and survives Agent removal', async () => {
  const page = await openPage(stateOf())
  page.$('environment-open').onclick(); await settle()
  assert.equal(page.$('dlg-page').hidden, false)
  assert.equal(page.$('page-title').textContent, 'This environment’s tools')
  const url = new URL(page.$('page-frame').src)
  assert.equal(url.pathname, '/tools')
  assert.equal(url.searchParams.get('k'), 'page-test-key')
  assert.equal(page.calls.filter(call => call.path === '/manager/instances/open').length, 0)
  page.render(stateOf({ instances: [] })); await settle()
  assert.equal(page.$('page-retry').disabled, false)
})

test('a migration conflict offers Check again without selecting tools for the Agent', async () => {
  const row = configuredOf('agent-alpha', { model: { ready: true }, tools: { source: 'own', conflicts: ['acme.lookup@1'],
    notice: { kind: 'conflict', text: 'Alpha keeps its own tools for now: acme.lookup@1 differs.' } } })
  const state = stateOf({ device: linkedDevice(), instances: [row] })
  const page = await openPage(state)
  await page.choose(row.id); await settle()
  assert.equal(page.$('agent-readiness-action').textContent, 'Check again')
  assert.match(page.$('agent-readiness-copy').textContent, /keeps its own tools/)
  await page.$('agent-readiness-action').onclick(); await settle()
  assert.deepEqual(page.calls.find(call => call.path === '/manager/instances/tools').body, { instanceId: row.id })
  assert.equal(page.calls.some(call => /selection/.test(call.path)), false)
})

test('an Agent that moved but could not remove its old files offers the same Check again, and a plain moved note offers nothing', async () => {
  const untidy = configuredOf('agent-alpha', { model: { ready: true }, tools: { source: 'library', conflicts: [],
    notice: { kind: 'untidy', text: 'Alpha now uses this environment’s tools, but its old files could not all be removed: EBUSY.' } } })
  const page = await openPage(stateOf({ device: linkedDevice(), instances: [untidy] }))
  await page.choose(untidy.id); await settle()
  assert.equal(page.$('agent-readiness-action').textContent, 'Check again')
  assert.match(page.$('agent-readiness-copy').textContent, /old files could not all be removed/)
  await page.$('agent-readiness-action').onclick(); await settle()
  assert.deepEqual(page.calls.find(call => call.path === '/manager/instances/tools').body, { instanceId: untidy.id })

  // Nothing needs doing once it moved: the note is shown where the Agent's own tools are, not as a next step.
  const moved = configuredOf('agent-beta', { model: { ready: true }, tools: { source: 'library', conflicts: [],
    notice: { kind: 'moved', text: 'Moved this Agent’s tools into this environment.' } } })
  const quiet = await openPage(stateOf({ device: linkedDevice(), instances: [moved] }))
  await quiet.choose(moved.id); await settle()
  assert.equal(quiet.$('agent-readiness').hidden, true)
})

test('Connection key replacement stays available while the Worker runs and preserves the exact identity scope', async () => {
  const row = configuredOf('agent-alpha', { connectionId: 'conn-alpha', open: true, roles: ['agent', 'worker'],
    agent: true, worker: true, workerSetting: { enabled: true, visible: true, state: 'online' } })
  const state = stateOf({ device: linkedDevice(), instances: [row] })
  const page = await runPageScript(managerPage, { respond: async () => ({ body: { ...state, ok: true,
    teaching: 'Connection key saved. The Worker reloads automatically after running executions drain.' } }) })
  await page.choose(row.id); await settle()
  assert.equal(page.$('connection-key-open').disabled, false)
  page.$('connection-key-open').onclick()
  assert.equal(page.$('connection-key-save').disabled, false)
  page.$('connection-key-value').value = 'replacement-fixture-key'
  page.render({ ...state, instances: [{ ...row, worker: false }] })
  assert.equal(page.$('connection-key-value').value, 'replacement-fixture-key', 'a Worker drain does not invalidate the identity')
  await page.$('connection-key-save').onclick(); await settle()
  const write = page.calls.find(call => call.path === '/manager/instances/connection-key')
  assert.deepEqual(write.body, { instanceId: row.id, expectedOrigin: ORIGIN, expectedAccountId: ACCOUNT,
    expectedAgentId: 'agent-alpha', expectedConnectionId: 'conn-alpha', key: 'replacement-fixture-key' })
  assert.match(page.$('details-notice').textContent, /reloads automatically/)
})

test('Connection key form invalidates on account, Agent or Connection changes', async () => {
  for (const changes of [{ account: { id: 'different-account' } }, { agentId: 'different-agent' }, { connectionId: 'different-connection' }]) {
    const row = configuredOf('agent-alpha', { connectionId: 'conn-alpha', worker: true })
    const state = stateOf({ device: linkedDevice(), instances: [row] })
    const page = await openPage(state)
    await page.choose(row.id); await settle()
    page.$('connection-key-open').onclick(); page.$('connection-key-value').value = 'replacement-fixture-key'
    page.render(changes.account ? { ...state, device: { ...state.device, account: changes.account } }
      : { ...state, instances: [{ ...row, ...changes }] })
    assert.equal(page.$('connection-key-value').value, '')
    assert.equal(page.$('connection-key-save').disabled, true)
    await page.$('connection-key-save').onclick(); await settle()
    assert.equal(page.calls.some(call => call.path === '/manager/instances/connection-key'), false)
  }
})

test('every element the script reaches for is declared in the markup it ships with', () => {
  const declared = new Set(declaredIds(managerPage))
  const missing = [...new Set(referencedIds(managerPage))].filter((id) => !declared.has(id))
  assert.deepEqual(missing, [], 'a handler is attached to nothing when its element id does not exist')
  assert.ok(declared.size > 15, 'the page must still be the workbench, not an empty shell')
})

test('every route the page calls is a route the manager server answers', () => {
  const paths = [...new Set([...managerPage.matchAll(/'(\/manager\/[a-z/-]+)'/g)].map((match) => match[1]))]
  assert.ok(paths.length >= 12, 'the page must still drive the whole manager')
  for (const path of paths) {
    assert.ok(SERVER_SOURCE.includes(`'${path}'`), `the page calls ${path}, which the manager server does not answer`)
  }
  // Every operation an operator can only reach from this page is still reachable.
  for (const required of ['/manager/device/signout', '/manager/device/forget', '/manager/instances/pair',
    '/manager/instances/pair/cancel', '/manager/instances/worker-setting',
    '/manager/instances/model/copy', '/manager/instances/forget', '/manager/instances/open']) {
    assert.ok(paths.includes(required), `${required} is unreachable from the page`)
  }
})

test('the page carries no key and takes one from its own address', () => {
  assert.doesNotMatch(managerPage, /__KEY__/)
  assert.match(managerPage, /new URLSearchParams\(location\.search\)\.get\('k'\)/)
  assert.match(managerPage, /<meta name="viewport" content="width=device-width,initial-scale=1">/)
  assert.match(managerPage, /@media\(max-width:\d+px\)/, 'a narrow viewport needs its own rules, not a horizontal scrollbar')
  assert.match(managerPage, /:focus-visible\{outline:2px solid var\(--accent\)/, 'keyboard focus must be visible')
})

test('presentation comes from the shared theme, with no second palette beside it', () => {
  assert.match(managerPage, /--accent:#5c9cf5/, 'blue carries navigation and focus, as Console decided')
  assert.match(managerPage, /--panel:#242424/, 'neutral charcoal surfaces')
  assert.equal((managerPage.match(/<style>/g) ?? []).length, 1)
  assert.equal(managerPage.includes(localThemeCss), true, 'the shared sheet is inlined, not paraphrased')

  const ownBlock = managerPage.slice(managerPage.indexOf(localThemeCss) + localThemeCss.length, managerPage.indexOf('</style>'))
  assert.ok(ownBlock.length > 100, 'the workbench still has layout rules of its own')
  assert.doesNotMatch(ownBlock, /#[0-9a-f]{3,8}\b/i, 'a second palette drifts from the first the day either changes')
  assert.match(ownBlock, /var\(--panel\)/, 'workbench rules reference the shared tokens')
  assert.doesNotMatch(managerPage, /#2dc8b6|#37cbbc/, 'the teal accent belongs to the previous style')
})

test('the shell is the Agent list and the stage, and the third column belongs to the Agent', () => {
  assert.match(managerPage, /\.shell\{display:grid;grid-template-columns:\d+px minmax\(0,1fr\);/,
    'two structural columns: the Agents, and the document that is one of them')
  assert.match(managerPage, /@media\(max-width:980px\)\{[\s\S]*?\.shell\{grid-template-columns:minmax\(0,1fr\)\}/,
    'the stage is the page on a narrow screen')
  assert.match(managerPage, /\.rail\{position:fixed/, 'the Agent list becomes a drawer rather than disappearing')
  assert.match(managerPage, /aria-expanded="false"/, 'a drawer toggle says whether it is open')
  assert.ok(managerPage.includes('aria-label="Show the Agent list"'), 'the drawer toggle needs a name')
  // The Cases, the unresolved call, the frontier and the Worker activity of the conversation
  // are the Agent page's own projection; a panel here would be a second answer about them.
  assert.doesNotMatch(managerPage, /workerrail|class="workerhead"/, 'the generic Worker rail is retired')
  for (const id of ['worker-pill', 'worker-setting', 'tools-open', 'details-open'])
    assert.ok(managerPage.includes('id="' + id + '"'), 'the per-Agent control ' + id + ' must still exist')
  const rail = managerPage.slice(managerPage.indexOf('<aside class="rail"'), managerPage.indexOf('<main class="center"'))
  for (const id of ['railsel', 'details-open', 'worker-setting', 'tools-open', 'account-open'])
    assert.ok(rail.includes('id="' + id + '"'), id + ' belongs in the Agent rail, beside the Agent it acts on')
  assert.equal((managerPage.match(/role="dialog" aria-modal="true"/g) ?? []).length, 9,
    'Health, account, add, connect, Connection key, model, settings, document assistant and the settings page are dialogs, not a homepage')
})

test('on a desk the shell adds no second activity header', () => {
  // The Agent's own page carries the activity header, the view tabs and the composer. A
  // header here as well is the same title twice, one of them unable to do anything.
  assert.match(managerPage, /\.centerhead\{display:none;/, 'hidden until the layout needs a way back')
  assert.match(managerPage, /@media\(max-width:980px\)\{[\s\S]*?\.centerhead\{display:flex\}/,
    'it exists for the widths where the Agent list is a drawer')
})

test('the page is the product, not its plumbing', () => {
  assert.match(managerPage, /<title>Rulith<\/title>/)
  assert.doesNotMatch(managerPage, /Local manager/, 'customers do not have a "Local manager"')
  assert.doesNotMatch(managerPage, />Add an instance</, 'an instance is a directory; a person adds an Agent')
})

test('a workbench opens on the work, with every dialog closed', async () => {
  const page = await openPage(stateOf({ device: linkedDevice(), instances: [configuredOf('agent-alpha', { id: 'a', name: 'A' })] }))
  for (const id of ['dlg-account', 'dlg-setup', 'dlg-attach', 'dlg-details']) {
    assert.equal(page.$(id).hidden, true, `${id} is open before anybody asked for it`)
  }
  assert.equal(page.frames.size, 0, 'no Agent host is opened by loading the page')
  assert.deepEqual(page.calls.map((call) => call.path), ['/manager/state'], 'the page asks for the state and nothing else')
  assert.equal(page.$('scrim').hidden, true)
})

test('never a wildcard postMessage, and never a reach into the embedded document', () => {
  assert.doesNotMatch(managerPage, /postMessage/, 'the two documents are different origins and stay that way')
  assert.doesNotMatch(managerPage, /contentDocument|contentWindow\.document/)
  assert.match(managerPage, /setAttribute\('referrerpolicy','no-referrer'\)/,
    'this page\'s own address carries the manager key; it must not travel in a Referer header')
  assert.match(managerPage, /setAttribute\('sandbox'/)
})

test('the list is the account directory, named by the Agent and joined to what is configured here', async () => {
  const page = await openPage(stateOf({
    device: linkedDevice([{ id: 'agent-alpha', name: 'Alpha' }, { id: 'agent-beta', name: 'Beta' }, { id: 'agent-gamma', name: 'Gamma' }]),
    instances: [
      configuredOf('agent-alpha', { id: 'inst-1', name: 'local nickname', agentName: 'Alpha', open: true, roles: ['agent', 'worker'], agent: true, worker: true }),
      configuredOf('agent-beta', { id: 'inst-2', name: 'Desk', mode: 'existing_client', agentName: 'Beta' }),
    ],
  }))
  const markup = page.$('agents').innerHTML
  // The name a person sees is the Agent's, from the account — not whatever a local profile
  // happens to be called.
  assert.ok(markup.includes('<b>Alpha</b>') && markup.includes('Running'))
  assert.equal(markup.includes('local nickname'), false, 'the directory names the Agent, not the profile')
  assert.ok(markup.includes('Worker only'), 'a computer that only does the work says so')
  assert.ok(markup.includes('data-instance="inst-1"'), 'a configured Agent keeps its instance row id')
  // Authorized and not configured here: offered, but as something to set up, not to open.
  assert.ok(markup.includes('data-agent="agent-gamma"') && markup.includes('Not set up in this environment'))
  assert.equal(markup.includes('data-instance="inst-000000000001"'), false)
  assert.equal(page.$('agents-empty').hidden, true)
})

test('the directory is empty without a grant, and never claims a remembered one is authorized', async () => {
  const signedOut = await openPage(stateOf({ instances: [configuredOf('agent-alpha', { id: 'a' })] }))
  assert.equal(signedOut.$('agents').innerHTML, '', 'a list of Agents is an authorization, not a memory')
  assert.equal(signedOut.$('agents-empty').hidden, false)
  assert.match(signedOut.$('agents-empty').textContent, /Sign in to see this account’s enabled Agents/)

  // A grant that the account service no longer accepts cannot go on naming Agents either,
  // and the profile stays reachable from the account dialog instead.
  for (const state of ['revoked', 'expired', 'unusable', 'unreadable']) {
    const page = await openPage(stateOf({
      device: deviceOf({ state, origin: ORIGIN, account: { id: ACCOUNT, name: 'Test Account' }, agents: [{ id: 'agent-alpha', name: 'Alpha' }] }),
      instances: [configuredOf('agent-alpha', { id: 'a', name: 'Kept' })],
    }))
    assert.equal(page.$('agents').innerHTML, '', state + ' still listed a cached directory')
    assert.ok(page.$('profiles').innerHTML.includes('Kept'), state + ' lost the local profile')
  }

  const linked = await openPage(stateOf({ device: linkedDevice([]), instances: [] }))
  assert.equal(linked.$('agents-empty').hidden, false)
  assert.match(linked.$('agents-empty').textContent, /No enabled Agents are available/)
  assert.match(linked.$('stage-copy').textContent, /created and enabled in Console/)
})

test('a profile from another account or another Console is never shown as one of these Agents', async () => {
  const page = await openPage(stateOf({
    device: linkedDevice(),
    instances: [
      instanceOf({ id: 'other-account', name: 'Elsewhere', paired: true, agentId: 'agent-alpha', agentName: 'Alpha', origin: ORIGIN, accountId: 'acct-2' }),
      instanceOf({ id: 'other-console', name: 'Other Console', paired: true, agentId: 'agent-alpha', agentName: 'Alpha', origin: 'https://other.example', accountId: ACCOUNT }),
      instanceOf({ id: 'unpaired', name: 'Not connected' }),
      instanceOf({ id: 'stale', name: 'Retired', paired: true, agentId: 'agent-zeta', agentName: 'Zeta', origin: ORIGIN, accountId: ACCOUNT }),
    ],
  }))
  // Alpha is authorized and nothing here is attached to it for this account, so it is offered
  // for first use — not satisfied by a profile that belongs to somebody else's grant.
  assert.ok(page.$('agents').innerHTML.includes('data-agent="agent-alpha"'))
  for (const id of ['other-account', 'other-console', 'unpaired', 'stale'])
    assert.equal(page.$('agents').innerHTML.includes('data-instance="' + id + '"'), false, id + ' impersonated an authorized Agent')

  const profiles = page.$('profiles').innerHTML
  for (const [id, why] of [['other-account', /another account or Console/], ['other-console', /another account or Console/],
    ['unpaired', /Not connected to an Agent/], ['stale', /not enabled in this account now/]]) {
    assert.ok(profiles.includes('data-profile="' + id + '"'), id + ' is not recoverable anywhere')
    assert.match(profiles, why, id + ' does not say why it is here')
  }
  assert.equal(page.$('profiles-empty').hidden, true)
})

test('an Agent name is escaped before it becomes markup, wherever it came from', async () => {
  // The name now arrives from the account service, which makes it exactly the kind of value
  // that must never be trusted into markup — in the directory, and in the profiles beside it.
  const hostile = '<img src=x onerror="alert(1)">'
  const page = await openPage(stateOf({
    device: linkedDevice([{ id: 'agent-alpha', name: hostile }, { id: '"><b>x', name: 'Odd id' }]),
    instances: [configuredOf('agent-alpha', { id: 'inst-1', name: hostile, agentName: hostile }),
      instanceOf({ id: 'loose', name: hostile })],
  }))
  for (const markup of [page.$('agents').innerHTML, page.$('profiles').innerHTML]) {
    assert.equal(markup.includes('<img'), false, 'a name became an element')
    assert.equal(/onerror\s*=\s*["']/.test(markup), false, 'a name became an attribute')
    assert.ok(markup.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), 'the name is still shown, as text')
  }
  assert.ok(page.$('agents').innerHTML.includes('data-agent="&quot;&gt;&lt;b&gt;x"'), 'an identifier is escaped too')
  await page.choose('inst-1')
  assert.equal(page.$('center-title').textContent, hostile, 'the centre shows it as text, never as markup')
  await page.choose('agent-alpha')
  assert.equal(page.$('setup-sub').textContent, hostile, 'and so does the first-use dialog')
})

test('the account dialog shows exactly one state at a time', async () => {
  const sections = ['signed-out', 'pending', 'linked', 'unusable']
  for (const [device, visible] of [
    [deviceOf(), 'signed-out'],
    [deviceOf({ state: 'pending', code: 'ABCD2345', consoleUrl: 'https://console.example/console/#/devices?code=ABCD2345' }), 'pending'],
    [deviceOf({ state: 'pending', origin: ORIGIN, deviceName: 'My computer' }), 'signed-out'],
    [deviceOf({ state: 'approved' }), 'pending'],
    [linkedDevice(), 'linked'],
    [deviceOf({ state: 'revoked', teaching: 'Revoked in Console.' }), 'unusable'],
    [deviceOf({ state: 'expired', teaching: 'This grant expired.' }), 'unusable'],
  ]) {
    const page = await openPage(stateOf({ device }))
    const shown = sections.filter((id) => page.$(id).hidden === false)
    assert.deepEqual(shown, [visible], `device state ${device.state} showed ${JSON.stringify(shown)}`)
  }
})

test('failed sign-in keeps the address editable and exposes retry instead of an empty approval screen', async () => {
  const device = deviceOf({ state: 'pending', origin: ORIGIN, deviceName: 'My laptop', teaching: 'Sign-in did not finish.' })
  const page = await openPage(stateOf({ device }))
  assert.equal(page.$('signed-out').hidden, false)
  assert.equal(page.$('pending').hidden, true)
  assert.equal(page.$('sign-in').disabled, false)
  assert.equal(page.$('sign-in').textContent, 'Retry sign-in')
  assert.equal(page.$('check-approval'), undefined)
  assert.equal(page.$('console-url').value, ORIGIN)
  assert.equal(page.$('device-name').value, 'My laptop')
  assert.match(page.$('signin-recovery').textContent, /did not finish/)
  assert.equal(page.$('console-link').href, '')
  page.timers.at(-1).callback(); await settle()
  assert.equal(page.calls.some(call => call.path === '/manager/device/poll'), false, 'incomplete starts refresh state without polling approval')
  page.$('console-url').value = 'http://127.0.0.1:62017'
  page.render(stateOf({ device }))
  assert.equal(page.$('console-url').value, 'http://127.0.0.1:62017', 'polls leave the corrected address alone')
  assert.match(managerPage, /<details id="local-settings"><summary>Advanced local settings<\/summary>/)
  page.render(stateOf({ device: { ...device, code: 'ABCD2345', consoleUrl: ORIGIN + '/console/#/devices?code=ABCD2345', teaching: '' } }))
  assert.equal(page.$('pending').hidden, false)
  assert.equal(page.$('signed-out').hidden, true)
  assert.equal(page.$('console-link').hidden, false)
})

test('a signed-in account shows its own name, its Agents, and an unfinished sign-out', async () => {
  const page = await openPage(stateOf({ device: deviceOf({
    state: 'linked', deviceName: 'Work laptop', account: { id: 'acct-1', name: 'Test Account' },
    agents: [{ id: 'agent-alpha', name: 'Alpha' }, { id: 'agent-beta', name: 'Beta' }],
    signOut: { state: 'incomplete', step: 'revoke' },
  }) }))
  assert.equal(page.$('account-name').textContent, 'Test Account')
  assert.equal(page.$('device-tag').textContent, 'This environment: Work laptop')
  assert.match(page.$('agent-summary').textContent, /Alpha, Beta/)
  assert.match(page.$('account-line').textContent, /Test Account/, 'the rail says who is signed in without a dialog')
  assert.match(page.$('signout-state').textContent, /incomplete at the revoke step/)
  assert.match(page.$('signout-state').textContent, /still signed in/,
    'an unfinished sign-out must never read as signed out')
})

function confirmFrame(page, frame) {
  const url = new URL(frame.src)
  frame.contentWindow ??= {}
  page.message({ source: frame.contentWindow, origin: url.origin,
    data: { type: 'rulith-ui-ready', view: url.searchParams.get('view') } })
}

test('choosing an Agent opens its workspace once, and coming back does not reload it', async () => {
  const rows = [instanceOf({ id: 'a', name: 'A', paired: true }), instanceOf({ id: 'b', name: 'B', paired: true })]
  const ports = { a: 9001, b: 9002 }
  const current = () => stateOf({ device: linkedDevice(), instances: rows })
  const page = await runPageScript(managerPage, { respond: async (path, request) => {
    if (path !== '/manager/instances/open') return { body: current() }
    const id = request.body.instanceId
    const row = rows.find((entry) => entry.id === id)
    row.open = true; row.hostPort = ports[id]; row.roles = ['agent', 'worker']
    return { body: { ...current(), url: `http://127.0.0.1:${ports[id]}/?k=host-key-${id}&manager=http%3A%2F%2F127.0.0.1%3A7780%2F`, hostPort: ports[id] } }
  } })

  await page.choose('a'); await settle()
  confirmFrame(page, page.created[0])
  await page.choose('b'); await settle()
  confirmFrame(page, page.created[1])
  await page.choose('a'); await settle()

  const opens = page.calls.filter((call) => call.path === '/manager/instances/open')
  assert.equal(opens.length, 2, 'A → B → A must not open A a second time')
  assert.equal(page.frames.size, 2)
  assert.equal(page.created.length, 2, 'a hidden frame is hidden, never re-created')
  assert.deepEqual([...page.frames].map(([id, frame]) => [id, frame.el.hidden]), [['a', false], ['b', true]])
  assert.equal(page.$('stage-note').hidden, true, 'the placeholder gets out of the way of the conversation')
})

test('the manager key never crosses into the frame, and the child is asked for its embedded presentation', async () => {
  const rows = [instanceOf({ id: 'a', name: 'A', paired: true })]
  const page = await runPageScript(managerPage, { respond: async (path) => {
    if (path !== '/manager/instances/open') return { body: stateOf({ device: linkedDevice(), instances: rows }) }
    Object.assign(rows[0], { open: true, hostPort: 9001, roles: ['agent', 'worker'] })
    return { body: { ...stateOf({ device: linkedDevice(), instances: rows }),
      url: 'http://127.0.0.1:9001/?k=host-key-a&manager=' + encodeURIComponent('http://127.0.0.1:7780/?k=MANAGERKEY'), hostPort: 9001 } }
  } })
  await page.choose('a'); await settle()
  const src = page.created[0].src
  // The embedded page renders no way back, so the launcher address is pure liability there:
  // it carries the key that opens this page, into a document of another origin.
  assert.equal(src.includes('manager='), false, 'the launcher address must not cross the origin boundary')
  assert.equal(src.includes('MANAGERKEY'), false, 'the manager browser key must not cross the origin boundary')
  assert.equal(src.includes('k=host-key-a'), true, 'the host still gets its own key, which is how it opens at all')
  assert.match(src, /[?&]embedded=1(&|$)/)
})

test('an Agent host address never lands in anything the page renders as text', async () => {
  const rows = [instanceOf({ id: 'a', name: 'A', paired: true })]
  const page = await runPageScript(managerPage, { respond: async (path) => (path === '/manager/instances/open'
    ? { body: { ...stateOf({ device: linkedDevice(), instances: rows }), url: 'http://127.0.0.1:9001/?k=host-key-secret', hostPort: 9001 } }
    : { body: stateOf({ device: linkedDevice(), instances: rows }) }) })
  await page.choose('a'); await settle()
  for (const element of page.elements.values()) {
    assert.equal(String(element.textContent).includes('host-key-secret'), false, `${element.id} rendered a host key as text`)
    assert.equal(String(element.innerHTML).includes('host-key-secret'), false, `${element.id} rendered a host key as markup`)
  }
  assert.equal(page.created[0].src.includes('host-key-secret'), true, 'it belongs in the frame address and nowhere else')
})

test('a workspace frame is discarded only when what it points at is gone', async () => {
  const rows = [instanceOf({ id: 'a', name: 'A', paired: true })]
  const page = await runPageScript(managerPage, { respond: async (path) => (path === '/manager/instances/open'
    ? { body: { ...stateOf({ instances: rows.map((row) => ({ ...row, open: true, hostPort: 9001 })) }), url: 'http://127.0.0.1:9001/?k=k1', hostPort: 9001 } }
    : { body: stateOf({ instances: rows }) }) })
  await page.choose('a'); await settle()
  assert.equal(page.frames.size, 1)

  // A poll that says nothing changed keeps it.
  page.render(stateOf({ instances: [instanceOf({ id: 'a', name: 'A', paired: true, open: true, hostPort: 9001, roles: ['agent', 'worker'] })] }))
  assert.equal(page.frames.size, 1, 'an unchanged host must not cost the conversation')

  // A host that came back at another address is another page; the frame goes.
  page.render(stateOf({ instances: [instanceOf({ id: 'a', name: 'A', paired: true, open: true, hostPort: 9999, roles: ['agent', 'worker'] })] }))
  assert.equal(page.frames.size, 0, 'a frame pointing at a dead address would show a dead page')
})

test('a new host generation discards a frame even when its port is reused', async () => {
  const row = instanceOf({ id: 'a', name: 'A', paired: true, open: true, hostPort: 9001, hostGeneration: 'old' })
  const page = await runPageScript(managerPage, { respond: async () => ({ body: {
    ...stateOf({ instances: [row] }), url: 'http://127.0.0.1:9001/?k=old', hostPort: 9001, hostGeneration: 'old',
  } }) })
  await page.choose('a'); await settle()
  confirmFrame(page, page.created[0])
  page.render(stateOf({ instances: [{ ...row, hostGeneration: 'new' }] }))
  assert.equal(page.frames.size, 0)
  assert.equal(page.$('stage-note').hidden, false)
})

test('no selectable cloud Agent means no enabled attachment submit', async () => {
  const device = linkedDevice([{ id: 'agent-alpha', name: 'Alpha' }])
  const page = await openPage(stateOf({ device, instances: [
    instanceOf({ id: 'owned', paired: true, agentId: 'agent-alpha' }), instanceOf({ id: 'new' }),
  ] }))
  await page.choose('new'); await settle()
  page.openDialog('dlg-attach', 'agent-select')
  assert.equal(page.$('agent-select').value, '')
  assert.equal(page.$('pair').disabled, true)
})

test('the Worker setting belongs to the selected Agent and never controls its Agent process', async () => {
  const rows = ['a', 'b'].map(id => instanceOf({ id, paired: true, open: true, hostPort: id === 'a' ? 9001 : 9002, roles: ['agent', 'worker'] }))
  const page = await runPageScript(managerPage, { respond: async (path, request) => {
    if (path === '/manager/instances/worker-setting') {
      const row = rows.find(r => r.id === request.body.instanceId)
      row.workerSetting = { enabled: request.body.enabled, visible: true, state: request.body.enabled ? 'online' : 'offline' }
    }
    return { body: { ...stateOf({ instances: rows }), url: 'http://127.0.0.1:9001/?k=k', hostPort: 9001 } }
  } })
  await page.choose('a'); await settle()
  page.$('worker-setting').checked = true
  await page.$('worker-setting').onchange(); await settle()
  assert.deepEqual(page.calls.find(c => c.path === '/manager/instances/worker-setting').body, { instanceId: 'a', enabled: true })
  assert.equal(page.$('worker-pill').textContent, 'online')
  assert.equal(rows[0].agent, false)
  assert.equal(page.calls.some(c => c.path === '/manager/instances/control'), false)
  assert.equal(page.$('agent-toggle'), undefined)
  await page.choose('b'); await settle()
  assert.equal(page.$('worker-setting').checked, false)
})

test('Worker availability and drain teaching come from the saved setting rather than process liveness', async () => {
  const row = instanceOf({ id: 'a', paired: true, worker: true, workerSetting: { enabled: true, visible: true, state: 'online' } })
  const page = await runPageScript(managerPage, { respond: async path => {
    if (path === '/manager/instances/worker-setting') row.workerSetting = { enabled: false, visible: true, state: 'offline', reloading: true }
    return { body: { ...stateOf({ instances: [row] }), url: 'http://127.0.0.1:9001/?k=k', hostPort: 9001, teaching: 'The Worker stops after running executions drain.' } }
  } })
  await page.choose('a'); await settle()
  page.$('worker-setting').checked = false
  await page.$('worker-setting').onchange(); await settle()
  assert.equal(page.$('worker-pill').textContent, 'offline')
  assert.match(page.$('worker-notice').textContent, /executions drain/)
  assert.equal(page.$('notice').textContent, '')
})

test('a role this environment does not run is described, not offered', async () => {
  const page = await openPage(stateOf({ device: linkedDevice(), instances: [
    instanceOf({ id: 'a', name: 'Desk', mode: 'existing_client', paired: true, connectionId: 'conn-1' }),
  ] }))
  await page.choose('a')
  assert.equal(page.$('agent-toggle'), undefined, 'Agent lifecycle has no button')
  assert.equal(page.$('agent-pill').textContent, 'Worker only')
  assert.equal(page.$('worker-setting-label').hidden, false, 'existing-client mode keeps the local-tools setting')
  assert.match(page.$('center-sub').textContent, /runs elsewhere|does the work/)
})

test('a blocked Agent says why, and its controls stay unavailable', async () => {
  const page = await openPage(stateOf({ device: linkedDevice(), instances: [
    instanceOf({ id: 'a', name: 'Blocked', paired: true, agentId: 'agent-alpha',
      blocked: 'Agent Alpha is no longer part of what this device is authorized for.' }),
  ] }))
  await page.choose('a')
  assert.equal(page.$('worker-setting').disabled, true)
  assert.match(page.$('worker-note').textContent, /no longer part of what this device/)
  page.openDialog('dlg-details')
  assert.equal(page.$('detail-attention').hidden, false)
  assert.match(page.$('detail-attention').textContent, /no longer part of what this device/)
})

test('processes from a manager that is gone are named, not summarised', async () => {
  const page = await openPage(stateOf({ instances: [
    instanceOf({ id: 'a', name: 'Orphaned', paired: true, orphaned: { managerPid: 4242, children: [{ role: 'agent', pid: 777 }] } }),
  ] }))
  await page.choose('a')
  page.openDialog('dlg-details')
  assert.match(page.$('detail-attention').textContent, /agent pid 777/)
  assert.equal(page.$('worker-setting').disabled, true, 'an unowned process keeps lifecycle changes unavailable')
})

test('connecting a cloud Agent offers the permitted ones, marks the taken ones, and needs explicit consent to replace', async () => {
  const page = await openPage(stateOf({
    device: linkedDevice([{ id: 'agent-alpha', name: 'Alpha' }, { id: 'agent-beta', name: 'Beta' }]),
    instances: [
      instanceOf({ id: 'a', name: 'A' }),
      instanceOf({ id: 'b', name: 'B', paired: true, agentId: 'agent-alpha', agentName: 'Alpha' }),
    ],
  }))
  await page.choose('a')
  page.openDialog('dlg-attach')
  const options = page.$('agent-select').innerHTML
  assert.ok(options.includes('>Beta</option>'))
  assert.ok(options.includes('already connected'), 'an Agent another one holds is shown as taken, not hidden')
  assert.match(options, /value="agent-alpha" disabled/)
  assert.equal(page.$('pair').disabled, false)
  assert.equal(page.$('replace').checked, false, 'replacing a credential is never the default')

  page.$('agent-select').value = 'agent-beta'
  page.$('agent-select').onchange()
  page.$('replace').checked = true
  page.$('replace').onchange()
  await page.$('pair').onclick(); await settle()
  const pair = page.calls.find((call) => call.path === '/manager/instances/pair')
  assert.deepEqual(pair.body, { instanceId: 'a', agentId: 'agent-beta', replaceAgentToken: true })
  assert.equal(page.$('replace').checked, false, 'consent is spent when it is used')
})

test('consent to replace a credential belongs to one Agent and one cloud Agent, and travels to neither', async () => {
  const rows = [instanceOf({ id: 'a', name: 'A' }), instanceOf({ id: 'b', name: 'B' })]
  const agents = [{ id: 'agent-alpha', name: 'Alpha' }, { id: 'agent-beta', name: 'Beta' }]
  const page = await runPageScript(managerPage, { respond: async () => ({ body: stateOf({ device: linkedDevice(agents), instances: rows }) }) })

  await page.choose('a')
  page.openDialog('dlg-attach')
  page.$('agent-select').value = 'agent-alpha'
  page.$('agent-select').onchange()
  page.$('replace').checked = true
  page.$('replace').onchange()

  // A poll that finds the same pair leaves the consent exactly where it was given.
  page.render(stateOf({ device: linkedDevice(agents), instances: rows }))
  assert.equal(page.$('replace').checked, true, 'a refresh must not take back a decision')

  // Another Agent in this environment is another credential; the tick does not come with it.
  await page.choose('b')
  assert.equal(page.$('replace').checked, false, 'consent given for A must not be spent on B')

  // And within one Agent, choosing a different cloud Agent is a different credential too.
  await page.choose('a')
  page.$('replace').checked = true
  page.$('replace').onchange()
  page.$('agent-select').value = 'agent-beta'
  page.$('agent-select').onchange()
  assert.equal(page.$('replace').checked, false, 'consent given for Alpha must not be spent on Beta')

  await page.$('pair').onclick(); await settle()
  const pair = page.calls.find((call) => call.path === '/manager/instances/pair')
  assert.equal(pair.body.replaceAgentToken, false, 'an unticked box sends no replacement')
})

test('choosing an authorized Agent that is not set up here opens first use and does nothing else', async () => {
  const page = await openPage(stateOf({ device: linkedDevice(), instances: [] }))
  await page.choose('agent-alpha')
  assert.equal(page.$('dlg-setup').hidden, false, 'the first press explains what setting up means')
  assert.equal(page.$('setup-sub').textContent, 'Alpha', 'the Agent is named, not asked for again')
  assert.equal(page.$('setup-form').hidden, false)
  // Rendering, listing and selecting are not allowed to allocate anything.
  assert.deepEqual(page.calls.map((call) => call.path), ['/manager/state'],
    'opening the dialog created a profile or asked for a credential')
})

test('first use names the profile after the Agent, pairs that exact Agent, and never replaces a credential', async () => {
  const rows = []
  const device = linkedDevice([{ id: 'agent-alpha', name: 'Alpha' }, { id: 'agent-beta', name: 'Beta' }])
  const page = await runPageScript(managerPage, { respond: async (path, request) => {
    const body = () => stateOf({ device, instances: rows })
    if (path === '/manager/instances/create') {
      rows.push(instanceOf({ id: 'new-1', name: request.body.name, mode: request.body.mode }))
      return { body: { ...body(), id: 'new-1', name: request.body.name } }
    }
    if (path === '/manager/instances/pair') {
      const row = rows.find((entry) => entry.id === request.body.instanceId)
      Object.assign(row, { paired: true, agentId: request.body.agentId, agentName: 'Alpha', origin: ORIGIN, accountId: ACCOUNT })
      return { body: body() }
    }
    if (path === '/manager/instances/open') return { body: { ...body(), url: 'http://127.0.0.1:9001/?k=k', hostPort: 9001 } }
    return { body: body() }
  } })

  await page.choose('agent-alpha')
  page.$('setup-mode').value = 'existing_client'
  await page.$('setup-start').onclick(); await settle()

  const create = page.calls.find((call) => call.path === '/manager/instances/create')
  assert.deepEqual(create.body, { name: 'Alpha', mode: 'existing_client', setupTarget: { origin: ORIGIN, accountId: ACCOUNT, agentId: 'agent-alpha' } },
    'the name comes from the Agent that was chosen, and the mode from the one question asked')
  const pair = page.calls.find((call) => call.path === '/manager/instances/pair')
  assert.deepEqual(pair.body, { instanceId: 'new-1', agentId: 'agent-alpha', replaceAgentToken: false },
    'first use mints this profile credential of its own and replaces nothing')
  assert.equal(page.$('dlg-setup').hidden, true)
  assert.equal(page.$('center-title').textContent, 'Alpha')
  // Configured now, so the row is the instance row the integration already knows.
  assert.ok(page.$('agents').innerHTML.includes('data-instance="new-1"'))
  assert.equal(page.$('agents').innerHTML.includes('data-agent="agent-alpha"'), false)
  assert.ok(page.$('agents').innerHTML.includes('data-agent="agent-beta"'), 'the other Agent is untouched')
})

test('a pairing that is not confirmed keeps its own proof, and is never assumed to have worked', async () => {
  const rows = []
  const page = await runPageScript(managerPage, { respond: async (path, request) => {
    const body = () => stateOf({ device: linkedDevice(), instances: rows })
    if (path === '/manager/instances/create') {
      rows.push(instanceOf({ id: 'new-1', name: request.body.name }))
      return { body: { ...body(), id: 'new-1' } }
    }
    if (path === '/manager/instances/pair') {
      Object.assign(rows[0], { pendingAgentId: 'agent-alpha', pendingAgentName: 'Alpha', pendingOrigin: ORIGIN, pendingAccountId: ACCOUNT })
      return { body: body() }
    }
    return { body: body() }
  } })
  await page.choose('agent-alpha')
  await page.$('setup-start').onclick(); await settle()

  assert.equal(page.$('dlg-setup').hidden, true)
  assert.equal(page.$('dlg-attach').hidden, false, 'an unconfirmed attachment is finished where its proof lives')
  assert.equal(page.$('attach-pending').hidden, false)
  assert.match(page.$('pair-agent').textContent, /Alpha/)
  assert.equal(page.$('pair-poll').disabled, false, 'checking again finishes the same attempt')
  assert.equal(page.$('pair-cancel').disabled, false)
  assert.equal(page.calls.some((call) => call.path === '/manager/instances/open'), false,
    'nothing is opened for an Agent whose attachment has not been confirmed')
  // The list shows it as mid-setup rather than as a configured Agent.
  assert.ok(page.$('agents').innerHTML.includes('Finishing setup'))
})

test('a late state read cannot replace the Agent directory returned by Refresh', async () => {
  let delayed = false, release
  const before = stateOf({ stateRevision: 1, device: linkedDevice() })
  const after = stateOf({ stateRevision: 3, device: linkedDevice([{ id: 'agent-alpha', name: 'Alpha' }, { id: 'agent-new', name: 'New Agent' }]) })
  const page = await runPageScript(managerPage, { respond: async path => {
    if (path === '/manager/device/refresh') return { body: { ...after, addedAgents: [{ id: 'agent-new', name: 'New Agent' }] } }
    if (delayed) return new Promise(resolve => { release = () => resolve({ body: { ...before, stateRevision: 2 } }) })
    return { body: before }
  } })
  delayed = true
  const oldRead = page.api('/manager/state')
  await settle()
  await page.$('refresh-account').onclick()
  assert.equal(page.state().device.agents.length, 2)
  release(); await oldRead
  assert.equal(page.state().device.agents.length, 2, 'older response must not undo a successful refresh')
  assert.match(page.$('agents').innerHTML, /New Agent/)
})

test('a fixed-key server restart accepts its new revision and rejects the old in-flight snapshot', async () => {
  let oldRead, delay = false, restarted = false
  const before = stateOf({ stateServerId: 'old', stateRevision: 100, device: linkedDevice() })
  const after = stateOf({ stateServerId: 'new', stateRevision: 1, device: linkedDevice([{ id: 'agent-new', name: 'New Agent' }]) })
  const page = await runPageScript(managerPage, { respond: async () => {
    if (restarted) return { body: after }
    if (delay) return new Promise(resolve => { oldRead = () => resolve({ body: { ...before, stateRevision: 101 } }) })
    return { body: before }
  } })
  delay = true
  const stale = page.api('/manager/state'); await settle()
  restarted = true
  await page.api('/manager/state')
  assert.equal(page.state().device.agents[0].id, 'agent-new')
  oldRead(); await stale
  assert.equal(page.state().device.agents[0].id, 'agent-new', 'an old process cannot replace a restarted process snapshot')
})

test('reopening a pending replacement discloses the previously approved key replacement', async () => {
  const row = instanceOf({ pendingAgentId: 'agent-alpha', pendingAgentName: 'Alpha', pendingOrigin: ORIGIN,
    pendingAccountId: ACCOUNT, pendingReplace: true, pendingError: { code: '', teaching: 'Network unavailable' } })
  const page = await openPage(stateOf({ device: linkedDevice(), instances: [row] }))
  await page.choose('agent-alpha')
  assert.equal(page.$('pair-replacement-pending').hidden, false)
  assert.match(page.$('pair-poll').textContent, /Continue key replacement/)
  assert.match(page.$('agents').innerHTML, /Key replacement pending/)
})

for (const cancellation of ['confirmed', 'unconfirmed', 'account-changed']) {
  test('key replacement requires explicit choice and confirmed cancellation: ' + cancellation, async () => {
    const row = instanceOf({ pendingAgentId: 'agent-alpha', pendingAgentName: 'Alpha', pendingOrigin: ORIGIN, pendingAccountId: ACCOUNT,
      pendingReconnect: 'conn-old', pendingError: { code: 'runtime_credential_exists', teaching: 'Agent already has an active credential' } })
    let device = linkedDevice([{ id: 'agent-alpha', name: 'Alpha', reconnectable: [{ connectionId: 'conn-old', name: 'Old computer', createdAt: '' }] }])
    const page = await runPageScript(managerPage, { respond: async (path, request) => {
      const body = () => stateOf({ device, instances: [row] })
      if (path === '/manager/instances/pair/cancel') {
        if (cancellation === 'unconfirmed') return { status: 400, body: { ...body(), ok: false, teaching: 'Cancellation not confirmed' } }
        Object.assign(row, { pendingAgentId: '', pendingError: null })
        if (cancellation === 'account-changed') device = { ...device, account: { id: 'another-account' } }
        return { body: body() }
      }
      if (path === '/manager/instances/pair') {
        assert.equal(request.body.replaceAgentToken, true)
        assert.equal(request.body.reconnectConnectionId, 'conn-old', 'replacing the Agent key preserves the Connection decision')
        Object.assign(row, { paired: true, agentId: 'agent-alpha', origin: ORIGIN, accountId: ACCOUNT })
        return { body: body() }
      }
      if (path === '/manager/instances/open') return { body: { ...body(), url: 'http://127.0.0.1:9001/?k=fixture', hostPort: 9001 } }
      return { body: body() }
    } })
    await page.choose('agent-alpha')
    assert.equal(page.$('pair-conflict').hidden, false)
    assert.equal(page.$('pair-poll').hidden, false, 'the existing key may have been retired outside this workbench')
    assert.match(page.$('agents').innerHTML, /Action needed/)
    assert.equal(page.$('pair-replace').disabled, true)
    await page.$('pair-replace').onclick()
    assert.equal(page.calls.some(c => c.path === '/manager/instances/pair/cancel'), false)
    page.$('pair-replace-confirm').checked = true; page.$('pair-replace-confirm').onchange()
    assert.equal(page.$('pair-replace').disabled, false)
    await page.$('pair-replace').onclick()
    assert.equal(page.calls.filter(c => c.path === '/manager/instances/pair').length, cancellation === 'confirmed' ? 1 : 0)
    if (cancellation === 'confirmed') assert.equal(page.$('dlg-attach').hidden, true)
    else assert.equal(page.$('dlg-attach').hidden, false)
  })
}

test('a failed or repeated first use finishes the same profile instead of leaving spares behind', async () => {
  const rows = []
  let pairFails = true
  const page = await runPageScript(managerPage, { respond: async (path, request) => {
    const body = () => stateOf({ device: linkedDevice(), instances: rows })
    if (path === '/manager/instances/create') {
      rows.push(instanceOf({ id: 'new-' + (rows.length + 1), name: request.body.name }))
      return { body: { ...body(), id: 'new-' + rows.length } }
    }
    if (path === '/manager/instances/pair') {
      if (pairFails) return { status: 400, body: { ...body(), ok: false, teaching: 'The account service did not answer.' } }
      const row = rows.find((entry) => entry.id === request.body.instanceId)
      Object.assign(row, { paired: true, agentId: request.body.agentId, origin: ORIGIN, accountId: ACCOUNT })
      return { body: body() }
    }
    if (path === '/manager/instances/open') return { body: { ...body(), url: 'http://127.0.0.1:9001/?k=k', hostPort: 9001 } }
    return { body: body() }
  } })

  await page.choose('agent-alpha')
  await page.$('setup-start').onclick(); await settle()
  assert.equal(rows.length, 1, 'the profile was created')
  assert.match(page.$('setup-notice').textContent, /did not answer/, 'the failure is the service own words')
  assert.match(page.$('setup-existing').textContent, /already exists/, 'and the retry says what it will finish')

  pairFails = false
  await page.$('setup-start').onclick(); await settle()
  assert.equal(rows.length, 1, 'a retry after a partial failure must not leave a second profile behind')
  assert.equal(page.calls.filter((call) => call.path === '/manager/instances/create').length, 1)
  assert.equal(page.calls.filter((call) => call.path === '/manager/instances/pair').length, 2)
  assert.equal(page.$('dlg-setup').hidden, true)
})

test('a reloaded first-use page resumes the exact account and Agent profile before pairing', async () => {
  const setupTarget = { origin: ORIGIN, accountId: ACCOUNT, agentId: 'agent-alpha' }
  const rows = [
    instanceOf({ id: 'foreign', name: 'Alpha', setupTarget: { ...setupTarget, accountId: 'other-account' } }),
    instanceOf({ id: 'same', name: 'Alpha', mode: 'existing_client', setupTarget }),
  ]
  const page = await runPageScript(managerPage, { respond: async (path) => ({ body: {
    ...stateOf({ device: linkedDevice(), instances: rows }),
    ...(path.endsWith('/pair') ? { ok: false, teaching: 'Pairing has not started.' } : {}),
  } }) })
  await page.choose('agent-alpha')
  assert.equal(page.$('setup-mode').value, 'existing_client')
  assert.equal(page.$('setup-mode').disabled, true)
  await page.$('setup-start').onclick(); await settle()
  assert.equal(page.calls.some(call => call.path === '/manager/instances/create'), false)
  assert.equal(page.calls.find(call => call.path === '/manager/instances/pair').body.instanceId, 'same')
})

test('a second press while first use is working says so rather than starting a second attempt', async () => {
  const rows = []
  let release
  const page = await runPageScript(managerPage, { respond: async (path, request) => {
    const body = () => stateOf({ device: linkedDevice(), instances: rows })
    if (path === '/manager/instances/create') {
      await new Promise((done) => { release = done })
      rows.push(instanceOf({ id: 'new-1', name: request.body.name }))
      return { body: { ...body(), id: 'new-1' } }
    }
    return { body: body() }
  } })
  await page.choose('agent-alpha')
  const first = page.$('setup-start').onclick(); await settle()
  page.$('setup-start').onclick()
  assert.match(page.$('setup-notice').textContent, /still working/)
  release(); await first; await settle()
  assert.equal(page.calls.filter((call) => call.path === '/manager/instances/create').length, 1,
    'a double press created two profiles')
})

test('first use is refused when the grant no longer names that Agent', async () => {
  const page = await openPage(stateOf({ device: linkedDevice([{ id: 'agent-alpha', name: 'Alpha' }]), instances: [] }))
  await page.choose('agent-alpha')
  assert.equal(page.$('setup-start').disabled, false)

  // The Agent left the grant while the dialog was open, or the grant itself stopped being
  // usable: either way this page must not go on offering to connect to it.
  page.render(stateOf({ device: linkedDevice([{ id: 'agent-beta', name: 'Beta' }]), instances: [] }))
  assert.equal(page.$('setup-start').disabled, true)
  assert.equal(page.$('setup-form').hidden, true)
  assert.match(page.$('setup-blocked').textContent, /no longer enabled in this account/)

  page.render(stateOf({ device: deviceOf({ state: 'revoked', origin: ORIGIN, agents: [{ id: 'agent-alpha', name: 'Alpha' }] }), instances: [] }))
  assert.equal(page.$('setup-start').disabled, true)
  assert.match(page.$('setup-blocked').textContent, /not signed in to an account any more/)
})

test('pending configuration from another account or Console never joins this directory', async () => {
  const foreign = instanceOf({ id: 'foreign', name: 'Other account profile', pendingAgentId: 'agent-alpha',
    pendingOrigin: ORIGIN, pendingAccountId: 'different-account' })
  const page = await openPage(stateOf({ device: linkedDevice(), instances: [foreign] }))
  assert.doesNotMatch(page.$('agents').innerHTML, /Finishing setup|Other account profile/)
  assert.match(page.$('profiles').innerHTML, /Other account profile/)
  await page.choose('agent-alpha')
  assert.equal(page.$('dlg-setup').hidden, false)
  assert.equal(page.$('setup-existing').hidden, true)
})

test('first-use target remains pinned when the account changes during creation', async () => {
  const rows = [], device = linkedDevice()
  const page = await runPageScript(managerPage, { respond: async (path, request) => {
    if (path === '/manager/instances/create') {
      rows.push(instanceOf({ id: 'new-1', name: request.body.name }))
      return { body: { ...stateOf({ device: { ...device, account: { id: 'other', name: 'Other' } }, instances: rows }), id: 'new-1' } }
    }
    return { body: stateOf({ device, instances: rows }) }
  } })
  await page.choose('agent-alpha')
  await page.$('setup-start').onclick(); await settle()
  assert.equal(page.calls.some(call => call.path === '/manager/instances/pair'), false)
  assert.match(page.$('setup-notice').textContent, /account changed or this Agent is no longer enabled/)
  assert.equal(page.$('setup-start').disabled, true)
})

test('an Agent that is already connected says so instead of offering to connect again', async () => {
  const page = await openPage(stateOf({ device: linkedDevice(), instances: [
    instanceOf({ id: 'a', name: 'A', paired: true, agentId: 'agent-alpha', agentName: 'Alpha' }),
  ] }))
  await page.choose('a')
  page.openDialog('dlg-attach')
  assert.equal(page.$('attach-form').hidden, true)
  assert.match(page.$('attach-blocked').textContent, /already connected to Alpha/)
  assert.equal(page.$('attach-blocked').hidden, false)
})

test('an interrupted attachment offers to finish itself or to be given up', async () => {
  const page = await openPage(stateOf({
    device: linkedDevice(), instances: [instanceOf({ id: 'a', name: 'A', pendingAgentId: 'agent-alpha' })],
  }))
  await page.choose('a')
  page.openDialog('dlg-attach')
  assert.equal(page.$('attach-pending').hidden, false)
  assert.equal(page.$('attach-form').hidden, true, 'a second attempt while one is open is how two credentials get minted')
  assert.match(page.$('pair-agent').textContent, /agent-alpha/)
  await page.$('pair-poll').onclick(); await settle()
  await page.$('pair-cancel').onclick(); await settle()
  assert.deepEqual(page.calls.find((call) => call.path === '/manager/instances/pair/poll').body, { instanceId: 'a' })
  assert.deepEqual(page.calls.find((call) => call.path === '/manager/instances/pair/cancel').body, { instanceId: 'a' })
})

test('model settings can be copied from another Agent while running and never from itself', async () => {
  const rows = [
    instanceOf({ id: 'a', name: 'Configured', paired: true, agentId: 'agent-alpha' }),
    instanceOf({ id: 'b', name: 'Fresh', paired: true, agentId: 'agent-beta' }),
    instanceOf({ id: 'c', name: 'Desk', mode: 'existing_client', paired: true, connectionId: 'conn-1' }),
  ]
  const page = await openPage(stateOf({ device: linkedDevice(), instances: rows }))
  await page.choose('a')
  page.openDialog('dlg-details')
  assert.equal(page.$('model-row').hidden, false)
  assert.equal(page.$('model-copy').disabled, false)
  assert.ok(page.$('model-from').innerHTML.includes('value="b"'))
  assert.equal(page.$('model-from').innerHTML.includes('>Configured<'), false, 'an Agent cannot take its own settings')
  assert.equal(page.$('model-from').innerHTML.includes('value="c"'), false, 'a Worker-only profile has no model of its own')

  // Both roles reload their new configuration automatically.
  page.render(stateOf({ device: linkedDevice(), instances: rows.map((row) => (row.id === 'a' ? { ...row, open: true, roles: ['agent', 'worker'], worker: true } : row)) }))
  assert.equal(page.$('model-copy').disabled, false)

  await page.choose('c')
  assert.equal(page.$('model-row').hidden, true)
})

test('a chosen option survives a refresh even when its identifier had to be escaped', async () => {
  const hostile = 'agent-"&<>-alpha'
  const agents = [{ id: hostile, name: 'Alpha' }, { id: 'agent-beta', name: 'Beta' }]
  const rows = [instanceOf({ id: 'a', name: 'A' })]
  const page = await openPage(stateOf({ device: linkedDevice(agents), instances: rows }))
  await page.choose('a')
  page.openDialog('dlg-attach')
  page.$('agent-select').value = hostile

  // The same list arriving again must not quietly move the selection to the first row: the
  // value is compared against the options the document holds, not against escaped markup.
  page.render(stateOf({ device: linkedDevice([...agents]), instances: [instanceOf({ id: 'a', name: 'A', createdAt: 'x' })] }))
  assert.equal(page.$('agent-select').value, hostile)
})

test('settings open inside the workbench, with a real link out, and never a pop-up nobody sees', async () => {
  const rows = [instanceOf({ id: 'a', name: 'A', paired: true, open: true, hostPort: 9001, roles: ['agent', 'worker'] })]
  const page = await runPageScript(managerPage, { respond: async (path, request) => (path === '/manager/instances/open'
    ? { body: { ...stateOf({ instances: rows }),
      url: 'http://127.0.0.1:9001' + request.body.page + '?k=host-key-a&manager=' + encodeURIComponent('http://127.0.0.1:7780/?k=MANAGERKEY'),
      hostPort: 9001 } }
    : { body: stateOf({ instances: rows }) }) })
  await page.choose('a'); await settle()

  await page.$('tools-open').onclick(); await settle()
  assert.deepEqual(page.opened, [], 'a window.open after an await is a pop-up with no gesture behind it')
  assert.equal(page.$('dlg-page').hidden, false)
  assert.equal(page.$('page-title').textContent, 'Agent tools')
  assert.equal(page.$('page-sub').textContent, 'A')
  const settingsUrl = new URL(page.$('page-frame').src)
  assert.equal(settingsUrl.searchParams.has('manager'), false)
  assert.equal(settingsUrl.searchParams.get('k'), 'host-key-a')
  assert.ok(settingsUrl.searchParams.get('view'))
  assert.equal(page.$('page-tab').hidden, false, 'a real anchor is how a person gets a tab of their own')
  assert.equal(page.$('page-tab').href, 'http://127.0.0.1:9001/worker-tools?k=host-key-a')

  page.closeDialog('dlg-page')
  assert.equal(page.$('page-frame').src, 'about:blank', 'a closed settings page stops polling its host')
  assert.equal(page.$('page-tab').href, '')
  assert.equal(page.$('page-tab').hidden, true)
})

test('opening settings is not the same action as opening the workspace', async () => {
  const rows = [instanceOf({ id: 'a', name: 'A', paired: true })]
  let releaseFrame
  const page = await runPageScript(managerPage, { respond: async (path, request) => {
    if (path !== '/manager/instances/open') return { body: stateOf({ instances: rows }) }
    Object.assign(rows[0], { open: true, hostPort: 9001, roles: ['agent', 'worker'] })
    const answer = { body: { ...stateOf({ instances: rows }), url: 'http://127.0.0.1:9001' + request.body.page + '?k=k', hostPort: 9001 } }
    if (request.body.page !== '/') return answer
    await new Promise((done) => { releaseFrame = done })
    return answer
  } })
  const opening = page.choose('a')
  await settle()
  assert.match(page.$('stage-title').textContent, /^Opening/)

  // Tools while the workspace is still opening must not be silently swallowed by one shared
  // scope, and must not make the stage claim the workspace is opening when it is not.
  await page.$('tools-open').onclick(); await settle()
  assert.equal(page.$('dlg-page').hidden, false, 'Tools did nothing at all while the frame was opening')
  releaseFrame(); await opening; await settle()
  assert.equal(page.frames.size, 1)
})

test('a second press of a control that is still working says so', async () => {
  const rows = [instanceOf({ id: 'a', name: 'A', paired: true, open: true, hostPort: 9001, roles: ['agent', 'worker'] })]
  let release
  const page = await runPageScript(managerPage, { respond: async (path) => {
    if (path === '/manager/instances/worker-setting') { await new Promise((done) => { release = done }) }
    return { body: { ...stateOf({ instances: rows }), url: 'http://127.0.0.1:9001/?k=k', hostPort: 9001 } }
  } })
  await page.choose('a'); await settle()
  const first = page.$('worker-setting').onchange(); await settle()
  page.$('worker-setting').onchange()
  assert.match(page.$('worker-notice').textContent, /still working/, 'a control that quietly does nothing is a control nobody trusts')
  release(); await first; await settle()
})

test('the centre says what the frame actually did, and offers to try again when it did not', async () => {
  const rows = [instanceOf({ id: 'a', name: 'A', paired: true })]
  const page = await runPageScript(managerPage, { respond: async (path) => {
    if (path !== '/manager/instances/open') return { body: stateOf({ instances: rows }) }
    Object.assign(rows[0], { open: true, hostPort: 9001, roles: ['agent', 'worker'] })
    return { body: { ...stateOf({ instances: rows }), url: 'http://127.0.0.1:9001/?k=k', hostPort: 9001 } }
  } })
  await page.choose('a'); await settle()
  assert.equal(page.$('stage-note').hidden, false, 'an appended frame has not loaded anything yet')
  assert.match(page.$('stage-copy').textContent, /Loading/)

  // The watchdog the page set for a frame that never arrives.
  const watchdog = page.timers[page.timers.length - 1]
  watchdog.callback()
  assert.match(page.$('stage-title').textContent, /Workspace not ready/)
  assert.equal(page.$('stage-action').textContent, 'Try again')

  page.created[0].onerror()
  assert.match(page.$('stage-copy').textContent, /did not load/)
  assert.equal(page.frames.size, 1, 'a frame that failed is not pretended to be closed')

  await page.$('stage-action').onclick(); await settle()
  assert.equal(page.created.length, 2, 'trying again asks the manager for the address again')
  page.created[1].onload()
  assert.equal(page.$('stage-note').hidden, false, 'HTTP load alone cannot confirm the expected page')
  const frame = page.created[1], url = new URL(frame.src)
  frame.contentWindow = {}
  for (const event of [
    { source: {}, origin: url.origin, data: { type: 'rulith-ui-ready', view: url.searchParams.get('view') } },
    { source: frame.contentWindow, origin: 'http://127.0.0.1:1', data: { type: 'rulith-ui-ready', view: url.searchParams.get('view') } },
    { source: frame.contentWindow, origin: url.origin, data: { type: 'rulith-ui-ready', view: 'stale' } },
  ]) page.message(event)
  assert.equal(page.$('stage-note').hidden, false, 'an unrelated sender cannot claim this view loaded')
  confirmFrame(page, frame)
  assert.equal(page.$('stage-note').hidden, true)
})

test('a manager that stops answering is said so, and nothing may be changed from a remembered picture', async () => {
  const rows = [instanceOf({ id: 'a', name: 'A', paired: true, open: true, hostPort: 9001, roles: ['agent', 'worker'] })]
  let answering = true
  const page = await runPageScript(managerPage, { respond: async () => {
    if (!answering) throw new TypeError('Failed to fetch')
    return { body: stateOf({ device: linkedDevice(), instances: rows }) }
  } })
  await page.choose('a'); await settle()
  assert.equal(page.$('connection').hidden, true)

  answering = false
  await page.render && null
  await page.api('/manager/state').catch(() => {})
  await settle()
  assert.equal(page.$('connection').hidden, true, 'one dropped answer during a restart is not a state worth announcing')
  await page.api('/manager/state').catch(() => {})
  await settle()
  assert.equal(page.$('connection').hidden, false)
  assert.match(page.$('connection').textContent, /did not answer/)
  assert.equal(page.$('worker-setting').disabled, true, 'a write decided from a remembered picture is the one mistake this page can make')
  assert.equal(page.$('setup-start').disabled, true, 'setting an Agent up allocates a profile and mints a credential')
  assert.equal(page.$('setup-mode').disabled, true)

  answering = true
  await page.api('/manager/state'); await settle()
  assert.equal(page.$('connection').hidden, true, 'a manager that came back is not still reported as gone')
  assert.equal(page.$('worker-setting').disabled, false)
  assert.equal(page.$('stage-action').disabled, false, 'recovery applies to the stage immediately')
})

test('a drawer is out of the tab order when it is closed, and stops existing when the window grows', async () => {
  const page = await openPage(stateOf({ device: linkedDevice(), instances: [instanceOf({ id: 'a', name: 'A', paired: true })] }))
  assert.equal(page.$('rail').inert, false, 'on a desk the Agent list is simply there')

  page.setNarrow(true)
  assert.equal(page.$('rail').inert, true, 'an off-screen drawer that can still be tabbed into is a trap')

  page.$('rail-open').onclick()
  assert.equal(page.$('rail').inert, false)
  assert.equal(page.$('rail-open').getAttribute('aria-expanded'), 'true')
  assert.equal(page.$('scrim').hidden, false)

  page.setNarrow(false)
  assert.equal(page.$('scrim').hidden, true, 'a layout without drawers cannot have one open')
  assert.equal(page.$('rail-open').getAttribute('aria-expanded'), 'false')
  assert.equal(page.$('rail').inert, false, 'a rail that is simply part of the page must not stay inert')
})

test('a dialog whose Agent disappeared says so rather than showing nothing at all', async () => {
  const page = await openPage(stateOf({ device: linkedDevice(), instances: [instanceOf({ id: 'a', name: 'A' })] }))
  await page.choose('a')
  page.openDialog('dlg-attach')
  assert.equal(page.$('attach-form').hidden, false)

  // Another manager removed it, or a sign-out did; the poll brings back a list without it.
  page.render(stateOf({ device: linkedDevice(), instances: [] }))
  assert.equal(page.$('attach-form').hidden, true)
  assert.equal(page.$('attach-pending').hidden, true)
  assert.equal(page.$('attach-blocked').hidden, false, 'an empty dialog is a dialog that tells you nothing')
  assert.match(page.$('attach-blocked').textContent, /no longer in this environment/)
  page.openDialog('dlg-details')
  assert.equal(page.$('detail-attention').hidden, false)
  assert.match(page.$('detail-attention').textContent, /no longer in this environment/)
})

test('signing in sends what the operator typed, and nothing else', async () => {
  const requests = []
  const page = await runPageScript(managerPage, {
    respond: async (path, request) => {
      requests.push({ path, body: request.body })
      return { body: path.endsWith('/device/start') ? stateOf({ device: deviceOf({ state: 'pending', code: 'ABCD2345', consoleUrl: ORIGIN + '/console/#/devices?code=ABCD2345' }) }) : stateOf() }
    },
  })
  page.$('console-url').value = 'https://console.example'
  page.$('device-name').value = 'Work laptop'
  await page.$('sign-in').onclick(); await settle()
  const start = requests.find((row) => row.path === '/manager/device/start')
  assert.deepEqual(start.body, { consoleUrl: 'https://console.example', name: 'Work laptop' })
  assert.equal(page.$('device-code'), undefined, 'the authorization code is carried by the link, not shown as a task for the user')
  assert.equal(page.opened[0].url, ORIGIN + '/console/#/devices?code=ABCD2345')
  assert.equal(page.opened[0].opener, null, 'the page script severs its opener reference; browser behavior is checked separately')
  assert.equal(page.calls.every((row) => row.headers['x-rulith-manager'] === 'page-test-key'), true,
    'every request carries the key from this page\'s address')
})

test('sign-in reserves one tab before the network request and prevents duplicate starts', async () => {
  let finish
  const waiting = new Promise(resolve => { finish = resolve })
  const page = await runPageScript(managerPage, { respond: async path => {
    if (!path.endsWith('/device/start')) return { body: stateOf() }
    await waiting
    return { body: stateOf({ device: deviceOf({ state: 'pending', code: 'ABCD2345', consoleUrl: ORIGIN + '/console/#/devices?code=ABCD2345' }) }) }
  } })
  assert.equal(page.opened.length, 0, 'loading the page does not sign in')
  const first = page.$('sign-in').onclick()
  assert.equal(page.opened.length, 1, 'the tab is opened in the click, before an await')
  assert.equal(page.calls.filter(c => c.path.endsWith('/device/start')).length, 0)
  await page.$('sign-in').onclick()
  assert.equal(page.opened.length, 1)
  finish(); await first
  assert.equal(page.calls.filter(c => c.path.endsWith('/device/start')).length, 1)
})

test('a blocked sign-in tab keeps a usable link and approval completes through automatic polling', async () => {
  let device = deviceOf()
  const page = await runPageScript(managerPage, { openWindow: () => null, respond: async path => {
    if (path.endsWith('/device/start')) device = deviceOf({ state: 'pending', code: 'ABCD2345', consoleUrl: ORIGIN + '/console/#/devices?code=ABCD2345' })
    if (path.endsWith('/device/poll')) device = linkedDevice()
    return { body: stateOf({ device }) }
  } })
  page.$('account-open').onclick()
  await page.$('sign-in').onclick()
  assert.equal(page.$('console-link').href, ORIGIN + '/console/#/devices?code=ABCD2345')
  assert.match(page.$('account-notice').textContent, /link below/)
  page.timers.at(-1).callback(); await settle()
  assert.equal(page.$('dlg-account').hidden, true)
  assert.equal(page.$('account-line').textContent, 'Test Account')
  assert.match(page.$('agents').innerHTML, /Alpha/)
  assert.equal(page.calls.filter(c => c.path.endsWith('/device/start')).length, 1)
})

test('a failed sign-in request closes its blank tab and remains retryable', async () => {
  const page = await runPageScript(managerPage, { respond: async path => path.endsWith('/device/start')
    ? { status: 400, body: { ...stateOf(), ok: false, teaching: 'Console did not answer.' } }
    : { body: stateOf() } })
  await page.$('sign-in').onclick()
  assert.equal(page.opened[0].closed, true)
  assert.equal(page.$('sign-in').disabled, false)
  assert.match(page.$('account-notice').textContent, /Console did not answer/)
})

test('a clean installation can reach sign-in settings without a legacy profile', async () => {
  const page = await openPage(stateOf())
  page.$('account-open').onclick()
  assert.equal(page.$('local-settings').hidden, false)
  assert.equal(page.$('signin-settings').hidden, false)
  assert.equal(page.opened.length, 0, 'the account menu allows configuration before sign-in')
})

test('a stalled sign-in times out, closes the reserved tab and allows retry', async () => {
  const page = await runPageScript(managerPage, { respond: async (path, request) => {
    if (path.endsWith('/device/start')) await new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(Error('aborted'))))
    return { body: stateOf() }
  } })
  const started = page.$('sign-in').onclick()
  await settle()
  page.timers.find(t => t.ms === 30000).callback()
  await started
  assert.equal(page.opened[0].closed, true)
  assert.equal(page.$('sign-in').disabled, false)
  assert.match(page.$('account-notice').textContent, /took too long/)
})

test('automatic approval failures are visible and can be reset, including the approved state', async () => {
  for (const state of ['pending', 'approved']) {
    let device = deviceOf({ state, code: state === 'pending' ? 'ABCD2345' : '', consoleUrl: state === 'pending' ? ORIGIN + '/console/#/devices?code=ABCD2345' : '' })
    const page = await runPageScript(managerPage, { respond: async path => {
      if (path.endsWith('/device/poll')) return { status: 400, body: { ...stateOf({ device }), ok: false, teaching: 'The device token could not be opened.' } }
      if (path.endsWith('/device/forget')) {
        if (device.state === 'approved') return { status: 400, body: { ...stateOf({ device }), ok: false, teaching: 'Use Sign out and stop this device.' } }
        device = deviceOf()
      }
      if (path.endsWith('/device/signout')) device = deviceOf()
      return { body: stateOf({ device }) }
    } })
    page.timers.find(t => t.ms === 3000).callback(); await settle()
    assert.match(page.$('signin-poll-error').textContent, /could not be opened/)
    assert.equal(page.$('signin-reset').hidden, false)
    assert.equal(page.$('start-over').disabled, false)
    await page.$('start-over').onclick()
    assert.equal(page.$('signed-out').hidden, false)
    assert.equal(page.$('sign-in').disabled, false)
    assert.equal(page.calls.filter(c => c.path.endsWith(state === 'approved' ? '/device/signout' : '/device/forget')).length, 1)
    assert.equal(page.calls.filter(c => c.path.endsWith(state === 'approved' ? '/device/forget' : '/device/signout')).length, 0)
  }
})

test('returning to the visible workbench immediately collects approval', async () => {
  let device = deviceOf({ state: 'approved' })
  const page = await runPageScript(managerPage, { respond: async path => {
    if (path.endsWith('/device/poll')) device = linkedDevice()
    return { body: stateOf({ device }) }
  } })
  for (const listener of page.document.listeners.visibilitychange) listener()
  await settle()
  assert.equal(page.$('account-line').textContent, 'Test Account')
  assert.match(page.$('notice').textContent, /Signed in as Test Account/)
})

for (const state of ['pending', 'approved']) test('sign-in completes while the workbench is hidden: ' + state, async () => {
  let device = deviceOf({ state, code: state === 'pending' ? 'ABCD2345' : '',
    codeExpiresAt: state === 'pending' ? new Date(Date.now() + 600000).toISOString() : '',
    consoleUrl: state === 'pending' ? ORIGIN + '/console/#/devices?code=ABCD2345' : '' })
  const page = await runPageScript(managerPage, { respond: async path => {
    if (path.endsWith('/device/poll')) device = linkedDevice()
    return { body: stateOf({ device }) }
  } })
  page.document.hidden = true
  page.timers.find(t => t.ms === 3000).callback(); await settle()
  assert.equal(page.$('account-line').textContent, 'Test Account')
  assert.equal(page.calls.filter(c => c.path.endsWith('/device/poll')).length, 1)
  const count = page.calls.length
  page.timers.find(t => t.ms === 3000).callback(); await settle()
  assert.equal(page.calls.length, count, 'background checks stop on the same page once linked')
})

test('hidden workbenches do not retry incomplete or expired login requests', async () => {
  for (const device of [deviceOf({ state: 'pending' }), deviceOf({ state: 'pending', code: 'ABCD2345', consoleUrl: ORIGIN,
    codeExpiresAt: new Date(Date.now() - 1000).toISOString() })]) {
    const page = await openPage(stateOf({ device }))
    page.document.hidden = true
    page.timers.find(t => t.ms === 3000).callback(); await settle()
    assert.equal(page.calls.length, 1)
  }
})

test('background account refresh remains idle after sign-in completes', async () => {
  const page = await openPage(stateOf({ device: linkedDevice() }))
  page.document.hidden = true
  page.timers.find(t => t.ms === 3000).callback(); await settle()
  assert.equal(page.calls.length, 1, 'only the initial state request was made')
})

test('a refused operation shows its teaching and leaves the operator where they can retry', async () => {
  const page = await runPageScript(managerPage, {
    respond: async (path) => (path.endsWith('/device/start')
      ? { status: 400, body: { ...stateOf(), ok: false, teaching: 'Choose a device name of at most 120 characters.' } }
      : { body: stateOf() }),
  })
  await page.$('sign-in').onclick(); await settle()
  assert.equal(page.$('account-notice').textContent, 'Choose a device name of at most 120 characters.')
  assert.match(page.$('account-notice').className, /error/)
  assert.equal(page.$('signed-out').hidden, false)
  assert.equal(page.$('sign-in').disabled, false, 'a refusal must leave the control that was refused usable')
})

test('a slow action on one Agent blocks neither the other Agents nor choosing between them', async () => {
  const rows = [
    instanceOf({ id: 'a', name: 'A', paired: true, open: true, hostPort: 9001, roles: ['agent', 'worker'] }),
    instanceOf({ id: 'b', name: 'B', paired: true, open: true, hostPort: 9002, roles: ['agent', 'worker'] }),
  ]
  let release
  const page = await runPageScript(managerPage, { respond: async (path, request) => {
    if (path === '/manager/instances/worker-setting') { await new Promise((done) => { release = done }); return { body: stateOf({ instances: rows }) } }
    if (path === '/manager/instances/open') {
      const id = request.body.instanceId
      return { body: { ...stateOf({ instances: rows }), url: `http://127.0.0.1:900${id === 'a' ? 1 : 2}/?k=k`, hostPort: id === 'a' ? 9001 : 9002 } }
    }
    return { body: stateOf({ instances: rows }) }
  } })
  await page.choose('a'); await settle()
  const pending = page.$('worker-setting').onchange()
  await settle()
  assert.equal(page.$('worker-setting').disabled, true, 'the control that is working says so')

  await page.choose('b'); await settle()
  assert.equal(page.$('center-title').textContent, 'B', 'a slow action elsewhere must not hold the workbench still')
  assert.equal(page.$('worker-setting').disabled, false, 'B\'s Worker has nothing in flight')

  release({}); await pending; await settle()
  await page.choose('a'); await settle()
  assert.equal(page.$('worker-setting').disabled, false)
})

test('a refreshed state keeps what is being typed, chosen, opened and focused', async () => {
  const rows = [instanceOf({ id: 'a', name: 'A', paired: true }), instanceOf({ id: 'b', name: 'B', paired: true })]
  const page = await runPageScript(managerPage, { respond: async (path) => {
    if (path !== '/manager/instances/open') return { body: stateOf({ device: linkedDevice(), instances: rows }) }
    Object.assign(rows[0], { open: true, hostPort: 9001, roles: ['agent', 'worker'] })
    return { body: { ...stateOf({ device: linkedDevice(), instances: rows }), url: 'http://127.0.0.1:9001/?k=k', hostPort: 9001 } }
  } })
  await page.choose('a'); await settle()
  page.openDialog('dlg-attach')
  page.$('agent-select').value = 'agent-alpha'
  page.$('agent-select').onchange()
  page.$('replace').checked = true
  page.$('replace').onchange()
  page.$('device-name').value = 'Half typed name'
  page.$('device-name').focus()

  // Exactly what the three-second poll does when nothing has changed.
  page.render(stateOf({ device: linkedDevice(), instances: rows }))

  assert.equal(page.$('device-name').value, 'Half typed name', 'a poll must not take back what is being typed')
  assert.equal(page.$('replace').checked, true, 'nor a consent that was given')
  assert.equal(page.$('agent-select').value, 'agent-alpha', 'nor a choice that is still offered')
  assert.equal(page.$('dlg-attach').hidden, false, 'nor close an open dialog')
  assert.equal(page.document.activeElement.id, 'device-name', 'nor move focus')
  assert.equal(page.$('center-title').textContent, 'A', 'nor change which Agent is open')
  assert.equal(page.frames.size, 1)
})

test('a dialog can be closed with the keyboard, and gives focus back where it came from', async () => {
  const page = await openPage(stateOf({ device: linkedDevice(), instances: [instanceOf({ id: 'a', name: 'A' })] }))
  page.$('account-open').focus()
  page.$('account-open').onclick()
  assert.equal(page.$('dlg-account').hidden, false)
  assert.equal(page.document.activeElement.id, 'account-close', 'focus moves into the dialog')
  page.press('Escape')
  assert.equal(page.$('dlg-account').hidden, true)
  assert.equal(page.document.activeElement.id, 'account-open', 'focus comes back to what opened it')
})

test('removing an Agent drains its owned roles and says where its files stayed', async () => {
  const rows = [instanceOf({ id: 'a', name: 'A', paired: true, open: true, hostPort: 9001, roles: ['agent', 'worker'], worker: true })]
  const page = await runPageScript(managerPage, { respond: async (path) => (path === '/manager/instances/forget'
    ? { body: { ...stateOf({ instances: [] }), directory: 'D:/instances/one' } }
    : path === '/manager/instances/open'
      ? { body: { ...stateOf({ instances: rows }), url: 'http://127.0.0.1:9001/?k=k', hostPort: 9001 } }
      : { body: stateOf({ instances: rows }) }) })
  await page.choose('a'); await settle()
  page.openDialog('dlg-details')
  assert.equal(page.$('forget').disabled, false, 'the manager drains owned roles before removing the profile')

  rows[0].worker = false
  page.render(stateOf({ instances: rows }))
  assert.equal(page.$('forget').disabled, false)
  await page.$('forget').onclick(); await settle()
  assert.match(page.$('notice').textContent, /files remain at D:\/instances\/one/)
  assert.equal(page.$('dlg-details').hidden, true)
  assert.equal(page.frames.size, 0, 'the workspace of an Agent that is gone goes with it')
})

test('the private-draft review exposes premises, source quotes, examples and Case scope before saving once', async () => {
  const row = configuredOf('agent-alpha', { id: 'a', open: true, hostPort: 9001, roles: ['agent', 'worker'], worker: true })
  const snapshot = stateOf({ device: linkedDevice(), instances: [row] })
  let saves = 0
  const review = {
    resultId: 'art_checked', cases: [{ caseId: 'case-4', title: 'case-4' }],
    draft: {
      program: { id: 'qa.shipping_fee', title: 'Shipping fee', summary: 'For each order',
        vocabulary: { defines: [{ id: 'qa.shipping_fee.fee', as: 'fee', args: ['order', 'yuan'] }] }, pins: ['fee'],
        rules: [{ id: 'r1', label: 'At least 200', when: [{ predicate: 'gte', args: { left: '?amount', right: 200 } }], then: [{ predicate: 'fee', args: { yuan: 0 } }] }] },
      caseContracts: [{ caseType: 'shipping_fee', businessKey: { arguments: ['order'] } }],
      citations: [{ ruleId: 'r1', quote: 'amount <200> is free' }],
      examples: [{ label: 'Boundary', facts: [{ predicate: 'qa.shipping_fee.amount', args: { order: 'A', yuan: 200 } }], expect: [{ predicate: 'qa.shipping_fee.fee', args: { order: 'A', yuan: 0 } }], forbidPredicates: ['qa.shipping_fee.error'] }],
      questions: [], notes: 'One order at a time.' },
    report: { compiled: true, examples: { total: 1, passed: 1 }, citations: { total: 1, verified: 1 } },
  }
  const page = await runPageScript(managerPage, { respond: async path => {
    if (path === '/manager/authoring/review') return { body: review }
    if (path === '/manager/authoring/save') { saves += 1; return { body: { entry: {}, packId: 'qa.shipping_fee', caseId: 'case-4' } } }
    return { body: snapshot }
  } })
  await page.choose('a'); await settle()
  await page.$('authoring-open').onclick(); await settle()
  await page.$('authoring-review-open').onclick(); await settle()
  const shown = page.$('authoring-result').innerHTML
  for (const evidence of ['Vocabulary and Case boundary', 'businessKey', 'When', 'Then', 'right', '200', 'Boundary', 'Input facts', 'Expected conclusions', 'No conclusions of these kinds', 'One order at a time.'])
    assert.match(shown, new RegExp(evidence))
  assert.match(shown, /amount &lt;200&gt; is free/, 'source quotes are visible but escaped')
  page.$('authoring-result').innerHTML += '<details open>Reading this rule</details>'
  page.$('authoring-case').value = 'case-4' // mini DOM does not create select options from innerHTML.
  page.render(snapshot)
  assert.match(page.$('authoring-result').innerHTML, /details open/, 'background refresh must not collapse an open review item')
  assert.equal(page.$('authoring-save').disabled, false)
  await page.$('authoring-save').onclick(); await settle()
  assert.equal(saves, 1)
  assert.equal(page.$('authoring-save').disabled, true, 'saving the exact checked draft again is not offered')
  assert.equal(page.$('authoring-save').textContent, 'Private draft saved')
  assert.equal(page.$('authoring-case').value, 'case-4')
  assert.equal(page.$('authoring-case').disabled, true, 'the receipt pins the Case used for this private pack')
  assert.match(page.$('authoring-publication').href, /qa\.shipping_fee/)
})

test('document revisions stay selectable and a save retry rechecks the exact selected version', async () => {
  const row = configuredOf('agent-alpha', { id: 'a', open: true, hostPort: 9001, roles: ['agent', 'worker'], worker: true })
  const snapshot = stateOf({ device: linkedDevice(), instances: [row] })
  const first = 'res_' + '1'.repeat(32), second = 'res_' + '2'.repeat(32)
  const versions = [second, first].map((resultId, i) => ({ resultId,
    materialId: 'mat_' + String(i + 1).repeat(32), proposalDigest: 'sha256:' + String(i + 1).repeat(64),
    checkedAt: `2026-09-25T10:0${i}:00Z` }))
  const review = resultId => ({ resultId, availableResults: versions,
    draft: { program: { id: 'qa.revision', title: resultId === first ? 'First' : 'Second' }, questions: [] },
    report: { compiled: true, examples: { total: 1, passed: 1 }, citations: { total: 1, verified: 1 } },
    cases: [{ caseId: 'case-revision', title: 'Certified' }] })
  let refuseFirst = true
  const page = await runPageScript(managerPage, { respond: async (path, { body }) => {
    if (path === '/manager/authoring/review') return body.resultId === first && refuseFirst
      ? { status: 503, body: { teaching: 'Earlier result temporarily unreadable' } }
      : { body: review(body.resultId || second) }
    if (path === '/manager/authoring/save') return { status: 503, body: { teaching: 'Response lost' } }
    return { body: snapshot }
  } })
  await page.choose('a'); await settle()
  await page.$('authoring-open').onclick(); await settle()
  await page.$('authoring-review-open').onclick(); await settle()
  assert.equal(page.$('authoring-result-row').hidden, false)
  assert.equal(page.$('authoring-result-choice').value, second)
  page.$('authoring-result-choice').value = first
  await page.$('authoring-result-choice').onchange(); await settle()
  assert.equal(page.$('authoring-result-choice').value, second,
    'a failed switch cannot label the old draft with the new result identity')
  assert.match(page.$('authoring-result').innerHTML, /Second/)
  refuseFirst = false
  page.$('authoring-result-choice').value = first
  await page.$('authoring-result-choice').onchange(); await settle()
  assert.equal(page.$('authoring-result-choice').value, first)
  assert.match(page.$('authoring-result').innerHTML, /First/)
  page.$('authoring-case').value = 'case-revision'
  page.applyControls()
  assert.equal(page.$('authoring-save').disabled, false)
  await page.$('authoring-save').onclick(); await settle()
  const reads = page.calls.filter(c => c.path === '/manager/authoring/review')
  assert.deepEqual(reads.map(c => c.body.resultId ?? ''), ['', first, first, first],
    'the uncertain save must inspect its own immutable version, even when a newer check exists')
  assert.deepEqual(page.calls.find(c => c.path === '/manager/authoring/save').body,
    { instanceId: 'a', resultId: first, caseId: 'case-revision' })
  assert.equal(page.$('authoring-save').disabled, true)
  assert.equal(page.$('authoring-save').textContent, 'Check save outcome')
})

test('reopening a saved document check shows its durable receipt and never offers Save again', async () => {
  const row = configuredOf('agent-alpha', { id: 'a', open: true, hostPort: 9001, roles: ['agent', 'worker'], worker: true })
  const snapshot = stateOf({ device: linkedDevice(), instances: [row] })
  let saves = 0
  const review = { resultId: 'art_checked', cases: [], savedPackId: 'qa.shipping_fee', savedCaseId: 'case-4', savedEntryCurrent: true,
    draft: { program: { id: 'qa.shipping_fee', title: 'Shipping fee', rules: [] }, questions: [] },
    report: { compiled: true, examples: { total: 1, passed: 1 }, citations: { total: 1, verified: 1 } } }
  const page = await runPageScript(managerPage, { respond: async path => {
    if (path === '/manager/authoring/review') return { body: review }
    if (path === '/manager/authoring/save') { saves += 1; return { body: {} } }
    return { body: snapshot }
  } })
  await page.choose('a'); await settle()
  await page.$('authoring-open').onclick(); await settle()
  await page.$('authoring-review-open').onclick(); await settle()
  assert.equal(page.$('authoring-save').disabled, true)
  assert.equal(page.$('authoring-save').textContent, 'Private draft saved')
  assert.equal(page.$('authoring-case').value, 'case-4')
  assert.equal(page.$('authoring-case').disabled, true)
  assert.match(page.$('authoring-publication').href, /localAuthoringDraft=qa\.shipping_fee/)
  await page.$('authoring-save').onclick(); await settle()
  assert.equal(saves, 0)
  assert.match(page.$('authoring-notice').textContent, /already saved/)

  review.savedEntryCurrent = false
  await page.$('authoring-review-open').onclick(); await settle()
  assert.equal(page.$('authoring-save').disabled, true)
  assert.equal(page.$('authoring-save').textContent, 'Previously saved')
  assert.equal(page.$('authoring-publication').textContent, 'Inspect private drafts in Console')
  assert.doesNotMatch(page.$('authoring-publication').href, /publish=1/)
  assert.match(page.$('authoring-notice').textContent, /changed or been removed/)
})

test('an Agent without local tools shows no Worker setting or status', async () => {
  const row = configuredOf('agent-alpha', { id: 'a', model: { ready: true }, workerSetting: { enabled: false, visible: false, state: 'offline' } })
  const page = await openPage(stateOf({ device: linkedDevice(), instances: [row] }))
  await page.choose('a'); await settle()
  assert.equal(page.$('worker-setting-label').hidden, true)
  assert.equal(page.$('worker-pill').hidden, true)
  assert.equal(page.$('worker-note').hidden, true)
  assert.equal(page.$('agent-readiness').hidden, true)
  assert.doesNotMatch(managerPage, /id="(?:agent-toggle|worker-toggle|start-all|stop-all|model-save-start)"/)
})

test('the selected Agent asks for model setup then leaves startup to its first message', async () => {
  const row = configuredOf('agent-alpha', { id: 'a', model: { ready: false } })
  const snapshot = () => stateOf({ device: linkedDevice(), instances: [row] })
  const page = await openPage(snapshot())
  await page.choose('a'); await settle()
  assert.equal(page.$('agent-readiness-action').textContent, 'Set model')
  row.model.ready = true; page.render(snapshot())
  assert.equal(page.$('agent-readiness').hidden, true)
  row.agentReloading = true; page.render(snapshot())
  assert.match(page.$('agent-readiness-copy').textContent, /between turns/)
  assert.equal(page.$('agent-readiness-action').disabled, true)
  assert.equal(page.$('agent-runtime-link').href, ORIGIN + '/console/#/agents/agent-alpha?tab=runtime')
  row.agentReloading = false; row.pendingAgentId = 'agent-alpha'; row.blocked = 'not attached'; page.render(snapshot())
  assert.equal(page.$('agent-readiness-action').textContent, 'Continue setup')
  await page.$('agent-readiness-action').onclick()
  assert.equal(page.$('dlg-attach').hidden, false)
})

test('automatic Worker reload is explained while its executions drain', async () => {
  const row = configuredOf('agent-alpha', { id: 'a', agent: true, worker: true, model: { ready: true },
    workerSetting: { enabled: true, visible: true, state: 'offline', reloading: true } })
  const snapshot = () => stateOf({ device: linkedDevice(), instances: [row] })
  const page = await openPage(snapshot())
  await page.choose('a'); await settle()
  assert.equal(page.$('agent-readiness').hidden, true)
  assert.match(page.$('worker-note').textContent, /Reloading after running executions drain/)
  assert.equal(page.$('worker-pill').textContent, 'offline')
  row.workerSetting = { enabled: true, visible: true, state: 'online' }; page.render(snapshot())
  assert.equal(page.$('worker-pill').textContent, 'online')
  assert.doesNotMatch(page.$('worker-note').textContent, /Stop and start/)
})

test('sync errors and incomplete withdrawal stops have visible recovery without offering the old account link', async () => {
  const row = configuredOf('agent-alpha', { id: 'a', accessStopWarning: 'still running', agent: true, open: true })
  const snapshot = stateOf({ device: linkedDevice(), instances: [row], directorySync: { error: 'network offline', checkedAt: '', stale: true } })
  const page = await openPage(snapshot)
  assert.match(page.$('directory-sync').textContent, /network offline.*Retrying automatically/)
  assert.equal(page.$('access-stop-warning').hidden, false)
  await page.$('access-stop-open').onclick()
  assert.equal(page.$('dlg-account').hidden, false)
  assert.equal(page.$('local-settings').open, true)
  await page.choose('a'); await settle()
  snapshot.device = linkedDevice(); snapshot.device.account.id = 'different-account'; page.render(snapshot)
  assert.equal(page.$('agent-runtime-link').hidden, true)
  assert.equal(Boolean(page.$('agent-runtime-link').getAttribute('href')), false)
})

test('a late Worker-setting answer never writes into another Agent panel', async () => {
  const rows = ['a', 'b'].map(id => configuredOf('agent-' + id, { id, name: id.toUpperCase() }))
  const snapshot = () => stateOf({ device: linkedDevice(rows.map(r => ({ id: r.agentId, name: r.name }))), instances: rows })
  let release
  const page = await runPageScript(managerPage, { respond: async path => {
    if (path === '/manager/instances/worker-setting') await new Promise(done => { release = done })
    return { body: { ...snapshot(), teaching: 'A local tools enabled.' } }
  } })
  await page.choose('a'); await settle()
  page.$('worker-setting').checked = true
  const pending = page.$('worker-setting').onchange(); await settle()
  await page.choose('b'); await settle()
  release(); await pending; await settle()
  assert.equal(page.$('worker-notice').textContent, '')
  assert.equal(page.$('worker-setting').checked, false)
  assert.equal(page.calls.find(c => c.path === '/manager/instances/worker-setting').body.instanceId, 'a')
})

test('the Worker box shows what was asked for while the change is in flight, then what the manager reports', async () => {
  const rows = ['a', 'b'].map(id => configuredOf('agent-' + id, { id, name: id.toUpperCase() }))
  const snapshot = () => stateOf({ device: linkedDevice(rows.map(r => ({ id: r.agentId, name: r.name }))), instances: rows })
  let release, refusal = ''
  const page = await runPageScript(managerPage, { respond: async (path, request) => {
    if (path !== '/manager/instances/worker-setting') return { body: snapshot() }
    await new Promise(done => { release = done })
    if (refusal) return { status: 409, body: { ...snapshot(), ok: false, teaching: refusal } }
    const row = rows.find(r => r.id === request.body.instanceId)
    row.workerSetting = { enabled: request.body.enabled, visible: true, state: request.body.enabled ? 'online' : 'offline' }
    return { body: snapshot() }
  } })
  const box = () => page.$('worker-setting')
  await page.choose('a'); await settle()

  // Accepted. Starting the Worker can take seconds; a box that un-ticks itself while it works
  // reads as "that did nothing", so it keeps the request and only the control is disabled.
  box().checked = true
  const accepted = box().onchange(); await settle()
  assert.equal(box().disabled, true)
  assert.equal(box().checked, true, 'the box must not go back to the old state before the manager has answered')
  // The request belongs to the Agent that made it: another Agent shows its own state.
  await page.choose('b'); await settle()
  assert.equal(box().checked, false)
  await page.choose('a'); await settle()
  assert.equal(box().checked, true)
  release(); await accepted; await settle()
  assert.equal(box().checked, true)
  assert.equal(box().disabled, false)
  assert.equal(page.$('worker-pill').textContent, 'online')

  // Refused. What was asked for is shown while it is in flight; the answer undoes it.
  refusal = 'Reconnect this Agent before starting it.'
  box().checked = false
  const refused = box().onchange(); await settle()
  assert.equal(box().checked, false)
  release(); await refused; await settle()
  assert.equal(box().checked, true, 'a refused change leaves the box at what the manager reports')
  assert.match(page.$('worker-notice').textContent, /Reconnect this Agent/)
})

test('document tools link to ordinary Console configuration without a second preparation call', async () => {
  const row = configuredOf('agent-alpha', { id: 'a', open: true, hostPort: 9001, roles: ['agent', 'worker'] })
  const snapshot = stateOf({ device: linkedDevice(), instances: [row] })
  const calls = []
  const page = await runPageScript(managerPage, { respond: async path => { calls.push(path); return { body: snapshot } } })
  await page.choose('a'); await settle()
  await page.$('authoring-open').onclick(); await settle()
  assert.equal(page.$('authoring-install-checker').disabled, false)
  assert.match(page.$('authoring-configure').href, /agents\/agent-alpha.*tab=runtime/)
  assert.equal(calls.some(path => /authoring\/(status|prepare)/.test(path)), false)
})

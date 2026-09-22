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
  blocked: '', orphaned: null, legacyImport: null,
  hostPort: 0, servePort: 0, signedOutAt: '', createdAt: '', importedFrom: '', ...overrides,
})
const stateOf = (overrides = {}) => ({ ok: true, root: 'D:/manager', device: deviceOf(), instances: [], legacyInstall: null, ...overrides })
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

test('every element the script reaches for is declared in the markup it ships with', () => {
  const declared = new Set(declaredIds(managerPage))
  const missing = [...new Set(referencedIds(managerPage))].filter((id) => !declared.has(id))
  assert.deepEqual(missing, [], 'a handler is attached to nothing when its element id does not exist')
  assert.ok(declared.size > 15, 'the page must still be the workbench, not an empty shell')
})

test('every route the page calls is a route the manager server answers', () => {
  const paths = [...new Set([...managerPage.matchAll(/'(\/manager\/[a-z/]+)'/g)].map((match) => match[1]))]
  assert.ok(paths.length >= 12, 'the page must still drive the whole manager')
  for (const path of paths) {
    assert.ok(SERVER_SOURCE.includes(`'${path}'`), `the page calls ${path}, which the manager server does not answer`)
  }
  // Every operation an operator can only reach from this page is still reachable.
  for (const required of ['/manager/device/signout', '/manager/device/forget', '/manager/instances/pair',
    '/manager/instances/pair/cancel', '/manager/instances/control', '/manager/instances/import',
    '/manager/instances/model/copy', '/manager/instances/forget', '/manager/instances/open',
    '/manager/instances/stop']) {
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
  for (const id of ['worker-pill', 'worker-toggle', 'tools-open', 'agent-toggle', 'details-open'])
    assert.ok(managerPage.includes('id="' + id + '"'), 'the per-Agent control ' + id + ' must still exist')
  const rail = managerPage.slice(managerPage.indexOf('<aside class="rail"'), managerPage.indexOf('<main class="center"'))
  for (const id of ['railsel', 'agent-toggle', 'details-open', 'worker-toggle', 'tools-open', 'account-open'])
    assert.ok(rail.includes('id="' + id + '"'), id + ' belongs in the Agent rail, beside the Agent it acts on')
  assert.equal((managerPage.match(/role="dialog" aria-modal="true"/g) ?? []).length, 8,
    'account, add, connect, Connection key, model, settings, document assistant and the settings page are dialogs, not a homepage')
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
  assert.ok(markup.includes('data-agent="agent-gamma"') && markup.includes('Not set up on this computer'))
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
  const page = await openPage(stateOf({ device, legacyInstall: { configFile: 'D:/old/local.json' } }))
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
  assert.equal(page.$('device-tag').textContent, 'This computer: Work laptop')
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

test('a role is started and stopped by itself, for the Agent chosen when the button was pressed', async () => {
  const rows = [
    instanceOf({ id: 'a', name: 'A', paired: true, open: true, hostPort: 9001, roles: ['agent', 'worker'] }),
    instanceOf({ id: 'b', name: 'B', paired: true, open: true, hostPort: 9002, roles: ['agent', 'worker'] }),
  ]
  const page = await runPageScript(managerPage, { respond: async (path, request) => {
    if (path === '/manager/instances/open') return { body: { ...stateOf({ instances: rows }), url: 'http://127.0.0.1:9001/?k=k', hostPort: 9001 } }
    if (path === '/manager/instances/control') {
      const row = rows.find((entry) => entry.id === request.body.instanceId)
      row[request.body.role] = request.body.operation === 'start'
      return { body: { ...stateOf({ instances: rows }), control: { state: 'ready' } } }
    }
    return { body: stateOf({ instances: rows }) }
  } })
  await page.choose('a'); await settle()
  await page.$('worker-toggle').onclick(); await settle()
  const control = page.calls.filter((call) => call.path === '/manager/instances/control')
  assert.deepEqual(control[0].body, { instanceId: 'a', role: 'worker', operation: 'start' })
  assert.equal(page.$('worker-pill').textContent, 'Running')
  assert.equal(page.$('worker-toggle').textContent, 'Stop Worker')
  assert.equal(page.$('agent-toggle').textContent, 'Start Agent', 'controlling one role must not touch the other')

  await page.$('agent-toggle').onclick(); await settle()
  assert.deepEqual(page.calls.filter((call) => call.path === '/manager/instances/control')[1].body,
    { instanceId: 'a', role: 'agent', operation: 'start' })
  assert.equal(page.$('notice').textContent, '', 'a role that started needs no commentary')
})

test('a role that did not stop is not reported as stopped', async () => {
  const rows = [instanceOf({ id: 'a', name: 'A', paired: true, open: true, hostPort: 9001, roles: ['agent', 'worker'], worker: true })]
  const page = await runPageScript(managerPage, { respond: async (path) => (path === '/manager/instances/control'
    // The request succeeded; the process did not exit, and the state says so.
    ? { body: { ...stateOf({ instances: rows }), control: { state: 'stopping', teaching: 'It was sent the stop signal.' } } }
    : path === '/manager/instances/open'
      ? { body: { ...stateOf({ instances: rows }), url: 'http://127.0.0.1:9001/?k=k', hostPort: 9001 } }
      : { body: stateOf({ instances: rows }) }) })
  await page.choose('a'); await settle()
  await page.$('worker-toggle').onclick(); await settle()
  // In the Worker's own panel: on a phone the centre's notice is behind that panel's scrim.
  assert.match(page.$('worker-notice').textContent, /asked to stop and has not exited yet/)
  assert.match(page.$('worker-notice').textContent, /sent the stop signal/, 'the host\'s own teaching is carried, not replaced')
  assert.equal(page.$('notice').textContent, '', 'the Worker does not write into the centre')
  assert.equal(page.$('worker-pill').textContent, 'Running', 'the pill follows the process, not the request')
})

test('a role this computer does not run is described, not offered', async () => {
  const page = await openPage(stateOf({ device: linkedDevice(), instances: [
    instanceOf({ id: 'a', name: 'Desk', mode: 'existing_client', paired: true, connectionId: 'conn-1' }),
  ] }))
  await page.choose('a')
  assert.equal(page.$('agent-toggle').hidden, true, 'an Agent that runs elsewhere has no Start here')
  assert.equal(page.$('agent-pill').textContent, 'Worker only')
  assert.equal(page.$('worker-toggle').hidden, false, 'the Worker is what this computer does run')
  assert.match(page.$('center-sub').textContent, /runs elsewhere|does the work/)
})

test('a blocked Agent says why, and its controls stay unavailable', async () => {
  const page = await openPage(stateOf({ device: linkedDevice(), instances: [
    instanceOf({ id: 'a', name: 'Blocked', paired: true, agentId: 'agent-alpha',
      blocked: 'Agent Alpha is no longer part of what this device is authorized for.' }),
  ] }))
  await page.choose('a')
  assert.equal(page.$('agent-toggle').disabled, true)
  assert.equal(page.$('worker-toggle').disabled, true)
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
  assert.equal(page.$('agent-toggle').disabled, true, 'starting beside a process nobody owns is how two Agents share one identity')
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

  // Another Agent on this computer is another credential; the tick does not come with it.
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
      pendingError: { code: 'runtime_credential_exists', teaching: 'Agent already has an active credential' } })
    let device = linkedDevice()
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

test('model settings can be taken from another Agent, never from itself, and never while one runs', async () => {
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

  // Either role running is enough: the file is read by both.
  page.render(stateOf({ device: linkedDevice(), instances: rows.map((row) => (row.id === 'a' ? { ...row, open: true, roles: ['agent', 'worker'], worker: true } : row)) }))
  assert.equal(page.$('model-copy').disabled, true)

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
  assert.equal(page.$('page-title').textContent, 'Worker tools')
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
    if (path === '/manager/instances/control') { await new Promise((done) => { release = done }) }
    return { body: { ...stateOf({ instances: rows }), url: 'http://127.0.0.1:9001/?k=k', hostPort: 9001 } }
  } })
  await page.choose('a'); await settle()
  const first = page.$('worker-toggle').onclick(); await settle()
  page.$('worker-toggle').onclick()
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
  assert.equal(page.$('worker-toggle').disabled, true, 'a write decided from a remembered picture is the one mistake this page can make')
  assert.equal(page.$('agent-toggle').disabled, true)
  assert.equal(page.$('setup-start').disabled, true, 'setting an Agent up allocates a profile and mints a credential')
  assert.equal(page.$('setup-mode').disabled, true)

  answering = true
  await page.api('/manager/state'); await settle()
  assert.equal(page.$('connection').hidden, true, 'a manager that came back is not still reported as gone')
  assert.equal(page.$('worker-toggle').disabled, false)
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
  assert.match(page.$('attach-blocked').textContent, /no longer on this computer/)
  page.openDialog('dlg-details')
  assert.equal(page.$('detail-attention').hidden, false)
  assert.match(page.$('detail-attention').textContent, /no longer on this computer/)
})

test('an older installation is offered only when one is there, and the import says what it leaves behind', async () => {
  const absent = await openPage(stateOf())
  assert.equal(absent.$('import-block').hidden, true)
  const present = await openPage(stateOf({ legacyInstall: { configFile: 'D:/home/.rulith/local.json', imported: false } }))
  assert.equal(present.$('import-block').hidden, false)
  assert.ok(present.$('import-path').innerHTML.includes('D:/home/.rulith/local.json'))
  assert.match(managerPage, /copied into a profile of its own/)
  assert.match(managerPage, /stay with the original installation/, 'an import that leaves credentials behind has to say so')
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
    if (path === '/manager/instances/control') { await new Promise((done) => { release = done }); return { body: stateOf({ instances: rows }) } }
    if (path === '/manager/instances/open') {
      const id = request.body.instanceId
      return { body: { ...stateOf({ instances: rows }), url: `http://127.0.0.1:900${id === 'a' ? 1 : 2}/?k=k`, hostPort: id === 'a' ? 9001 : 9002 } }
    }
    return { body: stateOf({ instances: rows }) }
  } })
  await page.choose('a'); await settle()
  const pending = page.$('worker-toggle').onclick()
  await settle()
  assert.equal(page.$('worker-toggle').disabled, true, 'the control that is working says so')

  await page.choose('b'); await settle()
  assert.equal(page.$('center-title').textContent, 'B', 'a slow action elsewhere must not hold the workbench still')
  assert.equal(page.$('worker-toggle').disabled, false, 'B\'s Worker has nothing in flight')
  assert.equal(page.$('agent-toggle').disabled, false)

  release({}); await pending; await settle()
  await page.choose('a'); await settle()
  assert.equal(page.$('worker-toggle').disabled, false)
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

test('removing an Agent says where its files stayed, and is refused while it runs', async () => {
  const rows = [instanceOf({ id: 'a', name: 'A', paired: true, open: true, hostPort: 9001, roles: ['agent', 'worker'], worker: true })]
  const page = await runPageScript(managerPage, { respond: async (path) => (path === '/manager/instances/forget'
    ? { body: { ...stateOf({ instances: [] }), directory: 'D:/instances/one' } }
    : path === '/manager/instances/open'
      ? { body: { ...stateOf({ instances: rows }), url: 'http://127.0.0.1:9001/?k=k', hostPort: 9001 } }
      : { body: stateOf({ instances: rows }) }) })
  await page.choose('a'); await settle()
  page.openDialog('dlg-details')
  assert.equal(page.$('forget').disabled, true, 'removing an Agent while it works would leave a process nobody lists')

  rows[0].worker = false
  page.render(stateOf({ instances: rows }))
  assert.equal(page.$('forget').disabled, false)
  await page.$('forget').onclick(); await settle()
  assert.match(page.$('notice').textContent, /files remain at D:\/instances\/one/)
  assert.equal(page.$('dlg-details').hidden, true)
  assert.equal(page.frames.size, 0, 'the workspace of an Agent that is gone goes with it')
})

test('authoring reloads saved permissions and does not carry an unsaved choice into another opening', async () => {
  const row = configuredOf('agent-alpha', { id: 'a', open: true, hostPort: 9001, roles: ['agent', 'worker'], worker: true })
  const snapshot = stateOf({ device: linkedDevice(), instances: [row] })
  let unavailable = false, release
  const page = await runPageScript(managerPage, { respond: async path => {
    if (path === '/manager/authoring/status') {
      if (unavailable) return { status: 503, body: { ok: false, teaching: 'Permission read unavailable' } }
      if (release === false) await new Promise(done => { release = done })
      return { body: { ok: true, bindingMatches: true, configured: true, materialPermissions: { localRead: false, offMachine: true } } }
    }
    return { body: snapshot }
  } })
  await page.choose('a'); await settle()
  release = false
  const opening = page.$('authoring-open').onclick(); await settle()
  assert.equal(page.$('authoring-prepare').disabled, true, 'unknown permissions cannot be submitted')
  release(); await opening
  assert.equal(page.$('authoring-local-read').checked, false)
  assert.equal(page.$('authoring-off-machine').checked, true)
  assert.equal(page.$('authoring-prepare').disabled, false)
  page.$('authoring-off-machine').checked = false
  await page.$('authoring-open').onclick()
  assert.equal(page.$('authoring-off-machine').checked, true, 'unsaved UI choices are not the stored grant')
  unavailable = true
  await page.$('authoring-open').onclick()
  assert.equal(page.$('authoring-prepare').disabled, true, 'read failure must not overwrite a saved grant with defaults')
  assert.match(page.$('authoring-notice').textContent, /Permission read unavailable/)
})

test('a late readiness receipt clears only the matching unconfirmed-start notice', async () => {
  const row = configuredOf('agent-alpha', { id: 'a', open: true, hostPort: 9001, roles: ['agent', 'worker'], ready: { agent: false, worker: false } })
  const snapshot = () => stateOf({ device: linkedDevice(), instances: [row] })
  const page = await runPageScript(managerPage, { respond: async path => {
    if (path === '/manager/instances/control') {
      row.agent = true
      return { body: { ...snapshot(), ok: false, state: 'unconfirmed', teaching: 'Agent initialization is not yet confirmed.' } }
    }
    return { body: snapshot() }
  } })
  await page.choose('a'); await settle()
  await page.$('agent-toggle').onclick(); await settle()
  assert.match(page.$('worker-notice').textContent, /not yet confirmed/)
  page.render(snapshot())
  assert.match(page.$('worker-notice').textContent, /not yet confirmed/, 'process liveness is not readiness')
  row.ready.agent = true
  page.render(snapshot())
  assert.equal(page.$('worker-notice').textContent, '')
})

test('identical slow-start messages remain scoped to their Agent across switching and late readiness', async () => {
  const rows = ['a','b'].map(id => configuredOf('agent-'+id, { id, name:id.toUpperCase(), agentName:id.toUpperCase(), open:true, hostPort:9001, roles:['agent','worker'], ready:{agent:false,worker:false} }))
  const snapshot = () => stateOf({device:linkedDevice(rows.map(r=>({id:r.agentId,name:r.name}))),instances:rows})
  const page = await runPageScript(managerPage,{respond:async (path,request)=>{
    if(path==='/manager/instances/control'){
      rows.find(r=>r.id===request.body.instanceId).agent=true
      return {body:{...snapshot(),ok:false,state:'unconfirmed',teaching:'Same slow start message'}}
    }
    return {body:snapshot()}
  }})
  await page.choose('a'); await settle(); await page.$('agent-toggle').onclick(); await settle()
  assert.match(page.$('worker-notice').textContent,/A · agent/)
  await page.choose('b'); await settle()
  assert.equal(page.$('worker-notice').textContent,'','A warning does not describe B')
  await page.$('agent-toggle').onclick(); await settle()
  assert.match(page.$('worker-notice').textContent,/B · agent/)
  rows[0].ready.agent=true; page.render(snapshot())
  assert.match(page.$('worker-notice').textContent,/B · agent/,'A becoming ready does not silence B')
  rows[1].ready.agent=true; page.render(snapshot())
  assert.equal(page.$('worker-notice').textContent,'')
})

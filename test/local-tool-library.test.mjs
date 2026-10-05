// SPDX-License-Identifier: Apache-2.0
/**
 * This environment's tools: one library under the manager, composed into every Agent's Worker.
 *
 * Each arm drives the real manager: real registry writes, real hosts, real child processes (the
 * reporting stand-in of `support/echo-role.mjs`, which reads the two files it was given the way a
 * Worker does and says what they held), and a real MCP server where a service is saved. What an
 * arm asserts is what the Worker received, not what the manager meant to give it.
 *
 * The model under test: tools and MCP services are shared by every Agent; an MCP service's own
 * credentials belong to it and go wherever it goes; the environment's keys go nowhere — a Worker is
 * told where the vault is and reads an entry only for a Source the authority bound to it (that rule
 * is the Worker's, and `worker-environment-vault.test.mjs` tests it there). Moving an Agent's own
 * tools into the library is `local-tool-library-migration.test.mjs`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { loadInstanceConfig, saveInstanceConfig } from '../local/instance-manager.mjs'
import { LIBRARY_FORMAT, createToolLibrary } from '../local/tool-library.mjs'
import { holdFiles } from './support/fs-faults.mjs'
import { controlFixtureInstance } from './support/local-role-controls.mjs'
import {
  KEY, addInstance, composedOf, http, installServer, lookup, readJson, saveService, saveTool, script, startWorker, starts,
  waitUntil, withManager, writeOwn,
} from './support/tool-library-fixture.mjs'

test('the library lives under the manager and nowhere in an instance, and starts on the marker it was given', async (t) => {
  await withManager(t, async ({ manager, root, library }) => {
    const instance = await addInstance(manager, 'Layout', { agentId: 'agent-alpha' })
    assert.equal(manager.registry.instance(instance.id).tools.source, 'library', 'a new Agent starts on the environment\'s tools')
    assert.equal(existsSync(join(root, 'library')), false, 'nothing is created until something is added')
    await saveTool(library, 'acme.orders.lookup@1', http)
    await saveService(library, 'mail', { env: { MAIL_FIXTURE_SECRET: 'service-secret' } })

    assert.deepEqual(readJson(join(root, 'library', 'library.json')), { format: LIBRARY_FORMAT })
    assert.deepEqual(Object.keys(readJson(join(root, 'library', 'worker-tools.json')).tools), ['acme.orders.lookup@1'])
    const saved = readJson(join(root, 'library', 'mcp', 'services.json')).services
    assert.equal(saved.mail.source.env.MAIL_FIXTURE_SECRET, 'service-secret', 'a service keeps its own credential beside it')
    // The Agent's own folder has none of it, and the page never receives the service's credential.
    assert.equal(existsSync(join(instance.directory, 'mcp')), false)
    assert.equal(existsSync(join(instance.directory, 'worker-tools.json')), false, 'a tool saved in the environment was written into an Agent\'s own file')
    assert.doesNotMatch(JSON.stringify(library.state()), /service-secret/)
    assert.equal(library.state().libraryRoot, join(root, 'library'))
  })
})

test('every Agent\'s Worker is composed from its own tools and all of the environment\'s, and nothing leaks a key', async (t) => {
  await withManager(t, async ({ manager, root, library }) => {
    const markers = 'KEY-SECRET-ORDERS,service-secret'
    const alpha = await addInstance(manager, 'Alpha', { agentId: 'agent-alpha', markers })
    const beta = await addInstance(manager, 'Beta', { agentId: 'agent-beta', markers })
    // Each Agent's own files: a script (which stays with it) and a non-secret location.
    writeOwn(alpha.directory, { tools: { 'acme.alpha.script@1': script }, vault: { reports: { type: 'file', access: join(alpha.directory, 'reports') } } })
    writeOwn(beta.directory, { tools: { 'acme.beta.script@1': script }, vault: {} })
    await saveTool(library, 'acme.orders.lookup@1', http)
    await saveService(library, 'mail', { env: { MAIL_FIXTURE_SECRET: 'service-secret' } })
    // A key of the environment's: written by hand, as the page tells a person to.
    mkdirSync(join(root, 'library'), { recursive: true })
    writeFileSync(join(root, 'library', 'worker-secrets.json'), JSON.stringify({ orders: { type: 'db', dsn: 'postgres://app:KEY-SECRET-ORDERS@db/orders' } }))

    await startWorker(manager, alpha.id)
    await startWorker(manager, beta.id)
    const [first, second] = [composedOf(manager, alpha.id), composedOf(manager, beta.id)]
    const libraryTools = ['acme.orders.lookup@1', ...Object.keys(readJson(join(root, 'library', 'mcp', 'services.json')).services.mail.tools)]
    assert.deepEqual(first.tools, [...libraryTools, 'acme.alpha.script@1'].sort(), 'its own script, and every tool the environment has')
    assert.deepEqual(second.tools, [...libraryTools, 'acme.beta.script@1'].sort())
    assert.deepEqual(first.vault, ['mail', 'reports'], 'its own location and the service\'s Source; the key is not here')
    assert.deepEqual(second.vault, ['mail'])
    // A service's credential belongs to it and goes with it to every Agent; a key goes to nobody.
    assert.equal(first.sources.mail.env.MAIL_FIXTURE_SECRET, 'service-secret')
    assert.equal(second.sources.mail.env.MAIL_FIXTURE_SECRET, 'service-secret')
    for (const composed of [first, second]) {
      assert.deepEqual(composed.markersInFiles.filter((marker) => marker.startsWith('KEY')), [], 'the key reached a composed file')
      assert.deepEqual(composed.markersInEnvironment, [], 'a secret reached the Worker\'s environment')
    }
    // The only library path a Worker is given is where the keys are, and that is not a file it was composed into.
    for (const [instance, composed] of [[alpha, first], [beta, second]]) {
      assert.equal(composed.files.environmentVault, join(root, 'library', 'worker-secrets.json'))
      assert.equal(composed.files.tools, join(instance.directory, 'environment', 'worker-tools.json'))
      assert.equal(composed.files.vault, join(instance.directory, 'environment', 'worker-secrets.json'))
      const given = Object.entries(starts(manager, instance.id)[0].observed).filter(([, value]) => String(value).includes(join(root, 'library')))
      assert.deepEqual(given.map(([name]) => name), ['RULITH_ENVIRONMENT_SECRETS_FILE'])
    }
    // Everything else about an Agent stays its own.
    assert.equal(starts(manager, alpha.id).at(-1).observed.RULITH_WORKER_ROOT, join(alpha.directory, 'workspace'))
    assert.equal(starts(manager, beta.id).at(-1).observed.RULITH_WORKER_ROOT, join(beta.directory, 'workspace'))
    assert.deepEqual(readJson(join(alpha.directory, 'worker-tools.json')).tools, { 'acme.alpha.script@1': script }, 'composition never edits an Agent\'s own file')
  })
})

test('the file a Worker is composed into goes away with the Worker, and no setting can name the keys\' file for it', async (t) => {
  await withManager(t, async ({ manager, root, library }) => {
    const instance = await addInstance(manager, 'Tidy', { agentId: 'agent-alpha' })
    const config = loadInstanceConfig(instance.directory)
    // A value in an Agent's own configuration is not how a Worker learns where the keys are.
    config.worker.env.RULITH_ENVIRONMENT_SECRETS_FILE = join(tmpdir(), 'somewhere-else.json')
    saveInstanceConfig(instance.directory, config)
    await saveService(library, 'mail', { env: { MAIL_FIXTURE_SECRET: 'service-secret' } })
    await startWorker(manager, instance.id)
    assert.equal(composedOf(manager, instance.id).files.environmentVault, join(root, 'library', 'worker-secrets.json'))
    const composedVault = join(instance.directory, 'environment', 'worker-secrets.json')
    assert.equal(existsSync(composedVault), true)
    await manager.instances.stop(instance.id)
    assert.equal(existsSync(composedVault), false, 'a composed vault holds a service\'s credential and has no use once its Worker has gone')
    assert.equal(existsSync(join(instance.directory, 'environment', 'worker-tools.json')), false)

    // An Agent on its own files is told nothing about an environment, whatever its configuration says.
    await manager.registry.update((state) => { delete state.instances.find((row) => row.id === instance.id).tools; return state })
    await startWorker(manager, instance.id)
    const own = composedOf(manager, instance.id)
    assert.equal(own.files.environmentVault, '', 'no setting can name the environment\'s vault')
    assert.equal(own.files.vault, join(instance.directory, 'worker-secrets.json'), 'an Agent on its own files runs on them')
    assert.deepEqual(own.tools, [])
  })
})

test('a library change reloads exactly the Workers whose tools changed, and one that cannot compose keeps running and is told why', async (t) => {
  await withManager(t, async ({ manager, library }) => {
    const alpha = await addInstance(manager, 'Alpha', { agentId: 'agent-alpha' })
    const beta = await addInstance(manager, 'Beta', { agentId: 'agent-beta' })
    // Beta already has this very tool of its own, so the environment gaining it changes nothing it runs.
    writeOwn(beta.directory, { tools: { 'acme.orders.lookup@1': http } })
    await startWorker(manager, alpha.id)
    await startWorker(manager, beta.id)
    assert.deepEqual([starts(manager, alpha.id).length, starts(manager, beta.id).length], [1, 1])

    await saveTool(library, 'acme.orders.lookup@1', http)
    await waitUntil(() => starts(manager, alpha.id).length === 2, 'Alpha to reload')
    assert.deepEqual(composedOf(manager, alpha.id).tools, ['acme.orders.lookup@1'])
    await new Promise((done) => setTimeout(done, 400))
    assert.equal(starts(manager, beta.id).length, 1, 'a Worker whose tools did not change was reloaded')

    // Beta's own tool of that name is then changed to something else: the next library change cannot
    // compose for it. Its Worker keeps running with what it started with, and its Agent is told why.
    writeOwn(beta.directory, { tools: { 'acme.orders.lookup@1': lookup('/v2') } })
    await saveTool(library, 'acme.orders.status@1', lookup('/status'))
    await waitUntil(() => manager.registry.instance(beta.id).tools.notice?.kind === 'failed', 'Beta\'s notice')
    assert.match(manager.registry.instance(beta.id).tools.notice.text, /This environment's tools cannot be loaded for Beta/)
    assert.match(manager.registry.instance(beta.id).tools.notice.text, /acme\.orders\.lookup@1 differs/)
    assert.equal(starts(manager, beta.id).length, 1, 'a failing composition replaced a running Worker')
    assert.equal(manager.instances.hosts.get(beta.id).host.status().worker, true)
    assert.equal(manager.instances.overview().find((row) => row.id === beta.id).tools.notice.kind, 'failed')
    await waitUntil(() => starts(manager, alpha.id).length === 3, 'Alpha to reload again')

    // The Agent fixes its side and the next change clears the notice and brings its Worker up to date.
    writeOwn(beta.directory, { tools: {} })
    await saveTool(library, 'acme.orders.other@1', lookup('/other'))
    await waitUntil(() => manager.registry.instance(beta.id).tools.notice === undefined, 'the notice to clear')
    await waitUntil(() => starts(manager, beta.id).length === 2, 'Beta to reload')
    assert.deepEqual(composedOf(manager, beta.id).tools, ['acme.orders.lookup@1', 'acme.orders.other@1', 'acme.orders.status@1'])
  })
})

test('a changed tool is refused against a stale page, and a script tool cannot be saved in the environment', async (t) => {
  await withManager(t, async ({ manager, root, library }) => {
    await saveTool(library, 'acme.orders.lookup@1', http)
    const shown = library.state().revision
    await saveTool(library, 'acme.orders.status@1', lookup('/status'))
    const before = readFileSync(join(root, 'library', 'worker-tools.json'), 'utf8')
    await assert.rejects(library.save({ id: 'acme.orders.late@1', definition: http, revision: shown, confirmed: true }), /changed/)
    await assert.rejects(library.remove({ id: 'acme.orders.lookup@1', revision: shown, confirmed: true }), /changed/)
    // A script resolves under one Agent's own folder, so sharing its definition would not share its code.
    await assert.rejects(saveTool(library, 'acme.script@1', script), /stays with that Agent/)
    assert.equal(readFileSync(join(root, 'library', 'worker-tools.json'), 'utf8'), before, 'a refused save changed the manifest')
    // A key added by hand after a page loaded makes that page stale too.
    const withKeys = library.state()
    writeFileSync(join(root, 'library', 'worker-secrets.json'), JSON.stringify({ billing: { type: 'http', token: 'never-listed' } }))
    assert.deepEqual(library.state().keys, [{ name: 'billing', type: 'http' }], 'keys are listed by name and type')
    assert.doesNotMatch(JSON.stringify(library.state()), /never-listed/)
    await assert.rejects(library.remove({ id: 'acme.orders.status@1', revision: withKeys.revision, confirmed: true }), /changed/)
    // A removal says who loses the tool.
    await manager.instances.create({ name: 'Somebody' })
    const removed = await library.remove({ id: 'acme.orders.status@1', revision: library.state().revision, confirmed: true })
    assert.deepEqual(removed.affected, ['Somebody'])
  })
})

test('a file in the environment that cannot be read is named and never repaired or overwritten', async (t) => {
  await withManager(t, async ({ manager, root, library }) => {
    const instance = await addInstance(manager, 'Unreadable', { agentId: 'agent-alpha' })
    await saveTool(library, 'acme.orders.lookup@1', http)
    const file = join(root, 'library', 'worker-tools.json'), damaged = '{"tools": {"leaked-text-from-a-secret'
    writeFileSync(file, damaged)
    assert.throws(() => library.state(), (error) => error.message.includes(file) && /not valid JSON/.test(error.message) && !/leaked-text/.test(error.message),
      'the refusal names the file and does not quote it')
    await assert.rejects(async () => saveTool(library, 'acme.orders.status@1', lookup('/status')), /not valid JSON/)
    const refused = await controlFixtureInstance(manager.instances, instance.id, { role: 'worker', operation: 'start' }).catch((error) => error)
    assert.match(String(refused.message ?? refused.results?.[0]?.teaching ?? ''), /cannot be loaded for/)
    assert.equal(readFileSync(file, 'utf8'), damaged, 'a file that could not be read was changed')
    assert.equal(manager.instances.hosts.get(instance.id).host.status().worker, false)
  })
})

test('an instance cannot name the environment\'s vault as its own, whatever else may reach it', async (t) => {
  await withManager(t, async ({ manager, root, library }) => {
    const instance = await addInstance(manager, 'Nosy', { agentId: 'agent-alpha' })
    await saveService(library, 'mail')
    const config = loadInstanceConfig(instance.directory)
    config.worker.env.RULITH_SECRETS_FILE = join(root, 'library', 'worker-secrets.json')
    saveInstanceConfig(instance.directory, config)
    const refused = await controlFixtureInstance(manager.instances, instance.id, { role: 'worker', operation: 'start' }).catch((error) => error)
    assert.match(refused.message, /RULITH_SECRETS_FILE is set to .*library.*overlaps the manager directory/s)
    // The one path into the manager directory a Worker is given is the one composition names, and it starts.
    config.worker.env.RULITH_SECRETS_FILE = join(instance.directory, 'worker-secrets.json')
    saveInstanceConfig(instance.directory, config)
    await manager.instances.closeHost(instance.id)
    await startWorker(manager, instance.id)
    assert.equal(composedOf(manager, instance.id).files.environmentVault, join(root, 'library', 'worker-secrets.json'))
  })
})

test('an installed server\'s entry script is accepted in the library, and the manager tree around it is not', async (t) => {
  await withManager(t, async ({ manager, root, library }) => {
    const instance = await addInstance(manager, 'Probing', { agentId: 'agent-alpha' })
    const entry = installServer(join(root, 'library', 'mcp'))
    // The fixture server only discovers tools; it never reads this existing external directory.
    const project = dirname(process.execPath)
    assert.equal((await library.probe({ name: 'files', mode: 'filesystem', isNew: true, directory: project })).tools.length, 2)

    const stdio = (extra) => library.probe({ name: 'elsewhere', mode: 'stdio', isNew: true, command: process.execPath, args: [entry], env: {}, ...extra })
    for (const directory of [root, join(root, 'library'), join(root, 'library', 'mcp'), instance.directory]) {
      await assert.rejects(library.probe({ name: 'nosy', mode: 'filesystem', isNew: true, directory }), /must not overlap/, directory)
      await assert.rejects(stdio({ cwd: directory }), /working directory/, directory)
      await assert.rejects(stdio({ args: [entry, directory] }), /allowed directory/, directory)
    }
    await assert.rejects(stdio({ args: [entry, join(root, 'device.json')] }), /file argument|device\.json/)
    // The scratch folder Local keeps for a server is the one place in the tree it may work in, and each Agent
    // that receives the service is given a folder of its own in place of it.
    const scratch = join(root, 'library', 'mcp', 'workspaces', 'mail')
    mkdirSync(scratch, { recursive: true })
    // The two places a server may be pointed at are the folders inside `workspaces` and `packages`; the two folders
    // themselves are not: as a working directory or an argument they would give a server every other service's
    // scratch, or all the code Local installed.
    for (const directory of [join(root, 'library', 'mcp', 'workspaces'), join(root, 'library', 'mcp', 'packages')]) {
      await assert.rejects(stdio({ cwd: directory }), /working directory/, directory)
      await assert.rejects(stdio({ args: [entry, directory] }), /allowed directory/, directory)
    }
    await saveService(library, 'mail', { cwd: scratch })
    const second = await addInstance(manager, 'Second', { agentId: 'agent-beta' })
    await startWorker(manager, instance.id)
    await startWorker(manager, second.id)
    for (const agent of [instance, second]) {
      const cwd = composedOf(manager, agent.id).sources.mail.cwd
      assert.equal(cwd, join(agent.directory, 'environment', 'work', 'mail'))
      assert.equal(existsSync(cwd), true, 'the folder a Worker is told to work in was not made')
    }
    assert.equal(readJson(join(root, 'library', 'mcp', 'services.json')).services.mail.source.cwd, scratch, 'the saved service still names the shared scratch')
  })
})

test('an Agent on its environment\'s tools cannot edit them from its own page, keeps its file-tool mode, and Setup sees what it has', async (t) => {
  await withManager(t, async ({ manager, library }) => {
    const instance = await addInstance(manager, 'Page', { agentId: 'agent-alpha' })
    const own = await addInstance(manager, 'Own', { agentId: 'agent-beta' })
    await manager.registry.update((state) => { delete state.instances.find((row) => row.id === own.id).tools; return state })
    await saveService(library, 'mail')
    const call = async (agent, path, body) => {
      const url = new URL((await manager.instances.open(agent.id)).url)
      const response = await fetch(url.origin + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-rulith-local': url.searchParams.get('k'), ...(body === undefined ? {} : { origin: url.origin }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: response.status, body: await response.json() }
    }
    const state = await call(instance, '/worker-tools/state')
    assert.equal(state.status, 200)
    assert.deepEqual(state.body.library, { notice: '' }, 'the page is told it is showing an Agent that uses the environment')
    assert.equal(state.body.tools.filter(tool => tool.origin === 'mcp').length, 1, 'its inventory includes environment tools')
    assert.equal((await call(own, '/worker-tools/state')).body.library, undefined, 'an Agent on its own files is shown exactly what it was')
    for (const [path, body] of [['/worker-tools/save', { id: 'acme.late@1', definition: http, revision: state.body.revision }],
      ['/worker-tools/remove', { id: 'acme.late@1', revision: state.body.revision }], ['/mcp-services/probe', { name: 'x', mode: 'stdio' }],
      ['/mcp-services/remove', { name: 'mail' }], ['/mcp-services/install', { catalogId: 'filesystem' }]]) {
      const refused = await call(instance, path, body)
      assert.equal(refused.status, 409, path)
      assert.match(refused.body.teaching, /Add or change them under "This environment's tools"/)
    }
    // Its file tools are its own: changed here, for this Agent only.
    const mode = await call(instance, '/worker-tools/workspace', { mode: 'read-write', revision: state.body.revision })
    assert.equal(mode.status, 200, JSON.stringify(mode.body))
    assert.equal(loadInstanceConfig(instance.directory).worker.env.RULITH_WORKSPACE_TOOLS, 'read-write')
    assert.equal(loadInstanceConfig(own.directory).worker.env.RULITH_WORKSPACE_TOOLS, undefined, 'another Agent\'s file-tool mode moved')
    // Setup is shown the service the Agent has through its environment.
    const setup = await call(instance, '/setup/state')
    assert.deepEqual(setup.body.services.map((service) => service.name), ['mail'])
    assert.deepEqual((await call(own, '/setup/state')).body.services, [])
    // The manager tells the page how each Agent gets its tools, and nothing about where.
    const rows = manager.instances.overview()
    assert.equal(rows.find((row) => row.id === instance.id).tools.source, 'library')
    assert.equal(rows.find((row) => row.id === own.id).tools, null)
    assert.equal(rows.find((row) => row.id === instance.id).workerSetting.visible, true, 'the setting is offered once there are tools to use')
  })
})

test('this environment\'s tools are served by the manager with its header and exact origin, and name no grant', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    const base = `http://127.0.0.1:${manager.port}`
    const send = (path, { body, headers = { 'x-rulith-manager': KEY }, method = body === undefined ? 'GET' : 'POST' } = {}) =>
      fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
        .then(async (response) => ({ status: response.status, text: await response.text() }))
    const page = await send('/tools')
    assert.equal(page.status, 200)
    assert.match(page.text, /<title>This environment’s tools · Rulith<\/title>/)
    assert.doesNotMatch(page.text, new RegExp(KEY), 'the page carries no key')
    assert.equal((await send('/tools', { headers: {} })).status, 401)
    const state = JSON.parse((await send('/manager/tools/state')).text)
    assert.deepEqual(state.keys, [])
    assert.equal(state.libraryRoot, join(root, 'library'))
    const save = { id: 'acme.orders.lookup@1', definition: http, revision: state.revision, confirmed: true }
    assert.equal((await send('/manager/tools/save', { body: save, headers: { 'x-rulith-manager': KEY, origin: 'http://localhost:1' } })).status, 403)
    assert.equal((await send('/manager/tools/save', { body: save, headers: {} })).status, 401)
    const saved = await send('/manager/tools/save', { body: save, headers: { 'x-rulith-manager': KEY, origin: base } })
    assert.equal(saved.status, 200, saved.text)
    assert.deepEqual(Object.keys(readJson(join(root, 'library', 'worker-tools.json')).tools), ['acme.orders.lookup@1'])
    const refused = await send('/manager/tools/save', { body: { ...save, extra: true, revision: JSON.parse((await send('/manager/tools/state')).text).revision }, headers: { 'x-rulith-manager': KEY, origin: base } })
    assert.equal(refused.status, 400, 'a field the route does not take is refused')
    assert.equal(JSON.parse((await send('/manager/tools/state')).text).tools.find((tool) => tool.id === 'acme.orders.lookup@1').origin, 'manifest')
    await assert.rejects(manager.instances.checkTools('inst-000000000000'), /No local instance inst-000000000000 is registered/)
  })
})

test('tool and service changes need confirmation, and discovery cannot overwrite a newer edit', async t => {
  await withManager(t, async ({ root, library }) => {
    const id = 'acme.orders.lookup@1'
    await assert.rejects(library.save({ id, definition: http, revision: library.state().revision }), /confirm/)
    assert.equal(existsSync(library.root), false, 'an unconfirmed edit created files')
    await saveTool(library, id, http)
    const bytes = readFileSync(library.paths.tools)
    await assert.rejects(library.remove({ id, revision: library.state().revision }), /confirm/)
    assert.deepEqual(readFileSync(library.paths.tools), bytes)
    await saveService(library, 'mail')
    await assert.rejects(library.removeService({ name: 'mail', revision: library.state().revision }), /confirm/)
    const before = readFileSync(library.paths.services)
    const service = readJson(library.paths.services).services.mail
    const body = { name: 'mail', originalName: 'mail', mode: 'stdio', command: service.source.command, args: service.source.args, env: {} }
    const probe = await library.probe(body)
    const edit = { probeId: probe.probeId, tools: [{ name: 'mail.read', kind: 'read' }] }
    await assert.rejects(library.apply(edit), /confirm/)
    await saveTool(library, 'acme.later@1', lookup('/later'))
    await assert.rejects(library.apply({ ...edit, confirmed: true }), /environment's tools changed/)
    assert.deepEqual(readFileSync(library.paths.services), before)
    const shown = library.state().revision
    service.source.env = { PRIVATE_SERVICE_TOKEN: 'changed-privately' }
    writeFileSync(library.paths.services, JSON.stringify({ format: 'rulith-local-mcp/1', services: { mail: service } }))
    await assert.rejects(library.removeService({ name: 'mail', revision: shown, confirmed: true }), /changed/)
    assert.doesNotMatch(JSON.stringify(library.state()), /changed-privately/)
    writeFileSync(join(root, 'library', 'worker-secrets.json'), '[]')
    assert.throws(() => saveTool(library, 'acme.invalid@1', http), /must be a JSON object/)
    assert.equal(readFileSync(library.paths.vault, 'utf8'), '[]')
  })
})

test('a service with credentials added later reaches every existing Agent without local selection', async t => {
  await withManager(t, async ({ manager, library }) => {
    const alpha = await addInstance(manager, 'Alpha', { agentId: 'agent-alpha' })
    const beta = await addInstance(manager, 'Beta', { agentId: 'agent-beta' })
    await startWorker(manager, alpha.id); await startWorker(manager, beta.id)
    await saveService(library, 'mail', { env: { MAIL_FIXTURE_SECRET: 'shared-service-credential' } })
    await waitUntil(() => starts(manager, alpha.id).length === 2 && starts(manager, beta.id).length === 2, 'both Agents to receive the service')
    for (const instance of [alpha, beta]) {
      const inputs = composedOf(manager, instance.id)
      assert.equal(inputs.tools.length, 1)
      assert.equal(inputs.sources.mail.env.MAIL_FIXTURE_SECRET, 'shared-service-credential')
      assert.equal(manager.registry.instance(instance.id).tools.include, undefined)
      assert.equal(manager.registry.instance(instance.id).tools.exclude, undefined)
    }
  })
})

test('composition enforces the advertisement ceiling and collisions with built-ins', async t => {
  await withManager(t, async ({ manager, library }) => {
    const instance = await manager.instances.create({ name: 'Limited' })
    await saveTool(library, 'acme.first@1', http)
    writeFileSync(library.paths.tools, JSON.stringify({ format: 'rulith-worker-tools/1', tools: Object.fromEntries(
      Array.from({ length: 128 }, (_, i) => ['acme.tool' + i + '@1', http])) }))
    const check = library.forInstance(instance.id).check
    assert.throws(() => check({ tools: {}, vault: {} }, { RULITH_WORKSPACE_TOOLS: 'read' }), /128/)
    writeFileSync(library.paths.tools, JSON.stringify({ format: 'rulith-worker-tools/1', tools: { 'rulith.workspace.read_text@1': http } }))
    assert.throws(() => check({ tools: {}, vault: {} }, { RULITH_WORKSPACE_TOOLS: 'read' }), /collid|built.in|reserved/i)
  })
})

test('a composed file that will not go does not keep the runtime record from being written, and is removed once it can be', async (t) => {
  await withManager(t, async ({ manager, library }) => {
    const instance = await addInstance(manager, 'Held', { agentId: 'agent-alpha' })
    await saveService(library, 'mail', { env: { MAIL_FIXTURE_SECRET: 'service-secret' } })
    await startWorker(manager, instance.id)
    const tools = join(instance.directory, 'environment', 'worker-tools.json'), vault = join(instance.directory, 'environment', 'worker-secrets.json')
    const running = () => manager.registry.instance(instance.id).runtime?.children?.map((child) => child.role) ?? []
    assert.deepEqual(running(), ['worker'])

    // The tools file is held the way Windows lets a scanner hold a file that was written a moment ago.
    const hold = holdFiles(t, (path) => path === tools)
    await controlFixtureInstance(manager.instances, instance.id, { role: 'worker', operation: 'stop' })
    // The record of what this instance runs is what a later manager reads after a crash; a refusal to
    // remove a file used to throw before it was written, and the host swallows what its owner throws.
    await waitUntil(() => running().length === 0, 'the registry to record that the Worker stopped')
    assert.equal(existsSync(vault), false, 'the file that holds the service credential stayed because the other one was held')
    assert.equal(existsSync(tools), true, 'the held file was reported removed')
    assert.ok(hold.refused().includes(tools))

    // A hold is a delay, not a verdict: the next try removes it, with nobody asking again.
    hold.release()
    await waitUntil(() => !existsSync(tools), 'the held file to be removed by a later try')
  })
})

/** A library over one registered Agent and nothing else, for the arms that are about its own bookkeeping. */
function bareLibrary(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rulith-library-unit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'instances', 'inst-000000000001')
  mkdirSync(join(directory, 'environment'), { recursive: true })
  const row = { id: 'inst-000000000001', name: 'Unit', directory, tools: { source: 'library' } }
  const registry = { root, instance: (id) => (id === row.id ? row : undefined), read: () => ({ instances: [row] }), patchInstance: async () => {} }
  const hosts = new Map()
  const library = createToolLibrary({ registry, hosts, loadConfig: () => ({}), ...options })
  const files = { tools: join(directory, 'environment', 'worker-tools.json'), vault: join(directory, 'environment', 'worker-secrets.json') }
  const write = () => { writeFileSync(files.tools, '{}'); writeFileSync(files.vault, '{}') }
  return { library, row, hosts, files, write, stopped: library.forInstance(row.id).stopped }
}

test('composed files that will not go are retried a bounded number of times, left alone once a Worker runs again, and named when they never go', async (t) => {
  const { library, row, hosts, files, write, stopped } = bareLibrary(t, { retryDelaysMs: [15, 15] })
  const held = new Set([files.tools])
  const hold = holdFiles(t, (path) => held.has(path))
  const said = []
  t.mock.method(console, 'error', (...line) => { said.push(line.join(' ')) })

  // Held for good: the vault goes at once, whatever happens to the tools file, and the tools file gets
  // the first try and two more, and then one line that names it and says what to do.
  write()
  stopped()
  assert.equal(existsSync(files.vault), false, 'the credentials waited for the other file')
  await waitUntil(() => said.length > 0, 'the last try to be named')
  assert.equal(hold.refused().length, 3, 'one try and two retries')
  assert.equal(said.length, 1)
  assert.ok(said[0].includes(files.tools) && said[0].includes('EBUSY'), said[0])
  assert.match(said[0], /Delete it once nothing else is using it/)
  await new Promise((done) => setTimeout(done, 80))
  assert.equal(hold.refused().length, 3, 'a try was made after the last one')

  // A Worker that runs again was composed into these paths, and a try that was already waiting does not remove what it is using.
  write()
  stopped()
  hosts.set(row.id, { host: { status: () => ({ worker: true }) } })
  hold.release()
  await new Promise((done) => setTimeout(done, 100))
  assert.equal(existsSync(files.tools), true, 'a retry removed the file of a Worker that was running again')
  hosts.delete(row.id)

  // Released before the next try: the retry is what removes it, nobody asks again.
  const refusals = hold.refused().length
  hold.engage()
  write()
  stopped()
  await waitUntil(() => hold.refused().length > refusals, 'the first refusal')
  hold.release()
  await waitUntil(() => !existsSync(files.tools), 'the retry to remove the file')

  // Closing the workbench is the last try, made at once.
  hold.engage()
  write()
  stopped()
  hold.release()
  await library.close()
  assert.equal(existsSync(files.tools), false, 'closing left a file that could have been removed')

  // And what still will not go when it closes is said, as it is when the tries run out. Here the tries are still to come.
  const spoken = said.length
  hold.engage()
  write()
  stopped()
  await library.close()
  assert.equal(said.length, spoken + 1, 'closing left a file that would not go and said nothing')
  assert.ok(said.at(-1).includes(files.tools) && said.at(-1).includes('EBUSY'), said.at(-1))
  assert.match(said.at(-1), /Delete it once nothing else is using it/)

  // It is said once: a file the tries running out already named is not named again by the close that follows.
  const other = bareLibrary(t, { retryDelaysMs: [5] })
  held.add(other.files.tools)
  other.write()
  other.stopped()
  await waitUntil(() => said.length === spoken + 2, 'the tries to run out')
  await other.library.close()
  assert.equal(said.length, spoken + 2, 'closing named a file again that the tries had already named')
  assert.ok(said.at(-1).includes(other.files.tools), said.at(-1))
})

test('a save that is applied is not reported as failed when a Worker\'s reload cannot be made, and the other Workers still reload', async (t) => {
  await withManager(t, async ({ manager, library }) => {
    // Beta is visited first (its Worker was started first), so that what goes wrong for it comes before the others.
    const beta = await addInstance(manager, 'Beta', { agentId: 'agent-beta' })
    const alpha = await addInstance(manager, 'Alpha', { agentId: 'agent-alpha' })
    const gamma = await addInstance(manager, 'Gamma', { agentId: 'agent-gamma' })
    // Beta has a tool of the name the environment is about to gain, defined otherwise: it cannot compose, and is to be told so.
    writeOwn(beta.directory, { tools: { 'acme.orders.lookup@1': lookup('/v2') } })
    for (const instance of [beta, alpha, gamma]) await startWorker(manager, instance.id)

    // The notice cannot be stored for Beta (a registry write that fails after the library was saved).
    const patch = manager.registry.patchInstance
    manager.registry.patchInstance = async (id, mutate) => { if (id === beta.id) throw new Error('registry busy'); return patch(id, mutate) }
    try {
      const saved = await saveTool(library, 'acme.orders.lookup@1', http)
      assert.deepEqual(Object.keys(readJson(library.paths.tools).tools), ['acme.orders.lookup@1'], 'the change was applied')
      assert.deepEqual(saved.reloadPending, ['Beta'])
      assert.match(saved.teaching, /^Tool definition saved in this environment\./)
      assert.match(saved.teaching, /Saved; reload pending for Beta\. Their running Workers keep the previous tools until they reload/)
      assert.deepEqual(saved.affected.sort(), ['Alpha', 'Beta', 'Gamma'])
      await waitUntil(() => starts(manager, alpha.id).length === 2 && starts(manager, gamma.id).length === 2, 'the Workers after Beta to reload')
      assert.equal(starts(manager, beta.id).length, 1, 'a Worker that could not compose was replaced')
    } finally { manager.registry.patchInstance = patch }

    // A reload that cannot be started is the same: saved, named, and the others are not held up by it.
    const alphaHost = manager.instances.hosts.get(alpha.id).host, reload = alphaHost.reloadWorker
    alphaHost.reloadWorker = () => { throw new Error('cannot reload') }
    const removed = await library.remove({ id: 'acme.orders.lookup@1', revision: library.state().revision, confirmed: true })
    assert.deepEqual(Object.keys(readJson(library.paths.tools).tools), [], 'the removal was applied')
    assert.deepEqual(removed.reloadPending, ['Alpha'])
    assert.match(removed.teaching, /^Tool removed from this environment\..* Saved; reload pending for Alpha\./)
    await waitUntil(() => starts(manager, gamma.id).length === 3, 'the Worker after Alpha to reload')

    // Once nothing blocks it, the next change reloads everyone who is behind, with nothing pending.
    alphaHost.reloadWorker = reload
    const again = await saveTool(library, 'acme.orders.status@1', lookup('/status'))
    assert.equal(again.reloadPending, undefined)
    assert.doesNotMatch(again.teaching, /pending/)
    await waitUntil(() => starts(manager, alpha.id).length === 3, 'Alpha to catch up')
  })
})

/** The permission bits a file or folder was created with, as an octal string. */
const modeOf = (path) => (statSync(path).mode & 0o777).toString(8)
const POSIX_MODES = process.platform === 'win32'
  ? 'Windows reports no POSIX permission bits; the manager root is protected by the account\'s filesystem permissions there'
  : false

test('the library, its saved services and the files composed for a Worker are private to their owner', { skip: POSIX_MODES }, async (t) => {
  await withManager(t, async ({ manager, root, library }) => {
    const instance = await addInstance(manager, 'Private', { agentId: 'agent-alpha' })
    // Everything is created by Rulith, except the one folder a service is told to work in: that is made here the way the
    // directory flow makes it (it must exist before it can be named), after the library and its MCP folder are there.
    await saveTool(library, 'acme.orders.lookup@1', http)
    await saveService(library, 'mail', { env: { MAIL_FIXTURE_SECRET: 'service-secret' } })
    const scratch = join(root, 'library', 'mcp', 'workspaces', 'notes')
    mkdirSync(scratch, { recursive: true, mode: 0o700 })
    await saveService(library, 'notes', { cwd: scratch })
    await startWorker(manager, instance.id)

    // The library: its vault and the saved service with its own credential, and the folders they sit in.
    for (const file of ['library.json', 'worker-tools.json', 'worker-secrets.json', 'mcp/services.json']) {
      assert.equal(modeOf(join(root, 'library', file)), '600', file)
    }
    for (const directory of ['library', 'library/mcp']) assert.equal(modeOf(join(root, directory)), '700', directory)
    // What was composed for the Worker, which holds the service's credential, and the folder it works in.
    const environment = join(instance.directory, 'environment')
    for (const file of ['worker-tools.json', 'worker-secrets.json']) assert.equal(modeOf(join(environment, file)), '600', file)
    for (const directory of [environment, join(environment, 'work'), join(environment, 'work', 'notes')]) assert.equal(modeOf(directory), '700', directory)
    // The files a change writes over keep the mode: an atomic replacement does not widen it.
    await saveTool(library, 'acme.orders.status@1', lookup('/status'))
    await waitUntil(() => starts(manager, instance.id).length === 2, 'the Worker to reload')
    assert.equal(modeOf(join(environment, 'worker-secrets.json')), '600')
    assert.equal(modeOf(join(root, 'library', 'worker-tools.json')), '600')
  })
})

test('a reload that was made is not reported as pending because the note that preceded it could not be taken away', async (t) => {
  await withManager(t, async ({ manager, library }) => {
    const beta = await addInstance(manager, 'Beta', { agentId: 'agent-beta' })
    // Beta has a tool of the name the environment is about to gain, defined otherwise: it cannot compose, and is told so.
    writeOwn(beta.directory, { tools: { 'acme.orders.lookup@1': lookup('/v2') } })
    await startWorker(manager, beta.id)
    await saveTool(library, 'acme.orders.lookup@1', http)
    await waitUntil(() => manager.registry.instance(beta.id).tools.notice?.kind === 'failed', 'Beta\'s notice')
    assert.equal(starts(manager, beta.id).length, 1)

    // Beta fixes its side. From then on its Worker is to reload, and the note that it could not is out of date; what fails is
    // storing a note (the same write that recording which processes it runs is not, so that the reload itself goes through).
    writeOwn(beta.directory, { tools: {} })
    const patch = manager.registry.patchInstance
    manager.registry.patchInstance = async (id, mutate) => {
      const change = mutate({ tools: {} })
      if (id === beta.id && Object.hasOwn(change ?? {}, 'tools') && !Object.hasOwn(change, 'runtime')) throw new Error('registry busy')
      return patch(id, mutate)
    }
    try {
      const saved = await saveTool(library, 'acme.orders.other@1', lookup('/other'))
      await waitUntil(() => starts(manager, beta.id).length === 2, 'Beta to reload')
      assert.equal(saved.reloadPending, undefined, 'a reload that was made was reported as waiting')
      assert.doesNotMatch(saved.teaching, /pending/)
      assert.equal(manager.registry.instance(beta.id).tools.notice.kind, 'failed', 'the stale note could not have been taken away')
    } finally { manager.registry.patchInstance = patch }

    // The next change takes it away, with nothing pending.
    const again = await saveTool(library, 'acme.orders.status@1', lookup('/status'))
    assert.equal(again.reloadPending, undefined)
    assert.equal(manager.registry.instance(beta.id).tools.notice, undefined)
  })
})

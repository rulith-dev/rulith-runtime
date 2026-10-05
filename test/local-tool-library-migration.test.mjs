// SPDX-License-Identifier: Apache-2.0
/**
 * Moving an Agent's own tools into the environment's library, as the workbench starts.
 *
 * Before the library each Agent kept its own manifest, vault and MCP services. The move pools what
 * is the same and refuses to choose between what is not: equal tools and services are merged, a
 * credential in an Agent's vault becomes a key of the environment (which no Worker is ever handed,
 * only told where to find), and an Agent whose tool, service or key differs from another's under the
 * same name stays exactly as it was, with a notice, until somebody makes the two agree. Each arm sets
 * Agents up the way 0.11 left them — files in their own directories and nothing on their row — and
 * runs the move through the manager, then looks at what is on disk and what a Worker receives.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { holdFiles } from './support/fs-faults.mjs'
import { controlFixtureInstance } from './support/local-role-controls.mjs'
import {
  composedOf, http, legacyInstance, lookup, readJson, rowOf, script, startWorker, waitUntil, withManager, writeOwn,
} from './support/tool-library-fixture.mjs'

const DSN = 'postgres://app:POSTGRES-SECRET@db/orders'
const mail = { name: 'mail', env: { MAIL_FIXTURE_SECRET: 'service-secret' } }
const bytes = (...files) => files.map((file) => (existsSync(file) ? readFileSync(file, 'utf8') : null))
const own = (instance) => [join(instance.directory, 'worker-tools.json'), join(instance.directory, 'worker-secrets.json'), join(instance.directory, 'mcp', 'services.json')]

test('the first start moves each Agent\'s tools into the library: equal things merge, keys move, scripts and locations stay', async (t) => {
  await withManager(t, async ({ manager, root, library }) => {
    const markers = 'POSTGRES-SECRET'
    const alpha = await legacyInstance(manager, 'Alpha', { agentId: 'agent-alpha', markers, services: [mail],
      tools: { 'acme.orders.lookup@1': http, 'acme.alpha.script@1': script },
      vault: { orders: { type: 'db', dsn: DSN }, reports: { type: 'file', access: '/data/reports' } } })
    const beta = await legacyInstance(manager, 'Beta', { agentId: 'agent-beta', markers, services: [mail],
      tools: { 'acme.orders.lookup@1': http, 'acme.beta.status@1': lookup('/status') }, vault: { orders: { type: 'db', dsn: DSN } } })
    const originals = bytes(...own(alpha))

    const outcome = await manager.instances.migrateTools()
    assert.deepEqual(outcome.moved.map((row) => row.name), ['Alpha', 'Beta'])
    // The library holds each thing once: tools, the service with its own credential, and the key.
    assert.deepEqual(Object.keys(readJson(join(root, 'library', 'worker-tools.json')).tools).sort(), ['acme.beta.status@1', 'acme.orders.lookup@1'])
    assert.deepEqual(Object.keys(readJson(join(root, 'library', 'mcp', 'services.json')).services), ['mail'])
    assert.equal(readJson(join(root, 'library', 'mcp', 'services.json')).services.mail.source.env.MAIL_FIXTURE_SECRET, 'service-secret')
    assert.deepEqual(readJson(join(root, 'library', 'worker-secrets.json')), { orders: { type: 'db', dsn: DSN } })
    for (const agent of [alpha, beta]) {
      const row = rowOf(manager, agent.id)
      assert.equal(row.tools.source, 'library')
      assert.equal(row.tools.notice.kind, 'moved')
      assert.match(row.tools.notice.text, /Old files are in .*tools-before-environment/)
    }
    // What stays with an Agent: its script and its location. What moved is gone from its files, and
    // its MCP directory with it; the originals are kept, secrets and all, where only it can read them.
    assert.deepEqual(Object.keys(readJson(own(alpha)[0]).tools), ['acme.alpha.script@1'])
    assert.deepEqual(readJson(own(alpha)[1]), { reports: { type: 'file', access: '/data/reports' } })
    assert.equal(existsSync(join(alpha.directory, 'mcp')), false)
    const backup = join(alpha.directory, 'tools-before-environment')
    assert.deepEqual(readdirSync(backup).sort(), ['services.json', 'worker-secrets.json', 'worker-tools.json'])
    assert.deepEqual([join(backup, 'worker-tools.json'), join(backup, 'worker-secrets.json'), join(backup, 'services.json')].map((file) => readFileSync(file, 'utf8')), originals)
    // And what each Worker is then given: its own, plus all of the environment's, and no key.
    await startWorker(manager, alpha.id)
    await startWorker(manager, beta.id)
    const mailTools = Object.keys(readJson(join(root, 'library', 'mcp', 'services.json')).services.mail.tools)
    assert.deepEqual(composedOf(manager, alpha.id).tools, ['acme.alpha.script@1', 'acme.beta.status@1', 'acme.orders.lookup@1', ...mailTools].sort())
    assert.deepEqual(composedOf(manager, beta.id).tools, ['acme.beta.status@1', 'acme.orders.lookup@1', ...mailTools].sort())
    assert.deepEqual(composedOf(manager, alpha.id).vault, ['mail', 'reports'])
    assert.deepEqual(composedOf(manager, beta.id).vault, ['mail'])
    for (const agent of [alpha, beta]) {
      assert.deepEqual(composedOf(manager, agent.id).markersInFiles, [], 'a key moved into the library was composed into a Worker\'s file')
      assert.deepEqual(composedOf(manager, agent.id).markersInEnvironment, [])
    }
    // Starting again moves nothing and rewrites nothing.
    const settled = JSON.stringify(manager.registry.read().instances.map((row) => row.tools))
    assert.deepEqual((await library.migrateAll()).moved, [])
    assert.equal(JSON.stringify(manager.registry.read().instances.map((row) => row.tools)), settled)
  })
})

test('an Agent whose tool or key differs from another\'s keeps its files byte for byte, is told why, and moves once it agrees', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    const alpha = await legacyInstance(manager, 'Alpha', { agentId: 'agent-alpha', tools: { 'acme.orders.lookup@1': http }, vault: { orders: { type: 'db', dsn: DSN } } })
    const beta = await legacyInstance(manager, 'Beta', { agentId: 'agent-beta', services: [mail], tools: { 'acme.orders.lookup@1': lookup('/other') },
      vault: { orders: { type: 'db', dsn: 'postgres://app:another@db/orders' } } })
    const before = bytes(...own(beta))
    await manager.instances.migrateTools()

    assert.equal(rowOf(manager, alpha.id).tools.source, 'library')
    const kept = rowOf(manager, beta.id).tools
    assert.equal(kept.source, 'own')
    assert.deepEqual(kept.conflicts.sort(), ['acme.orders.lookup@1', 'orders'])
    assert.equal(kept.notice.kind, 'conflict')
    assert.match(kept.notice.text, /^Beta keeps its own tools for now: acme\.orders\.lookup@1, orders differ from this environment's tools with the same ID\. Remove or change one side, then check again\.$/)
    assert.deepEqual(bytes(...own(beta)), before, 'an Agent that could not move was changed')
    assert.equal(existsSync(join(beta.directory, 'tools-before-environment')), false)
    assert.equal(manager.instances.overview().find((row) => row.id === beta.id).tools.notice.kind, 'conflict')
    // Nothing of Beta's reached the library: it holds Alpha's tool, Alpha's key and nothing else.
    assert.deepEqual(Object.keys(readJson(join(root, 'library', 'worker-tools.json')).tools), ['acme.orders.lookup@1'])
    assert.deepEqual(readJson(join(root, 'library', 'worker-secrets.json')), { orders: { type: 'db', dsn: DSN } })
    assert.equal(existsSync(join(root, 'library', 'mcp', 'services.json')), false)
    // A start on the same notice changes nothing, not even the row's timestamp.
    const stamp = rowOf(manager, beta.id).tools.updatedAt
    await manager.instances.migrateTools()
    assert.equal(rowOf(manager, beta.id).tools.updatedAt, stamp)
    // Its Worker runs on exactly the files it always did.
    await startWorker(manager, beta.id)
    // (Its own MCP service is projected into its own `mcp` directory, as it always was.)
    assert.equal(composedOf(manager, beta.id).files.vault, join(beta.directory, 'mcp', 'worker-secrets.json'))
    assert.equal(composedOf(manager, beta.id).files.environmentVault, '')
    assert.equal(existsSync(join(beta.directory, 'environment')), false)

    // "Check again" does not move an Agent while its own Worker runs, nor while the two still differ.
    await assert.rejects(manager.instances.checkTools(beta.id), /is using local tools/)
    await manager.instances.stop(beta.id)
    assert.match((await manager.instances.checkTools(beta.id)).teaching, /keeps its own tools for now/)
    assert.deepEqual(bytes(...own(beta)), before)
    // Once Beta agrees with the library, checking moves it.
    writeOwn(beta.directory, { tools: { 'acme.orders.lookup@1': http }, vault: { orders: { type: 'db', dsn: DSN } } })
    const checked = await manager.instances.checkTools(beta.id)
    assert.match(checked.teaching, /^Moved this Agent's tools into this environment\./)
    assert.equal(rowOf(manager, beta.id).tools.source, 'library')
    assert.deepEqual(readJson(own(beta)[0]).tools, {}, 'what moved is gone from the Agent\'s own file')
    assert.deepEqual(readJson(join(root, 'library', 'worker-secrets.json')), { orders: { type: 'db', dsn: DSN } }, 'an equal key is one key')
  })
})

test('a service that differs from another\'s under the same name keeps its Agent on its own files', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    const alpha = await legacyInstance(manager, 'Alpha', { agentId: 'agent-alpha', services: [mail] })
    const beta = await legacyInstance(manager, 'Beta', { agentId: 'agent-beta', services: [{ name: 'mail', env: { MAIL_FIXTURE_SECRET: 'another-secret' } }] })
    const before = bytes(...own(beta))
    await manager.instances.migrateTools()
    assert.equal(rowOf(manager, alpha.id).tools.source, 'library')
    assert.deepEqual(rowOf(manager, beta.id).tools.conflicts, ['mail'])
    assert.deepEqual(bytes(...own(beta)), before)
    assert.equal(readJson(join(root, 'library', 'mcp', 'services.json')).services.mail.source.env.MAIL_FIXTURE_SECRET, 'service-secret')
  })
})

test('a move that would stop an Agent that has already moved is refused for the Agent that would cause it', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    // Alpha has a script under an id that Beta has as an HTTP tool: adding Beta's to the library would
    // give Alpha two different tools of one name.
    const alpha = await legacyInstance(manager, 'Alpha', { agentId: 'agent-alpha', tools: { 'acme.shared@1': script } })
    const beta = await legacyInstance(manager, 'Beta', { agentId: 'agent-beta', tools: { 'acme.shared@1': http, 'acme.beta.status@1': lookup('/status') } })
    const before = bytes(...own(beta))
    await manager.instances.migrateTools()
    assert.equal(rowOf(manager, alpha.id).tools.source, 'library', 'the Agent that was already fine was disturbed')
    assert.equal(rowOf(manager, beta.id).tools.source, 'own')
    assert.match(rowOf(manager, beta.id).tools.notice.text, /adding its tools would stop Alpha from starting: acme\.shared@1 differs/)
    assert.deepEqual(bytes(...own(beta)), before)
    assert.equal(existsSync(join(root, 'library', 'worker-tools.json')), false, 'a refused Agent put something into the library')
    await startWorker(manager, alpha.id)
    assert.deepEqual(composedOf(manager, alpha.id).tools, ['acme.shared@1'])
  })
})

test('installed packages are copied into the library once, paths follow them, and scratch folders keep their contents', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    const alpha = await legacyInstance(manager, 'Alpha', { agentId: 'agent-alpha', services: [{ name: 'files', install: true }] })
    const beta = await legacyInstance(manager, 'Beta', { agentId: 'agent-beta', services: [{ name: 'files', install: true }] })
    // Leftovers an installer can leave beside its packages, and something a service wrote in its scratch folder.
    mkdirSync(join(alpha.directory, 'mcp', 'packages', '.install-abandoned'), { recursive: true })
    mkdirSync(join(alpha.directory, 'mcp', 'workspaces', 'files'), { recursive: true })
    writeFileSync(join(alpha.directory, 'mcp', 'workspaces', 'files', 'notes.txt'), 'kept')

    await manager.instances.migrateTools()
    const packages = join(root, 'library', 'mcp', 'packages')
    assert.deepEqual(readdirSync(packages), ['filesystem-2026.8.31'], 'one install, no staging or copy left over')
    const service = readJson(join(root, 'library', 'mcp', 'services.json')).services.files
    assert.equal(service.source.args[0], join(packages, 'filesystem-2026.8.31', 'node_modules', '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js'),
      'the launch line names the library\'s copy')
    assert.equal(existsSync(service.source.args[0]), true)
    for (const agent of [alpha, beta]) assert.equal(existsSync(join(agent.directory, 'mcp')), false, 'the Agent\'s own MCP directory, caches and duplicate install, was dropped')
    assert.equal(readFileSync(join(alpha.directory, 'environment', 'work', 'files', 'notes.txt'), 'utf8'), 'kept')
    // The library's service launches, from its own copy, for each Agent.
    await startWorker(manager, alpha.id)
    await startWorker(manager, beta.id)
    for (const agent of [alpha, beta]) assert.equal(composedOf(manager, agent.id).sources.files.args[0], service.source.args[0])
  })
})

test('an interrupted move converges when the workbench starts again, before or after the Agent was recorded as moved', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    const alpha = await legacyInstance(manager, 'Alpha', { agentId: 'agent-alpha', services: [mail],
      tools: { 'acme.orders.lookup@1': http, 'acme.alpha.script@1': script }, vault: { orders: { type: 'db', dsn: DSN }, reports: { type: 'file', access: '/data/reports' } } })
    const originals = bytes(...own(alpha))
    await manager.instances.migrateTools()
    const library = bytes(join(root, 'library', 'worker-tools.json'), join(root, 'library', 'worker-secrets.json'), join(root, 'library', 'mcp', 'services.json'))
    const restore = () => {
      const [tools, vault, services] = originals
      writeFileSync(own(alpha)[0], tools); writeFileSync(own(alpha)[1], vault)
      mkdirSync(join(alpha.directory, 'mcp'), { recursive: true }); writeFileSync(own(alpha)[2], services)
    }
    const backup = join(alpha.directory, 'tools-before-environment')

    // Before the row was written: the library has everything, the Agent's files are as they were, no backup yet.
    restore()
    rmSync(backup, { recursive: true, force: true })
    await manager.registry.update((state) => { delete state.instances.find((row) => row.id === alpha.id).tools; return state })
    await manager.instances.migrateTools()
    assert.equal(rowOf(manager, alpha.id).tools.source, 'library')
    assert.deepEqual(bytes(join(root, 'library', 'worker-tools.json'), join(root, 'library', 'worker-secrets.json'), join(root, 'library', 'mcp', 'services.json')), library,
      'a rerun duplicated or rewrote what the library already held')
    assert.deepEqual(Object.keys(readJson(own(alpha)[0]).tools), ['acme.alpha.script@1'])
    assert.equal(existsSync(join(alpha.directory, 'mcp')), false)
    assert.deepEqual(['worker-tools.json', 'worker-secrets.json', 'services.json'].map((name) => readFileSync(join(backup, name), 'utf8')), originals)

    // After the row was written and before the tidying finished: the row says moved, its old files are back.
    restore()
    await manager.instances.migrateTools()
    assert.equal(rowOf(manager, alpha.id).tools.source, 'library')
    assert.equal(existsSync(join(alpha.directory, 'mcp')), false, 'the interrupted tidying was not finished')
    assert.deepEqual(Object.keys(readJson(own(alpha)[0]).tools), ['acme.alpha.script@1'])
    assert.deepEqual(readJson(own(alpha)[1]), { reports: { type: 'file', access: '/data/reports' } })
    assert.deepEqual(['worker-tools.json', 'worker-secrets.json', 'services.json'].map((name) => readFileSync(join(backup, name), 'utf8')), originals, 'the backup is never overwritten')
  })
})

test('an Agent whose processes another workbench owns, or whose file cannot be read, is not moved, and the rest are', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    const busy = await legacyInstance(manager, 'Busy', { agentId: 'agent-alpha', tools: { 'acme.busy@1': http } })
    const damaged = await legacyInstance(manager, 'Damaged', { agentId: 'agent-beta' })
    const fine = await legacyInstance(manager, 'Fine', { agentId: 'agent-gamma', tools: { 'acme.fine@1': http } })
    await manager.registry.patchInstance(busy.id, () => ({ runtime: { pid: process.pid + 1, children: [] } }))
    writeFileSync(join(damaged.directory, 'worker-tools.json'), '{"tools": {"quoted-secret-text')
    const before = bytes(...own(busy), ...own(damaged))
    await manager.instances.migrateTools()
    assert.equal(rowOf(manager, busy.id).tools, undefined, 'an Agent another workbench owns was touched')
    assert.equal(rowOf(manager, damaged.id).tools.source, 'own')
    // (The notice speaks of the Agent, which Console calls Beta, not of the profile's own name.)
    assert.match(rowOf(manager, damaged.id).tools.notice.text, /^Beta keeps its own tools for now: .*worker-tools\.json is not valid JSON.*Then check again\.$/)
    assert.doesNotMatch(rowOf(manager, damaged.id).tools.notice.text, /quoted-secret-text/)
    assert.deepEqual(bytes(...own(busy), ...own(damaged)), before)
    assert.equal(rowOf(manager, fine.id).tools.source, 'library')
    assert.deepEqual(Object.keys(readJson(join(root, 'library', 'worker-tools.json')).tools), ['acme.fine@1'])
  })
})

test('a library file that cannot be read leaves every waiting Agent on its own files with a notice, and a fix lets them move', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    const alpha = await legacyInstance(manager, 'Alpha', { agentId: 'agent-alpha', tools: { 'acme.orders.lookup@1': http } })
    mkdirSync(join(root, 'library'), { recursive: true })
    const file = join(root, 'library', 'worker-tools.json')
    writeFileSync(file, 'not json at all')
    const before = bytes(...own(alpha))
    const outcome = await manager.instances.migrateTools()
    assert.match(outcome.error, /worker-tools\.json is not valid JSON/)
    assert.equal(rowOf(manager, alpha.id).tools.source, 'own')
    assert.match(rowOf(manager, alpha.id).tools.notice.text, /Moving Alpha's tools into this environment did not finish: .*not valid JSON/)
    assert.deepEqual(bytes(...own(alpha)), before)
    assert.equal(readFileSync(file, 'utf8'), 'not json at all', 'the library file that could not be read was overwritten')
    rmSync(file)
    assert.match((await manager.instances.checkTools(alpha.id)).teaching, /^Moved this Agent's tools/)
    assert.deepEqual(Object.keys(readJson(file).tools), ['acme.orders.lookup@1'])
  })
})

test('cleanup resumes after a manifest-only move, and skips an Agent whose processes still run', async t => {
  await withManager(t, async ({ manager }) => {
    const instance = await legacyInstance(manager, 'Alpha', { agentId: 'agent-alpha', tools: { 'acme.lookup@1': http },
      vault: { orders: { type: 'db', dsn: DSN } } })
    await manager.instances.migrateTools()
    const restore = () => writeOwn(instance.directory, { tools: { 'acme.lookup@1': http }, vault: { orders: { type: 'db', dsn: DSN } } })
    restore()
    await manager.registry.patchInstance(instance.id, () => ({ orphaned: { children: [{ pid: process.pid }] } }))
    await manager.instances.migrateTools()
    assert.deepEqual(readJson(own(instance)[0]).tools, { 'acme.lookup@1': http })
    await manager.registry.patchInstance(instance.id, () => ({ orphaned: undefined }))
    await manager.instances.migrateTools()
    assert.deepEqual(readJson(own(instance)[0]).tools, {})
    assert.deepEqual(readJson(own(instance)[1]), {})
    assert.equal(existsSync(join(instance.directory, 'mcp')), false)
  })
})

test('a change to an Agent’s own file during the migration commit is preserved', async t => {
  await withManager(t, async ({ manager }) => {
    const instance = await legacyInstance(manager, 'Alpha', { agentId: 'agent-alpha', tools: { 'acme.lookup@1': http } })
    const patch = manager.registry.patchInstance
    manager.registry.patchInstance = async (...args) => {
      const result = await patch(...args)
      if (args[0] === instance.id && rowOf(manager, instance.id).tools?.source === 'library')
        writeOwn(instance.directory, { tools: { 'acme.lookup@1': lookup('/edited-during-commit') } })
      return result
    }
    const outcome = await manager.instances.migrateTools()
    manager.registry.patchInstance = patch
    assert.equal(outcome.untidy.length, 1)
    assert.match(outcome.untidy[0].reason, /configuration changed during migration/)
    assert.deepEqual(readJson(own(instance)[0]).tools, { 'acme.lookup@1': lookup('/edited-during-commit') })
    assert.deepEqual(readJson(manager.instances.library.paths.tools).tools, { 'acme.lookup@1': http })
  })
})

test('a move whose old files cannot all be removed says so on the Agent, and Check again or a restart finishes it', async (t) => {
  await withManager(t, async ({ manager, root, library }) => {
    // Both Agents were installed with the same server under their own MCP directory, which the move copies into the library
    // and then removes. The library's copy is at another path, so an old directory that is left behind makes the Agent's
    // own copy of the service differ from the library's, and its Worker refuses to start with a message about "differs".
    const alpha = await legacyInstance(manager, 'Alpha', { agentId: 'agent-alpha', services: [{ name: 'files', install: true }] })
    const beta = await legacyInstance(manager, 'Beta', { agentId: 'agent-beta', services: [{ name: 'files', install: true }] })
    const held = new Set([alpha, beta].map((agent) => resolve(join(agent.directory, 'mcp'))))
    // Windows holds the directory open for a program that is looking at it, for as long as it does.
    const hold = holdFiles(t, (path) => held.has(resolve(path)))

    const outcome = await manager.instances.migrateTools()
    assert.deepEqual(outcome.moved.map((row) => row.name), ['Alpha', 'Beta'], 'the move is made whatever happens to the tidying')
    assert.equal(outcome.untidy.length, 2)
    for (const agent of [alpha, beta]) {
      const notice = rowOf(manager, agent.id).tools.notice
      assert.equal(rowOf(manager, agent.id).tools.source, 'library')
      assert.equal(notice.kind, 'untidy')
      assert.match(notice.text, / now uses this environment's tools, but its old files could not all be removed: EBUSY: resource busy or locked/)
      assert.ok(notice.text.includes(agent.directory), 'the notice says where to look')
      assert.match(notice.text, /Its Worker may refuse to start because the old copies differ from the environment's\. Fix that .*then Check again\. Starting the workbench again retries it too\.$/i)
      assert.equal(manager.instances.overview().find((row) => row.id === agent.id).tools.notice.kind, 'untidy', 'the page is told')
    }
    // What the notice warns about is real: the Worker is refused, with a message that names nothing the person did.
    const refused = await controlFixtureInstance(manager.instances, alpha.id, { role: 'worker', operation: 'start' }).catch((error) => error)
    assert.match(String(refused.message ?? refused.results?.[0]?.teaching ?? ''), /files differs from the tool or Source of the same name/)

    // Check again while it is still held says so again and changes nothing, not even the row's timestamp.
    const stamp = rowOf(manager, alpha.id).tools.updatedAt
    const still = await manager.instances.checkTools(alpha.id)
    assert.match(still.teaching, /^.* now uses this environment's tools, but its old files could not all be removed: EBUSY/)
    assert.equal(rowOf(manager, alpha.id).tools.updatedAt, stamp)
    assert.equal(existsSync(join(alpha.directory, 'mcp')), true)

    // Once nothing holds it, Check again removes what is left and the note about it goes: the one that remains says where the
    // originals are, and that they keep the old credentials.
    hold.release()
    const finished = await manager.instances.checkTools(alpha.id)
    assert.match(finished.teaching, /^Finished removing .*'s old files\. It uses this environment's tools\.$/)
    assert.equal(existsSync(join(alpha.directory, 'mcp')), false)
    const moved = rowOf(manager, alpha.id).tools.notice
    assert.equal(moved.kind, 'moved')
    assert.match(moved.text, /^Moved this Agent's tools into this environment\. Old files are in .*tools-before-environment\. That folder keeps the old keys and service credentials as they were; delete it when you no longer need it\.$/)
    await controlFixtureInstance(manager.instances, alpha.id, { role: 'worker', operation: 'start' })
    await waitUntil(() => manager.instances.hosts.get(alpha.id).host.status().ready.worker, 'the Worker to be ready')
    assert.deepEqual(composedOf(manager, alpha.id).vault, ['files'])

    // Starting the workbench again does the same for an Agent nobody asked about.
    assert.equal(rowOf(manager, beta.id).tools.notice.kind, 'untidy')
    const restarted = await manager.instances.migrateTools()
    assert.deepEqual(restarted.untidy, [])
    assert.equal(existsSync(join(beta.directory, 'mcp')), false)
    assert.equal(rowOf(manager, beta.id).tools.notice.kind, 'moved')
    // Nothing of the library was touched by any of it: one install, one service.
    assert.deepEqual(readdirSync(join(root, 'library', 'mcp', 'packages')), ['filesystem-2026.8.31'])
    assert.deepEqual(Object.keys(readJson(join(library.paths.services)).services), ['files'])
  })
})

test('a note that the old files are left is taken away when nothing is left, and is never made for a move that is clean', async (t) => {
  await withManager(t, async ({ manager }) => {
    const clean = await legacyInstance(manager, 'Clean', { agentId: 'agent-alpha', tools: { 'acme.lookup@1': http } })
    await manager.instances.migrateTools()
    assert.equal(rowOf(manager, clean.id).tools.notice.kind, 'moved')

    // The notice is out of date as soon as there is nothing left to tidy, however that came about.
    const { notice: _moved, ...rest } = rowOf(manager, clean.id).tools
    await manager.registry.patchInstance(clean.id, () => ({ tools: { ...rest, notice: { kind: 'untidy', text: 'stale' } } }))
    const checked = await manager.instances.checkTools(clean.id)
    assert.match(checked.teaching, /already uses this environment's tools\.$/)
    assert.equal(rowOf(manager, clean.id).tools.notice.kind, 'moved', 'the note stayed after the files it was about were gone')
  })
})

const POSIX_MODES = process.platform === 'win32' ? 'Windows reports no POSIX permission bits' : false

test('the backup of an Agent\'s old files, which keeps its keys, is private to its owner', { skip: POSIX_MODES }, async (t) => {
  await withManager(t, async ({ manager }) => {
    const alpha = await legacyInstance(manager, 'Alpha', { agentId: 'agent-alpha', services: [mail],
      tools: { 'acme.orders.lookup@1': http }, vault: { orders: { type: 'db', dsn: DSN } } })
    await manager.instances.migrateTools()
    const backup = join(alpha.directory, 'tools-before-environment')
    assert.equal((statSync(backup).mode & 0o777).toString(8), '700')
    for (const name of readdirSync(backup)) assert.equal((statSync(join(backup, name)).mode & 0o777).toString(8), '600', name)
    // The files it left behind in the Agent's own folder were rewritten in place and are no wider.
    assert.equal((statSync(join(alpha.directory, 'worker-secrets.json')).mode & 0o777).toString(8), '600')
  })
})

test('an Agent\'s vault entries that say where or how to connect stay in its own vault, and the notice says so', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    const entries = {
      orders: { type: 'db', dsn: DSN },
      billing: { type: 'http', token: 'BILLING-TOKEN' },
      // These say where or how to connect, or something the environment would ignore, so it would refuse or cut them down.
      api: { type: 'http', url: 'https://api.example/orders', token: 'API-TOKEN' },
      erp: { type: 'mcp', transport: 'streamable-http', url: 'https://mcp.example/mcp', token: 'ERP-TOKEN' },
      'local-mail': { type: 'mcp', transport: 'stdio', command: 'node', args: ['mail.mjs'], cwd: '/srv/mail', env: { MAIL_API_TOKEN: 'MAIL-TOKEN' } },
      slow: { type: 'http', token: 'SLOW-TOKEN', timeoutMs: 5000 },
      // No credential at all: a location, which never moved.
      reports: { type: 'file', access: '/data/reports' },
    }
    const alpha = await legacyInstance(manager, 'Alpha', { agentId: 'agent-alpha', markers: 'POSTGRES-SECRET', tools: { 'acme.orders.lookup@1': http }, vault: entries })
    const before = readFileSync(own(alpha)[1], 'utf8')
    await manager.instances.migrateTools()

    // Only a credential and what the environment can honour moved. The rest is exactly as it was, in the Agent's own vault.
    assert.deepEqual(readJson(join(root, 'library', 'worker-secrets.json')), { orders: entries.orders, billing: entries.billing })
    const kept = readJson(own(alpha)[1])
    assert.deepEqual(kept, { api: entries.api, erp: entries.erp, 'local-mail': entries['local-mail'], slow: entries.slow, reports: entries.reports },
      'an entry that was kept was changed, or one that moved was left behind')
    for (const name of Object.keys(kept)) assert.deepEqual(kept[name], entries[name], name)
    const notice = rowOf(manager, alpha.id).tools.notice
    assert.equal(notice.kind, 'moved')
    assert.match(notice.text, /Its keys now live in this environment; a key is used only for a Source bound to the Agent in Console, at the address granted there\./)
    assert.match(notice.text, /Kept in this Agent's own vault, because they say where or how to connect and an environment key cannot: api, erp, local-mail, slow\./)
    // The backup holds what was rewritten, as it was.
    assert.equal(readFileSync(join(alpha.directory, 'tools-before-environment', 'worker-secrets.json'), 'utf8'), before)

    // The Worker runs with the entries it kept, as it always did, because they reach it through its own vault; the key that moved does not.
    await startWorker(manager, alpha.id)
    assert.deepEqual(composedOf(manager, alpha.id).vault, ['api', 'erp', 'local-mail', 'reports', 'slow'])
    assert.deepEqual(composedOf(manager, alpha.id).markersInFiles, [], 'a key that moved to the environment was composed into a Worker file')
  })
})

test('an Agent whose credentials all say where or how to connect keeps them, is told so, and gets no copy of them', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    const erp = { type: 'mcp', transport: 'streamable-http', url: 'https://mcp.example/mcp', token: 'ERP-TOKEN' }
    const alpha = await legacyInstance(manager, 'Alpha', { agentId: 'agent-alpha', vault: { erp } })
    const before = bytes(...own(alpha))
    await manager.instances.migrateTools()
    const row = rowOf(manager, alpha.id)
    assert.equal(row.tools.source, 'library')
    assert.equal(row.tools.notice.kind, 'moved')
    assert.equal(row.tools.notice.text, 'This Agent now uses this environment\'s tools. Kept in this Agent\'s own vault, because it says where or how to connect and an environment key cannot: erp.')
    assert.deepEqual(readJson(join(root, 'library', 'worker-secrets.json')), {})
    assert.deepEqual(bytes(...own(alpha)), before, 'a file that nothing moved out of was rewritten')
    // Nothing of it was rewritten or removed, so there is nothing to back up, and no second copy of its token.
    assert.equal(existsSync(join(alpha.directory, 'tools-before-environment')), false)
  })
})

test('Check again says why an Agent\'s old files were left when it did not remove them', async (t) => {
  await withManager(t, async ({ manager }) => {
    const alpha = await legacyInstance(manager, 'Alpha', { agentId: 'agent-alpha', services: [{ name: 'docs', install: true }] })
    const leftover = resolve(join(alpha.directory, 'mcp'))
    const hold = holdFiles(t, (path) => resolve(path) === leftover)
    await manager.instances.migrateTools()
    assert.equal(rowOf(manager, alpha.id).tools.notice.kind, 'untidy')
    hold.release()

    // Its Agent is running: nothing is removed under a running Agent, and Check again says that, not that all is well.
    await controlFixtureInstance(manager.instances, alpha.id, { role: 'agent', operation: 'start' })
    const running = await manager.instances.checkTools(alpha.id)
    assert.match(running.teaching, /^.* uses this environment's tools, but its old files were not removed: its Agent is running, so its files are not touched now\./)
    assert.doesNotMatch(running.teaching, /already uses/)
    assert.equal(rowOf(manager, alpha.id).tools.notice.kind, 'untidy', 'the note went while the files were still there')
    assert.equal(existsSync(join(alpha.directory, 'mcp')), true)
    await controlFixtureInstance(manager.instances, alpha.id, { role: 'agent', operation: 'stop' })

    // Its old copy of a service is not the environment's: whose is right is for a person to say, and nothing is removed.
    const file = join(alpha.directory, 'mcp', 'services.json'), saved = readFileSync(file, 'utf8')
    const edited = JSON.parse(saved)
    edited.services.docs.source.env = { CHANGED: 'yes' }
    writeFileSync(file, JSON.stringify(edited))
    const differs = await manager.instances.checkTools(alpha.id)
    assert.match(differs.teaching, /but its old files were not removed: docs in its old files differs from this environment's\. If the environment's is the right one, delete that old copy yourself/)
    assert.doesNotMatch(differs.teaching, /already uses/)
    assert.equal(rowOf(manager, alpha.id).tools.notice.kind, 'untidy')
    assert.equal(existsSync(join(alpha.directory, 'mcp')), true)

    // A file that cannot be read is said too, by what is wrong with it and without quoting it.
    writeFileSync(file, '{"services": {"quoted-secret-text')
    const unreadable = await manager.instances.checkTools(alpha.id)
    assert.match(unreadable.teaching, /but its old files were not removed: its files cannot be read: .*services\.json is not valid JSON/)
    assert.doesNotMatch(unreadable.teaching, /quoted-secret-text/)

    // Put right, Check again finishes it, and says so.
    writeFileSync(file, saved)
    const done = await manager.instances.checkTools(alpha.id)
    assert.match(done.teaching, /^Finished removing .*'s old files\. It uses this environment's tools\.$/)
    assert.equal(existsSync(join(alpha.directory, 'mcp')), false)
    assert.equal(rowOf(manager, alpha.id).tools.notice.kind, 'moved')
  })
})

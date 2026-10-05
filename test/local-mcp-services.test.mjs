// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createMcpServices, parametersOf } from '../local/mcp-services.mjs'
import { createLocalHost, defaultLocalConfig } from '../local/rulith-local.mjs'
import { execute, adapterToolFromSpec } from '../worker/rulith-worker.mjs'
import { closeMcpClients } from '../worker/mcp-client.mjs'

const fixture = resolve(import.meta.dirname, 'support/local-mcp-server.mjs')
function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'local-mcp-config-'))
  t.after(async () => { await closeMcpClients(); rmSync(dir, { recursive: true, force: true }) })
  return dir
}
const configuration = (dir, extra = {}) => ({ name: 'mail', mode: 'stdio', command: process.execPath, args: [fixture],
  env: { MAIL_FIXTURE_SECRET: 'fixture-secret', MCP_FIXTURE_LOG: join(dir, 'calls.jsonl') }, ...extra })

test('discovery saves only selected tools, keeps credentials local, and survives a host restart', async t => {
  const dir = workspace(t), config = join(dir, 'local.json'), manager = createMcpServices(config)
  const probe = await manager.probe(configuration(dir))
  assert.equal(existsSync(join(dir, 'calls.jsonl')), false, 'discovery must not execute tools')
  assert.deepEqual(probe.tools.map(row => row.name), ['mail.read', 'mail.draft'])
  await assert.rejects(manager.apply({ probeId: probe.probeId, tools: [{ name: 'mail.read', kind: '' }] }), /explicit/)
  const applied = await manager.apply({ probeId: probe.probeId, tools: [{ name: 'mail.read', kind: 'read' }] })
  const saved = applied.service
  assert.equal(saved.secretConfigured, true)
  assert.doesNotMatch(JSON.stringify(manager.overview()), /fixture-secret|MCP_FIXTURE_LOG/)
  assert.equal(saved.definition.accessModes.length, 1)
  assert.deepEqual(saved.definition.accessModes[0].returns, [], 'discovery cannot infer certified business facts')
  const restarted = createMcpServices(config)
  const env = restarted.workerEnvironment({}, dir)
  const vault = JSON.parse(readFileSync(env.RULITH_SECRETS_FILE)), manifest = JSON.parse(readFileSync(env.RULITH_TOOLS_FILE))
  assert.equal(vault.mail.env.MAIL_FIXTURE_SECRET, 'fixture-secret')
  assert.equal(Object.keys(manifest.tools).length, 1)
  const definition = Object.values(manifest.tools)[0]
  assert.equal(definition.entry, 'mail.read')
  const tool = adapterToolFromSpec(JSON.stringify({ impl: 'mcp', source: 'mail', exec: definition.entry, params: definition.params }), JSON.stringify({ message_id: 'm-1' }))
  const result = await execute('read', { message_id: 'm-1' }, { read: tool }, vault)
  assert.match(result, /订单确认/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'calls.jsonl'), 'utf8')).name, 'mail.read')
  await restarted.remove('mail')
  assert.equal(existsSync(env.RULITH_SECRETS_FILE), false, 'removed credentials must not remain in a stopped projection')
  assert.deepEqual(restarted.overview().services, [])
})

test('edits require fresh discovery and cannot silently overwrite the existing Worker manifest or vault', async t => {
  const dir = workspace(t), manager = createMcpServices(join(dir, 'local.json'))
  const first = await manager.probe(configuration(dir))
  const second = await manager.probe(configuration(dir))
  await assert.rejects(manager.apply({ probeId: first.probeId, tools: [{ name: 'mail.read', kind: 'read' }] }), /expired/)
  await manager.apply({ probeId: second.probeId, tools: [{ name: 'mail.read', kind: 'read' }] })
  const file = join(dir, 'original.json'), bytes = JSON.stringify({ mail: { type: 'mcp', token: 'original' } })
  writeFileSync(file, bytes)
  assert.throws(() => manager.workerEnvironment({ RULITH_SECRETS_FILE: file }, dir), /conflicts/)
  assert.equal(readFileSync(file, 'utf8'), bytes)
  const edit = await manager.probe(configuration(dir, { env: undefined }))
  await manager.apply({ probeId: edit.probeId, tools: [{ name: 'mail.read', kind: 'read' }] })
  assert.equal(manager.overview().services[0].secretConfigured, true)
  const cleared = await manager.probe(configuration(dir, { env: undefined, clearSecrets: true }))
  await manager.apply({ probeId: cleared.probeId, tools: [{ name: 'mail.read', kind: 'read' }] })
  assert.equal(manager.overview().services[0].secretConfigured, false)
})

test('unsupported parameter shapes stay explicit rather than silently losing required input', () => {
  assert.deepEqual(parametersOf({ type: 'object', properties: { path: { type: 'string' }, rows: { type: 'array' }, head: { type: 'integer' } }, required: ['path'] }), { path: 'string', rows: 'json?', head: 'number?' })
  for (const schema of [{ type: 'object', properties: { source: { type: 'string' } } },
    { type: 'object', properties: { camelCase: { type: 'string' } } },
    { type: 'object', properties: {}, required: ['absent'] },
    { type: 'object', properties: {}, additionalProperties: true }, { type: 'object', oneOf: [] }]) assert.throws(() => parametersOf(schema))
})

test('structured write/run authorization is refused before saving while JSON reads and optional inputs remain supported', async t => {
  const dir = workspace(t), manager = createMcpServices(join(dir, 'local.json'))
  t.after(() => manager.close())
  for (const type of ['object', 'array']) {
    const inputSchema = { type: 'object', properties: { value: { type } }, required: ['value'] }
    const config = configuration(dir, { env: { MCP_FIXTURE_SCHEMA: JSON.stringify(inputSchema), MCP_FIXTURE_LOG: join(dir, 'calls.jsonl') } })
    const probe = await manager.probe(config)
    assert.match(probe.tools[0].groundedWriteProblem, /Required JSON parameter\(s\): value/)
    const before = JSON.stringify(manager.overview())
    for (const kind of ['write', 'run']) {
      await assert.rejects(manager.apply({ probeId: probe.probeId, tools: [{ name: 'mail.read', kind: 'read' }, { name: 'mail.draft', kind }] }), /Required JSON parameter\(s\): value/)
      assert.equal(JSON.stringify(manager.overview()), before, 'a failed batch must not partially save its read tool')
    }
    const result = await manager.apply({ probeId: probe.probeId, tools: [{ name: 'mail.read', kind: 'read' }] })
    assert.equal(result.service.definition.accessModes[0].params.value, 'json')
    await manager.remove('mail')
    delete inputSchema.required
    const optional = await manager.probe({ ...config, env: { ...config.env, MCP_FIXTURE_SCHEMA: JSON.stringify(inputSchema) } })
    assert.equal(optional.tools[0].groundedWriteProblem, undefined)
    const saved = await manager.apply({ probeId: optional.probeId, tools: [{ name: 'mail.draft', kind: 'write' }] })
    assert.equal(saved.service.definition.accessModes[0].params.value, 'json?')
    await manager.remove('mail')
  }
  assert.equal(existsSync(join(dir, 'calls.jsonl')), false, 'authorization must not call any MCP business tool')
})

test('Filesystem cannot grant access to Local credentials or a nested Runtime executable directory', async t => {
  const dir = workspace(t), manager = createMcpServices(join(dir, 'local.json'))
  const entryDirectory = join(dir, 'mcp/packages/filesystem-2026.8.31/node_modules/@modelcontextprotocol/server-filesystem/dist')
  mkdirSync(entryDirectory, { recursive: true }); writeFileSync(join(entryDirectory, 'index.js'), 'throw new Error("must not launch")')
  for (const directory of [dir, join(dir, 'mcp'), entryDirectory, resolve(import.meta.dirname, '../worker')]) {
    await assert.rejects(manager.probe({ name: 'files', mode: 'filesystem', directory }), /must not overlap/)
  }
})

test('MCP configuration uses the header key, exact browser origin, and does not allow arbitrary package installation', async t => {
  const dir = workspace(t), config = defaultLocalConfig()
  config.paths = { agent: join(dir, 'absent.mjs') }
  const host = createLocalHost({ configFile: join(dir, 'local.json'), config, roles: ['agent'], port: 0, key: 'fixture-key' })
  await host.listen(); t.after(() => host.close())
  const base = 'http://127.0.0.1:' + host.port
  const send = headers => fetch(base + '/mcp-services/install?k=fixture-key', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ catalogId: 'untrusted-package' }) })
  assert.equal((await send({})).status, 403)
  assert.equal((await send({ 'x-rulith-local': 'fixture-key', origin: 'http://127.0.0.1:1' })).status, 403)
  const refused = await send({ 'x-rulith-local': 'fixture-key', origin: base })
  assert.equal(refused.status, 400)
  assert.match((await refused.json()).teaching, /catalog/)
  const page = await fetch(base + '/mcp-services?k=fixture-key')
  assert.equal(page.status, 200)
  assert.doesNotMatch(await page.text(), /fixture-key/)
  assert.deepEqual((await (await fetch(base + '/mcp-services/state?k=fixture-key')).json()).services, [])
})


test('plain file arguments cannot expose account credentials or another Agent profile', async t => {
  const dir = workspace(t), privateRoot = join(dir, 'accounts'), configFile = join(dir, 'local.json')
  mkdirSync(privateRoot); writeFileSync(join(privateRoot, 'device.json'), '{"token":"private"}')
  const services = createMcpServices(configFile, { protectedPaths: [privateRoot] })
  await assert.rejects(services.probe(configuration(dir, {
    args: [fixture, join(privateRoot, 'device.json')],
  })), /file argument.*configuration and credentials/)
  assert.equal(existsSync(join(dir, 'calls.jsonl')), false)
  // A server's code in the installation remains usable; private state is the guarded file boundary.
  assert.equal((await services.probe(configuration(dir))).tools.length, 2)
})

test('the launch guard accepts a server\'s own installed entry script and still refuses the rest of Rulith\'s tree', async t => {
  // The layout `installPackage` leaves under the MCP directory, in a manager-shaped tree: a
  // library beside whatever else lives in the manager directory (its device record, the
  // instances). The entry script is a real MCP server, so "accepted" means discovered, not
  // merely not refused — the guard used to refuse it as a file argument inside the private tree.
  const manager = workspace(t), library = join(manager, 'library')
  const entry = join(library, 'mcp/packages/filesystem-2026.8.31/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, `import { localMcpServer } from ${JSON.stringify(import.meta.resolve('./support/local-mcp-server.mjs'))}\n`
    + `import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))}\n`
    + 'await localMcpServer().connect(new StdioServerTransport())\n')
  writeFileSync(join(manager, 'device.json'), '{"token":"private"}')
  mkdirSync(join(manager, 'instances/inst-1'), { recursive: true })
  // The scripted server discovers without reading this existing directory outside the repository.
  const outside = dirname(process.execPath)
  const services = createMcpServices(join(library, 'library.json'), { protectedPaths: [manager] })
  t.after(() => services.close())

  // Accepted: the catalog template, whose launch line is `node <entry> <directory>` ...
  const files = await services.probe({ name: 'files', mode: 'filesystem', directory: outside })
  assert.deepEqual(files.tools.map(row => row.name), ['mail.read', 'mail.draft'])
  const applied = await services.apply({ probeId: files.probeId, tools: [{ name: 'mail.read', kind: 'read' }] })
  assert.doesNotThrow(() => services.assertLaunch(services.rows().find(row => row.name === applied.service.name)),
    'the launch guard run again at every start refused the same line')
  // ... and a stdio server working in the scratch folder Local mints for it.
  const scratch = join(library, 'mcp/workspaces/scratch')
  mkdirSync(scratch, { recursive: true })
  assert.equal((await services.probe({ name: 'scratch', mode: 'stdio', command: process.execPath, args: [entry], cwd: scratch })).tools.length, 2)

  // Refused: a root, a working directory or an argument anywhere else in the manager tree.
  const stdio = (extra) => services.probe({ name: 'elsewhere', mode: 'stdio', command: process.execPath, args: [entry], ...extra })
  for (const directory of [manager, library, join(library, 'mcp'), join(manager, 'instances/inst-1')]) {
    await assert.rejects(services.probe({ name: 'nosy', mode: 'filesystem', directory }), /must not overlap/, directory)
  }
  await assert.rejects(stdio({ cwd: manager }), /working directory/)
  await assert.rejects(stdio({ cwd: join(manager, 'instances/inst-1') }), /working directory/)
  await assert.rejects(stdio({ args: [entry, join(manager, 'device.json')] }), /file argument/)
  await assert.rejects(stdio({ args: [entry, join(manager, 'instances/inst-1')] }), /allowed directory/)
  await assert.rejects(stdio({ args: [entry, join(library, 'mcp')] }), /allowed directory/,
    'the directory that contains the installed packages and the scratch folders is not itself either')
  await assert.rejects(stdio({ command: join(library, 'mcp/services.json') }), /executable/)
  // What is allowed is what lies inside the two places. The places themselves are refused as a working directory and as an
  // argument: a server given `workspaces` reaches every other service's scratch, one given `packages` all the installed code.
  for (const directory of [join(library, 'mcp/workspaces'), join(library, 'mcp/packages')]) {
    await assert.rejects(stdio({ cwd: directory }), /working directory/, directory)
    await assert.rejects(stdio({ args: [entry, directory] }), /allowed directory/, directory)
  }
  const nested = join(library, 'mcp/workspaces/scratch/nested')
  mkdirSync(nested, { recursive: true })
  assert.equal((await services.probe({ name: 'deeper', mode: 'stdio', command: process.execPath, args: [entry], cwd: nested })).tools.length, 2,
    'a folder further inside the scratch folder is still inside it')
})

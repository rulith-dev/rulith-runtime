// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createMcpServices } from '../local/mcp-services.mjs'
import { createWorkerToolManagement } from '../local/worker-tool-management.mjs'
import { createLocalHost, defaultLocalConfig } from '../local/rulith-local.mjs'
import { configuredWorkerTools } from '../worker/rulith-worker.mjs'

function setup(t, tools = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'worker-management-'))
  const file = join(directory, 'worker-tools.json')
  writeFileSync(file, JSON.stringify({ format: 'rulith-worker-tools/1', tools }))
  writeFileSync(join(directory, 'worker-secrets.json'), JSON.stringify({ records: { type: 'db', password: 'never-return-this-secret' } }))
  const environment = { RULITH_WORKSPACE_TOOLS: 'read' }, workerContext = () => ({ environment, directory })
  const mcpServices = createMcpServices(join(directory, 'local.json'), { workerContext })
  const manager = createWorkerToolManagement({ mcpServices, workerContext, setWorkspaceMode: mode => { environment.RULITH_WORKSPACE_TOOLS = mode } })
  t.after(async () => { await mcpServices.close(); rmSync(directory, { recursive: true, force: true }) })
  return { manager, mcpServices, environment, directory, file }
}
const http = { adapter: 'http', sourceTypes: ['http'], entry: '/items', fence: { method: 'GET' }, params: {}, returns: [] }

test('the selected profile material reader is in the same inventory as the real Worker composition', t => {
  const {manager,environment,directory,file}=setup(t)
  const old=manager.overview()
  environment.RULITH_MATERIALS_ROOT=join(directory,'materials')
  const view=manager.overview(), reader=view.tools.find(row=>row.id==='rulith.materials.read@1')
  assert.equal(reader?.configured,true)
  assert.equal(reader.origin,'builtin')
  assert.deepEqual(reader.returns,[])
  assert.equal(reader.digest,configuredWorkerTools(JSON.parse(readFileSync(file)),environment.RULITH_WORKSPACE_TOOLS,environment.RULITH_MATERIALS_ROOT)[reader.id].digest)
  assert.notEqual(view.revision,old.revision)
  assert.throws(()=>manager.save({id:reader.id,definition:http,revision:view.revision}),/redefines built-in/)
})

test('unified inventory covers built-ins, every declared adapter and selected MCP tools without exposing the vault or writing projections', async t => {
  const declared = {
    'test.http@1': http,
    'test.query@1': { adapter: 'db-query', sourceTypes: ['db'], entry: 'SELECT id FROM records' },
    'test.update@1': { adapter: 'db-exec-fenced', sourceTypes: ['db'], entry: 'UPDATE records SET done=true' },
    'test.script@1': { adapter: 'run', sourceTypes: [], entry: 'task.mjs', env: { pass: [] } },
    'test.mcp@1': { adapter: 'mcp', sourceTypes: ['mcp'], entry: 'read' },
    'test.files@1': { adapter: 'workspace', sourceTypes: ['file'], entry: 'read_text' },
  }
  const { manager, mcpServices, directory } = setup(t, declared)
  const probe = await mcpServices.probe({ name: 'mail', mode: 'stdio', command: process.execPath,
    args: [resolve(import.meta.dirname, 'support/local-mcp-server.mjs')] })
  await mcpServices.apply({ probeId: probe.probeId, tools: [{ name: 'mail.read', kind: 'read' }] })
  const view = manager.overview()
  assert.equal(view.tools.filter(tool => tool.origin === 'manifest').length, 6)
  assert.equal(view.tools.filter(tool => tool.origin === 'mcp').length, 1)
  assert.equal(view.tools.filter(tool => tool.origin === 'builtin' && tool.configured).length, 7)
  assert.equal(view.tools.filter(tool => !tool.configured).length, 2)
  assert.doesNotMatch(JSON.stringify(view), /never-return-this-secret/)
  assert.equal(existsSync(join(directory, 'mcp/worker-tools.json')), false, 'inventory reads must not write Worker input files')
})

test('editing is revision-checked, preserves other tools and refuses built-in restatement or id replacement', t => {
  const { manager, file } = setup(t, { 'test.http@1': http })
  const original = manager.overview()
  manager.save({ id: 'test.script@1', definition: { adapter: 'run', sourceTypes: [], entry: 'task.mjs' }, revision: original.revision })
  assert.deepEqual(JSON.parse(readFileSync(file)).tools['test.http@1'], http)
  assert.throws(() => manager.remove({ id: 'test.http@1', revision: original.revision }), /changed/)
  const view = manager.overview(), bytes = readFileSync(file, 'utf8')
  assert.throws(() => manager.save({ id: 'test.other@1', originalId: 'test.http@1', definition: http, revision: view.revision }), /existing Tool ID/)
  assert.throws(() => manager.save({ id: 'rulith.workspace.read_text@1', definition: http, revision: view.revision }), /redefines built-in/)
  assert.equal(readFileSync(file, 'utf8'), bytes)
  manager.remove({ id: 'test.script@1', revision: view.revision })
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file)).tools), ['test.http@1'])
})

test('workspace mode changes the same tool composition used at real Worker startup', t => {
  const { manager, environment, file } = setup(t)
  manager.workspace({ mode: 'off', revision: manager.overview().revision })
  assert.deepEqual(Object.keys(configuredWorkerTools(JSON.parse(readFileSync(file)), environment.RULITH_WORKSPACE_TOOLS)), ['rulith.mcp.discover@1'])
  manager.workspace({ mode: 'read-write', revision: manager.overview().revision })
  const tools = configuredWorkerTools(JSON.parse(readFileSync(file)), environment.RULITH_WORKSPACE_TOOLS)
  assert.equal(tools['rulith.workspace.write_text@1'].kind, 'write')
  const inventory = manager.overview().tools
  assert.match(inventory.find(tool => tool.id === 'rulith.workspace.write_json@1').automaticActionProblem, /Required JSON parameter\(s\): value/)
  assert.equal(inventory.find(tool => tool.id === 'rulith.workspace.write_text@1').automaticActionProblem, undefined)
  assert.equal(tools['rulith.workspace.write_json@1'].params.value, 'json', 'the local tool contract remains available to explicitly authored capabilities')
  assert.throws(() => manager.remove({ id: 'rulith.mcp.discover@1', revision: manager.overview().revision }), /Only manifest/)
})

test('rediscovery keeps unchanged selections, source ids stay stable, and changed launch targets do not inherit credentials', async t => {
  const { mcpServices } = setup(t)
  const config = { name: 'mail', mode: 'stdio', command: process.execPath,
    args: [resolve(import.meta.dirname, 'support/local-mcp-server.mjs')], env: { MAIL_TOKEN: 'only-for-first-target' } }
  const first = await mcpServices.probe(config)
  await mcpServices.apply({ probeId: first.probeId, tools: [{ name: 'mail.read', kind: 'read' }] })
  const repeated = await mcpServices.probe({ ...config, env: undefined, originalName: 'mail' })
  assert.deepEqual(repeated.selected, [{ name: 'mail.read', kind: 'read' }])
  await assert.rejects(mcpServices.probe({ ...config, name: 'new-name', originalName: 'mail' }), /cannot be renamed/)
  await assert.rejects(mcpServices.probe({ ...config, isNew: true }), /already exists/)
  await assert.rejects(mcpServices.probe({ ...config, args: ['--no-warnings', ...config.args], env: undefined }), /launch target changed/)
  assert.equal(mcpServices.overview().services[0].secretConfigured, true, 'refusal must preserve the saved service')
})

test('management endpoints require the exact origin and persist only the existing workspace setting', async t => {
  const { directory } = setup(t), config = defaultLocalConfig(), configFile = join(directory, 'local.json')
  config.paths = { agent: join(directory, 'absent.mjs'), worker: join(directory, 'absent-worker.mjs') }
  config.agent.env.RULITH_MODEL_KEY = 'preserve-model-secret'
  writeFileSync(configFile, JSON.stringify(config))
  const host = createLocalHost({ configFile, config, roles: ['agent'], port: 0, key: 'management-key' })
  await host.listen(); t.after(() => host.close())
  const base = 'http://127.0.0.1:' + host.port, headers = { 'x-rulith-local': 'management-key', 'content-type': 'application/json' }
  const before = await (await fetch(base + '/worker-tools/state', { headers })).json()
  const body = JSON.stringify({ mode: 'off', revision: before.revision })
  assert.equal((await fetch(base + '/worker-tools/workspace', { method: 'POST', headers: { ...headers, origin: 'http://localhost:1' }, body })).status, 403)
  assert.equal((await fetch(base + '/worker-tools/workspace', { method: 'POST', headers, body })).status, 200)
  const saved = JSON.parse(readFileSync(configFile))
  assert.equal(saved.worker.env.RULITH_WORKSPACE_TOOLS, 'off')
  assert.equal(saved.agent.env.RULITH_MODEL_KEY, 'preserve-model-secret')
  assert.doesNotMatch(JSON.stringify(before), /preserve-model-secret/)
})

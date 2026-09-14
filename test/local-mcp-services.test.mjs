// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

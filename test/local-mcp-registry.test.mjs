// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configurationTemplate, resolveConfiguration, createMcpRegistry, registryJson } from '../local/mcp-registry.mjs'
import { createMcpServices } from '../local/mcp-services.mjs'

const serverName = 'io.github.example/notes'
function row(extra = {}, status = 'active') {
  return { server: { name: serverName, version: '1.2.3', title: '<img src=x>', description: 'Notes', packages: [{ registryType: 'npm', identifier: '@example/notes', version: '2.0.1', transport: { type: 'stdio' } }], ...extra },
    _meta: { 'io.modelcontextprotocol.registry/official': { status, isLatest: true } } }
}
const metadata = { name: '@example/notes', version: '2.0.1', mcpName: serverName, bin: { notes: 'dist/index.js' }, dist: { integrity: 'sha512-YWJjZA==' } }
function fixture(initial = row(), npm = metadata) {
  const calls = [], data = { row: initial }
  const registry = createMcpRegistry({ fetcher: async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify(url.startsWith('https://registry.npmjs.org/') ? npm : url.includes('/versions/') ? data.row : { servers: [data.row], metadata: { nextCursor: 'next:1' } }))
  } })
  return { registry, calls, data }
}

test('directory search is paginated, bounded and cached; details never run a package', async () => {
  const { registry, calls } = fixture()
  const result = await registry.search(' notes ')
  assert.equal(result.nextCursor, 'next:1')
  assert.equal(result.servers[0].title, '<img src=x>', 'UI must render publisher text as text')
  await registry.search(' notes ')
  assert.equal(calls.length, 1)
  await registry.search(' notes ', result.nextCursor)
  const url = new URL(calls[1].url)
  assert.equal(url.searchParams.get('cursor'), 'next:1')
  assert.equal(url.searchParams.get('version'), 'latest')
  const detail = await registry.detail(serverName, '1.2.3')
  assert.equal(detail.options[0].unsupported, undefined)
  assert.equal(detail.options[0].descriptor, undefined)
  assert.ok(calls.every(call => call.options.redirect === 'error' && !call.options.headers.authorization))
  await assert.rejects(registry.search('a'.repeat(151)), /too long/)
})

test('prepare rechecks status and reviewed metadata, and checks npm ownership without trusting browser package fields', async () => {
  const { registry, data, calls } = fixture()
  const detail = await registry.detail(serverName, '1.2.3')
  const request = { serverName, version: '1.2.3', optionId: 'package.0', reviewToken: detail.reviewToken, values: {} }
  const prepared = await registry.prepare({ ...request, package: '--script=evil' })
  assert.equal(prepared.entry.package, '@example/notes')
  assert.equal(prepared.entry.entry, 'dist/index.js')
  assert.equal(calls.filter(call => call.url.includes('/versions/')).length, 2)
  data.row = row({ description: 'changed' })
  await assert.rejects(registry.prepare(request), /changed/)
  data.row = row({}, 'deleted')
  await assert.rejects(registry.prepare(request), /not active/)
  const mismatch = fixture(row(), { ...metadata, mcpName: 'io.github.other/notes' })
  await assert.rejects(mismatch.registry.prepare(request), /identity/)
})

test('directory input templates preserve fixed, optional, repeated and secret values without shell interpolation', () => {
  const template = configurationTemplate({ packageArguments: [
    { type: 'positional', value: 'serve' }, { type: 'named', name: '--folder', isRequired: true },
    { type: 'positional', valueHint: 'tags', isRepeated: true },
  ], environmentVariables: [{ name: 'API_TOKEN', value: 'Bearer {token}', variables: { token: { isRequired: true, isSecret: true } } }, { name: 'OPTIONAL', default: 'yes' }] })
  const result = resolveConfiguration(template, { 'arg.1': 'D:/a directory/$(never execute)', 'arg.2': ['one', 'two'], 'env.api_token.token': 'a&b' })
  assert.deepEqual(result.args, ['serve', '--folder', 'D:/a directory/$(never execute)', 'one', 'two'])
  assert.deepEqual(result.env, { API_TOKEN: 'Bearer a&b', OPTIONAL: 'yes' })
  assert.equal(template.fields.find(field => field.secret).default, undefined)
  assert.throws(() => resolveConfiguration(template, { extra: 'value' }), /Unexpected/)
  assert.throws(() => resolveConfiguration(template), /required/)
})

test('unsupported ecosystems, runner flags, unsafe executables and incomplete templates remain explicit', async () => {
  for (const pkg of [
    { registryType: 'pypi' }, { runtimeArguments: [{ type: 'positional', value: '--call=evil' }] },
    { registryBaseUrl: 'https://other.example' }, { version: 'latest' },
    { environmentVariables: [{ name: 'NODE_OPTIONS' }] },
    { packageArguments: [{ type: 'positional', value: '{undeclared}' }] },
  ]) {
    const original = row()
    original.server.packages[0] = { ...original.server.packages[0], ...pkg }
    const detail = await fixture(original).registry.detail(serverName)
    assert.ok(detail.options[0].unsupported)
  }
  for (const bin of ['../../out.js', '/outside.js', 'C:/outside.js', { one: 'one.js', two: 'two.js' }]) {
    const { registry } = fixture(row(), { ...metadata, bin })
    const detail = await registry.detail(serverName)
    await assert.rejects(registry.prepare({ serverName, version: '1.2.3', optionId: 'package.0', reviewToken: detail.reviewToken }), /executable/)
  }
  assert.throws(() => configurationTemplate({ url: 'https://example.test/mcp?token=secret' }, true), /fixed HTTPS/)
  assert.throws(() => configurationTemplate({ url: 'https://example.test/mcp', headers: [{ name: 'Host' }] }, true), /Reserved/)
})

test('remote header configuration carries no credentials in returned registry provenance', async () => {
  const { registry } = fixture(row({ packages: [], remotes: [{ type: 'streamable-http', url: 'https://example.test/mcp', headers: [
    { name: 'Authorization', value: 'Bearer {token}', variables: { token: { isRequired: true, isSecret: true } } },
  ] }] }))
  const detail = await registry.detail(serverName)
  const prepared = await registry.prepare({ serverName, version: '1.2.3', optionId: 'remote.0', reviewToken: detail.reviewToken, values: { 'header.authorization.token': 'test-secret' } })
  assert.equal(prepared.source.headers.Authorization, 'Bearer test-secret')
  assert.doesNotMatch(JSON.stringify(prepared.provenance), /test-secret/)
})

test('directory metadata requests bound streamed bodies and redact remote failure content', async () => {
  await assert.rejects(registryJson('https://example.test', async () => new Response('x'.repeat(2_097_153))), /unavailable/)
  await assert.rejects(registryJson('https://example.test', async () => { throw new Error('credential-leak') }), error => !error.message.includes('credential-leak'))
})

test('a prepared directory service uses the existing selection workflow and never returns secret launch arguments', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'registry-service-'))
  const manager = createMcpServices(join(directory, 'local.json'), { registry: { prepare: async () => ({
    source: { type: 'mcp', transport: 'stdio', command: process.execPath, args: [resolve(import.meta.dirname, 'support/local-mcp-server.mjs'), 'secret-argument'], env: { MAIL_FIXTURE_SECRET: 'secret-value' } },
    provenance: { name: serverName, version: '1.2.3' },
  }) } })
  t.after(async () => { await manager.close(); rmSync(directory, { recursive: true, force: true }) })
  const prepared = await manager.prepareRegistry({})
  assert.doesNotMatch(JSON.stringify(prepared), /secret-argument|secret-value/)
  const probed = await manager.probe({ name: 'notes', mode: 'registry', preparationId: prepared.preparationId })
  const saved = await manager.apply({ probeId: probed.probeId, tools: [{ name: 'mail.read', kind: 'read' }] })
  assert.equal(saved.service.registry.name, serverName)
  assert.doesNotMatch(JSON.stringify(manager.overview()), /secret-argument|secret-value/)
  const rediscovered = await manager.probe({ name: 'notes', mode: 'registry' })
  assert.equal(rediscovered.tools.length, 2)
})

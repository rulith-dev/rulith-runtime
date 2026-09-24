// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { execute, toolDigest, toolFromSpec, workerToolsOf } from '../worker/rulith-worker.mjs'
import { guardCatalogDigest } from '../worker/action-input-db.mjs'

const ID = 'acme.store_text@1'
const PROFILE = { format: 'rulith-http-text-write/1', method: 'PUT', relativePath: '/records/{target}',
  targetParam: 'target', payloadParam: 'payload', contentType: 'text/plain; charset=utf-8' }
const TOOL = { adapter: 'http', sourceTypes: ['http'], entry: PROFILE.relativePath, kind: 'write',
  params: { target: 'string', payload: 'string' }, returns: [],
  fence: { method: 'PUT', textWrite: PROFILE,
    completion: { stage: 'terminal', statuses: [200], json: { field: 'state', equals: 'committed' } } } }
const SPEC = { impl: 'worker-tool', exec: ID, kind: 'write', sourceTypes: ['http'],
  params: TOOL.params, returns: [], fence: TOOL.fence, guardCatalogDigest,
  inputRoles: { target: { role: 'grounded' }, payload: { role: 'payload',
    guard: 'rulith.payload.bounded-text@1', guardConfig: { maxBytes: 16_384, mediaType: 'text/plain' } } } }

test('fixed HTTP text write sends only UTF-8 body to one governed target segment', async () => {
  const calls = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const path = request.url
    calls.push({ method: request.method, path, headers: request.headers, body: Buffer.concat(chunks) })
    if (path === '/records/lost') { request.socket.destroy(); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ state: path === '/records/accepted' ? 'accepted' : 'committed' }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const sources = { store: { type: 'http', url: `http://127.0.0.1:${server.address().port}/`,
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer local-only' } } }
  const compile = args => toolFromSpec(JSON.stringify(SPEC), JSON.stringify({ source: 'store', ...args }),
    { [ID]: TOOL }, toolDigest(TOOL), sources, 'store')
  const send = args => { const tool = compile(args); return execute('write', tool._args, { write: tool }, sources) }
  try {
    assert.equal(workerToolsOf({ format: 'rulith-worker-tools/1', tools: { [ID]: TOOL } })[ID].digest,
      toolDigest(TOOL))
    const good = compile({ target: 'note-42', payload: 'hello 世界\n' })
    assert.equal(good.inputRolesV2, true, 'fixed text writes require Action v2 adoption')
    await execute('write', good._args, { write: good }, sources)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'PUT')
    assert.equal(calls[0].path, '/records/note-42')
    assert.equal(calls[0].headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(calls[0].headers.authorization, 'Bearer local-only')
    assert.deepEqual(calls[0].body, Buffer.from('hello 世界\n', 'utf8'))

    for (const bad of [
      { target: '../escape', payload: 'x' }, { target: 'a/b', payload: 'x' },
      { target: 'a?x=1', payload: 'x' }, { target: 'ok', payload: 'x', url: 'http://elsewhere/' },
      { target: 'ok', payload: 'x', query: { admin: true } },
      { target: 'ok', payload: 'x', headers: { authorization: 'attacker' } },
      { target: 'ok', payload: 'x', method: 'DELETE' },
      { target: { path: 'ok' }, payload: 'x' }, { target: 'ok', payload: { text: 'x' } },
      { target: 'ok', payload: '界'.repeat(5462) }, { target: 'ok', payload: '\ud800' },
    ]) {
      await assert.rejects(async () => send(bad))
      assert.equal(calls.length, 1, `invalid input reached the HTTP Source: ${JSON.stringify(bad).slice(0, 100)}`)
    }
    await assert.rejects(send({ target: 'accepted', payload: 'write once' }),
      /terminal evidence absent/)
    await assert.rejects(send({ target: 'lost', payload: 'write once' }),
      /outcome unknown after transport error/)
    assert.deepEqual(calls.map(call => call.path), ['/records/note-42', '/records/accepted', '/records/lost'])
  } finally {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
  }
})

test('fixed HTTP text profile rejects path, method, parameter and nested controls before execution', () => {
  const manifest = tool => workerToolsOf({ format: 'rulith-worker-tools/1', tools: { [ID]: tool } })
  for (const profile of [
    { ...PROFILE, relativePath: '/records/{target}/again/{target}' },
    { ...PROFILE, relativePath: '/records/prefix-{target}' },
    { ...PROFILE, relativePath: '/records/{target}?overwrite=true' },
    { ...PROFILE, relativePath: '//elsewhere/{target}' },
    { ...PROFILE, relativePath: '/records/../{target}' },
    { ...PROFILE, method: 'POST' },
    { ...PROFILE, contentType: 'application/json' },
    { ...PROFILE, headers: { authorization: 'unsafe' } },
  ]) assert.throws(() => manifest({ ...TOOL, entry: profile.relativePath,
    fence: { ...TOOL.fence, method: profile.method, textWrite: profile } }), /HTTP text write/)
  assert.throws(() => manifest({ ...TOOL, params: { target: 'string', payload: 'json' } }), /HTTP text write/)
  assert.throws(() => manifest({ ...TOOL, params: { target: 'string', payload: 'string', method: 'string' } }), /HTTP text write/)
  assert.throws(() => manifest({ ...TOOL, fence: { ...TOOL.fence, headers: { 'x-admin': '1' } } }), /HTTP text write/)
  assert.throws(() => manifest({ ...TOOL, kind: 'read' }), /HTTP text write|read Tool/)
  const legacy = { ...TOOL, fence: { method: 'PUT', completion: TOOL.fence.completion } }
  assert.equal(manifest(legacy)[ID].fence.textWrite, undefined,
    'ordinary HTTP Tools remain ordinary legacy Tools')
})

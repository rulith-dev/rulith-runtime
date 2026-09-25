import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { execute, toolFromSpec, workerToolManifest, workerToolsOf } from '../worker/rulith-worker.mjs'
import { guardCatalogDigest, legacyGuardCatalogDigest, inputAdoptionForTools, toolContractFingerprint } from '../worker/action-input-db.mjs'
import { actionRow, driveWorker, HOLD } from './support/worker-harness.mjs'

const ID = 'qa.note@1'
const profile = { format: 'rulith-http-text-write/1', method: 'PUT', relativePath: '/notes/{target}',
  targetParam: 'target', payloadParam: 'payload', contentType: 'text/plain; charset=utf-8' }
const fence = { method: 'PUT', completion: { stage: 'terminal', statuses: [200], json: { field: 'done', equals: true } },
  textWrite: profile }
const tool = { adapter: 'http', sourceTypes: ['http'], entry: profile.relativePath, kind: 'write',
  params: { target: 'string', payload: 'string' }, returns: [], fence }
const roles = { target: { role: 'grounded' }, payload: { role: 'payload',
  guard: 'rulith.payload.bounded-text@1', guardConfig: { maxBytes: 16_384, mediaType: 'text/plain' } } }
const spec = { impl: 'worker-tool', exec: ID, kind: 'write', sourceTypes: ['http'],
  params: tool.params, returns: [], fence, inputRoles: roles, guardCatalogDigest }
const tools = workerToolsOf({ format: 'rulith-worker-tools/1', tools: { [ID]: tool } })
const descriptor = workerToolManifest(tools)[0]
const sources = { notes: { type: 'http', url: 'http://127.0.0.1:8000/' } }
const compile = (shape = spec, args = { source: 'notes', target: 'record-1', payload: 'text' }, inventory = tools) =>
  toolFromSpec(JSON.stringify(shape), JSON.stringify(args), inventory, inventory[ID].digest, sources, 'notes')

test('HTTP Poll adoption includes fixed entry and fence in the Java-compatible fingerprint and scopes ready Sources', () => {
  assert.equal(descriptor.entry, profile.relativePath)
  assert.deepEqual(descriptor.fence, fence)
  const adoption = inputAdoptionForTools(tools, { ...sources, missing: { type: 'http' },
    wrong: { type: 'db', dsn: 'postgres://fixture' } }, [descriptor])
  assert.deepEqual(adoption?.sourceNamesByExec, { [ID]: ['notes'] })
  assert.deepEqual(adoption?.guardsByKind, { write: ['rulith.value.enum@1', 'rulith.payload.bounded-text@1'] })
  assert.equal(adoption.toolContractsByExec[ID], toolContractFingerprint(descriptor))
  assert.notEqual(toolContractFingerprint(descriptor), toolContractFingerprint({ ...descriptor,
    fence: { ...fence, completion: { ...fence.completion, statuses: [201] } } }))
  assert.equal(inputAdoptionForTools(tools, { notes: { type: 'http', url: 'file:///tmp/notes' } }, [descriptor]), undefined)
  assert.equal(inputAdoptionForTools(tools, sources, [{ ...descriptor, fence: { ...fence, method: 'POST' } }]), undefined)
  assert.equal(inputAdoptionForTools(tools, sources, [{ ...descriptor, entry: '/other/{target}' }]), undefined)
})

test('historical /1 HTTP text Action retains its frozen old catalog digest', () => {
  assert.notEqual(legacyGuardCatalogDigest, guardCatalogDigest)
  assert.equal(compile({ ...spec, guardCatalogDigest: legacyGuardCatalogDigest }).inputRolesV2, true)
})

test('real Worker Poll states the HTTP fence and refuses altered frozen work before ClaimWork', async () => {
  let polls = 0
  const row = actionRow({ tool: 'qa.note', toolContractId: ID, toolDigest: tools[ID].digest,
    sourceRecordId: 'notes', args: JSON.stringify({ source: 'notes', target: 'record-1', payload: 'text' }),
    toolSpec: JSON.stringify({ ...spec, fence: { ...fence, method: 'POST' } }) })
  const run = await driveWorker({ extraTools: { [ID]: tool },
    sources: () => [{ name: 'notes', type: 'http', access: 'http://127.0.0.1:8000/' }],
    reply: operation => operation.kind === 'Poll'
      ? (++polls === 1 ? { body: { accepted: true, payload: { work: [row] } } } : HOLD)
      : { body: { accepted: true } },
    done: (_, output) => /pinned local HTTP text write/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  const poll = run.of('Poll')[0].operation
  assert.deepEqual(poll.tools.find(entry => entry.id === ID).fence, fence)
  assert.deepEqual(poll.inputAdoption, inputAdoptionForTools(tools, sources, [descriptor]))
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(run.of('ReportWork').length, 0)
})

test('legacy row cannot borrow a fixed HTTP text Tool after a real Poll or cause an external effect', async () => {
  let calls = 0
  const server = createServer((_, response) => { calls++; response.end('{"done":true}') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}/`
  let polls = 0
  const row = actionRow({ tool: 'qa.note', toolContractId: ID, toolDigest: tools[ID].digest,
    sourceRecordId: 'notes', args: JSON.stringify({ source: 'notes', target: 'record-1', payload: 'text' }),
    toolSpec: JSON.stringify({ impl: 'worker-tool', exec: ID, kind: 'write',
      sourceTypes: ['http'], params: tool.params, returns: [] }) })
  try {
    const run = await driveWorker({ extraTools: { [ID]: tool },
      sources: () => [{ name: 'notes', type: 'http', access: endpoint }],
      reply: operation => operation.kind === 'Poll'
        ? (++polls === 1 ? { body: { accepted: true, payload: { work: [row] } } } : HOLD)
        : { body: { accepted: true } },
      done: (_, output) => /fixed HTTP text write requires a complete Action v2 contract/.test(output),
    })
    assert.equal(run.timedOut, false, run.output)
    assert.ok(run.of('Poll')[0].operation.inputAdoption?.toolContractsByExec?.[ID])
    assert.equal(run.of('ClaimWork').length, 0)
    assert.equal(run.of('ReportWork').length, 0)
    assert.equal(calls, 0)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('frozen HTTP v2 contract sends bounded text and rejects all alternate controls before the Source', async () => {
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    calls.push({ method: req.method, path: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"done":true}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  sources.notes.url = `http://127.0.0.1:${server.address().port}/`
  try {
    const compiled = compile()
    assert.equal(compiled.inputRolesV2, true)
    assert.equal(compiled.toolContractFingerprint, toolContractFingerprint(descriptor))
    await execute('write', compiled._args, { write: compiled }, sources)
    assert.deepEqual(calls, [{ method: 'PUT', path: '/notes/record-1',
      type: 'text/plain; charset=utf-8', body: Buffer.from('text') }])
    for (const [shape, args] of [
      [{ ...spec, fence: { ...fence, method: 'POST' } }, undefined],
      [{ ...spec, fence: undefined }, undefined],
      [{ ...spec, inputRoles: { ...roles, target: { role: 'payload' } } }, undefined],
      [{ ...spec, inputRoles: { ...roles, payload: { ...roles.payload,
        guardConfig: { maxBytes: 16_385, mediaType: 'text/plain' } } } }, undefined],
      [{ ...spec, inputRoles: undefined }, undefined],
      [spec, { source: 'notes', target: '../escape', payload: 'x' }],
      [spec, { source: 'notes', target: 'safe', payload: 'x', method: 'DELETE' }],
      [spec, { source: 'notes', target: 'safe', payload: 'x', headers: {} }],
      [spec, { source: 'notes', target: 'safe', payload: '界'.repeat(5462) }],
    ]) {
      assert.throws(() => compile(shape, args), /Action v2|HTTP text write|undeclared parameter/)
      assert.equal(calls.length, 1, 'invalid v2 input reached the HTTP Source')
    }
    const changedTool = { ...tools[ID], fence: { ...fence, completion: { ...fence.completion, statuses: [201] } } }
    assert.throws(() => compile(spec, undefined, { [ID]: changedTool }), /digest does not match|pinned local HTTP/)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

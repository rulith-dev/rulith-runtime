import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { databaseDriver, execute, toolFromSpec, workerToolManifest, workerToolsOf } from '../worker/rulith-worker.mjs'
import { fixedUpdateShape, guardCatalogDigest, inputAdoptionForTools, toolContractFingerprint } from '../worker/action-input-db.mjs'
import { actionRow, driveWorker, HOLD } from './support/worker-harness.mjs'

const source = { orders: { type: 'db', dsn: 'postgres://fixture' } }
const write = { adapter: 'db-exec-fenced', sourceTypes: ['db'], kind: 'write',
  entry: 'UPDATE records SET body={body} WHERE id={id} AND version={version} RETURNING id, version',
  params: { id: 'string', version: 'string', body: 'string' },
  returns: [{ predicate: 'acme.record', args: { id: '$id', version: '$version' } }] }
const read = { adapter: 'db-query', sourceTypes: ['db'], kind: 'read',
  entry: 'SELECT status FROM records WHERE id={id} AND status={status}',
  params: { id: 'string', status: 'string' },
  returns: [{ predicate: 'acme.status', args: { status: '$status' } }] }
const tools = workerToolsOf({ format: 'rulith-worker-tools/1', tools: {
  'acme.write@1': write, 'acme.read@1': read,
} })
const descriptors = workerToolManifest(tools)
const adoption = (inventory = tools, sources = source, advertised = descriptors) =>
  inputAdoptionForTools(inventory, sources, advertised)
const roles = { id: { role: 'grounded' }, version: { role: 'grounded' },
  body: { role: 'payload', guard: 'rulith.payload.bounded-text@1',
    guardConfig: { maxBytes: 4, mediaType: 'text/plain' } } }
function compiled(def = tools['acme.write@1'], specChanges = {}, argsChanges = {}) {
  const args = { source: 'orders', id: 'r1', version: 'v1', body: 'é', ...argsChanges }
  const spec = { impl: 'worker-tool', exec: 'acme.write@1', kind: 'write',
    params: write.params, sourceTypes: ['db'], returns: write.returns, inputRoles: roles,
    guardCatalogDigest, ...specChanges }
  return toolFromSpec(JSON.stringify(spec), JSON.stringify(args), { 'acme.write@1': def },
    def.digest, source, 'orders')
}

test('Poll phases require an executable local DB Tool and Source', () => {
  const adoptionBytes = readFileSync(new URL('../protocol/action-input-adoption.json', import.meta.url))
  assert.equal(createHash('sha256').update(adoptionBytes).digest('hex'),
    '0cc5081570904f761be70540bd2fa089edcfffdc1db9e79acb25de0b70a05c86')
  assert.equal(toolContractFingerprint(descriptors.find(row => row.id === 'acme.write@1')),
    'sha256:f6a30a296a45d6cb5559c00f37011908aeae4ddf3a2bd11a84ecc9c4448379dc')
  assert.deepEqual(adoption(), { format: 'rulith-action-inputs/2', guardCatalogDigest,
    guardsByKind: { read: ['rulith.value.enum@1'],
      write: ['rulith.value.enum@1', 'rulith.payload.bounded-text@1'] },
    toolContractsByExec: {
      'acme.read@1': toolContractFingerprint(descriptors.find(row => row.id === 'acme.read@1')),
      'acme.write@1': toolContractFingerprint(descriptors.find(row => row.id === 'acme.write@1')),
    }, sourceNamesByExec: { 'acme.read@1': ['orders'], 'acme.write@1': ['orders'] } })
  assert.equal(adoption(tools, {}), undefined)
  assert.equal(adoption(tools, { orders: { type: 'file', dsn: 'x' } }), undefined)
  assert.equal(adoption(tools, { orders: { type: 'db' } }), undefined)
  assert.deepEqual(adoption(tools, { ...source, offline: { type: 'db' } }).sourceNamesByExec,
    { 'acme.read@1': ['orders'], 'acme.write@1': ['orders'] })
  assert.equal(adoption({ 'acme.write@1': { ...write, adapter: 'run' } }, source,
    descriptors.filter(row => row.id === 'acme.write@1')), undefined)
})

test('optional SQL slots are not advertised and are refused before v2 compilation', () => {
  const optional = { ...write, params: { ...write.params, body: 'string?' } }
  const installed = workerToolsOf({ format: 'rulith-worker-tools/1', tools: { 'acme.optional@1': optional } })
  const advertised = workerToolManifest(installed)
  assert.equal(inputAdoptionForTools(installed, source, advertised), undefined)
  const spec = { impl: 'worker-tool', exec: 'acme.optional@1', kind: 'write',
    params: optional.params, sourceTypes: ['db'], returns: optional.returns,
    inputRoles: roles, guardCatalogDigest }
  assert.throws(() => toolFromSpec(JSON.stringify(spec),
    JSON.stringify({ source: 'orders', id: 'r1', version: 'v1', body: 'ok' }), installed,
    installed['acme.optional@1'].digest, source, 'orders'), /required scalar/)
})

test('real Worker Poll advertises only the DB phases backed by its Source and manifest', async () => {
  const run = await driveWorker({
    extraTools: { 'acme.write@1': write, 'acme.read@1': read },
    sources: () => [{ name: 'orders', type: 'db', access: 'postgres://fixture' }],
    reply: operation => operation.kind === 'Poll' ? { body: { accepted: true, payload: { work: [] } } } : undefined,
    done: seen => seen.some(entry => entry.operation.kind === 'Poll'),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.deepEqual(run.of('Poll')[0].operation.inputAdoption,
    adoption())
})

test('real Worker refuses a signed v2 row whose Tool contract id differs from its local exec before claim', async () => {
  let polls = 0
  const row = actionRow({ tool: 'acme.write', toolContractId: 'acme.other@1',
    toolDigest: tools['acme.write@1'].digest,
    args: JSON.stringify({ source: 'orders', id: 'r1', version: 'v1', body: 'ok' }),
    toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.write@1', kind: 'write',
      params: write.params, sourceTypes: ['db'], returns: write.returns,
      inputRoles: roles, guardCatalogDigest }) })
  const run = await driveWorker({ extraTools: { 'acme.write@1': write },
    sources: () => [{ name: 'orders', type: 'db', access: 'postgres://fixture' }],
    reply: operation => operation.kind === 'Poll'
      ? (++polls === 1 ? { body: { accepted: true, payload: { work: [row] } } } : HOLD)
      : { body: { accepted: true } },
    done: (_, output) => /Tool contract id differs/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(run.of('ReportWork').length, 0)
})

test('real Worker refuses a signed optional-slot v2 row without claiming or reporting', async () => {
  const optional = { ...write, params: { ...write.params, body: 'string?' } }
  const installed = workerToolsOf({ format: 'rulith-worker-tools/1', tools: { 'acme.optional@1': optional } })
  let polls = 0
  const row = actionRow({ tool: 'acme.optional', toolContractId: 'acme.optional@1',
    toolDigest: installed['acme.optional@1'].digest,
    args: JSON.stringify({ source: 'orders', id: 'r1', version: 'v1', body: 'ok' }),
    toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.optional@1', kind: 'write',
      params: optional.params, sourceTypes: ['db'], returns: optional.returns,
      inputRoles: roles, guardCatalogDigest }) })
  const run = await driveWorker({ extraTools: { 'acme.optional@1': optional },
    sources: () => [{ name: 'orders', type: 'db', access: 'postgres://fixture' }],
    reply: operation => operation.kind === 'Poll'
      ? (++polls === 1 ? { body: { accepted: true, payload: { work: [row] } } } : HOLD)
      : { body: { accepted: true } },
    done: (_, output) => /required scalar parameters/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('Poll')[0].operation.inputAdoption, undefined)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(run.of('ReportWork').length, 0)
})

test('a Source learned after Poll cannot enter the frozen v2 readiness set', async () => {
  const sourceRows = [{ name: 'db-b', type: 'db', access: 'postgres://fixture-b' }]
  let polls = 0
  const row = actionRow({ tool: 'acme.write', toolContractId: 'acme.write@1',
    sourceRecordId: 'db-a', toolDigest: tools['acme.write@1'].digest,
    args: JSON.stringify({ source: 'db-a', id: 'r1', version: 'v1', body: 'ok' }),
    toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.write@1', kind: 'write',
      params: write.params, sourceTypes: ['db'], returns: write.returns,
      inputRoles: roles, guardCatalogDigest }) })
  const run = await driveWorker({ extraTools: { 'acme.write@1': write },
    sources: () => sourceRows,
    reply: operation => {
      if (operation.kind !== 'Poll') return { body: { accepted: true } }
      if (++polls > 1) return HOLD
      // This appears at the Source endpoint only after the initial Poll claim
      // was fixed. The Worker refreshes it before trying the work row.
      sourceRows.push({ name: 'db-a', type: 'db', access: 'postgres://fixture-a' })
      return { body: { accepted: true, payload: { work: [row] } } }
    },
    done: (_, output) => /not ready in this Worker generation original Poll adoption/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.deepEqual(run.of('Poll')[0].operation.inputAdoption.sourceNamesByExec,
    { 'acme.write@1': ['db-b'] })
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(run.of('ReportWork').length, 0)
})

test('write v2 compiles only fixed SQL and exact typed payload bytes', () => {
  const result = compiled()
  assert.equal(result.sql, 'UPDATE records SET body=$1 WHERE id=$2 AND version=$3 RETURNING id, version')
  assert.deepEqual(result.values, ['é', 'r1', 'v1'])
  assert.equal(result.inputRolesV2, true)
  assert.throws(() => compiled(undefined, {}, { body: 'ééé' }), /UTF-8 byte limit/)
  assert.throws(() => compiled(undefined, { guardCatalogDigest: 'sha256:' + '0'.repeat(64) }), /catalog digest/)
  assert.throws(() => compiled(undefined, { kind: 'run' }), /database Tool contract/)
  assert.throws(() => compiled(undefined, { sourceTypes: ['file'] }), /database Tool contract|Source/)
  assert.throws(() => compiled(undefined, { params: { ...write.params, body: 'json' } }), /database Tool contract/)
  assert.throws(() => compiled(undefined, { inputRoles: { ...roles,
    id: { role: 'payload', guard: 'rulith.payload.bounded-text@1', guardConfig: { maxBytes: 5, mediaType: 'text/plain' } } } }),
  /grounded target\/version/)
  assert.deepEqual(fixedUpdateShape(write.entry),
    { set: ['body'], where: ['id', 'version'], columns: ['id', 'version'] })
  assert.equal(fixedUpdateShape('UPDATE records SET body={body} WHERE id={id}'), undefined)
  assert.equal(fixedUpdateShape('UPDATE records SET body={body} WHERE id={id} AND version={version}; DELETE FROM records'), undefined)
})

test('read enum is exact and does not coerce string 42', () => {
  const def = tools['acme.read@1']
  const spec = { impl: 'worker-tool', exec: 'acme.read@1', kind: 'read', params: read.params,
    sourceTypes: ['db'], returns: read.returns, inputRoles: { id: { role: 'grounded' },
      status: { role: 'scoped', guard: 'rulith.value.enum@1', guardConfig: { values: ['42', 'open'] } } },
    guardCatalogDigest }
  const resolve = value => toolFromSpec(JSON.stringify(spec), JSON.stringify({ source: 'orders', id: 'r1', status: value }),
    { 'acme.read@1': def }, def.digest, source, 'orders')
  assert.deepEqual(resolve('42').values, ['r1', '42'])
  assert.throws(() => resolve(42), /must be string|outside its exact type/)
  assert.throws(() => resolve('closed'), /outside its exact type or range/)
})

test('read v2 reports only the database row and keeps its exact enum argument', async () => {
  const def = tools['acme.read@1']
  const spec = { impl: 'worker-tool', exec: 'acme.read@1', kind: 'read', params: read.params,
    sourceTypes: ['db'], returns: read.returns, inputRoles: { id: { role: 'grounded' },
      status: { role: 'scoped', guard: 'rulith.value.enum@1', guardConfig: { values: ['42', 'open'] } } },
    guardCatalogDigest }
  const tool = toolFromSpec(JSON.stringify(spec), JSON.stringify({ source: 'orders', id: 'r1', status: '42' }),
    { 'acme.read@1': def }, def.digest, source, 'orders')
  const original = databaseDriver.run
  try {
    databaseDriver.run = async (_dsn, sql, values) => {
      assert.equal(sql, 'SELECT status FROM records WHERE id=$1 AND status=$2')
      assert.deepEqual(values, ['r1', '42'])
      return { rows: [{ status: 'closed' }], rowCount: 1, command: 'SELECT' }
    }
    const result = await execute('acme.read@1', {}, { 'acme.read@1': tool }, source)
    assert.deepEqual(result.facts, [{ predicate: 'acme.status', args: { status: 'closed' } }])
    assert.match(result.result, /"status":"closed"/)
  } finally { databaseDriver.run = original }
})

test('v2 UPDATE reports zero as failure and multi or unknown outcome as undeliverable', async () => {
  const tool = compiled()
  const original = databaseDriver.run
  try {
    for (const [rowCount, command, pattern] of [
      [0, 'UPDATE', /matched zero rows/], [2, 'UPDATE', /affected multiple rows/],
      [undefined, 'UPDATE', /effect is unknown/], [1, 'INSERT', /effect is unknown/],
    ]) {
      databaseDriver.run = async () => ({ rows: [{ id: 'r1', version: 'v1' }], rowCount, command })
      await assert.rejects(execute('acme.write@1', {}, { 'acme.write@1': tool }, source), pattern)
    }
    databaseDriver.run = async () => ({ rows: [{ id: 'r1', version: 'v2' }], rowCount: 1, command: 'UPDATE' })
    assert.deepEqual(await execute('acme.write@1', {}, { 'acme.write@1': tool }, source),
      { result: 'sql:constructive update ok rows=1 UPDATE',
        facts: [{ predicate: 'acme.record', args: { id: 'r1', version: 'v2' } }] })
    databaseDriver.run = async () => { throw new Error('connection closed after query submission') }
    await assert.rejects(execute('acme.write@1', {}, { 'acme.write@1': tool }, source), /outcome is unknown/)
  } finally { databaseDriver.run = original }
})

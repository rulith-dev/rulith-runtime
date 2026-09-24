import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { databaseDriver, execute, pgRunReadOnlyWithClient, pgRunV2UpdateWithClient, toolFromSpec, workerToolManifest, workerToolsOf } from '../worker/rulith-worker.mjs'
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

test('legacy database write is refused before ClaimWork and cannot leave an uncertain SQL effect', async () => {
  const spec = { impl: 'worker-tool', exec: 'acme.write@1', kind: 'write',
    params: write.params, sourceTypes: ['db'], returns: write.returns, inputPolicy: 'grounded' }
  const args = { source: 'orders', id: 'r1', version: 'v1', body: 'ok' }
  assert.throws(() => toolFromSpec(JSON.stringify(spec), JSON.stringify(args), tools,
    tools['acme.write@1'].digest, source, 'orders'), /requires v2 input roles/)
  let polls = 0
  const row = actionRow({ tool: 'acme.write', toolContractId: 'acme.write@1',
    sourceRecordId: 'orders', toolDigest: tools['acme.write@1'].digest,
    args: JSON.stringify(args), toolSpec: JSON.stringify(spec) })
  const run = await driveWorker({ extraTools: { 'acme.write@1': write },
    sources: () => [{ name: 'orders', type: 'db', access: 'postgres://fixture' }],
    reply: operation => operation.kind === 'Poll'
      ? (++polls === 1 ? { body: { accepted: true, payload: { work: [row] } } } : HOLD)
      : { body: { accepted: true } },
    done: (_, output) => /requires v2 input roles/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(run.of('ReportWork').length, 0)
})

test('a database mutation cannot advertise or execute under a read Tool kind', () => {
  assert.throws(() => workerToolsOf({ format: 'rulith-worker-tools/1', tools: {
    'acme.spoof@1': { ...write, kind: 'read' },
  } }), /kind conflicts with the db-exec-fenced/)
  assert.throws(() => workerToolsOf({ format: 'rulith-worker-tools/1', tools: {
    'acme.spoof@1': { ...read, kind: 'write' },
  } }), /kind conflicts with the db-query/)
  const spec = { impl: 'worker-tool', exec: 'acme.write@1', kind: 'read',
    params: write.params, sourceTypes: ['db'], returns: write.returns, inputPolicy: 'clue' }
  assert.throws(() => toolFromSpec(JSON.stringify(spec), JSON.stringify({
    source: 'orders', id: 'r1', version: 'v1', body: 'ok',
  }), tools, tools['acme.write@1'].digest, source, 'orders'),
  /kind differs from its pinned local implementation/)
})

test('a run or other process adapter cannot borrow a database Source under any Tool kind', () => {
  const processTool = { adapter: 'run', sourceTypes: ['db'], kind: 'run',
    entry: process.execPath, params: {}, returns: [] }
  assert.throws(() => workerToolsOf({ format: 'rulith-worker-tools/1', tools: {
    'acme.process@1': processTool,
  } }), /database Sources require a fixed-SQL adapter/)
  const spec = { impl: 'worker-tool', exec: 'acme.process@1', kind: 'run',
    sourceTypes: ['db'], params: {}, returns: [] }
  assert.throws(() => toolFromSpec(JSON.stringify(spec), JSON.stringify({ source: 'orders' }),
    { 'acme.process@1': processTool }, undefined, source, 'orders'),
  /cannot use a database Source without a fixed-SQL adapter/)
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
  assert.throws(() => compiled(undefined, { kind: 'run' }), /kind differs from its pinned local implementation/)
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
  const original = databaseDriver.runReadOnly
  try {
    databaseDriver.runReadOnly = async (_dsn, sql, values) => {
      assert.equal(sql, 'SELECT status FROM records WHERE id=$1 AND status=$2')
      assert.deepEqual(values, ['r1', '42'])
      return { rows: [{ status: 'closed' }], rowCount: 1, command: 'SELECT' }
    }
    const result = await execute('acme.read@1', {}, { 'acme.read@1': tool }, source)
    assert.deepEqual(result.facts, [{ predicate: 'acme.status', args: { status: 'closed' } }])
    assert.match(result.result, /"status":"closed"/)
  } finally { databaseDriver.runReadOnly = original }
})

test('db-query starts a PostgreSQL read-only transaction before its SELECT', async () => {
  const def = tools['acme.read@1']
  const spec = { impl: 'worker-tool', exec: 'acme.read@1', kind: 'read', params: read.params,
    sourceTypes: ['db'], returns: read.returns, inputRoles: { id: { role: 'grounded' },
      status: { role: 'scoped', guard: 'rulith.value.enum@1', guardConfig: { values: ['open'] } } },
    guardCatalogDigest }
  const tool = toolFromSpec(JSON.stringify(spec), JSON.stringify({ source: 'orders', id: 'r1', status: 'open' }),
    { 'acme.read@1': def }, def.digest, source, 'orders')
  const original = databaseDriver.runReadOnly
  try {
    const client = { calls: [],
      async connect() { this.calls.push('connect') },
      async query(query) {
        const step = typeof query === 'string' ? query : query.text
        this.calls.push(step)
        if (step.startsWith('SELECT')) return { rows: [{ status: 'closed' }], rowCount: 1, command: 'SELECT' }
        return {}
      },
      async end() { this.calls.push('end') },
    }
    databaseDriver.runReadOnly = async (dsn, sql, values) => {
      assert.equal(dsn, 'postgres://fixture')
      assert.deepEqual(values, ['r1', 'open'])
      return pgRunReadOnlyWithClient(client, sql, values)
    }
    const result = await execute('acme.read@1', {}, { 'acme.read@1': tool }, source)
    assert.deepEqual(result.facts, [{ predicate: 'acme.status', args: { status: 'closed' } }])
    assert.deepEqual(client.calls, ['connect', 'BEGIN READ ONLY',
      'SELECT status FROM records WHERE id=$1 AND status=$2', 'COMMIT', 'end'])
  } finally { databaseDriver.runReadOnly = original }
})

test('a mutating SELECT is rejected by the read-only transaction and rolled back', async () => {
  const client = { calls: [], readOnly: false,
    async connect() { this.calls.push('connect') },
    async query(query) {
      const step = typeof query === 'string' ? query : query.text
      this.calls.push(step)
      if (step === 'BEGIN READ ONLY') this.readOnly = true
      if (step === 'SELECT nextval($1)') {
        assert.equal(this.readOnly, true)
        throw new Error('cannot execute nextval() in a read-only transaction')
      }
      return {}
    },
    async end() { this.calls.push('end') },
  }
  await assert.rejects(pgRunReadOnlyWithClient(client, 'SELECT nextval($1)', ['orders_seq']),
    /cannot execute nextval\(\) in a read-only transaction/)
  assert.deepEqual(client.calls, ['connect', 'BEGIN READ ONLY', 'SELECT nextval($1)', 'ROLLBACK', 'end'])
})

function fakePgClient(updateResult, failures = {}) {
  const calls = []
  return { calls,
    async connect() { calls.push('connect') },
    async query(query) {
      const step = typeof query === 'string' ? query : 'UPDATE'
      calls.push(step)
      if (failures[step]) throw new Error(failures[step])
      return step === 'UPDATE' ? updateResult : {}
    },
    async end() { calls.push('end'); if (failures.end) throw new Error(failures.end) },
  }
}

test('v2 UPDATE validates the effect and returned facts before COMMIT', async () => {
  const tool = compiled()
  const originalRun = databaseDriver.run
  const originalV2 = databaseDriver.runV2Update
  try {
    databaseDriver.run = async () => { throw new Error('v2 must not use the autocommit driver') }
    for (const [raw, pattern] of [
      [{ rows: [], rowCount: 0, command: 'UPDATE' }, /matched zero rows/],
      [{ rows: [{ id: 'r1', version: 'v2' }, { id: 'r2', version: 'v2' }], rowCount: 2, command: 'UPDATE' }, /exactly one UPDATE row/],
      [{ rows: [{ id: 'r1', version: 'v2' }], rowCount: undefined, command: 'UPDATE' }, /exactly one UPDATE row/],
      [{ rows: [{ id: 'r1', version: 'v2' }], rowCount: 1, command: 'INSERT' }, /exactly one UPDATE row/],
      [{ rows: [], rowCount: 1, command: 'UPDATE' }, /exactly one result row/],
      [{ rows: [{ id: 'r1' }], rowCount: 1, command: 'UPDATE' }, /missing scalar column version/],
    ]) {
      const client = fakePgClient(raw)
      databaseDriver.runV2Update = async (dsn, sql, values, validate) => {
        assert.equal(dsn, 'postgres://fixture')
        assert.equal(sql, 'UPDATE records SET body=$1 WHERE id=$2 AND version=$3 RETURNING id, version')
        assert.deepEqual(values, ['é', 'r1', 'v1'])
        return pgRunV2UpdateWithClient(client, sql, values, validate)
      }
      await assert.rejects(execute('acme.write@1', {}, { 'acme.write@1': tool }, source), error => {
        assert.match(error.message, pattern)
        assert.equal(error.constructor.name, 'Error')
        return true
      })
      assert.deepEqual(client.calls, ['connect', 'BEGIN', 'UPDATE', 'ROLLBACK', 'end'])
    }
    const client = fakePgClient({ rows: [{ id: 'r1', version: 'v2' }], rowCount: 1, command: 'UPDATE' })
    databaseDriver.runV2Update = async (_dsn, sql, values, validate) => pgRunV2UpdateWithClient(client, sql, values, validate)
    assert.deepEqual(await execute('acme.write@1', {}, { 'acme.write@1': tool }, source),
      { result: 'sql:constructive update ok rows=1 UPDATE',
        facts: [{ predicate: 'acme.record', args: { id: 'r1', version: 'v2' } }] })
    assert.deepEqual(client.calls, ['connect', 'BEGIN', 'UPDATE', 'COMMIT', 'end'])
  } finally { databaseDriver.run = originalRun; databaseDriver.runV2Update = originalV2 }
})

test('v2 UPDATE distinguishes confirmed rollback from ambiguous database outcome', async () => {
  const tool = compiled()
  const originalV2 = databaseDriver.runV2Update
  try {
    for (const [raw, failures, pattern, errorType, calls] of [
      [{ rows: [], rowCount: 0, command: 'UPDATE' }, { ROLLBACK: 'connection lost' }, /outcome is unknown because ROLLBACK was not confirmed/, 'ResultDeliveryError', ['connect', 'BEGIN', 'UPDATE', 'ROLLBACK', 'end']],
      [{ rows: [{ id: 'r1', version: 'v2' }], rowCount: 1, command: 'UPDATE' }, { COMMIT: 'connection lost' }, /outcome is unknown after COMMIT/, 'ResultDeliveryError', ['connect', 'BEGIN', 'UPDATE', 'COMMIT', 'end']],
      [undefined, { UPDATE: 'constraint failed' }, /constraint failed/, 'Error', ['connect', 'BEGIN', 'UPDATE', 'ROLLBACK', 'end']],
    ]) {
      const client = fakePgClient(raw, failures)
      databaseDriver.runV2Update = async (_dsn, sql, values, validate) => pgRunV2UpdateWithClient(client, sql, values, validate)
      await assert.rejects(execute('acme.write@1', {}, { 'acme.write@1': tool }, source), error => {
        assert.match(error.message, pattern)
        assert.equal(error.constructor.name, errorType)
        return true
      })
      assert.deepEqual(client.calls, calls)
    }
    const client = fakePgClient({ rows: [{ id: 'r1', version: 'v2' }], rowCount: 1, command: 'UPDATE' }, { end: 'connection lost after COMMIT' })
    databaseDriver.runV2Update = async (_dsn, sql, values, validate) => pgRunV2UpdateWithClient(client, sql, values, validate)
    const result = await execute('acme.write@1', {}, { 'acme.write@1': tool }, source)
    assert.equal(result.facts[0].args.version, 'v2')
    assert.deepEqual(client.calls, ['connect', 'BEGIN', 'UPDATE', 'COMMIT', 'end'])
  } finally { databaseDriver.runV2Update = originalV2 }
})

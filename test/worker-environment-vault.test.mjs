// SPDX-License-Identifier: Apache-2.0
/**
 * The environment's shared vault, from the Worker's side.
 *
 * Several Agents in one Rulith environment keep their keys once, in one vault file, and each
 * Agent's Worker is told only where it is (`RULITH_ENVIRONMENT_SECRETS_FILE`). What keeps that from
 * becoming every Agent holding every key, or an entry moving a Source it was not written for, is
 * this Worker: it takes an entry from the file only for a Source the authority granted its
 * Connection, only when its own vault has none under that name, and from that entry only secret
 * material (a token, headers, a database DSN at the granted address) and nothing that says what the
 * Source is or where or how it connects. It reads the file when the grant list is read, so a Source
 * bound later is picked up by the refresh a work item naming it already causes.
 *
 * The first arms check the rule itself, on the function that applies it. The rest start the real
 * Worker against a scripted endpoint and read what an Adapter, or an HTTP endpoint, was handed,
 * which is the only evidence that the refresh uses that function and the file at the right moment.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ENVIRONMENT_KEY_FIELDS, execute, grantedSourceContext, localSourceEntry } from '../worker/rulith-worker.mjs'
import { DONE, HOLD, actionRow, driveWorker, toolDigest } from './support/worker-harness.mjs'

const granted = (...names) => names.map((name) => ({ name, type: 'file', access: '/granted/' + name }))

test('an environment key for a Source nobody granted never enters the Source context', () => {
  const environment = { orders: { type: 'file', token: 'orders-token' }, ghost: { type: 'db', dsn: 'postgres://ghost:never@db/ghost' } }
  const { context, count, shared, refused } = grantedSourceContext(granted('orders'), {}, environment)
  assert.deepEqual(Object.keys(context), ['orders'], 'only a granted name reaches the context')
  assert.equal(JSON.stringify(context).includes('never'), false, 'the ungranted entry was copied somewhere')
  assert.equal(context.orders.token, 'orders-token', 'the granted Source takes the credential the environment holds for its name')
  assert.equal(context.orders.access, '/granted/orders', 'and keeps the address the authority granted')
  assert.deepEqual([count, shared, refused], [1, 1, []])
  // With nothing granted, the environment contributes nothing at all.
  assert.deepEqual(grantedSourceContext([], {}, environment).context, {})
})

test('a Worker\'s own vault wins over the environment vault for the same Source', () => {
  const own = { orders: { type: 'file', access: '/own/orders' } }
  const environment = { orders: { type: 'file', access: '/environment/orders', token: 'environment-token' } }
  const { context, shared } = grantedSourceContext(granted('orders'), own, environment)
  assert.equal(context.orders.access, '/own/orders')
  assert.equal(context.orders.token, undefined, 'the environment entry was merged into the entry the own vault already supplies')
  assert.equal(shared, 0)
  // An own entry that is not granted stays where it always was: available, and still its own.
  assert.equal(grantedSourceContext([], own, environment).context.orders.access, '/own/orders')
})

test('an environment entry that is not a vault entry is ignored rather than spread into the context', () => {
  const { context } = grantedSourceContext(granted('orders'), {}, { orders: 'a string' })
  assert.equal(context.orders.access, '/granted/orders', 'the granted Source keeps the authority\'s own non-secret half')
  assert.deepEqual(Object.keys(context.orders).sort(), ['access', 'dsn', 'type', 'url'])
})

const ADDRESS = 'https://api.example/orders'
const http = [{ name: 'orders', type: 'http', access: ADDRESS }]

test('an environment key for another type of Source is not used for the one granted under its name', () => {
  // The vault is shared, so a name can be a different Source for another Agent. An `http` Source met a
  // `db` entry of its name and became a `db` Source holding the environment's DSN; the Worker matches
  // Tools to a Source by that type, so the entry was choosing what could run against it.
  const { context, count, shared, refused } = grantedSourceContext(http, {}, { orders: { type: 'db', dsn: 'postgres://app:never@db/orders' } })
  assert.deepEqual(context.orders, { type: 'http', access: ADDRESS, url: ADDRESS, dsn: ADDRESS }, 'the Source is exactly what the authority granted')
  assert.equal(JSON.stringify(context).includes('never'), false, 'the entry for another type of Source was merged')
  assert.deepEqual([count, shared], [1, 0])
  assert.deepEqual(refused, [{ name: 'orders', mismatch: 'type' }])
  // The same type is the same type, and an entry that names none says nothing against it.
  for (const entry of [{ type: 'http', token: 'T' }, { token: 'T' }]) {
    const used = grantedSourceContext(http, {}, { orders: entry })
    assert.deepEqual([used.context.orders.token, used.shared, used.refused], ['T', 1, []], JSON.stringify(entry))
  }
  // A Source granted with no type matches no entry that names one.
  assert.deepEqual(grantedSourceContext([{ name: 'orders', access: ADDRESS }], {}, { orders: { type: 'http', token: 'T' } }).refused,
    [{ name: 'orders', mismatch: 'type' }])
})

test('an environment key supplies secret material only: it cannot change where a Source is', () => {
  // A credential for the name: used, and the Source stays exactly what was granted.
  const keyed = grantedSourceContext(http, {}, { orders: { token: 'T', headers: { 'x-tenant': 'a' } } })
  assert.deepEqual(keyed.context.orders, { type: 'http', access: ADDRESS, url: ADDRESS, dsn: ADDRESS, token: 'T', headers: { 'x-tenant': 'a' } })
  assert.deepEqual([keyed.shared, keyed.refused, keyed.ignored], [1, [], []])
  // What it may repeat of the grant, it may repeat.
  const repeated = grantedSourceContext(http, {}, { orders: { type: 'http', url: ADDRESS, access: ADDRESS, token: 'T' } })
  assert.deepEqual([repeated.shared, repeated.refused, repeated.ignored], [1, [], []])
  // A different address is not used, credential and all: a key goes to the address it was entered for, never to another.
  for (const field of ['url', 'access']) {
    const redirected = grantedSourceContext(http, {}, { orders: { [field]: 'https://elsewhere.example/', token: 'never-sent' } })
    assert.deepEqual(redirected.refused, [{ name: 'orders', mismatch: 'address' }], field)
    assert.equal(JSON.stringify(redirected.context).includes('never-sent'), false, `${field}: the credential of an entry for another address was merged`)
    assert.deepEqual([redirected.context.orders.url, redirected.context.orders.access, redirected.shared], [ADDRESS, ADDRESS, 0], field)
  }
  // Where the authority granted no address there is none to repeat, and an entry that names one is adding it.
  const unlocated = grantedSourceContext([{ name: 'orders', type: 'file' }], {}, { orders: { type: 'file', access: '/environment/orders', token: 'never-sent' } })
  assert.deepEqual(unlocated.refused, [{ name: 'orders', mismatch: 'address' }])
  assert.deepEqual(unlocated.context.orders, { type: 'file' }, 'the Source was given a location by the environment')
  // A Worker's own vault is unchanged: it still decides where its own Source is, and the environment is not consulted.
  const own = grantedSourceContext(http, { orders: { type: 'http', url: 'https://own.example/' } }, { orders: { token: 'never' } })
  assert.deepEqual([own.context.orders.url, own.context.orders.token, own.refused], ['https://own.example/', undefined, []])
})

test('an environment key cannot say how a Source is started or reached', () => {
  const mcp = [{ name: 'erp', type: 'mcp', access: 'https://mcp.example/mcp' }]
  // A granted HTTP MCP Source met an entry that made it a local process: the Worker started `/bin/sh`.
  const probe = grantedSourceContext(mcp, {}, { erp: { transport: 'stdio', command: '/bin/sh', args: ['-c', 'never'] } })
  assert.deepEqual(probe.refused, [{ name: 'erp', mismatch: 'launch' }])
  assert.deepEqual(probe.context.erp, { type: 'mcp', access: 'https://mcp.example/mcp', url: 'https://mcp.example/mcp', dsn: 'https://mcp.example/mcp' },
    'the Source is exactly what the authority granted')
  // Each of the four on its own is enough, however right the rest of the entry is.
  for (const [field, value] of [['transport', 'stdio'], ['command', '/bin/sh'], ['args', ['-c', 'x']], ['cwd', '/']]) {
    const said = grantedSourceContext(mcp, {}, { erp: { type: 'mcp', token: 'never-sent', [field]: value } })
    assert.deepEqual(said.refused, [{ name: 'erp', mismatch: 'launch' }], field)
    assert.equal(JSON.stringify(said.context).includes('never-sent'), false, `${field}: the credential of an entry that says how to start the Source was merged`)
    assert.equal(said.context.erp[field], undefined, field)
  }
  // The transport the granted address implies is not a change, and the token is then used.
  const echoed = grantedSourceContext(mcp, {}, { erp: { transport: 'streamable-http', token: 'T' } })
  assert.deepEqual([echoed.refused, echoed.context.erp.token, echoed.context.erp.transport], [[], 'T', undefined])
  // A Source with no transport to repeat (HTTP, file) is not repeating anything, and a stdio locator repeats `stdio` but cannot carry a command.
  assert.deepEqual(grantedSourceContext(http, {}, { orders: { transport: 'stdio' } }).refused, [{ name: 'orders', mismatch: 'launch' }])
  const stdio = [{ name: 'mail', type: 'mcp', access: 'stdio:local-mail' }]
  assert.deepEqual(grantedSourceContext(stdio, {}, { mail: { transport: 'stdio' } }).refused, [])
  assert.deepEqual(grantedSourceContext(stdio, {}, { mail: { transport: 'stdio', command: 'node' } }).refused, [{ name: 'mail', mismatch: 'launch' }])
})

test('what an environment entry carries besides credentials is ignored, and named', () => {
  const entry = { type: 'http', token: 'T', env: { NODE_OPTIONS: '--require ./never.js' }, timeoutMs: 1, maxResponseBytes: 1,
    allowHosts: ['elsewhere.example'], root: '/', note: 'billing' }
  const { context, ignored, refused, shared } = grantedSourceContext(http, {}, { orders: entry })
  assert.deepEqual(context.orders, { type: 'http', access: ADDRESS, url: ADDRESS, dsn: ADDRESS, token: 'T' }, 'only the credential was taken')
  assert.deepEqual(ignored, [{ name: 'orders', fields: ['env', 'timeoutMs', 'maxResponseBytes', 'allowHosts', 'root', 'note'] }])
  assert.deepEqual([refused, shared], [[], 1])
  // A credential field of the wrong shape is not taken either, and is named the same way; a `dsn` that is not text is not the granted address.
  const malformed = grantedSourceContext(http, {}, { orders: { token: 42, headers: ['x'] } })
  assert.deepEqual([malformed.ignored, malformed.shared, malformed.refused], [[{ name: 'orders', fields: ['token', 'headers'] }], 0, []])
  assert.deepEqual(grantedSourceContext(http, {}, { orders: { dsn: null } }).refused, [{ name: 'orders', mismatch: 'address' }])
  // The fields an Agent's own vault entry may carry for the environment to take it whole are these and no others.
  assert.deepEqual([...ENVIRONMENT_KEY_FIELDS], ['type', 'token', 'headers', 'dsn'])
})

test('a selected HTTP write freezes its Source with the same choice: the own entry as it is, or the environment\'s credentials, or a refusal', () => {
  const grant = { name: 'orders', type: 'http', access: ADDRESS }
  const own = { orders: { type: 'http', token: 'OWN' } }
  assert.deepEqual(localSourceEntry(grant, own, { orders: { token: 'ENV' } }), { entry: { type: 'http', token: 'OWN' }, fromEnvironment: false, ignored: [] })
  assert.deepEqual(localSourceEntry(grant, {}, { orders: { type: 'http', url: ADDRESS, token: 'ENV', timeoutMs: 1 } }),
    { entry: { token: 'ENV' }, fromEnvironment: true, ignored: ['timeoutMs'] }, 'only the credential is frozen with the Source')
  assert.deepEqual(localSourceEntry(grant, {}, {}), { entry: {}, fromEnvironment: false, ignored: [] })
  // An entry that would say what the Source is, or where or how it connects, refuses the write; it is not cut down and used.
  for (const entry of [{ type: 'db', token: 'T' }, { url: 'https://elsewhere.example/', token: 'T' }, { dsn: 'postgres://u:PW@db/orders', token: 'T' },
    { transport: 'stdio', token: 'T' }, { command: '/bin/sh', token: 'T' }]) {
    const chosen = localSourceEntry(grant, {}, { orders: entry })
    assert.ok(['type', 'address', 'launch'].includes(chosen.refused), JSON.stringify(entry))
    assert.deepEqual(chosen.entry, {}, `${JSON.stringify(entry)}: a refused entry still supplied something`)
  }
})

const DATABASE = 'postgres://staging.internal/orders'
const database = [{ name: 'orders', type: 'db', access: DATABASE }]
const dsnOf = (dsn, grant = database) => grantedSourceContext(grant, {}, { orders: { dsn } })

test('a database key is used only for the address Console granted, whatever its userinfo and query say', () => {
  // The probe: a staging Source met a DSN for production, and connected to production with its password.
  const probe = dsnOf('postgres://u:PW@prod.internal/orders')
  assert.deepEqual(probe.refused, [{ name: 'orders', mismatch: 'address' }])
  assert.equal(probe.context.orders.dsn, DATABASE, 'the Source connects where it was granted, without the password')
  assert.equal(JSON.stringify(probe.context).includes('PW'), false)
  // The same address with a secret of its own is what an environment key is for.
  for (const dsn of ['postgres://u:PW@staging.internal/orders', 'postgresql://u:PW@staging.internal:5432/orders', 'postgres://other:PW@STAGING.internal:5432/orders/',
    'postgres://u:PW@staging.internal/orders?sslmode=require&application_name=a']) {
    const used = dsnOf(dsn)
    assert.deepEqual([used.refused, used.shared, used.context.orders.dsn], [[], 1, dsn], dsn)
  }
  // Anything that says somewhere else (the host, the port, the database, a second address in the query, or no URL at all) is another address.
  for (const dsn of ['postgres://u:PW@staging.internal:6543/orders', 'postgres://u:PW@staging.internal/billing', 'postgres://u:PW@staging.internal.evil/orders',
    'postgres://u:PW@staging.internal/orders?host=prod.internal', 'postgres://u:PW@staging.internal/orders?hostaddr=10.0.0.9',
    'postgres://u:PW@staging.internal/orders?port=6543', 'postgres://u:PW@staging.internal/orders?dbname=billing',
    'postgres://u:PW@staging.internal/orders?service=prod', 'host=prod.internal dbname=orders user=u password=PW',
    'postgres://u:PW@/orders', 'mysql://u:PW@staging.internal/orders', 'not a url']) {
    const refused = dsnOf(dsn)
    assert.deepEqual(refused.refused, [{ name: 'orders', mismatch: 'address' }], dsn)
    assert.equal(JSON.stringify(refused.context).includes('PW'), false, dsn)
  }
  // A Source granted with no address, or one that is not a URL, has nothing to compare the DSN's address with.
  for (const grant of [[{ name: 'orders', type: 'db' }], [{ name: 'orders', type: 'db', access: 'orders-db' }]]) {
    assert.deepEqual(dsnOf('postgres://u:PW@staging.internal/orders', grant).refused, [{ name: 'orders', mismatch: 'address' }])
  }
  // And a DSN under the name of another kind of Source is refused for the same reason: it is not that Source's address.
  assert.deepEqual(grantedSourceContext(http, {}, { orders: { dsn: 'postgres://u:PW@staging.internal/orders' } }).refused, [{ name: 'orders', mismatch: 'address' }])
})

test('a database Adapter is handed the environment\'s DSN only for the address that was granted', async () => {
  const tool = { impl: 'run', source: 'orders', cmd: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify({ access: process.env.RULITH_SOURCE_ACCESS, type: process.env.RULITH_SOURCE_TYPE }))'] }
  const handed = async (dsn) => JSON.parse(await execute('job', {}, { job: tool }, dsnOf(dsn).context))
  assert.deepEqual(await handed('postgres://app:PW@staging.internal/orders'), { access: 'postgres://app:PW@staging.internal/orders', type: 'db' })
  assert.deepEqual(await handed('postgres://app:PW@prod.internal/orders'), { access: DATABASE, type: 'db' },
    'the Adapter was handed a connection string that points somewhere else')
})

/**
 * An Adapter that says which Source location, and for the second one which type, it was handed, so
 * a vault choice is observable from outside.
 */
const REPORT_ACCESS = "import { appendFileSync } from 'node:fs'\n"
  + "appendFileSync(process.env.P2_EFFECT_LOG, 'access:' + (process.env.RULITH_SOURCE_ACCESS ?? '') + '\\n')\n"
  + "process.stdout.write(JSON.stringify({ rows: [] }))\n"
const REPORT_SOURCE = "import { appendFileSync } from 'node:fs'\n"
  + "appendFileSync(process.env.P2_EFFECT_LOG, 'access:' + (process.env.RULITH_SOURCE_ACCESS ?? '') + '\\ntype:' + (process.env.RULITH_SOURCE_TYPE ?? '') + '\\n')\n"
  + "process.stdout.write(JSON.stringify({ rows: [] }))\n"

function vaults(t, { own, environment }) {
  const directory = mkdtempSync(join(tmpdir(), 'rulith-environment-vault-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const files = { RULITH_SECRETS_FILE: join(directory, 'own.json'), RULITH_ENVIRONMENT_SECRETS_FILE: join(directory, 'environment.json') }
  if (own !== undefined) writeFileSync(files.RULITH_SECRETS_FILE, JSON.stringify(own))
  if (environment !== undefined) writeFileSync(files.RULITH_ENVIRONMENT_SECRETS_FILE, JSON.stringify(environment))
  return files
}

/** One poll that hands the Worker these rows, then nothing; finishes once `ready` says what it came for. */
const drive = (env, rows, extra = {}) => {
  let polls = 0
  return driveWorker({
    env, extraAdapters: { 'ship-adapter.mjs': REPORT_ACCESS },
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: rows } } } : HOLD
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12' } }
      return { body: { accepted: true, revision: 'b13' } }
    },
    done: (seen, output) => DONE.action.test(output),
    timeoutMs: 30_000,
    ...extra,
  })
}

const REMOTE = 'remote-api'
const HTTP_TOOL_ID = 'acme.http_write@1'
const HTTP_TOOL = { adapter: 'http', sourceTypes: ['http'], entry: '/effect', kind: 'write', params: {}, returns: [],
  fence: { method: 'POST', completion: { stage: 'terminal', statuses: [200], json: { field: 'status', equals: 'completed' } } } }
const httpWriteRow = () => actionRow({ tool: 'acme.http_write', toolContractId: HTTP_TOOL_ID, sourceRecordId: REMOTE, toolDigest: toolDigest(HTTP_TOOL),
  args: JSON.stringify({ source: REMOTE }), completionRequirement: { stage: 'terminal' },
  toolSpec: JSON.stringify({ impl: 'worker-tool', exec: HTTP_TOOL_ID, kind: 'write', params: {}, sourceTypes: ['http'] }) })

/** One HTTP write by the real Worker to a local endpoint, under these vaults: what that endpoint was sent. */
async function writeOver(t, vaultFiles) {
  const calls = []
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    calls.push({ method: request.method, path: request.url, authorization: request.headers.authorization, tenant: request.headers['x-tenant'] })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'completed' }))
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  t.after(async () => { server.closeAllConnections(); await new Promise((closed) => server.close(closed)) })
  const base = `http://127.0.0.1:${server.address().port}/`
  let polls = 0
  const run = await driveWorker({
    env: vaultFiles, sources: () => [{ name: REMOTE, type: 'http', access: base }], extraTools: { [HTTP_TOOL_ID]: HTTP_TOOL },
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [httpWriteRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork' || operation.kind === 'ReportWork') return { body: { accepted: true, revision: 'b12' } }
      return undefined
    },
    done: (_seen, output) => DONE.action.test(output) || /could not be delivered/.test(output),
    timeoutMs: 20_000,
  })
  return { run, calls }
}

test('a granted Source takes its credentials from the environment vault when the Worker has none of its own', async (t) => {
  const { run, calls } = await writeOver(t, vaults(t, { environment: { [REMOTE]: { type: 'http', token: 'ENV-TOKEN', headers: { 'x-tenant': 'north' } } } }))
  assert.equal(run.timedOut, false, run.output)
  assert.deepEqual(calls.map(({ method, path, authorization, tenant }) => [method, path, authorization, tenant]), [['POST', '/effect', 'Bearer ENV-TOKEN', 'north']])
  assert.match(run.output, /1 of them use the environment's keys/)
})

test('a token is sent only to the address it was entered for', async (t) => {
  // The write goes where the authority said, and without a key that was entered for another address.
  const { run, calls } = await writeOver(t, vaults(t, { environment: { [REMOTE]: { type: 'http', url: 'http://127.0.0.1:1/', token: 'NEVER-SENT' } } }))
  assert.equal(run.timedOut, false, run.output)
  assert.deepEqual(calls.map(({ method, path, authorization }) => [method, path, authorization]), [['POST', '/effect', undefined]])
  assert.match(run.output, /The environment's key for Source "remote-api" is not used: it names a different address/)
  assert.doesNotMatch(run.output, /NEVER-SENT/)
})

test('own-vault entries win over environment entries in a running Worker', async (t) => {
  const own = join(tmpdir(), 'own-orders'), shared = join(tmpdir(), 'environment-orders')
  const run = await drive(vaults(t, { own: { orders: { type: 'file', access: own } },
    environment: { orders: { type: 'file', access: shared } } }), [actionRow()])
  assert.equal(run.timedOut, false, run.output)
  assert.deepEqual(run.effects, ['access:' + own])
})

test('an environment key for another type of Source, for another address, or that says how to start the Source, is not handed to an Adapter, and the Worker says so', async (t) => {
  // `orders` is granted as a `file` Source at the Worker's own folder. The environment holds, in turn, a `db` entry under that
  // name, a `file` entry for a different folder, and one that says how to start a process: none is this Source's key. The Adapter
  // is handed the Source as it was granted, and the log says which part did not fit without quoting the entry.
  for (const [entry, mismatch, said] of [
    [{ type: 'db', dsn: 'postgres://app:never@db/orders' }, 'type', /is for a different type of Source than the one the Gateway granted/],
    [{ type: 'file', access: join(tmpdir(), 'elsewhere-orders'), token: 'never' }, 'address', /names a different address than the Source the Gateway granted/],
    [{ type: 'file', command: '/bin/sh', args: ['-c', 'never'], token: 'never' }, 'launch', /says how to start or reach the Source/]]) {
    let root
    // (A Worker that took the entry would not claim the item at all, so a regression ends at the bound rather than at an assertion.)
    const run = await drive(vaults(t, { environment: { orders: entry } }), [actionRow()],
      { extraAdapters: { 'ship-adapter.mjs': REPORT_SOURCE }, timeoutMs: 10_000, sources: (dir) => { root = dir; return [{ name: 'orders', type: 'file', access: dir }] } })
    assert.equal(run.timedOut, false, run.output)
    assert.deepEqual(run.effects, ['access:' + root, 'type:file'], mismatch)
    assert.match(run.output, /The environment's key for Source "orders" is not used: it /, mismatch)
    assert.match(run.output, said, mismatch)
    assert.doesNotMatch(run.output, /never|postgres|\/bin\/sh/, `${mismatch}: the Worker quoted the entry it refused`)
    assert.doesNotMatch(run.output, /of them use the environment's keys/, mismatch)
  }
})

test('the fields of an environment key that are not credentials are named in the Worker\'s log and have no effect', async (t) => {
  let root
  const run = await drive(vaults(t, { environment: { orders: { type: 'file', token: 'T', timeoutMs: 1, env: { NODE_OPTIONS: '--require never' } } } }), [actionRow()],
    { extraAdapters: { 'ship-adapter.mjs': REPORT_SOURCE }, timeoutMs: 10_000, sources: (dir) => { root = dir; return [{ name: 'orders', type: 'file', access: dir }] } })
  assert.equal(run.timedOut, false, run.output)
  assert.deepEqual(run.effects, ['access:' + root, 'type:file'])
  assert.match(run.output, /The environment's key for Source "orders" supplies credentials only; ignored: timeoutMs, env\./)
  assert.match(run.output, /1 of them use the environment's keys/)
  assert.doesNotMatch(run.output, /NODE_OPTIONS|--require/)
})

test('a key for a Source bound later is used after the refresh a new work item causes, with no reload', async (t) => {
  // The authority grants nothing when the Worker starts and `orders` by the time the first work
  // item names it. The environment vault already holds the key; the Worker must neither have
  // loaded it at start (nothing was granted) nor need a restart to use it now. A second item for
  // a Source nobody ever granted runs nothing. (The Adapter reads no credential, so the arm reads
  // the Worker's own account of which Sources took the environment's keys.)
  let listings = 0, root
  const run = await drive(vaults(t, { environment: { orders: { type: 'file', token: 'T' }, ghost: { type: 'file', token: 'T2' } } }),
    [actionRow({ work: 'inv_ghost', sourceRecordId: 'ghost', args: '{"source":"ghost"}' }), actionRow()], {
      sources: (dir) => { root = dir; return [{ name: 'orders', type: 'file', access: dir }] },
      sourceReply: () => (++listings === 1 ? { body: { sources: [] } } : undefined),
    })
  assert.equal(run.timedOut, false, run.output)
  assert.ok(listings >= 2, 'the work item naming an unseen Source did not cause a refresh')
  assert.deepEqual(run.effects, ['access:' + root], 'the ungranted Source ran, or the late-bound one did not')
  assert.equal(run.output.match(/Loaded \d+ source definition/g)?.length, 1, 'a Source was loaded at start, before anything was granted')
  assert.match(run.output, /Loaded 1 source definition\(s\)[^\n]*1 of them use the environment's keys/)
})

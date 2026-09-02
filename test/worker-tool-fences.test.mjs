// SPDX-License-Identifier: Apache-2.0
/**
 * The fences a Worker Tool cannot be talked out of.
 *
 * Each arm below covers a place where an untrusted input — a model-chosen Action
 * argument, a work-item payload, a third-party MCP endpoint, a capability package's
 * Adapter — reached past a boundary the surrounding code appeared to enforce. The
 * common failure mode is that the enforcement still ran: `selectOnlyGuard` classified,
 * `validateInvocationArgs` validated, the `run` fence resolved a path under the Worker
 * root. They were simply asked about the wrong text, the wrong arguments, or a process
 * that had already been handed everything it needed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'

import {
  adapterEnv, adapterToolFromSpec, databaseDriver, execute, invocationArgs,
  refuseSqlParameter, toolFromSpec, workerToolsOf,
} from '../worker/rulith-worker.mjs'

// ── A. SQL text comes from the Tool, never from an argument ──────────────────

/** Record what actually reached the driver instead of guessing from an error string. */
function withRecordedDatabase(run) {
  const original = databaseDriver.run
  const statements = []
  databaseDriver.run = async (dsn, sql, values) => {
    statements.push({ dsn, sql, values })
    return { rows: [], rowCount: 0, command: 'SELECT' }
  }
  const previousDsn = process.env.RULITH_DB_URL
  process.env.RULITH_DB_URL = 'postgres://test-host/test-db'
  return (async () => {
    try { return await run(statements) } finally {
      databaseDriver.run = original
      if (previousDsn === undefined) delete process.env.RULITH_DB_URL
      else process.env.RULITH_DB_URL = previousDsn
    }
  })()
}

const lookupTool = () => adapterToolFromSpec(JSON.stringify({
  name: 'orders.lookup', impl: 'db-query', source: 'orders',
  exec: 'SELECT id, status FROM orders WHERE id={order_id}',
  params: { order_id: 'number' },
}), JSON.stringify({ order_id: 702 }))

test('a db-query invocation cannot replace the compiled template with its own SQL', async () => {
  await withRecordedDatabase(async (statements) => {
    const tool = lookupTool()
    await execute('orders_lookup', { sql: 'UPDATE users SET is_admin=true' }, { orders_lookup: tool })
    assert.equal(statements.length, 1, 'exactly one statement must reach the driver')
    assert.equal(statements[0].sql, 'SELECT id, status FROM orders WHERE id=$1',
      `the argument named sql replaced the Tool's template: ${statements[0].sql}`)
    assert.deepEqual(statements[0].values, [702])
    assert.doesNotMatch(statements[0].sql, /UPDATE|is_admin/)
  })
})

test('a db-exec-fenced invocation cannot smuggle a destructive statement through an argument', async () => {
  await withRecordedDatabase(async (statements) => {
    // The template is constructive, so the destructive classifier lets the call through.
    // Before the fix the classifier saw the *argument*, which is the other half of the
    // same defect: an argument could also make a legitimate write look destructive and
    // block it, or make a destructive one look benign and run it.
    const tool = adapterToolFromSpec(JSON.stringify({
      name: 'orders.mark', impl: 'db-exec-fenced', source: 'orders',
      exec: 'UPDATE orders SET status={status} WHERE id={order_id}',
      params: { status: 'string', order_id: 'number' },
    }), JSON.stringify({ status: 'shipped', order_id: 702 }))
    await execute('orders_mark', { sql: 'DROP TABLE users' }, { orders_mark: tool })
    assert.equal(statements.length, 1)
    assert.equal(statements[0].sql, 'UPDATE orders SET status=$1 WHERE id=$2')
    assert.deepEqual(statements[0].values, ['shipped', 702])
    assert.doesNotMatch(statements[0].sql, /DROP/)
  })
})

test('the SELECT-only and destructive fences still classify the template (calibration)', async () => {
  // Without this arm, a change that stopped classifying anything at all would satisfy
  // every assertion above.
  await withRecordedDatabase(async (statements) => {
    const writeThroughRead = adapterToolFromSpec(JSON.stringify({
      name: 'orders.sneak', impl: 'db-query', source: 'orders',
      exec: 'UPDATE orders SET status={status}', params: { status: 'string' },
    }), JSON.stringify({ status: 'shipped' }))
    await assert.rejects(
      execute('orders_sneak', { status: 'shipped' }, { orders_sneak: writeThroughRead }),
      /db_query accepts SELECT only/)

    const destructive = adapterToolFromSpec(JSON.stringify({
      name: 'orders.wipe', impl: 'db-exec-fenced', source: 'orders',
      exec: 'DELETE FROM orders WHERE id={order_id}', params: { order_id: 'number' },
    }), JSON.stringify({ order_id: 702 }))
    await assert.rejects(
      execute('orders_wipe', { order_id: 702 }, { orders_wipe: destructive }),
      /destructive SQL statement \(delete\)/)

    assert.deepEqual(statements, [], 'a refused statement must never reach the driver')
  })
})

test('a database Tool that declares a sql parameter is refused at declaration time', () => {
  for (const impl of ['db-query', 'db-exec-fenced']) {
    assert.throws(() => adapterToolFromSpec(JSON.stringify({
      name: 'orders.free', impl, source: 'orders', exec: 'SELECT {sql}', params: { sql: 'string' },
    }), JSON.stringify({ sql: 'SELECT 1' })), /SQL text is never an Action argument/, `${impl} accepted a sql parameter`)
  }
  // The name is refused however it is cased: a `SQL` slot teaches the same thing.
  assert.throws(() => refuseSqlParameter('db-query', { SQL: 'string' }), /SQL text is never an Action argument/)
  // Non-database Adapters are untouched: `sql` is an ordinary name to an http Tool.
  assert.doesNotThrow(() => refuseSqlParameter('http', { sql: 'string' }))
  assert.doesNotThrow(() => refuseSqlParameter('db-query', { order_id: 'number' }))
})

test('toolFromSpec refuses a sql parameter before validating the invocation', () => {
  const tools = { 'acme.query@1': { adapter: 'db-query', sourceTypes: ['db'], entry: 'SELECT 1', digest: undefined } }
  const sources = { orders: { type: 'db', dsn: 'postgres://x/y' } }
  assert.throws(() => toolFromSpec(JSON.stringify({
    name: 'acme.query@1', kind: 'read', impl: 'worker-tool', source: 'orders',
    exec: 'acme.query@1', params: { sql: 'string' },
  }), JSON.stringify({ sql: 'SELECT 1' }), tools, undefined, sources), /SQL text is never an Action argument/)
})

// ── B. A work item's payload is not an argument channel ──────────────────────

test('a work item payload cannot replace the validated invocation arguments', () => {
  // The database compiler produces no `_args`, which is why this door was reachable at
  // all: for every other Adapter `_args` is `{}` and `??` short-circuits, so the door
  // was closed by accident rather than by decision.
  const compiled = lookupTool()
  assert.equal('_args' in compiled, false,
    'if the database compiler starts emitting _args this arm stops covering the path it was written for')

  const item = { args: '{"order_id":702}', payload: { args: { sql: 'DROP TABLE users', order_id: 1 } } }
  assert.equal(invocationArgs(compiled, item), '{"order_id":702}',
    'the payload won over the contract that validateInvocationArgs had already checked')

  // Calibration in both directions.
  const withArgs = { ...compiled, _args: { order_id: 702 } }
  assert.deepEqual(invocationArgs(withArgs, item), { order_id: 702 }, 'compiled args still take precedence')
  assert.equal(invocationArgs(compiled, { args: '{}' }), '{}')
})

// ── H. Outbound MCP calls are bounded ────────────────────────────────────────

test('an oversized MCP response is refused rather than buffered', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    // Two MiB of text content, over the 1 MiB cap.
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] } }))
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  try {
    const sources = { erp: { type: 'mcp', url: `http://127.0.0.1:${server.address().port}` } }
    const tool = adapterToolFromSpec(JSON.stringify({
      name: 'acme.erp.lookup@1', impl: 'mcp', source: 'erp', exec: 'orders.lookup',
    }), JSON.stringify({ order_id: 'O-1' }))
    await assert.rejects(
      execute('erp_lookup', { order_id: 'O-1' }, { erp_lookup: tool }, sources),
      /exceed(?:s|ed) the 1048576-byte limit/)
  } finally {
    await new Promise((closed) => server.close(closed))
    server.closeAllConnections()
  }
})

test('an MCP endpoint that never answers is abandoned instead of stalling the poll loop', async () => {
  const held = []
  const server = createServer((request, response) => { held.push(response) })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  try {
    const sources = { erp: { type: 'mcp', url: `http://127.0.0.1:${server.address().port}` } }
    // The fence comes from the local Worker Tool Manifest, never from the work item;
    // 150ms here is the same knob a deployment would set to a realistic value.
    const tool = adapterToolFromSpec(JSON.stringify({
      name: 'acme.erp.slow@1', impl: 'mcp', source: 'erp', exec: 'orders.lookup',
      fence: { timeoutMs: 150 },
    }), '{}')
    const started = Date.now()
    await assert.rejects(execute('erp_slow', {}, { erp_slow: tool }, sources), /abort|timeout/i)
    assert.ok(Date.now() - started < 5_000, 'the call must be abandoned quickly, not held for the default budget')
  } finally {
    for (const response of held) response.destroy()
    await new Promise((closed) => server.close(closed))
    server.closeAllConnections()
  }
})

test('an ordinary MCP response still passes through unchanged (calibration)', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"rows":[{"exists":true}]}' }] } }))
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  try {
    const sources = { erp: { type: 'mcp', url: `http://127.0.0.1:${server.address().port}` } }
    const tool = adapterToolFromSpec(JSON.stringify({
      name: 'acme.erp.lookup@1', impl: 'mcp', source: 'erp', exec: 'orders.lookup',
    }), '{}')
    const out = await execute('erp_lookup', {}, { erp_lookup: tool }, sources)
    assert.equal(out, '{"rows":[{"exists":true}]}')
  } finally {
    await new Promise((closed) => server.close(closed))
    server.closeAllConnections()
  }
})

// ── H. A run Adapter does not inherit the runtime's credentials ──────────────

test('adapterEnv removes the runtime credentials and keeps the ordinary environment', () => {
  const stripped = adapterEnv({
    PATH: '/usr/bin', HOME: '/home/operator', TEMP: '/tmp', LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://proxy:8080',
    RULITH_CASE_ID: 'CASE_1', RULITH_SOURCE_ACCESS: '/srv/data', RULITH_WORKER_ROOT: '/srv/worker',
    RULITH_CONNECTION_KEY: 'connection-secret',
    RULITH_TOKEN: 'agent-secret',
    RULITH_MODEL_KEY: 'model-secret',
    RULITH_SHADOW_KEY: 'shadow-secret',
    RULITH_REVIEWER_KEY: 'reviewer-secret',
    RULITH_SERVE_KEY: 'serve-secret',
    RULITH_LOCAL_KEY: 'local-secret',
    RULITH_DB_URL: 'postgres://user:password@db/orders',
    DEMO_DB_URL: 'postgres://user:password@db/demo',
    ANTHROPIC_API_KEY: 'model-provider-secret',
    RULITH_FUTURE_KEY: 'not-yet-invented',
    RULITH_SOMETHING_TOKEN: 'also-not-yet-invented',
  })
  assert.deepEqual(Object.keys(stripped).sort(), [
    'HOME', 'HTTPS_PROXY', 'LANG', 'PATH', 'RULITH_WORKER_ROOT', 'TEMP',
  ])
  const serialized = JSON.stringify(stripped)
  for (const secret of ['connection-secret', 'agent-secret', 'model-secret', 'shadow-secret', 'reviewer-secret',
    'serve-secret', 'local-secret', 'password', 'model-provider-secret', 'not-yet-invented', 'also-not-yet-invented']) {
    assert.doesNotMatch(serialized, new RegExp(secret), `${secret} survived into the Adapter environment`)
  }
})

test('the credential fence matches the name however Windows spells it', () => {
  // Windows environment variables are case-insensitive, so `Rulith_Connection_Key` and
  // `RULITH_CONNECTION_KEY` are one variable: a child reading `process.env.RULITH_TOKEN`
  // is answered by whichever casing the parent shell stored. The fence compared names
  // exactly, so every credential here reached the Adapter untouched under a casing no
  // one had thought to list — and the deny-list read as if it were doing its job.
  const stripped = adapterEnv({
    Path: 'C:\\Windows\\System32',
    PATH: '/usr/bin',
    HOME: '/home/operator',
    SystemRoot: 'C:\\Windows',
    Rulith_Connection_Key: 'connection-secret',
    rulith_token: 'agent-secret',
    RULITH_DB_URL: 'postgres://user:dbpassword@db/orders',
    Rulith_Case_Id: 'CASE_STALE',
    rulith_source_access: '/stale/source',
    Rulith_Source_Type: 'stale-type',
    openai_api_key: 'openai-secret',
    Anthropic_Api_Key: 'anthropic-secret',
  })
  assert.deepEqual(Object.keys(stripped).sort(), ['HOME', 'PATH', 'Path', 'SystemRoot'],
    `a credential survived under an unexpected casing: ${JSON.stringify(Object.keys(stripped))}`)
  // Surviving names keep the casing they arrived with. Rewriting `Path` to `PATH` or
  // `SystemRoot` to `SYSTEMROOT` would be a second, quieter defect on Windows, where a
  // child that inherits neither spelling of PATH cannot resolve a program at all.
  assert.equal(stripped.Path, 'C:\\Windows\\System32')
  assert.equal(stripped.SystemRoot, 'C:\\Windows')
  const serialized = JSON.stringify(stripped)
  for (const secret of ['connection-secret', 'agent-secret', 'dbpassword', 'openai-secret', 'anthropic-secret']) {
    assert.doesNotMatch(serialized, new RegExp(secret), `${secret} survived into the Adapter environment`)
  }
})

test('the deny list covers the credential families a host actually carries', () => {
  // The fence used to be the runtime's own variables and nothing else, so an Adapter
  // still inherited every other credential on the machine. This is a deny-list of known
  // patterns, not a sandbox: a name outside these families still reaches the Adapter,
  // which is what `env.pass` below is for.
  const denied = {
    OPENAI_API_KEY: 'openai-secret',
    GEMINI_APIKEY: 'gemini-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    AWS_REGION: 'aws-region',
    AZURE_CLIENT_SECRET: 'azure-secret',
    GOOGLE_APPLICATION_CREDENTIALS: '/home/operator/gcp.json',
    ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
    GITHUB_TOKEN: 'github-secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
    NPM_TOKEN: 'npm-secret',
    DATABASE_URL: 'postgres://user:dbpassword@db/app',
    SENTRY_DSN: 'https://key@sentry.io/1',
    PGPASSWORD: 'pg-secret',
    SSH_PRIVATE_KEY: 'ssh-secret',
    CLIENT_SECRET: 'client-secret',
  }
  const kept = {
    PATH: '/usr/bin', HOME: '/home/operator', TEMP: '/tmp', TMPDIR: '/tmp',
    SystemRoot: 'C:\\Windows', LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://proxy:8080',
    ACME_REGION: 'eu-west-1', NODE_ENV: 'production',
  }
  const stripped = adapterEnv({ ...denied, ...kept })
  assert.deepEqual(Object.keys(stripped).sort(), Object.keys(kept).sort(),
    `the fence kept or dropped the wrong names: ${JSON.stringify(Object.keys(stripped))}`)
  for (const name of Object.keys(denied)) {
    assert.equal(stripped[name], undefined, `${name} reached the Adapter`)
  }
})

// ── I. A Tool may declare exactly what its Adapter receives ──────────────────

test('a run Tool that declares env.pass receives the basics plus those names and nothing else', () => {
  const stripped = adapterEnv({
    PATH: '/usr/bin', HOME: '/home/operator', TEMP: '/tmp', SystemRoot: 'C:\\Windows',
    ACME_REGION: 'eu-west-1', ACME_TIMEOUT: '30',
    HTTPS_PROXY: 'http://proxy:8080', LANG: 'en_US.UTF-8', NODE_ENV: 'production',
    OPENAI_API_KEY: 'openai-secret', RULITH_CONNECTION_KEY: 'connection-secret',
  }, ['ACME_REGION'])
  assert.deepEqual(Object.keys(stripped).sort(), ['ACME_REGION', 'HOME', 'LANG', 'PATH', 'SystemRoot', 'TEMP'],
    `an allow-list must be exhaustive apart from the basics: ${JSON.stringify(Object.keys(stripped))}`)
  // A name outside the deny-list families — the very thing the deny-list cannot reach —
  // is gone here, which is the whole reason to declare an allow-list.
  assert.equal(stripped.NODE_ENV, undefined)
  assert.equal(stripped.HTTPS_PROXY, undefined)
  // The listed name is matched case-insensitively too, for the same Windows reason.
  assert.equal(adapterEnv({ Acme_Region: 'eu-west-1', OTHER: 'x' }, ['ACME_REGION']).Acme_Region, 'eu-west-1')
  assert.deepEqual(adapterEnv({ Rulith_Case_Id: 'CASE_STALE', ACME_REGION: 'eu-west-1' }, ['RULITH_CASE_ID', 'ACME_REGION']), { ACME_REGION: 'eu-west-1' },
    'trusted Case/Source context must be supplied by the current work item, never env.pass')
  // An empty list is a real setting, not a missing one: basics only.
  assert.deepEqual(Object.keys(adapterEnv({ PATH: '/usr/bin', ACME_REGION: 'eu-west-1' }, [])), ['PATH'])
})

test('a declared env.pass reaches the compiled run Tool from the local manifest only', () => {
  const tools = workerToolsOf({
    format: 'rulith-worker-tools/1',
    tools: {
      'acme.report@1': { adapter: 'run', sourceTypes: ['file'], entry: 'adapters/report.mjs', env: { pass: ['ACME_REGION'] } },
      'acme.plain@1': { adapter: 'run', sourceTypes: ['file'], entry: 'adapters/plain.mjs' },
    },
  })
  const sources = { docs: { type: 'file', access: '.' } }
  const compiled = (ref) => toolFromSpec(JSON.stringify({
    name: ref, kind: 'act', impl: 'worker-tool', source: 'docs', exec: ref, params: {},
  }), '{}', tools, undefined, sources)

  assert.deepEqual(compiled('acme.report@1').envPass, ['ACME_REGION'])
  assert.equal('envPass' in compiled('acme.plain@1'), false,
    'a Tool that declares no allow-list must keep the deny-list behaviour, not an empty allow-list')

  // The digest covers it, so a Tool cannot gain an allow-list without the Cloud pin moving.
  assert.notEqual(tools['acme.report@1'].digest, tools['acme.plain@1'].digest)

  // The board cannot supply one. `toolFromSpec` reads it off the installed definition;
  // an `env` in the work item's own spec is not consulted.
  const smuggled = toolFromSpec(JSON.stringify({
    name: 'acme.plain@1', kind: 'act', impl: 'worker-tool', source: 'docs', exec: 'acme.plain@1',
    params: {}, env: { pass: ['RULITH_CONNECTION_KEY'] },
  }), '{}', tools, undefined, sources)
  assert.equal('envPass' in smuggled, false, 'a work item supplied its own Adapter environment allow-list')
})

test('a malformed or misplaced env.pass is refused when the manifest is read', () => {
  const manifest = (entry) => ({ format: 'rulith-worker-tools/1', tools: { 'acme.t@1': entry } })
  const run = (extra) => ({ adapter: 'run', sourceTypes: ['file'], entry: 'adapters/report.mjs', ...extra })

  assert.throws(() => workerToolsOf(manifest(run({ env: { pass: 'ACME_REGION' } }))), /env\.pass must be an array/)
  assert.throws(() => workerToolsOf(manifest(run({ env: { pass: ['ACME REGION'] } }))), /env\.pass must be an array/)
  assert.throws(() => workerToolsOf(manifest(run({ env: { pass: [42] } }))), /env\.pass must be an array/)
  assert.throws(() => workerToolsOf(manifest(run({ env: ['ACME_REGION'] }))), /env must be an object/)
  assert.throws(() => workerToolsOf(manifest(run({ env: { allow: ['ACME_REGION'] } }))), /env has unknown field\(s\): allow/)
  // Refused, not ignored: an allow-list on an Adapter that starts no process would read
  // as a fence the operator had applied.
  assert.throws(() => workerToolsOf(manifest({ adapter: 'http', sourceTypes: ['http'], entry: '/x', env: { pass: ['ACME_REGION'] } })),
    /env applies only to a run Adapter/)
  // Calibration: the well-formed shapes are accepted.
  assert.doesNotThrow(() => workerToolsOf(manifest(run({ env: { pass: [] } }))))
  assert.doesNotThrow(() => workerToolsOf(manifest(run({ env: { pass: ['ACME_REGION', '_private'] } }))))
})

test('the shipped example Tool Manifest is one the Worker accepts', () => {
  // `config/worker-tools.example.json` is a file readers copy. A field taught there that
  // the validator refuses costs them an exit before their first poll, and nothing in the
  // suite would have noticed: the example is data, not code.
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'config', 'worker-tools.example.json'), 'utf8'))
  const tools = workerToolsOf(raw)
  assert.ok(Object.keys(tools).length >= 7, `only ${Object.keys(tools).length} example Tools parsed`)
  assert.deepEqual(tools['acme.report.publish@1'].env, { pass: ['ACME_REGION'] },
    'the example must keep demonstrating the environment allow-list it documents')
})

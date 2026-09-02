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
import { createServer } from 'node:http'
import test from 'node:test'

import {
  adapterEnv, adapterToolFromSpec, databaseDriver, execute, invocationArgs,
  refuseSqlParameter, toolFromSpec,
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
    'HOME', 'HTTPS_PROXY', 'LANG', 'PATH', 'RULITH_CASE_ID', 'RULITH_SOURCE_ACCESS', 'RULITH_WORKER_ROOT', 'TEMP',
  ])
  const serialized = JSON.stringify(stripped)
  for (const secret of ['connection-secret', 'agent-secret', 'model-secret', 'shadow-secret', 'reviewer-secret',
    'serve-secret', 'local-secret', 'password', 'model-provider-secret', 'not-yet-invented', 'also-not-yet-invented']) {
    assert.doesNotMatch(serialized, new RegExp(secret), `${secret} survived into the Adapter environment`)
  }
})

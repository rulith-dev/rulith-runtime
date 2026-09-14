// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { localMcpServer } from './support/local-mcp-server.mjs'
import { execute, adapterToolFromSpec } from '../worker/rulith-worker.mjs'
import { closeMcpClients, McpExecutionUnknownError } from '../worker/mcp-client.mjs'
import { toolDigest } from '../worker/rulith-worker.mjs'
import { driveWorker, actionRow, HOLD } from './support/worker-harness.mjs'
afterEach(closeMcpClients)

async function httpPeer(t, json) {
  const sessions = new Map(), calls = []
  const http = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, 'Bearer fixture-mail-token')
      const id = req.headers['mcp-session-id']
      let transport = sessions.get(id)
      let body
      if (req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk)
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        calls.push(body.method)
      }
      if (!transport && body?.method === 'initialize') {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: json,
          onsessioninitialized: (session) => sessions.set(session, transport) })
        await localMcpServer().connect(transport)
      }
      if (!transport) { res.writeHead(400); res.end('Initialize first'); return }
      await transport.handleRequest(req, res, body)
    } catch (error) { res.writeHead(500); res.end(String(error)) }
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await closeMcpClients()
    for (const transport of sessions.values()) await transport.close()
    http.closeAllConnections(); await new Promise(resolve => http.close(resolve))
  })
  return { source: { type: 'mcp', url: `http://127.0.0.1:${http.address().port}/mcp`, token: 'fixture-mail-token' }, calls }
}

function tool(name, extra = {}) {
  return adapterToolFromSpec(JSON.stringify({ impl: 'mcp', source: 'mail', exec: name, ...extra }), JSON.stringify({ message_id: 'm-1' }))
}

for (const json of [true, false]) test(`Worker calls a session-based SDK server (${json ? 'JSON' : 'SSE'}) and maps structured evidence`, async t => {
  const peer = await httpPeer(t, json)
  const read = tool('mail.read', { returns: [{ predicate: 'mail.message', args: { id: '$message_id', subject: '$subject' } }] })
  const result = await execute('read', { message_id: 'm-1' }, { read }, { mail: peer.source })
  assert.deepEqual(result.facts, [{ predicate: 'mail.message', args: { id: 'm-1', subject: '订单确认' } }])
  assert.deepEqual(peer.calls.filter(x => x !== 'ping'), ['initialize', 'notifications/initialized', 'tools/call'])
})

test('Worker launches a local stdio MCP server with Source-owned credentials and reuses its session', async () => {
  const sources = { mail: { type: 'mcp', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('support/local-mcp-server.mjs', import.meta.url))],
    env: { MAIL_FIXTURE_SECRET: 'local-source-secret' } } }
  const read = tool('mail.environment')
  const first = JSON.parse(await execute('read', {}, { read }, sources))
  const second = JSON.parse(await execute('read', {}, { read }, sources))
  assert.equal(first.rows[0].secret, 'local-source-secret')
  assert.equal(first.rows[0].leaked, false)
  assert.equal(second.rows[0].calls, 2)
})

test('MCP discovery consumes every page without granting a generic remote Tool', async t => {
  const peer = await httpPeer(t, false)
  const discover = adapterToolFromSpec(JSON.stringify({ impl: 'mcp', source: 'mail', exec: 'discover' }), '{}')
  const result = await execute('discover', {}, { discover }, { mail: peer.source })
  const listed = JSON.parse(result.result)
  assert.deepEqual(listed.tools.map(row => row.tool_name), ['mail.read', 'mail.draft'])
  assert.equal(listed.truncated, false)
  assert.equal(peer.calls.filter(method => method === 'tools/list').length, 2)
  assert.equal(peer.calls.includes('tools/call'), false)
})

test('MCP tool failure remains a failure and does not retire a healthy session', async t => {
  const peer = await httpPeer(t, true)
  await assert.rejects(execute('fail', {}, { fail: tool('mail.fail') }, { mail: peer.source }), /MCP tool reported failure/)
  const result = JSON.parse(await execute('read', {}, { read: tool('mail.read') }, { mail: peer.source }))
  assert.equal(result.rows[0].calls, 2)
  assert.equal(peer.calls.filter(method => method === 'initialize').length, 1)
})

test('successful MCP text is data; malformed required fact output does not fabricate a failed action', async t => {
  const peer = await httpPeer(t, true)
  const read = tool('mail.error-text')
  assert.equal((await execute('read', {}, { read }, { mail: peer.source })).result, 'error: this is the literal message subject')
  const mapped = tool('mail.read', { returns: [{ predicate: 'mail.message', args: { value: '$missing_column' } }] })
  await assert.rejects(execute('read', {}, { read: mapped }, { mail: peer.source }), McpExecutionUnknownError)
})

test('MCP timeout after dispatch is unknown and the external call is never resent', async t => {
  const peer = await httpPeer(t, false)
  const read = tool('mail.hang', { fence: { timeoutMs: 150 } })
  await assert.rejects(execute('read', {}, { read }, { mail: peer.source }), error =>
    error instanceof McpExecutionUnknownError && /timeout/i.test(error.message))
  assert.equal(peer.calls.filter(method => method === 'tools/call').length, 1)
})

test('MCP Source budget cannot be widened by a Tool fence', async t => {
  const peer = await httpPeer(t, true)
  const read = tool('mail.large', { fence: { maxResponseBytes: 100_000 } })
  await assert.rejects(execute('read', {}, { read }, { mail: { ...peer.source, maxResponseBytes: 2048 } }), /2048-byte limit/)
})

test('stdio exit after execution is unknown and closes the retired session', async () => {
  const sources = { mail: { transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('support/local-mcp-server.mjs', import.meta.url))] } }
  const read = tool('mail.disconnect')
  await assert.rejects(execute('read', {}, { read }, sources), McpExecutionUnknownError)
})

test('MCP Source cannot override protocol identity or pass the Rulith environment namespace', async () => {
  const read = tool('mail.read')
  await assert.rejects(execute('read', {}, { read }, { mail: { url: 'http://127.0.0.1:1', headers: { 'Mcp-Session-Id': 'foreign' } } }), /protocol header/)
  await assert.rejects(execute('read', {}, { read }, { mail: { transport: 'stdio', command: process.execPath, env: { RULITH_TOKEN: 'foreign' } } }), /Rulith namespace/)
  await assert.rejects(execute('read', {}, { read }, { mail: { url: 'http://127.0.0.1:1', timeoutMs: -1 } }), /positive integer/)
})

test('real Worker preserves a lost MCP result without reporting false success or failure', async t => {
  const peer = await httpPeer(t, true)
  const definition = { adapter: 'mcp', sourceTypes: ['mcp'], entry: 'mail.hang', kind: 'write', params: {}, fence: { timeoutMs: 150 } }
  const row = actionRow({ toolContractId: 'fixture.mail.hang@1', sourceRecordId: 'mail', args: '{"source":"mail"}', toolDigest: toolDigest(definition),
    toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'fixture.mail.hang@1', kind: 'write', params: {}, sourceTypes: ['mcp'] }) })
  let polls = 0
  const run = await driveWorker({
    extraTools: { 'fixture.mail.hang@1': definition },
    sources: () => [{ name: 'mail', type: 'mcp', access: peer.source.url }],
    // The fixture credential is explicitly Source-owned; no ambient token is borrowed.
    extraFiles: { 'no-secrets.json': JSON.stringify({ mail: peer.source }) },
    reply: operation => operation.kind === 'Poll' ? ++polls === 1 ? { body: { accepted: true, payload: { work: [row] } } } : HOLD : { body: { accepted: true, revision: 'r2' } },
    done: (_seen, output) => /could not be delivered|receipt committed/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ReportWork').length, 0, run.output)
  assert.equal(peer.calls.filter(method => method === 'tools/call').length, 1, run.output)
  assert.match(run.output, /remains pending.*do not rerun/)
})

// SPDX-License-Identifier: Apache-2.0
/**
 * The Local host's material routes, driven over real loopback HTTP.
 *
 * The product rule these arms are about is short: **selecting a file does not send it
 * anywhere.** Adding one stores bytes and answers with metadata; listing answers with
 * metadata; attaching one to a case forwards metadata across the loopback hop to the Agent and
 * nothing else. The delivery route produces bytes, and it produces none of them itself: this
 * host holds no capability that could authorize a read, and routes the Gateway's per-read
 * ticket to the custodian that does.
 *
 * The Agent and the Worker are stand-ins that record what crossed each hop, because what is
 * under test here is what the *host* sends. The custodian's own half — claiming the ticket at
 * the Gateway and reading verified chunks — is driven against the real Worker in
 * `worker-material-delivery.test.mjs`.
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { createLocalHost, defaultLocalConfig } from '../local/rulith-local.mjs'
import { defaultMaterialRoot, materialIdentity } from '../worker/material-store.mjs'

const KEY = 'local-materials-key'
const REMOTE_MODEL = 'https://api.anthropic.com/v1/messages'
const AGENT_TOKEN = `rlt_agt_${'a'.repeat(43)}`
const GATEWAY = 'https://api.rulith.ai'
const CONNECTION = 'con-local-materials'
const AGENT_ID = 'agent-test-1'
const HERE = resolve(import.meta.dirname)
/** The identity this host binds its material area to, built the way the host builds it. */
const identityOf = (configFile, modelUrl = REMOTE_MODEL) => materialIdentity({
  configFile, gatewayUrl: GATEWAY, connectionId: CONNECTION, agentId: AGENT_ID, modelUrl,
})

const freePort = () => new Promise((ready) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => ready(port))
  })
})

// Another test process can claim the probed port before the child binds it. Retry only
// that specific startup failure; every other failure should retain its original trace.
async function startAgentHost(configFile, config, roles) {
  for (let attempt = 0; attempt < 3; attempt++) {
    config.agent.env.RULITH_SERVE_PORT = String(await freePort())
    const host = createLocalHost({ configFile, config, roles, port: 0, key: KEY, autoStart: true, startConfirmMs: 8000 })
    let handedOff = false
    try {
      await host.listen()
      const deadline = Date.now() + 8000
      while (!host.status().ready.agent && host.status().agent && Date.now() < deadline) {
        await new Promise((wait) => setTimeout(wait, 25))
      }
      // A historical start event is insufficient if the same child has since exited.
      if (host.status().ready.agent) {
        handedOff = true
        return host
      }
      // Child stdio can flush after its exit event; give its diagnostic line time to arrive.
      if (!host.status().agent) await new Promise((wait) => setTimeout(wait, 25))
      const events = host.events()
      if (attempt < 2 && events.some((event) => event.src === 'agent' && /EADDRINUSE/u.test(event.line ?? ''))) continue
      assert.fail(`the Agent stand-in did not report readiness: ${JSON.stringify(events)}`)
    } finally {
      if (!handedOff) await host.close()
    }
  }
}

/**
 * A request whose `Host` header this test chooses.
 *
 * `fetch` refuses to set `Host` — it is a forbidden header — so a DNS-rebinding arm written
 * with `fetch` silently asserts against the loopback Host the client supplied instead, and
 * passes whatever the host does. This is the same request over the raw client, where the
 * header travels.
 */
const raw = (port, path, { method = 'GET', headers = {}, body } = {}) => new Promise((settle, fail) => {
  const call = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (response) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.on('end', () => settle({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
  })
  call.on('error', fail)
  if (body !== undefined) call.write(body)
  call.end()
})

/**
 * A real host on a free port, with a real material area, and — when asked — a real child
 * process standing in for the Agent so `/cases` has somewhere to forward to.
 */
async function withHost(run, {
  withAgent = false, custodyReply, modelUrl = REMOTE_MODEL, omitModelUrl = false, token = AGENT_TOKEN,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-materials-'))
  const configFile = join(dir, 'local.json')
  const taskLog = join(dir, 'tasks.jsonl')
  const config = defaultLocalConfig()
  config.agent.env = {
    ...config.agent.env, RULITH_TOKEN: token, RULITH_URL: GATEWAY,
    RULITH_MODEL_URL: modelUrl, RULITH_MODEL: 'test-model',
  }
  if (omitModelUrl) delete config.agent.env.RULITH_MODEL_URL
  config.worker.env = { ...config.worker.env, RULITH_CONNECTION: CONNECTION, RULITH_CONNECTION_KEY: 'key-1' }
  const withWorker = custodyReply !== undefined
  const roles = withWorker ? ['agent', 'worker'] : ['agent']
  config.roles = roles
  config.paths = {
    agent: withAgent ? join(HERE, 'support', 'task-agent.mjs') : join(dir, 'absent-agent.mjs'),
    worker: withWorker ? join(HERE, 'support', 'custodian-worker.mjs') : join(dir, 'absent-worker.mjs'),
  }
  if (withAgent) {
    config.agent.env.RULITH_TEST_TASK_LOG = taskLog
  }
  if (withWorker) {
    config.worker.env.RULITH_TEST_TASK_LOG = taskLog
    config.worker.env.RULITH_TEST_CUSTODY_REPLY = JSON.stringify(custodyReply)
  }
  let host
  try {
    host = withAgent ? await startAgentHost(configFile, config, roles) : createLocalHost({
      configFile, config, roles, port: 0, key: KEY, autoStart: withWorker, startConfirmMs: 8000,
    })
    if (!withAgent) await host.listen()
    if (withWorker) {
      const deadline = Date.now() + 8000
      while (!host.events().some((event) => event.src === 'worker' && event.type === 'up') && Date.now() < deadline) {
        await new Promise((wait) => setTimeout(wait, 25))
      }
      assert.equal(host.events().some((event) => event.src === 'worker' && event.type === 'up'), true,
        `the custodian stand-in did not report readiness: ${JSON.stringify(host.events())}`)
    }
    await run({
      host, dir, configFile, taskLog,
      materialRoot: defaultMaterialRoot(configFile),
      tasks: () => (existsSync(taskLog) ? readFileSync(taskLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
      call: (path, options = {}) => fetch(`http://127.0.0.1:${host.port}${path}`, {
        ...options,
        headers: {
          'x-rulith-local': KEY, host: `127.0.0.1:${host.port}`, origin: `http://127.0.0.1:${host.port}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.headers ?? {}),
        },
      }),
    })
  } finally {
    await host?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const add = (call, { name, mediaType, text, bytes }) => call('/materials', {
  method: 'POST',
  body: JSON.stringify({ name, mediaType, bytes: (bytes ?? Buffer.from(text, 'utf8')).toString('base64') }),
})

test('a stale file selection is refused before storage when the model destination changed', async () => {
  await withHost(async ({ call }) => {
    const request = { name: 'selected-before-change.txt', mediaType: 'text/plain', bytes: Buffer.from('private input').toString('base64') }
    const denied = await call('/materials', { method: 'POST', body: JSON.stringify({ ...request, modelDestination: 'https://different-model.example/v1' }) })
    assert.equal((await denied.json()).errorCode, 'material_destination_changed')
    assert.deepEqual((await (await call('/materials')).json()).materials, [])
    const allowed = await call('/materials', { method: 'POST', body: JSON.stringify({ ...request, modelDestination: REMOTE_MODEL + '/' }) })
    assert.equal((await allowed.json()).ok, true, 'equivalent destination spelling remains usable')
    assert.equal((await (await call('/materials')).json()).materials.length, 1)
  })
})

test('file selection agrees with the actual default provider when the model URL is unset', async () => {
  await withHost(async ({ call }) => {
    const status = await (await call('/status')).json()
    const response = await call('/materials', { method: 'POST', body: JSON.stringify({
      name: 'default-provider.txt', mediaType: 'text/plain', bytes: Buffer.from('test').toString('base64'),
      modelDestination: status.runtime.agent.modelService,
    }) })
    assert.equal((await response.json()).ok, true)
  }, { omitModelUrl: true })
})

test('POST /materials stores a file whole and answers with metadata, not content', async () => {
  await withHost(async ({ call, materialRoot }) => {
    const response = await add(call, { name: 'notes.txt', mediaType: 'text/plain; charset=utf-8', text: 'attached content\n' })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.deepEqual(Object.keys(body.material).sort(), ['digest', 'id', 'mediaType', 'name', 'totalBytes'])
    assert.match(body.material.id, /^mat_[0-9a-f]{32}$/u)
    assert.equal(body.material.totalBytes, Buffer.byteLength('attached content\n'))
    assert.doesNotMatch(JSON.stringify(body), /attached content/u, 'the answer carried the file content back')

    // The bytes are on disk before the response was written, under an opaque id.
    assert.equal(existsSync(join(materialRoot, 'objects', body.material.id, 'record.json')), true)

    const listed = await (await call('/materials')).json()
    assert.deepEqual(listed.materials.map((row) => [row.id, row.name, row.totalBytes]),
      [[body.material.id, 'notes.txt', Buffer.byteLength('attached content\n')]])
    assert.equal(listed.materials.every((row) => row.bytes === undefined && row.data === undefined), true,
      'the listing carried content')
  })
})

test('the material routes sit behind the same key, origin and host gate as everything else', async () => {
  await withHost(async ({ host, call }) => {
    const base = `http://127.0.0.1:${host.port}`
    // No key at all.
    assert.equal((await fetch(`${base}/materials`)).status, 401)
    // A key, but a cross-origin page.
    assert.equal((await fetch(`${base}/materials`, { headers: { 'x-rulith-local': KEY, origin: 'https://evil.example' } })).status, 403)
    // A key, but a rebound name.
    assert.equal((await raw(host.port, `/materials?k=${KEY}`, { headers: { host: 'rebound.example' } })).status, 403)
    // The key in the query string is enough to read the page, and not enough to add a file:
    // adding requires the header and the exact origin, like every other mutating route.
    const viaQuery = await fetch(`${base}/materials?k=${KEY}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${host.port}` },
      body: JSON.stringify({ name: 'x.txt', mediaType: 'text/plain', bytes: Buffer.from('x').toString('base64') }),
    })
    assert.equal(viaQuery.status, 403)
    assert.match((await viaQuery.json()).teaching, /Local page key and the same origin/u)
    // Calibration: the same request with the header lands.
    assert.equal((await add(call, { name: 'x.txt', mediaType: 'text/plain', text: 'x' })).status, 200)
  })
})

test('an unsafe name, a non-canonical body or an over-size file is refused before anything is stored', async () => {
  await withHost(async ({ call, materialRoot }) => {
    for (const [body, code] of [
      [{ name: '../escape.txt', mediaType: 'text/plain', bytes: 'eA==' }, 'material_name_path'],
      [{ name: `nul${String.fromCharCode(0)}.txt`, mediaType: 'text/plain', bytes: 'eA==' }, 'material_name_control'],
      [{ name: 'CON', mediaType: 'text/plain', bytes: 'eA==' }, 'material_name_reserved'],
      [{ name: 'ok.txt', mediaType: 'text/plain', bytes: 'not base64!' }, 'material_bytes_invalid'],
      [{ name: 'ok.txt', mediaType: 'text/plain', bytes: 'aGl=' }, 'material_bytes_not_canonical'],
      [{ name: 'ok.txt', mediaType: 'text/plain', bytes: '' }, 'material_bytes_invalid'],
      [{ name: 'ok.txt', mediaType: 'nonsense', bytes: 'eA==' }, 'material_media_type_invalid'],
    ]) {
      const response = await call('/materials', { method: 'POST', body: JSON.stringify(body) })
      assert.equal(response.status, 400, `${JSON.stringify(body.name)} was not refused`)
      assert.equal((await response.json()).errorCode, code)
    }
    // Over the documented per-file limit, checked on the decoded bytes.
    const over = await call('/materials', {
      method: 'POST',
      body: JSON.stringify({ name: 'big.bin', mediaType: 'application/octet-stream', bytes: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }),
    })
    assert.equal((await over.json()).errorCode, 'material_too_large')
    // Nothing landed for any of them, in the listing or on disk.
    assert.deepEqual((await (await call('/materials')).json()).materials, [])
    assert.equal(existsSync(join(materialRoot, 'objects', 'record.json')), false)
  })
})

test('a material area redirected by a reparse point refuses the whole route rather than following it', async () => {
  await withHost(async ({ call, configFile, dir }) => {
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    let redirected = true
    try {
      symlinkSync(elsewhere, defaultMaterialRoot(configFile), 'junction')
    } catch {
      redirected = false
    }
    if (!redirected) return
    const response = await call('/materials')
    assert.equal(response.status, 500)
    assert.equal((await response.json()).errorCode, 'materials_store_reparse')
  })
})

test('POST /cases forwards attachment metadata and nothing else at all', async () => {
  await withHost(async ({ call, tasks }) => {
    const added = (await (await add(call, { name: 'notes.txt', mediaType: 'text/plain', text: 'SECRET-CONTENT-MARKER' })).json()).material
    const response = await call('/cases', {
      method: 'POST', body: JSON.stringify({ text: 'have a look', sessionKey: 'ctx-1', attachments: [added.id] }),
    })
    assert.equal(response.status, 202, await response.text())
    const forwarded = tasks().filter((entry) => entry.kind === 'task')
    assert.equal(forwarded.length, 1)
    const body = forwarded[0].body
    assert.equal(forwarded[0].authorized, true)
    assert.equal(body.text, 'have a look', 'the host rewrote a message the user actually wrote')
    assert.equal(body.attachments.length, 1)
    // Metadata, and only metadata. There is no capability to carry beside it: a read is
    // authorized by the Gateway, per read, and an attachment is not a read.
    assert.deepEqual(Object.keys(body.attachments[0]).sort(), ['digest', 'id', 'mediaType', 'name', 'totalBytes'])
    assert.equal(body.attachments[0].id, added.id)
    assert.doesNotMatch(JSON.stringify(body), /SECRET-CONTENT-MARKER/u, 'the file content crossed the hop to the Agent')
    assert.doesNotMatch(JSON.stringify(body), new RegExp(KEY, 'u'), 'the host page key crossed the hop to the Agent')
  }, { withAgent: true })
})

test('attachments with no message get a generated inspect instruction that reads nothing', async () => {
  await withHost(async ({ call, tasks }) => {
    const added = (await (await add(call, { name: 'q3.csv', mediaType: 'text/csv', text: 'a,b\nSECRET,2\n' })).json()).material
    const response = await call('/cases', { method: 'POST', body: JSON.stringify({ text: '', attachments: [added.id] }) })
    assert.equal(response.status, 202, await response.text())
    const body = tasks().filter((entry) => entry.kind === 'task').at(-1).body
    assert.match(body.text, /attached 1 local material/u)
    assert.match(body.text, /q3\.csv \(text\/csv, 13 bytes, id mat_[0-9a-f]{32}\)/u)
    assert.match(body.text, /authorized Action/u)
    assert.doesNotMatch(body.text, /SECRET/u, 'the generated instruction quoted the file')
    // Neither a message nor an attachment is still a refusal.
    const empty = await call('/cases', { method: 'POST', body: JSON.stringify({ text: '   ' }) })
    assert.equal(empty.status, 400)
    assert.match((await empty.json()).teaching, /needs a message, an attachment, or both/u)
  }, { withAgent: true })
})

test('a text-only case submission is unchanged by the attachment path', async () => {
  await withHost(async ({ call, tasks }) => {
    const response = await call('/cases', {
      method: 'POST',
      body: JSON.stringify({ text: 'plain question', sessionKey: 'ctx-plain', caseType: 'exploration', businessKey: { id: 'x' } }),
    })
    assert.equal(response.status, 202)
    const body = tasks().filter((entry) => entry.kind === 'task').at(-1).body
    assert.deepEqual(body, { text: 'plain question', sessionKey: 'ctx-plain', caseType: 'exploration', businessKey: { id: 'x' } },
      'a submission with no attachments gained or lost a field')
  }, { withAgent: true })
})

test('a case submission naming a material this profile does not own fails whole', async () => {
  await withHost(async ({ call, tasks }) => {
    const added = (await (await add(call, { name: 'a.txt', mediaType: 'text/plain', text: 'a' })).json()).material
    for (const [attachments, status, code] of [
      [[`mat_${'0'.repeat(32)}`], 400, 'material_not_found'],
      [['/etc/passwd'], 400, 'material_id_invalid'],
      [[added.id, added.id], 400, 'attachments_repeated'],
      [Array.from({ length: 9 }, () => added.id), 400, 'attachments_too_many'],
      ['not-an-array', 400, 'attachments_invalid'],
    ]) {
      const response = await call('/cases', { method: 'POST', body: JSON.stringify({ text: 'go', attachments }) })
      assert.equal(response.status, status, `${JSON.stringify(attachments)} was not refused`)
      assert.equal((await response.json()).errorCode, code)
    }
    // Nothing was forwarded for any of them: a partially honoured list would not say which
    // of the operator's selections were dropped.
    assert.deepEqual(tasks().filter((entry) => entry.kind === 'task'), [])
  }, { withAgent: true })
})

test('local delivery is authenticated by the materials key, which is not the page key', async () => {
  await withHost(async ({ host, call }) => {
    const added = (await (await add(call, { name: 'notes.txt', mediaType: 'text/plain', text: 'delivered text' })).json()).material
    const base = `http://127.0.0.1:${host.port}`
    const claim = (headers, body) => fetch(`${base}/materials/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: `127.0.0.1:${host.port}`, ...headers },
      body: JSON.stringify(body),
    })
    // The page key is not the materials key, and neither is nothing at all.
    for (const headers of [{}, { 'x-rulith-local': KEY }, { 'x-rulith-material': 'guessed' }]) {
      const refused = await claim(headers, { ticket: 'anything', modelDestination: REMOTE_MODEL })
      assert.equal(refused.status, 401)
      const teaching = JSON.stringify(await refused.json())
      assert.doesNotMatch(teaching, /delivered text/u, 'a refusal carried content')
      assert.doesNotMatch(teaching, new RegExp(KEY, 'u'))
    }
    // And the rebinding protections still apply to it — it is answered ahead of the page
    // gate, so it has to carry them itself.
    const rebound = await raw(host.port, '/materials/deliver', {
      method: 'POST', headers: { 'content-type': 'application/json', host: 'rebound.example' }, body: '{}',
    })
    assert.equal(rebound.status, 403)
    assert.match(rebound.text, /DNS rebinding/u)
    const cross = await fetch(`${base}/materials/deliver`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}',
    })
    assert.equal(cross.status, 403)
    assert.ok(added.id)
  })
})

test('a material added under a local model attaches normally while that model is still configured', async () => {
  // The calibration for the arm below: under the destination it was added for, the same
  // gesture works. A refusal test alone would also pass against a host that refused
  // everything local.
  await withHost(async ({ call, tasks }) => {
    const added = (await (await add(call, { name: 'local.txt', mediaType: 'text/plain', text: 'local-only secret' })).json()).material
    assert.deepEqual((await (await call('/materials')).json()).materials.map((row) => row.id), [added.id])
    const attach = await call('/cases', { method: 'POST', body: JSON.stringify({ text: 'read it', attachments: [added.id] }) })
    assert.equal(attach.status, 202, await attach.text())
    const forwarded = tasks().filter((entry) => entry.kind === 'task')
    assert.equal(forwarded.length, 1)
    assert.doesNotMatch(JSON.stringify(forwarded[0].body), /local-only secret/u)
  }, { withAgent: true, modelUrl: 'http://127.0.0.1:1234' })
})

test('a host whose model endpoint was re-pointed refuses an attachment selected under the old one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-materials-move-'))
  try {
    const configFile = join(dir, 'local.json')
    const taskLog = join(dir, 'tasks.jsonl')
    const root = defaultMaterialRoot(configFile)
    const { openMaterialStore } = await import('../worker/material-store.mjs')
    // Written exactly as the host writes it, under the local model endpoint.
    const local = openMaterialStore(root, identityOf(configFile, 'http://127.0.0.1:1234'))
    const record = local.put({ name: 'local.txt', mediaType: 'text/plain', bytes: Buffer.from('local-only secret') })

    const config = defaultLocalConfig()
    config.agent.env = { ...config.agent.env, RULITH_TOKEN: AGENT_TOKEN, RULITH_URL: GATEWAY, RULITH_MODEL_URL: REMOTE_MODEL,
      RULITH_TEST_TASK_LOG: taskLog }
    config.worker.env = { ...config.worker.env, RULITH_CONNECTION: CONNECTION, RULITH_CONNECTION_KEY: 'key-1' }
    config.paths = { agent: join(HERE, 'support', 'task-agent.mjs'), worker: join(dir, 'absent-worker.mjs') }
    const host = await startAgentHost(configFile, config, ['agent'])
    try {
      const attach = await fetch(`http://127.0.0.1:${host.port}/cases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rulith-local': KEY },
        body: JSON.stringify({ text: 'read it', attachments: [record.id] }),
      })
      assert.equal(attach.status, 400)
      const refusal = await attach.json()
      assert.equal(refusal.errorCode, 'material_disclosure_refused')
      assert.match(refusal.teaching, /model destination is now/u)
      assert.doesNotMatch(JSON.stringify(refusal), /local-only secret/u)
      // Nothing crossed the hop.
      const forwarded = existsSync(taskLog)
        ? readFileSync(taskLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : []
      assert.deepEqual(forwarded.filter((entry) => entry.kind === 'task'), [])
    } finally {
      await host.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a local read is routed to the custodian, and this host adds no authority of its own', async () => {
  await withHost(async ({ host, call, tasks }) => {
    const added = (await (await add(call, { name: 'notes.txt', mediaType: 'text/plain', text: 'the real text' })).json()).material
    const claim = (body) => fetch(`http://127.0.0.1:${host.port}/materials/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rulith-material': host.materialsKey },
      body: JSON.stringify(body),
    })
    const delivered = await claim({ ticket: 'mlt_from_the_gateway', modelDestination: REMOTE_MODEL })
    const body = await delivered.json()
    assert.equal(delivered.status, 200, JSON.stringify(body))
    // The custodian's answer is handed back as it stands. This host produced no byte of it.
    assert.equal(body.result.ref, `art_${'a'.repeat(32)}`)
    assert.equal(body.result.data, 'from the custodian')
    // And the ticket reached the custodian unaltered, with the destination this host verified.
    const asked = tasks().filter((entry) => entry.kind === 'custody-read')
    assert.deepEqual(asked, [{ kind: 'custody-read', ticket: 'mlt_from_the_gateway', modelDestination: REMOTE_MODEL }])
    assert.ok(added.id)
  }, {
    withAgent: true,
    custodyReply: { ok: true, result: {
      ref: `art_${'a'.repeat(32)}`, mediaType: 'text/plain; charset=utf-8', encoding: 'utf8',
      data: 'from the custodian', offset: 0, nextOffset: null, totalBytes: 18, complete: true, truncated: false } },
  })
})

test('a local read with no ticket, no custodian, or the wrong destination is refused', async () => {
  // No ticket: there is no other way to ask, and this host has nothing it could substitute.
  // The Agent stand-in runs so the identity comparison passes and these arms are about the
  // thing each one names rather than about an unconfirmed reader.
  await withHost(async ({ host }) => {
    const claim = (body) => fetch(`http://127.0.0.1:${host.port}/materials/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rulith-material': host.materialsKey },
      body: JSON.stringify(body),
    })
    const noTicket = await claim({ modelDestination: REMOTE_MODEL })
    assert.equal(noTicket.status, 400)
    assert.equal((await noTicket.json()).errorCode, 'local_ticket_missing')
    // A destination this host is not configured for is refused rather than resolved in favour
    // of either side.
    const moved = await claim({ ticket: 'mlt_x', modelDestination: 'https://elsewhere.example/v1/messages' })
    assert.equal(moved.status, 400)
    assert.equal((await moved.json()).errorCode, 'material_destination_mismatch')
    // And with no Worker running there is no custodian to route to.
    const offline = await claim({ ticket: 'mlt_x', modelDestination: REMOTE_MODEL })
    assert.equal((await offline.json()).errorCode, 'material_custodian_offline')
  }, { withAgent: true })

  // A custodian that refuses passes its own refusal back, and no content comes with it.
  await withHost(async ({ host }) => {
    const refused = await fetch(`http://127.0.0.1:${host.port}/materials/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rulith-material': host.materialsKey },
      body: JSON.stringify({ ticket: 'mlt_x', modelDestination: REMOTE_MODEL }),
    })
    const body = await refused.json()
    assert.equal(refused.status, 400)
    assert.equal(body.errorCode, 'local_ticket_expired')
    assert.doesNotMatch(JSON.stringify(body), /real text/u)
  }, { withAgent: true, custodyReply: { ok: false, errorCode: 'local_ticket_expired', teaching: 'That ticket has expired.' } })
})

test('a profile whose Agent has not confirmed its identity does not disclose local material', async () => {
  // Both sides of the owner binding, compared by the one process that holds both. The Connection
  // side is settled by opening the area at all; the Agent side comes from the running Agent's own
  // authenticated session, and until it has one this host does not know whose files a read would
  // be disclosing. An unconfirmed reader is not the same as an absent restriction.
  await withHost(async ({ host, tasks }) => {
    const refused = await fetch(`http://127.0.0.1:${host.port}/materials/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rulith-material': host.materialsKey },
      body: JSON.stringify({ ticket: 'mlt_x', modelDestination: REMOTE_MODEL }),
    })
    const body = await refused.json()
    assert.equal(refused.status, 400)
    assert.equal(body.errorCode, 'material_identity_unconfirmed')
    // Nothing reached the custodian: the comparison happens before the hop, not after it.
    assert.deepEqual(tasks().filter((entry) => entry.kind === 'custody-read'), [])
  }, {
    withAgent: false,
    custodyReply: { ok: true, result: {
      ref: `art_${'a'.repeat(32)}`, mediaType: 'text/plain; charset=utf-8', encoding: 'utf8',
      data: 'SHOULD-NEVER-BE-READ', offset: 0, nextOffset: null, totalBytes: 20, complete: true, truncated: false } },
  })
})

test('the Agent child is given the delivery endpoint and the materials key, and never the page key', async () => {
  await withHost(async ({ tasks, host }) => {
    const start = tasks().find((entry) => entry.kind === 'start')
    assert.ok(start !== undefined, 'the Agent stand-in never reported its environment')
    const environment = start.environment
    assert.equal(environment.RULITH_MATERIALS_DELIVER_URL, `http://127.0.0.1:${host.port}/materials/deliver`)
    assert.equal(environment.RULITH_MATERIALS_KEY, host.materialsKey)
    assert.equal(environment.RULITH_MATERIALS_CONNECTION, CONNECTION)
    assert.match(environment.RULITH_MATERIALS_KEY, /^[0-9a-f]{32}$/u)
    assert.notEqual(host.materialsKey, KEY)
    assert.equal(Object.values(environment).includes(KEY), false,
      'the Agent was handed this host\'s page key, which also opens /control and /setup')
    // The custodian binding belongs to the Worker, not to the Agent.
    assert.equal(environment.RULITH_MATERIALS_OWNER, undefined,
      'the Agent child was given a Worker material binding it has no use for')
  }, { withAgent: true, custodyReply: { ok: false } })
})

test('an exited Agent cannot leave its confirmed identity available for later local claims', async () => {
  await withHost(async ({ host, call, tasks }) => {
    assert.equal(host.agentId, AGENT_ID)
    const stopped = await call('/control', { method: 'POST', body: JSON.stringify({ role: 'agent', operation: 'stop' }) })
    assert.equal((await stopped.json()).state, 'stopped')
    const response = await fetch(`http://127.0.0.1:${host.port}/materials/deliver`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-material': host.materialsKey },
      body: JSON.stringify({ ticket: 'mlt_from_the_gateway', modelDestination: REMOTE_MODEL }),
    })
    assert.equal((await response.json()).errorCode, 'material_identity_unconfirmed')
    assert.deepEqual(tasks().filter(entry => entry.kind === 'custody-read'), [])
  }, { withAgent: true, custodyReply: { ok: true, result: { data: 'must not be disclosed' } } })
})

test('an Agent-only profile does not offer a local custodian even when material storage is configured', async () => {
  await withHost(async ({ tasks }) => {
    const environment = tasks().find(entry => entry.kind === 'start').environment
    assert.equal(environment.RULITH_MATERIALS_CONNECTION, '')
    assert.equal(environment.RULITH_MATERIALS_DELIVER_URL, undefined)
    assert.equal(environment.RULITH_MATERIALS_KEY, undefined)
  }, { withAgent: true })
})

test('the Worker child is given the material area and fingerprints, never the Agent credential', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-materials-worker-'))
  try {
    const configFile = join(dir, 'local.json')
    const taskLog = join(dir, 'worker.jsonl')
    const config = defaultLocalConfig()
    config.agent.env = { ...config.agent.env, RULITH_TOKEN: AGENT_TOKEN, RULITH_URL: GATEWAY, RULITH_MODEL_URL: REMOTE_MODEL }
    config.worker.env = { ...config.worker.env, RULITH_CONNECTION: CONNECTION, RULITH_CONNECTION_KEY: 'key-1',
      RULITH_TEST_TASK_LOG: taskLog }
    config.paths = { agent: join(dir, 'absent-agent.mjs'), worker: join(import.meta.dirname, 'support', 'worker-probe.mjs') }
    const host = createLocalHost({ configFile, config, roles: ['worker'], port: 0, key: KEY, autoStart: true, startConfirmMs: 8000 })
    await host.listen()
    try {
      const deadline = Date.now() + 8000
      while (!existsSync(taskLog) && Date.now() < deadline) await new Promise((wait) => setTimeout(wait, 25))
      const environment = JSON.parse(readFileSync(taskLog, 'utf8').trim().split('\n')[0]).environment
      const expected = identityOf(configFile)
      assert.equal(environment.RULITH_MATERIALS_ROOT, resolve(defaultMaterialRoot(configFile)))
      assert.equal(environment.RULITH_MATERIALS_PROFILE, expected.profile)
      assert.equal(environment.RULITH_MATERIALS_OWNER, expected.owner)
      assert.equal(environment.RULITH_MATERIALS_MODEL_DESTINATION, expected.modelDestination)
      assert.equal(Object.values(environment).includes(AGENT_TOKEN), false,
        'the Worker was handed the Agent credential it is deliberately never given')
      assert.equal(environment.RULITH_MATERIALS_KEY, undefined,
        'the Worker was handed the delivery key, which is the Agent\'s to hold')
    } finally {
      await host.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

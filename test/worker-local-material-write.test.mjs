// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { materialIdentity, openMaterialStore } from '../worker/material-store.mjs'
import { executionDigest, workerToolsOf } from '../worker/rulith-worker.mjs'
import { guardCatalogDigest, legacyGuardCatalogDigest } from '../worker/action-input-db.mjs'
import { actionRow, driveWorker, grantFor, HOLD, signGrant } from './support/worker-harness.mjs'

const ID = 'qa.selected-note@1'
const profile = { format: 'rulith-http-text-write/2', method: 'PUT', relativePath: '/notes/{target}',
  targetParam: 'target', payloadParam: 'payload', contentType: 'text/plain; charset=utf-8' }
const fence = { method: 'PUT', completion: { stage: 'terminal', statuses: [200], json: { field: 'done', equals: true } }, textWrite: profile }
const tool = { adapter: 'http', sourceTypes: ['http'], entry: profile.relativePath, kind: 'write',
  params: { target: 'string', payload: 'json' }, returns: [], fence }
const roles = { target: { role: 'grounded' }, payload: { role: 'payload', guard: 'rulith.payload.local-material@1',
  guardConfig: {} } }
const spec = { impl: 'worker-tool', exec: ID, kind: 'write', sourceTypes: ['http'], params: tool.params,
  returns: [], fence, inputRoles: roles, guardCatalogDigest }
const bindingDigest = `sha256:${'a'.repeat(64)}`
const tools = workerToolsOf({ format: 'rulith-worker-tools/1', tools: { [ID]: tool } })

async function selectedRun({ bytes = Buffer.from('exact selected bytes'), mutateRow, claim, sourceResponse = '{"done":true}',
  removeAfterClaim = false, localOnly = false, workerDeviceId = 'device-one', localOverrideUrl, sourceReply,
  grantVersion = 4, grantSourceBindingDigest } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-selected-write-'))
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ method: req.method, path: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(sourceResponse)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const root = join(dir, 'materials')
    const identity = materialIdentity({ configFile: join(dir, 'local.json'), gatewayUrl: 'https://api.rulith.ai',
      connectionId: 'conn-p2', agentId: 'agent', deviceId: 'device-one',
      modelUrl: localOnly ? 'http://127.0.0.1:1234' : 'https://model.example' })
    const store = openMaterialStore(root, identity)
    const record = store.put({ name: 'selected.txt', mediaType: 'text/plain', bytes })
    store.submitSelected(record.uiHandle, { sessionKey: 's', caseId: 'c' })
    const input = { selector: record.selector, digest: record.digest, custodyId: record.id,
      totalBytes: record.totalBytes, deviceId: 'device-one', bindingDigest }
    const sourceBinding = { version: 'rulith-http-source-binding/1', sourceRecordId: 'notes',
      connectionId: 'conn-p2', access: `http://127.0.0.1:${server.address().port}/` }
    const row = actionRow({ tool: 'qa.selected-note', toolContractId: ID, toolDigest: tools[ID].digest,
      sourceRecordId: 'notes', args: JSON.stringify({ source: 'notes', target: 'record-1',
        payload: { ref: record.selector, digest: record.digest } }), toolSpec: JSON.stringify(spec),
      materialInput: input, sourceBinding, completionRequirement: { stage: 'terminal' } })
    mutateRow?.(row, record)
    let polls = 0
    const run = await driveWorker({ extraTools: { [ID]: tool }, sourceReply,
      ...(localOverrideUrl ? { extraFiles: { 'no-secrets.json': JSON.stringify({ notes: { type: 'http', url: localOverrideUrl } }) } } : {}),
      sources: () => [{ name: 'notes', type: 'http', access: `http://127.0.0.1:${server.address().port}/` }],
      env: { RULITH_MATERIALS_ROOT: root, RULITH_MATERIALS_PROFILE: identity.profile,
        RULITH_MATERIALS_OWNER: identity.owner, RULITH_MATERIALS_AGENT_FINGERPRINT: identity.agentFingerprint,
        RULITH_MATERIALS_DEVICE_ID: workerDeviceId, RULITH_MATERIALS_MODEL_DESTINATION: identity.modelDestination },
      reply: operation => {
        if (operation.kind === 'Poll') {
          if (++polls !== 1) return HOLD
          row.executionGrant = signGrant({ ...grantFor(row, { workerId: operation.workerId,
            workerGeneration: 7 }), version: grantVersion, materialBindingDigest: bindingDigest,
          ...(grantVersion === 4 ? { sourceBindingDigest: grantSourceBindingDigest ?? executionDigest(row.sourceBinding) } : {}) })
          return { body: { accepted: true, payload: { work: [row] } } }
        }
        if (operation.kind === 'ClaimWork') {
          if (removeAfterClaim) unlinkSync(join(root, 'objects', record.id, 'chunks', '000000.bin'))
          return { body: { accepted: typeof claim === 'function' ? claim(row) : claim !== false } }
        }
        return { body: { accepted: true } }
      },
      done: (seen, output) => seen.some(entry => entry.operation.kind === 'ReportWork')
        || /Skipping qa.selected-note|Not claiming qa.selected-note|Claiming qa.selected-note was rejected|Result data for qa.selected-note could not be delivered/.test(output),
    })
    return { run, requests, row, record }
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

test('selected /2 action sends exact verified bytes once after Claim and reports terminal evidence', async () => {
  const bytes = Buffer.from('Hi, 世界\n')
  const { run, requests } = await selectedRun({ bytes, removeAfterClaim: true })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').length, 1, run.output)
  assert.equal(run.of('Poll')[0].operation.inputAdoption?.guardsByKind?.write?.includes('rulith.payload.local-material@1'), true)
  assert.equal(requests.length, 1, run.output)
  assert.deepEqual(requests[0], { method: 'PUT', path: '/notes/record-1',
    type: 'text/plain; charset=utf-8', body: bytes })
  assert.equal(run.of('ReportWork').length, 1, run.output)
  assert.equal(run.of('ReportWork')[0].operation.ok, true)
})

test('selected /2 terminal response cannot echo submitted bytes into the Board result', async () => {
  const bytes = Buffer.from('private selected note')
  const { run, requests } = await selectedRun({ bytes,
    sourceResponse: JSON.stringify({ done: true, echo: bytes.toString('utf8') }) })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(requests.length, 1, run.output)
  const report = run.of('ReportWork')[0]?.operation
  assert.equal(report?.ok, true, run.output)
  assert.equal(report?.completionStage, 'terminal')
  assert.equal(String(report.result).includes(bytes.toString('utf8')), false)
  assert.equal(JSON.stringify(report).includes(bytes.toString('utf8')), false)
})

test('a local Source URL override cannot redirect selected bytes to another HTTP host', async () => {
  let redirected = 0
  const other = createServer((_, response) => { redirected++; response.end('{"done":true}') })
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve))
  try {
    const localOverrideUrl = `http://127.0.0.1:${other.address().port}/`
    const { run, requests } = await selectedRun({ localOverrideUrl })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(run.of('ClaimWork').length, 0, run.output)
    assert.equal(requests.length, 0)
    assert.equal(redirected, 0)
  } finally {
    other.closeAllConnections()
    await new Promise(resolve => other.close(resolve))
  }
})

test('selected write cannot use a stale startup Source when the fresh Gateway read fails', async () => {
  let reads = 0
  const { run, requests } = await selectedRun({ sourceReply: (_, sources) =>
    ++reads === 1 ? { body: { sources } } : { status: 503, body: { errorCode: 'unavailable' } } })
  assert.equal(run.timedOut, false, run.output)
  assert.ok(reads >= 2)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(requests.length, 0)
})

test('fresh Gateway Source A to B drift refuses before Claim and sends to neither destination', async () => {
  let otherWrites = 0
  const other = createServer((_, response) => { otherWrites++; response.end('{"done":true}') })
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve))
  try {
    let reads = 0
    const otherUrl = `http://127.0.0.1:${other.address().port}/`
    const { run, requests } = await selectedRun({ sourceReply: (_, sources) => {
      reads++
      return { body: { sources: reads === 1 ? sources : [{ ...sources[0], access: otherUrl }] } }
    } })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(run.of('ClaimWork').length, 0)
    assert.equal(requests.length, 0)
    assert.equal(otherWrites, 0)
  } finally {
    other.closeAllConnections()
    await new Promise(resolve => other.close(resolve))
  }
})

test('Claimed Source A remains the frozen PUT destination when current configuration later changes to B', async () => {
  let otherWrites = 0
  const other = createServer((_, response) => { otherWrites++; response.end('{"done":true}') })
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve))
  try {
    let current
    const otherUrl = `http://127.0.0.1:${other.address().port}/`
    const { run, requests } = await selectedRun({ sourceReply: (_, sources) => {
      current ??= sources[0].access
      return { body: { sources: [{ ...sources[0], access: current }] } }
    }, claim: () => { current = otherUrl; return true } })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(run.of('ClaimWork').length, 1)
    assert.equal(requests.length, 1)
    assert.equal(otherWrites, 0)
    assert.equal(run.of('ReportWork').length, 1)
  } finally {
    other.closeAllConnections()
    await new Promise(resolve => other.close(resolve))
  }
})

test('Gateway refusing Source A to B drift at Claim prevents the selected PUT', async () => {
  let otherWrites = 0
  const other = createServer((_, response) => { otherWrites++; response.end('{"done":true}') })
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve))
  try {
    let current
    const otherUrl = `http://127.0.0.1:${other.address().port}/`
    const { run, requests } = await selectedRun({ sourceReply: (_, sources) => {
      current ??= sources[0].access
      return { body: { sources } }
    }, claim: row => { current = otherUrl; return current === row.sourceBinding.access } })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(run.of('ClaimWork').length, 1)
    assert.equal(requests.length, 0)
    assert.equal(otherWrites, 0)
    assert.equal(run.of('ReportWork').length, 0)
  } finally {
    other.closeAllConnections()
    await new Promise(resolve => other.close(resolve))
  }
})

test('v4 signed Source binding digest mismatch cannot Claim or PUT', async () => {
  const { run, requests } = await selectedRun({ grantSourceBindingDigest: `sha256:${'0'.repeat(64)}` })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(requests.length, 0)
})

test('selected Source binding cannot name another Connection or Source', async () => {
  for (const field of ['connectionId', 'sourceRecordId']) {
    const { run, requests } = await selectedRun({ mutateRow: row => { row.sourceBinding[field] = 'other' } })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(run.of('ClaimWork').length, 0)
    assert.equal(requests.length, 0)
  }
})

test('archived v3 selected grant decodes but cannot authorize the Source-bound /2 write', async () => {
  const { run, requests } = await selectedRun({ grantVersion: 3 })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(requests.length, 0)
})

test('selected /2 action refuses a wrong public selector before Claim and sends no bytes', async () => {
  const { run, requests } = await selectedRun({ mutateRow: row => {
    const args = JSON.parse(row.args)
    args.payload.ref = `mat_${'0'.repeat(32)}`
    row.args = JSON.stringify(args)
  } })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(requests.length, 0)
})

test('artifact identity cannot substitute for a selected local material', async () => {
  const { run, requests } = await selectedRun({ mutateRow: row => {
    const args = JSON.parse(row.args)
    args.payload.ref = `art_${'0'.repeat(32)}`
    row.args = JSON.stringify(args)
  } })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(requests.length, 0)
})

test('Worker without its device binding does not advertise or execute local material input', async () => {
  const { run, requests } = await selectedRun({ workerDeviceId: '' })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(Boolean(run.of('Poll')[0].operation.inputAdoption?.guardsByKind?.write?.includes('rulith.payload.local-material@1')), false)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(requests.length, 0)
})

test('selected /2 action cannot borrow the old catalog that has no local-material guard', async () => {
  const { run, requests } = await selectedRun({ mutateRow: row => {
    row.toolSpec = JSON.stringify({ ...spec, guardCatalogDigest: legacyGuardCatalogDigest })
  } })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(requests.length, 0)
})

test('operator local-only material cannot leave through selected HTTP write', async () => {
  const { run, requests } = await selectedRun({ localOnly: true })
  assert.equal(run.timedOut, false, run.output)
  assert.match(run.output, /local-only/)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(requests.length, 0)
})

test('invalid UTF-8 is refused before Claim instead of being decoded into different Source bytes', async () => {
  const { run, requests } = await selectedRun({ bytes: Buffer.from([0x61, 0xc0, 0xaf]) })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(requests.length, 0)
})

test('a refused Claim cannot send selected bytes', async () => {
  const { run, requests } = await selectedRun({ claim: false })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').length, 1)
  assert.equal(requests.length, 0)
  assert.equal(run.of('ReportWork').length, 0)
})

test('missing terminal Source evidence leaves the selected invocation unresolved after one PUT', async () => {
  const { run, requests } = await selectedRun({ sourceResponse: '{"done":false}' })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').length, 1)
  assert.equal(requests.length, 1)
  assert.equal(run.of('ReportWork').length, 0)
})

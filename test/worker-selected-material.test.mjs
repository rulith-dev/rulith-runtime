// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { actionRowFaults, readExecutionGrant, selectedMaterialInputFault, selectedMaterialMismatch } from '../worker/rulith-worker.mjs'
import { materialIdentity, openMaterialStore } from '../worker/material-store.mjs'
import { CONNECTION_KEY, HOLD, actionRow, driveWorker, grantFor, signGrant } from './support/worker-harness.mjs'

const bindingDigest = `sha256:${'a'.repeat(64)}`
const v3 = row => ({ ...grantFor(row, { workerId: 'wkr_selected_material' }), version: 3, materialBindingDigest: bindingDigest })

test('v3 grant has its exact overlay shape and v2 cannot carry the selected commitment', () => {
  const row = actionRow()
  assert.equal(readExecutionGrant(signGrant(v3(row)), CONNECTION_KEY).fault, undefined)
  for (const changed of [
    { materialBindingDigest: undefined }, { materialBindingDigest: 'sha256:wrong' },
    { sourceRecordId: '' }, { arbitrary: true },
  ]) assert.ok(readExecutionGrant(signGrant({ ...v3(row), ...changed }), CONNECTION_KEY).fault)
  assert.match(readExecutionGrant(signGrant({ ...grantFor(row, { workerId: 'wkr_selected_material' }), materialBindingDigest: bindingDigest }), CONNECTION_KEY).fault, /does not define/)
})

test('selected row is closed and requires a Source; ordinary v2 row remains valid', () => {
  const row = actionRow({ executionGrant: 'grant' })
  assert.deepEqual(actionRowFaults(row, row.connectionId), [])
  const input = { selector: `mat_${'a'.repeat(32)}`, digest: `sha256:${'b'.repeat(64)}`,
    custodyId: `mat_${'c'.repeat(32)}`, totalBytes: 3, deviceId: 'device-one', bindingDigest }
  assert.deepEqual(actionRowFaults({ ...row, materialInput: input }, row.connectionId), [])
  assert.ok(actionRowFaults({ ...row, materialInput: { ...input, extra: true } }, row.connectionId).length)
  assert.ok(actionRowFaults({ ...row, sourceRecordId: '', materialInput: input }, row.connectionId).length)
  assert.ok(actionRowFaults({ ...row, materialInput: input, completionRequirement: { stage: 'terminal' } }, row.connectionId).length)
  assert.match(selectedMaterialInputFault({ ...input, totalBytes: 0 }), /byte count/)
})

test('selected bytes require signed binding, same device, exact submitted custody, and full original bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-selected-'))
  try {
    const root = join(dir, 'materials')
    const identity = materialIdentity({ configFile: join(dir, 'local.json'), gatewayUrl: 'https://api.rulith.ai',
      connectionId: 'connection', agentId: 'agent', deviceId: 'device-one', modelUrl: 'http://127.0.0.1:1234' })
    const store = openMaterialStore(root, identity)
    const record = store.put({ name: 'source.txt', mediaType: 'text/plain', bytes: Buffer.from('abc') })
    const input = { selector: record.selector, digest: record.digest, custodyId: record.id,
      totalBytes: record.totalBytes, deviceId: 'device-one', bindingDigest }
    const binding = { profile: identity.profile, owner: identity.owner,
      agentFingerprint: identity.agentFingerprint, deviceFingerprint: identity.deviceFingerprint,
      modelDestination: identity.modelDestination }
    const grant = { version: 3, materialBindingDigest: bindingDigest }
    const check = (g = grant, i = input, b = binding) => selectedMaterialMismatch(g, i, { root, binding: b })
    assert.match(check(), /material_not_found/, 'unsubmitted material cannot be used')
    store.submitSelected(record.uiHandle, { sessionKey: 's', caseId: 'c' })
    assert.equal(check(), undefined)
    assert.match(check({ ...grant, materialBindingDigest: `sha256:${'0'.repeat(64)}` }), /binding differs/)
    assert.match(check(grant, { ...input, deviceId: 'device-two' }), /material_device_mismatch/)
    assert.match(check(grant, input, { ...binding, deviceFingerprint: '' }), /material_device_mismatch/)
    assert.match(check(grant, { ...input, custodyId: `mat_${'0'.repeat(32)}` }), /material_not_found/)
    assert.match(check(grant, { ...input, totalBytes: 4 }), /material_effect_input_mismatch/)
    const chunk = join(root, 'objects', record.id, 'chunks', '000000.bin')
    writeFileSync(chunk, 'abd')
    assert.match(check(), /material_chunk_corrupt/)
    unlinkSync(chunk)
    assert.match(check(), /material_bytes_unavailable/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a valid v3 row stays before Claim and Tool until Gateway selected offer exists', async () => {
  let polls = 0
  const dir = mkdtempSync(join(tmpdir(), 'rulith-selected-wire-'))
  try {
    const root = join(dir, 'materials')
    const identity = materialIdentity({ configFile: join(dir, 'local.json'), gatewayUrl: 'https://api.rulith.ai',
      connectionId: 'conn-p2', agentId: 'agent', deviceId: 'device-one', modelUrl: 'http://127.0.0.1:1234' })
    const store = openMaterialStore(root, identity)
    const record = store.put({ name: 'selected.txt', mediaType: 'text/plain', bytes: Buffer.from('real selected bytes') })
    store.submitSelected(record.uiHandle, { sessionKey: 's', caseId: 'c' })
    const input = { selector: record.selector, digest: record.digest, custodyId: record.id,
      totalBytes: record.totalBytes, deviceId: 'device-one', bindingDigest }
    const run = await driveWorker({
      env: { RULITH_MATERIALS_ROOT: root, RULITH_MATERIALS_PROFILE: identity.profile,
        RULITH_MATERIALS_OWNER: identity.owner, RULITH_MATERIALS_AGENT_FINGERPRINT: identity.agentFingerprint,
        RULITH_MATERIALS_DEVICE_ID: 'device-one', RULITH_MATERIALS_MODEL_DESTINATION: identity.modelDestination },
      reply: operation => {
        if (operation.kind !== 'Poll') return undefined
        if (++polls !== 1) return HOLD
        const row = actionRow({ materialInput: input })
        row.executionGrant = signGrant({ ...v3(row), workerId: operation.workerId, workerGeneration: 7 })
        return { body: { accepted: true, payload: { work: [row] } } }
      },
      done: (seen, output) => /selected material Claim\/offer is not available yet/.test(output),
    })
    assert.equal(run.timedOut, false, run.output)
    assert.match(run.output, /selected material Claim\/offer is not available yet/)
    assert.doesNotMatch(run.output, /selected material is unavailable/)
    assert.equal(run.of('ClaimWork').length, 0)
    assert.equal(run.ran('ship'), 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

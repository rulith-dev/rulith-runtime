import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinLocalAuthoringTools, authoringNode, executeLocalAuthoring, proposalDigest } from '../worker/local-authoring.mjs'
import { materialIdentityFromFingerprints, openMaterialStore } from '../worker/material-store.mjs'

const binding = materialIdentityFromFingerprints({ profile: 'a'.repeat(64), owner: 'b'.repeat(64), modelDestination: 'http://127.0.0.1:11434' })
test('local authoring tools are versioned file read tools with the fixed fact mappings', () => {
  const tools = builtinLocalAuthoringTools()
  assert.deepEqual(Object.keys(tools).sort(), ['rulith.official_authoring.check_draft@2', 'rulith.official_authoring.ingest_document@2'])
  for (const tool of Object.values(tools)) assert.deepEqual(tool.sourceTypes, ['file'])
  assert.equal(tools['rulith.official_authoring.ingest_document@2'].returns[0].predicate, 'rulith.official_authoring.authoring_task')
})
test("proposal digest follows Java's four-field authoring surface and treats omissions as null", () => {
  const first = proposalDigest({ program: { id: 'p' }, caseContracts: [], citations: [], examples: [], ignored: 'no' })
  const reordered = proposalDigest({ program: { id: 'p' }, caseContracts: [], citations: [], examples: [] })
  assert.equal(first, reordered)
  assert.equal(proposalDigest({}), proposalDigest({ program: null, caseContracts: null, citations: null, examples: null }))
  assert.notEqual(proposalDigest({ program: { z: 1, a: 2 } }), proposalDigest({ program: { a: 2, z: 1 } }),
    'nested field order is part of Java OrderedJson proposal identity')
})
test('ingest accepts only the profile-owned immutable text material and binds a stable node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rulith-authoring-'))
  try {
    const store = openMaterialStore(root, binding)
    const record = store.put({ name: 'rules.txt', mediaType: 'text/plain', bytes: Buffer.from('When x then y.', 'utf8') })
    const tool = builtinLocalAuthoringTools()['rulith.official_authoring.ingest_document@2']
    const result = await executeLocalAuthoring(tool, { material: record.id }, { materialRoot: root, binding })
    assert.equal(result.rows[0].task_id, record.id)
    assert.equal(result.rows[0].node, authoringNode(record.id, record.digest))
    await assert.rejects(() => executeLocalAuthoring(tool, { material: record.id, node: 'not-used' }, { materialRoot: root, binding: materialIdentityFromFingerprints({ profile: 'c'.repeat(64), owner: 'd'.repeat(64) }) }), /different runtime profile/)
    await assert.rejects(() => executeLocalAuthoring(tool, { material: 'mat_' + '0'.repeat(32) }, { materialRoot: root, binding }), { code: 'material_not_found' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('ingest refuses non-UTF8 material even when its file Source label is text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rulith-authoring-'))
  try {
    const record = openMaterialStore(root, binding).put({ name: 'bad.txt', mediaType: 'text/plain', bytes: Buffer.from([0xc3, 0x28]) })
    const tool = builtinLocalAuthoringTools()['rulith.official_authoring.ingest_document@2']
    await assert.rejects(() => executeLocalAuthoring(tool, { material: record.id }, { materialRoot: root, binding }), /utf8_invalid/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

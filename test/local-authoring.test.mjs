import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinLocalAuthoringTools, authoringNode, executeLocalAuthoring, proposalDigest, LOCAL_AUTHORING_DRAFT_SHAPE, localAuthoringIndexDirectory, recordLocalAuthoringResult, readLocalAuthoringResults } from '../worker/local-authoring.mjs'
import { validateAuthoringCheckerManifest } from '../local/authoring-checker.mjs'
import { materialAgentFingerprint, materialIdentityFromFingerprints, openMaterialStore } from '../worker/material-store.mjs'

const binding = materialIdentityFromFingerprints({ profile: 'a'.repeat(64), owner: 'b'.repeat(64), agentFingerprint: materialAgentFingerprint('ag-authoring'), modelDestination: 'http://127.0.0.1:11434' })
const owner = { ...binding, agentId: 'ag-authoring' }
test('concurrent checked versions remain separately durable beyond the old 200-row index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rulith-authoring-index-'))
  try {
    const rows = Array.from({ length: 205 }, (_, i) => ({ profile: binding.profile, owner: binding.owner,
      resultId: `res_${i.toString(16).padStart(32, '0')}`, materialId: 'mat_' + 'a'.repeat(32),
      proposalDigest: 'sha256:' + 'b'.repeat(64), checkedAt: new Date(Date.UTC(2026, 8, 25) + i * 1000).toISOString() }))
    await Promise.all(rows.map(row => recordLocalAuthoringResult(root, row)))
    const reopened = readLocalAuthoringResults(root, binding)
    assert.equal(reopened.length, 205)
    assert.deepEqual(new Set(reopened.map(row => row.resultId)), new Set(rows.map(row => row.resultId)))
    assert.deepEqual(readLocalAuthoringResults(root, { profile: 'other', owner: binding.owner }), [],
      'another Agent must not even enumerate this profile\'s result entries')
    await recordLocalAuthoringResult(root, rows[0])
    await assert.rejects(() => recordLocalAuthoringResult(root, { ...rows[0], proposalDigest: 'sha256:' + 'c'.repeat(64) }),
      /result_index_conflict/)
    assert.deepEqual(readLocalAuthoringResults(root, binding).find(row => row.resultId === rows[0].resultId), rows[0])
    await mkdir(join(root, 'local-authoring'), { recursive: true })
    const legacy = { ...rows[0], resultId: 'res_' + 'f'.repeat(32) }
    await writeFile(join(root, 'local-authoring', 'results.json'), JSON.stringify([legacy]))
    assert.equal(readLocalAuthoringResults(root, binding).length, 206,
      'existing checked results remain readable without rewriting the old bounded index')
    await writeFile(join(localAuthoringIndexDirectory(root, binding), `${rows[1].resultId}.json`),
      JSON.stringify({ ...rows[1], owner: 'another-agent' }))
    assert.throws(() => readLocalAuthoringResults(root, binding), /differs from its Agent scope/,
      'a corrupted per-result entry must not be silently skipped as another Agent\'s work')
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('the checker source revision and executable URLs are one release identity', () => {
  const commit = 'a'.repeat(40)
  const manifest = { format: 'rulith-local-authoring-checker/1', sourceCommit: commit, files: [
    { name: 'local-authoring.jar', bytes: 1, sha256: 'b'.repeat(64),
      url: `https://console.rulith.ai/downloads/authoring/${commit}/local-authoring.jar` },
    { name: 'rule-check.jar', bytes: 1, sha256: 'c'.repeat(64),
      url: `https://console.rulith.ai/downloads/authoring/${commit}/rule-check.jar` },
  ] }
  assert.equal(validateAuthoringCheckerManifest(structuredClone(manifest)).sourceCommit, commit)
  const mixed = structuredClone(manifest)
  mixed.files[1].url = `https://console.rulith.ai/downloads/authoring/${'d'.repeat(40)}/rule-check.jar`
  assert.throws(() => validateAuthoringCheckerManifest(mixed), /invalid executable pin/)
  const renamed = structuredClone(manifest)
  renamed.files[0].url = `https://console.rulith.ai/downloads/authoring/${commit}/rule-check.jar`
  assert.throws(() => validateAuthoringCheckerManifest(renamed), /invalid executable pin/)
})
test('an upgraded checker pin requires reviewing the Worker draft-shape cue', () => {
  const manifest = JSON.parse(readFileSync(new URL('../local/authoring-checker.json', import.meta.url), 'utf8'))
  assert.equal(manifest.sourceCommit, 'de3c07879d7993a12fe44ba3e01fb4793cc55eb3',
    'the local checker changed; compare its AuthoringPrompt.localDraftReference with the Worker ingest cue before releasing')
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /name:"charge",as:"charge"/)
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /reference the exact as value/)
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /caseType is a business name/)
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /predicate:"add",args:\{left:"\?x",right:1,result:"\?y"\}/)
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /sub,mul,div,min,max use the same keys/)
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /naf:true tests absence in the current closure, not absence in the outside world/)
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /minimumGroundingFloor:"attested"/)
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /program is an object; only construction_json is a string/)
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /Predicate name is final name, as is alias/)
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /Atom args is an object keyed by field, not an array/)
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /program\.id is lowercase 2-32 chars without dots/)
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /Rules name declared aliases\/imports or built-ins/)
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /Business key and opening name the document INPUT/)
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /keys occur in both predicates/)
  assert.match(LOCAL_AUTHORING_DRAFT_SHAPE, /citation\.ruleId must equal a rules\[\]\.id or ruleGroups\[\]\.branches\[\]\.id/)
})
test('local authoring tools are versioned file read tools with the fixed fact mappings', () => {
  const tools = builtinLocalAuthoringTools()
  assert.deepEqual(Object.keys(tools).sort(), ['rulith.official_authoring.check_draft@2', 'rulith.official_authoring.construct_draft@3', 'rulith.official_authoring.ingest_document@2'])
  for (const tool of Object.values(tools)) assert.deepEqual(tool.sourceTypes, ['file'])
  assert.equal(tools['rulith.official_authoring.ingest_document@2'].returns[0].predicate, 'rulith.official_authoring.authoring_task')
  assert.equal(tools['rulith.official_authoring.construct_draft@3'].returns[0].predicate, 'rulith.official_authoring.draft_construction')
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
    const store = openMaterialStore(root, owner)
    const record = store.put({ name: 'rules.txt', mediaType: 'text/plain', bytes: Buffer.from('When x then y.', 'utf8') })
    store.submitSelected(record.uiHandle, { sessionKey: 'authoring-case' })
    const tool = builtinLocalAuthoringTools()['rulith.official_authoring.ingest_document@2']
    const result = await executeLocalAuthoring(tool, { material: record.selector }, { materialRoot: root, binding })
    assert.equal(result.rows[0].task_id, record.selector)
    assert.equal(result.rows[0].node, authoringNode(record.selector, record.digest))
    await assert.rejects(() => executeLocalAuthoring(tool, { material: record.selector, node: 'not-used' }, { materialRoot: root, binding: materialIdentityFromFingerprints({ profile: 'c'.repeat(64), owner: 'd'.repeat(64) }) }), /different runtime profile/)
    await assert.rejects(() => executeLocalAuthoring(tool, { material: 'mat_' + '0'.repeat(32) }, { materialRoot: root, binding }), { code: 'material_not_found' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('ingest refuses non-UTF8 material even when its file Source label is text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rulith-authoring-'))
  try {
    const store = openMaterialStore(root, owner)
    const record = store.put({ name: 'bad.txt', mediaType: 'text/plain', bytes: Buffer.from([0xc3, 0x28]) })
    store.submitSelected(record.uiHandle, { sessionKey: 'authoring-case' })
    const tool = builtinLocalAuthoringTools()['rulith.official_authoring.ingest_document@2']
    await assert.rejects(() => executeLocalAuthoring(tool, { material: record.selector }, { materialRoot: root, binding }), /utf8_invalid/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

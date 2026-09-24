// SPDX-License-Identifier: Apache-2.0
/**
 * `rulith.materials.read@1`: a governed read over this profile's immutable material area.
 *
 * Four properties are what make it safe to point a model at somebody's file, and each has an
 * arm here:
 *
 *   · **It is a Source-backed Tool, not a back door.** The invocation names a governed `file`
 *     Source whose access root *is* the material area. A Source naming a parent directory is
 *     refused, so the governed record cannot be widened into a filesystem browser.
 *   · **It reports a reference, never the content** — including for a three-byte text file, so
 *     material bytes are never copied into a cloud inline result as a side effect of being
 *     small, and `prepareActionReport` has no upload path for one.
 *   · **It lands no facts.** `returns` is empty. Reading bytes establishes what the bytes are,
 *     not that what they say is true.
 *   · **It opens no containers.** A DOCX is delivered as bytes under its media type.
 *
 * The material area's own bindings are exercised in `material-store.test.mjs`; what is under
 * test here is the Worker's use of them.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { defaultMaterialRoot, materialIdentity, openMaterialStore } from '../worker/material-store.mjs'

const TOOL = 'rulith.materials.read@1'
const AUTHORING_INGEST = 'rulith.official_authoring.ingest_document@2'
const REMOTE_MODEL = 'https://api.anthropic.com/v1/messages'
const GATEWAY = 'https://api.rulith.ai'

// One area, one binding, one import. The Worker reads its material binding from the
// environment at load time exactly as a launched child does, so the fixture is built before
// the module is brought in rather than injected afterwards.
const DIR = mkdtempSync(join(tmpdir(), 'rulith-worker-materials-'))
const CONFIG_FILE = join(DIR, 'local.json')
const ROOT = defaultMaterialRoot(CONFIG_FILE)
const IDENTITY = materialIdentity({
  configFile: CONFIG_FILE, gatewayUrl: GATEWAY, connectionId: 'con-worker', agentId: 'ag_worker', modelUrl: REMOTE_MODEL,
})
const store = openMaterialStore(ROOT, IDENTITY)
const TEXT = store.put({ name: 'notes.md', mediaType: 'text/markdown; charset=utf-8', bytes: Buffer.from('# Heading\n\nbody text\n', 'utf8') })
const PNG = store.put({ name: 'pixel.png', mediaType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) })
const DOCX = store.put({
  name: 'contract.docx', bytes: Buffer.from('PK not really a document', 'binary'),
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
})
const SPOILED = store.put({ name: 'spoiled.txt', mediaType: 'text/plain', bytes: Buffer.from('the original text') })
for (const record of [TEXT, PNG, DOCX, SPOILED]) store.submitSelected(record.uiHandle, { sessionKey: 'worker-case' })
writeFileSync(join(ROOT, 'objects', SPOILED.id, 'chunks', '000000.bin'), 'the REPLACED text')
// A record of the same profile under a different owner: written straight into this area's
// object directory, so it is present on disk and invisible to this Worker's binding. It cannot
// be written through a second store handle, because opening one under another owner is itself
// refused — which is the point.
const FOREIGN_ID = `mat_${'f'.repeat(32)}`
mkdirSync(join(ROOT, 'objects', FOREIGN_ID, 'chunks'), { recursive: true })
writeFileSync(join(ROOT, 'objects', FOREIGN_ID, 'chunks', '000000.bin'), 'not yours')
writeFileSync(join(ROOT, 'objects', FOREIGN_ID, 'record.json'), JSON.stringify({
  ...JSON.parse(readFileSync(join(ROOT, 'objects', TEXT.id, 'record.json'), 'utf8')),
  id: FOREIGN_ID, owner: { profile: IDENTITY.profile, owner: 'e'.repeat(64) },
}))

process.env.RULITH_MATERIALS_ROOT = ROOT
process.env.RULITH_MATERIALS_PROFILE = IDENTITY.profile
process.env.RULITH_MATERIALS_OWNER = IDENTITY.owner
process.env.RULITH_MATERIALS_AGENT_FINGERPRINT = IDENTITY.agentFingerprint
process.env.RULITH_MATERIALS_MODEL_DESTINATION = IDENTITY.modelDestination
const worker = await import('../worker/rulith-worker.mjs')

process.on('exit', () => rmSync(DIR, { recursive: true, force: true }))

const SOURCES = { materials: { type: 'file', access: ROOT }, wider: { type: 'file', access: DIR } }

/** The compiled Tool a dispatched invocation produces, through the Worker's own compiler. */
const compiled = (material, { source = 'materials', exec = 'read' } = {}) => worker.adapterToolFromSpec(
  JSON.stringify({ name: TOOL, kind: 'read', impl: 'material', ...(source === false ? {} : { source }), exec, params: { material: 'string' }, returns: [] }),
  JSON.stringify({ material }))

const read = (material, options) => worker.execute(TOOL, { material }, { [TOOL]: compiled(material, options) }, SOURCES, {})

const refusedWith = async (promise) => {
  try {
    await promise
  } catch (error) {
    return String(error.message)
  }
  return assert.fail('the read was expected to refuse and returned instead')
}

test('the material Tool is advertised only where a material area is configured', () => {
  const manifest = { format: 'rulith-worker-tools/1', tools: {} }
  assert.equal(Object.hasOwn(worker.configuredWorkerTools(manifest, 'read', ''), TOOL), false,
    'a profile with no material area advertised a Tool that cannot work')
  const withArea = worker.configuredWorkerTools(manifest, 'read', ROOT)
  assert.equal(Object.hasOwn(withArea, TOOL), true)

  const descriptor = worker.workerToolDescriptor(TOOL, withArea[TOOL])
  assert.deepEqual(descriptor.sourceTypes, ['file'])
  assert.equal(descriptor.kind, 'read')
  assert.deepEqual(descriptor.params, { material: 'string' })
  assert.deepEqual(descriptor.returns, [],
    'the material read declared result facts: reading bytes would become asserting them')
  assert.match(descriptor.digest, /^[a-f0-9]{64}$/u)
  // It survives the advertisement check the Poll sends it through.
  assert.equal(worker.workerToolManifest(withArea).some((row) => row.id === TOOL), true)
})

test('local authoring ingest reaches the actual adapter compiler, preserves work args, maps facts and returns an Artifact', async () => {
  const builtins = worker.builtinLocalAuthoringTools(ROOT)
  const definition = builtins[AUTHORING_INGEST]
  const resolved = worker.adapterToolFromSpec(JSON.stringify({
    name: AUTHORING_INGEST, kind: 'read', impl: 'local-authoring', source: 'materials', exec: 'ingest',
    params: definition.params, returns: definition.returns,
  }), JSON.stringify({ material: TEXT.selector }))
  const executed = await worker.execute(AUTHORING_INGEST, resolved._args, { [AUTHORING_INGEST]: resolved }, SOURCES, {})
  assert.equal(executed.facts.length, 1)
  assert.equal(executed.facts[0].predicate, 'rulith.official_authoring.authoring_task')
  assert.equal(executed.facts[0].args.task_id, TEXT.selector)
  assert.match(executed.facts[0].args.node, /^node_[a-f0-9]{32}$/u)
  assert.match(executed.localArtifact.id, /^res_[a-f0-9]{32}$/u)
  assert.equal(executed.localArtifact.producedFrom, TEXT.id)
  assert.match(executed.safeInlineGuidance, /construction_json as a STRING containing one rulith-authoring-construction\/1 object/u)
  assert.match(executed.safeInlineGuidance, /program=\{id,title,summary,predicates:/u)
  assert.match(executed.safeInlineGuidance, /caseContracts=\[\{caseType,title,businessKey:/u)
  assert.doesNotMatch(executed.result, /body text|Heading/u,
    'ingest guidance must not disclose or claim the uploaded document text')
  assert.ok(Buffer.byteLength(executed.safeInlineGuidance) < 2_048, 'the shape cue must stay inline and bounded')
  const report = await worker.prepareActionReport(ROW,
    { ok: true, ...executed }, { register: async record => accept(record) })
  assert.equal(report.body.result, executed.safeInlineGuidance,
    'the fixed format cue must reach the model beside the Artifact reference')
  assert.deepEqual(report.body.artifacts, [{ ref: `art_${'a'.repeat(32)}` }])
  assert.equal(JSON.stringify(report.body).includes('body text'), false)
  const narrow = await worker.prepareActionReport(
    { ...ROW, artifactPolicy: { ...ROW.artifactPolicy, inlineBytes: 200 } },
    { ok: true, result: 'body text', localArtifact: executed.localArtifact, safeInlineGuidance: executed.safeInlineGuidance },
    { register: async record => accept(record) })
  assert.equal(narrow.body.result, '', 'the cue must be optional under a small negotiated inline budget')
  const untrusted = await worker.prepareActionReport(ROW,
    { ok: true, result: 'body text', localArtifact: executed.localArtifact, safeInlineGuidance: 'body text' },
    { register: async record => accept(record) })
  assert.equal(untrusted.body.result, '', 'an arbitrary tool result must never cross the Artifact boundary')
})

test('the material adapter ships with this Worker and cannot be declared in a Manifest', () => {
  assert.throws(() => worker.workerToolsOf({
    format: 'rulith-worker-tools/1',
    tools: { 'acme.read_material@1': { adapter: 'material', sourceTypes: ['file'], entry: 'read' } },
  }), /ships with this Worker and is not declarable/u)
  // The reason is stated, not just the refusal: a declared copy could carry its own `returns`.
  assert.throws(() => worker.workerToolsOf({
    format: 'rulith-worker-tools/1',
    tools: { 'acme.read_material@1': { adapter: 'material', sourceTypes: ['file'], entry: 'read',
      returns: [{ predicate: 'acme.fact', args: { text: '$text' } }] } },
  }), /map raw bytes onto Board predicates/u)
})

test('a material read produces a durable local object and reports a sentence, never the content', async () => {
  const executed = await read(TEXT.selector)
  assert.doesNotMatch(executed.result, /body text|Heading/u, 'the material text was copied into the reported result')
  assert.match(executed.result, /notes\.md \(text\/markdown; charset=utf-8, \d+ bytes\) is attached as an Artifact\./u)
  assert.equal(executed.facts, undefined, 'a material read landed facts')

  const produced = executed.localArtifact
  assert.match(produced.id, /^res_[0-9a-f]{32}$/u)
  assert.equal(produced.producedFrom, TEXT.id)
  assert.equal(produced.mediaType, 'text/markdown; charset=utf-8')
  assert.equal(produced.encoding, 'utf8', 'UTF-8 text was not declared as text')
  assert.equal(produced.totalBytes, TEXT.totalBytes)
  assert.equal(produced.digest, TEXT.digest)
  assert.equal(produced.chunkBytes, 64 * 1024)
  assert.deepEqual(produced.chunks, TEXT.chunks)
  assert.notEqual(worker.workerLocalArtifact(produced), undefined,
    'the object this Worker produced does not pass its own validator')

  // The produced object is durable and readable in its own right, with the same bytes.
  const reopened = openMaterialStore(ROOT, IDENTITY)
  assert.equal(reopened.retention().some((row) => row.id === produced.id && row.kind === 'result'), true)
  assert.equal(reopened.read(TEXT.id, { modelDestination: REMOTE_MODEL }).bytes.toString('utf8'), '# Heading\n\nbody text\n')
})

test('binary material is delivered as bytes, and no container is opened', async () => {
  assert.equal((await read(PNG.selector)).localArtifact.encoding, 'base64')
  const document = (await read(DOCX.selector)).localArtifact
  assert.equal(document.encoding, 'base64',
    'this build declared a DOCX as text, which would put a partial reading in front of a model as the document')
  assert.equal(document.mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
})

test('the bound Source decides which area is read, and it cannot be widened', async () => {
  // A governed file Source naming the directory that *contains* the material area is not the
  // material area. Containment would turn one governed record into a filesystem browser.
  const wider = await refusedWith(read(TEXT.id, { source: 'wider' }))
  assert.match(wider, /material area is/u)
  assert.match(wider, /never against a directory that merely contains it/u)

  // A Source-free dispatch is refused during compilation, before anything is claimed.
  assert.throws(() => compiled(TEXT.id, { source: false }), /material toolSpec is missing source/u)
  // And an operation this Worker does not implement is refused by name.
  assert.throws(() => compiled(TEXT.id, { exec: 'write' }), /unsupported operation "write"/u)
})

test('a material id is opaque: a path, a wrong id, or another Agent\'s material is refused', async () => {
  for (const [material, expected] of [
    ['../../local.json', /opaque token/u],
    [join(ROOT, 'store.json'), /opaque token/u],
    ['', /opaque token/u],
    [`mat_${'0'.repeat(32)}`, /material_not_found/u],
    // Stored under the same profile but a different Agent credential. It exists on disk and
    // is still not this Worker's to read.
    [FOREIGN_ID, /material_not_found/u],
  ]) {
    const message = await refusedWith(read(material))
    assert.match(message, expected, `${JSON.stringify(material)} answered ${message}`)
    assert.doesNotMatch(message, /not yours/u, 'a refusal carried the content it was refusing')
  }
})

test('a material whose stored bytes changed underneath the store is refused, not reported', async () => {
  const message = await refusedWith(read(SPOILED.selector))
  assert.match(message, /material_chunk_corrupt/u)
  assert.doesNotMatch(message, /REPLACED|original text/u, 'the refusal carried the bytes it was refusing')
  // Nothing was produced for it: a reference to bytes nobody could verify must not exist.
  assert.equal(openMaterialStore(ROOT, IDENTITY).retention().some((row) => row.producedFrom === SPOILED.id), false)
})

const ROW = {
  work: 'inv-1', executionGrant: 'grant', sourceRecordId: 'materials',
  sourceUpload: { sourceRecordId: 'materials', permission: 'granted', upload: true, refusal: null },
  artifactPolicy: { inlineBytes: 64 * 1024, readBytes: 1024, objectBytes: 1024 * 1024, totalBytes: 1024 * 1024, temporaryRetentionMs: 1000 },
}
/** Registration as the Gateway answers it: the five fields, echoing this object's own. */
const accept = (record) => ({ accepted: true, payload: {
  ref: `art_${'a'.repeat(32)}`, mediaType: record.mediaType, encoding: record.encoding,
  totalBytes: record.totalBytes, digest: record.digest } })

test('a material read is reported by reference whatever its size, and no byte is uploaded', async () => {
  const executed = await read(TEXT.selector)
  const localArtifact = worker.workerLocalArtifact(executed.localArtifact)
  assert.notEqual(localArtifact, undefined)
  // Far inside the inline budget: without the custody branch this result would simply be sent
  // inline, which is exactly how a small attached file would end up copied into a cloud receipt.
  assert.ok(Buffer.byteLength(executed.result) < ROW.artifactPolicy.inlineBytes)

  let custodyCalls = 0
  const registered = []
  const prepared = await worker.prepareActionReport(ROW, { ok: true, result: executed.result, facts: [], localArtifact }, {
    custody: async () => { custodyCalls += 1; throw new Error('bytes already durable must not be re-stored') },
    register: async (record) => { registered.push(record); return accept(record) },
  })
  assert.equal(custodyCalls, 0)
  assert.deepEqual(prepared.body.artifacts, [{ ref: `art_${'a'.repeat(32)}` }])
  assert.equal(prepared.body.result, '', 'the reported result still carried data beside its Artifact reference')
  assert.deepEqual(registered.map((record) => record.id), [localArtifact.id])
  assert.equal(JSON.stringify(registered).includes('body text'), false,
    'the registration carried the object bytes it exists to replace')
})

test('an over-budget ordinary result takes custody locally and registers a manifest, never bytes', async () => {
  const big = 'x'.repeat(2000)
  const held = []
  const registered = []
  const prepared = await worker.prepareActionReport({ ...ROW, artifactPolicy: { ...ROW.artifactPolicy, inlineBytes: 200 } },
    { ok: true, result: big, facts: [] }, {
      custody: async ({ bytes, mediaType, encoding }) => {
        const record = openMaterialStore(ROOT, IDENTITY).putResult({ bytes, mediaType, encoding })
        held.push(record)
        return record
      },
      register: async (record) => { registered.push(record); return accept(record) },
    })
  assert.equal(held.length, 1, 'an over-budget result was not made durable before it was referenced')
  assert.equal(held[0].encoding, 'utf8')
  assert.equal(held[0].totalBytes, big.length)
  assert.deepEqual(prepared.body.artifacts, [{ ref: `art_${'a'.repeat(32)}` }])
  assert.equal(prepared.body.result, '')
  // The registration is a manifest. Searching it for the payload is the whole assertion.
  assert.equal(JSON.stringify(registered[0]).includes(big.slice(0, 100)), false,
    'the registration carried the result bytes')
  // And with no custodian there is no fallback that sends them instead.
  const noCustody = await worker.prepareActionReport({ ...ROW, artifactPolicy: { ...ROW.artifactPolicy, inlineBytes: 200 } },
    { ok: true, result: big, facts: [] }, { register: async (record) => accept(record) })
  assert.equal(noCustody.unavailable, 'material_custody_unavailable')
  assert.equal(noCustody.body, undefined)
})

test('a reference the service does not confirm is not put in a receipt', async () => {
  const executed = await read(TEXT.selector)
  const localArtifact = worker.workerLocalArtifact(executed.localArtifact)
  for (const [label, register, expected] of [
    ['a reference for other bytes', async (record) => ({ ...accept(record), payload: { ...accept(record).payload, digest: `sha256:${'0'.repeat(64)}` } }), 'artifact_registration_unconfirmed'],
    ['no reference at all', async () => ({ accepted: true, payload: {} }), 'artifact_registration_unconfirmed'],
    ['a named refusal', async () => { throw new (await import('../worker/material-store.mjs')).MaterialError('source_material_denied', 'no') }, 'source_material_denied'],
    ['an unexplained failure', async () => { throw new Error('the socket closed') }, 'artifact_registration_unknown'],
  ]) {
    const prepared = await worker.prepareActionReport(ROW, { ok: true, result: executed.result, facts: [], localArtifact },
      { register })
    assert.equal(prepared.unavailable, expected, label)
    assert.equal(prepared.body, undefined, `${label}: a receipt was manufactured anyway`)
  }
})

test('a malformed durable record is not one, and never becomes permission to send bytes instead', () => {
  const sound = {
    id: `res_${'a'.repeat(32)}`, mediaType: 'text/plain', encoding: 'utf8', totalBytes: 12,
    digest: `sha256:${'c'.repeat(64)}`, chunkBytes: 65_536, chunks: [`sha256:${'d'.repeat(64)}`],
  }
  assert.notEqual(worker.workerLocalArtifact(sound), undefined, 'a well-formed record was refused (calibration)')
  for (const broken of [
    undefined, null, 'a string', [],
    { ...sound, id: 'art_' + 'a'.repeat(32) },
    { ...sound, id: '../escape' },
    { ...sound, digest: 'c'.repeat(64) },
    { ...sound, totalBytes: 0 },
    { ...sound, encoding: 'utf-8' },
    { ...sound, chunkBytes: 4096 },
    { ...sound, chunks: [] },
    { ...sound, chunks: ['not-a-digest'] },
    { ...sound, totalBytes: 200_000 },
    { ...sound, mediaType: '' },
  ]) {
    assert.equal(worker.workerLocalArtifact(broken), undefined, `${JSON.stringify(broken)} passed as a durable record`)
  }
})

test('a Worker launched with no material area reads none', () => {
  // The module-level binding cannot be re-read in this process, so the refusal is checked
  // where it is decided for an unconfigured profile: the Tool is not advertised at all, so
  // no invocation can name it and there is nothing to dispatch against.
  assert.deepEqual(Object.keys(worker.builtinMaterialTools('')), [])
  assert.deepEqual(Object.keys(worker.builtinMaterialTools(ROOT)), [TOOL])
})

test('the material area path is not somewhere a workspace Tool may be pointed by accident', () => {
  // A sanity check on the fixture itself rather than on the Worker: the area lives beside the
  // configuration file, so a Source root that covers it also covers `local.json` — which the
  // workspace root check already refuses. Nothing here may quietly rely on that not being so.
  assert.equal(resolve(ROOT).startsWith(resolve(DIR)), true)
  assert.notEqual(resolve(ROOT), resolve(DIR))
  mkdirSync(join(DIR, 'sibling'), { recursive: true })
})

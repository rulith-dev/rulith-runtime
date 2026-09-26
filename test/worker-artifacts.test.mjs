// SPDX-License-Identifier: Apache-2.0
/**
 * How a result too large to report inline reaches the Board — under `rulith-worker-material/1`.
 *
 * The payload upload these arms used to drive is gone. An over-budget result is now made
 * **durable on this machine** and registered by manifest; the Gateway mints the reference and
 * holds no byte. So the questions have changed shape while staying the same questions:
 *
 *   · Does the receipt carry a reference rather than data, and do the required facts stay the
 *     exact business values they were? A reference cannot stand in for a fact.
 *   · Does a failure to register leave **no** receipt at all? The executor already changed the
 *     world; a manufactured outcome is worse than a pending invocation.
 *   · Does anything fall back to sending the bytes? Nothing may, and the absence of that path
 *     is what these arms check by making every failure mode visible instead.
 *
 * `ART-WK-3` is unchanged: the committed row and policy shapes are the same contract.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { prepareActionReport, actionRowFaults } from '../worker/rulith-worker.mjs'
import { defaultMaterialRoot, materialIdentity, openMaterialStore } from '../worker/material-store.mjs'
import { loadWorkerContract } from '../scripts/verify-worker-contract.mjs'
import { actionRow, CONNECTION, HOLD, driveWorker } from './support/worker-harness.mjs'
import { authoringDiagnostics, createAuthoringGuidance, authoringGuidanceText } from '../worker/authoring-diagnostics.mjs'
import { LOCAL_AUTHORING_MODERN_CUE, LOCAL_AUTHORING_REFERENCE_CUE } from '../worker/local-authoring.mjs'

const contract = loadWorkerContract()
const ref = `art_${'a'.repeat(32)}`

/** A real material area, so "durable before it is referenced" is answered by the filesystem. */
async function withArea(run) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-artifact-custody-'))
  try {
    const configFile = join(dir, 'local.json')
    const identity = materialIdentity({
      configFile, gatewayUrl: 'https://api.rulith.ai', connectionId: 'conn-p2',
      agentId: 'ag_artifacts', modelUrl: 'http://127.0.0.1:1234',
    })
    const root = defaultMaterialRoot(configFile)
    return await run({
      root, identity, store: openMaterialStore(root, identity),
      env: {
        RULITH_MATERIALS_ROOT: root,
        RULITH_MATERIALS_PROFILE: identity.profile,
        RULITH_MATERIALS_OWNER: identity.owner,
        RULITH_MATERIALS_MODEL_DESTINATION: identity.modelDestination,
      },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Registration as the Gateway answers it: the five fields, echoing the object's own. */
const confirm = (record) => ({ accepted: true, payload: {
  ref, mediaType: record.mediaType, encoding: record.encoding,
  totalBytes: record.totalBytes, digest: record.digest } })

test('checker guidance fits the receipt budget or is omitted, without copying local report text', async () => {
  await withArea(async ({ store }) => {
    const privateText = 'PRIVATE_MATERIAL_' + '\u0000😀'.repeat(1000)
    const report = { compileErrors: [privateText, 'Invalid Case Type'], examples: { total: 20, results: Array(20).fill({
      passed: false, label: privateText, detail: privateText, missing: [], unexpected: [{}], copiedIntoInputs: [],
    }) }, citations: { unverified: Array(20).fill({ ruleId: privateText, reason: privateText }) } }
    const localArtifact = store.putResult({ bytes: Buffer.from(JSON.stringify(report)), mediaType: 'application/json', encoding: 'utf8' })
    const counts = { examples_total: 20, examples_passed: 0, citations_total: 20, citations_verified: 0, external_actions: 0 }
    const summary = JSON.stringify({ compiled: false, ...counts, errors: authoringDiagnostics(report).errors })
    const facts = [{ predicate: 'rulith.official_authoring.draft_check', args: {
      node: 'node_' + 'c'.repeat(32), task_id: 'mat_' + 'b'.repeat(32), proposal_digest: 'sha256:' + 'a'.repeat(64),
      compiled: false, ...counts, report: summary,
    } }]
    const safeInlineGuidance = createAuthoringGuidance(report)
    const baseBytes = Buffer.byteLength(JSON.stringify({ result: '', reason: '', facts, artifacts: [{ ref }] }))
    for (const inlineBytes of [baseBytes, 8192]) {
      const row = { ...actionRow(), artifactPolicy: { ...actionRow().artifactPolicy, inlineBytes } }
      const prepared = await prepareActionReport(row, { ok: true, facts, localArtifact, safeInlineGuidance }, { register: async () => confirm(localArtifact) })
      assert.equal(prepared.unavailable, undefined)
      assert.deepEqual(prepared.body.facts, facts)
      assert.equal(prepared.body.result, inlineBytes === baseBytes ? '' : authoringGuidanceText(safeInlineGuidance))
      assert.doesNotMatch(JSON.stringify(prepared.body), /PRIVATE_MATERIAL_/)
      assert.deepEqual(prepared.body.artifacts, [{ ref }])
    }
    const narrow = await prepareActionReport({ ...actionRow(), artifactPolicy: { ...actionRow().artifactPolicy, inlineBytes: 200 } },
      { ok: true, facts, localArtifact, safeInlineGuidance }, { register: () => assert.fail('required facts should fail before registration') })
    assert.equal(narrow.unavailable, 'required_facts_exceed_inline_budget')
    for (const forged of [privateText, {}, { ...safeInlineGuidance }]) {
      const prepared = await prepareActionReport(actionRow(), { ok: true, facts, localArtifact, safeInlineGuidance: forged }, { register: async () => confirm(localArtifact) })
      assert.equal(prepared.body.result, '')
    }
    assert.ok(store.read(localArtifact.id, { modelDestination: 'http://127.0.0.1:1234' }).bytes.includes(Buffer.from('PRIVATE_MATERIAL_')))
  })
})

test('ART-WK-1: an over-budget result is durable here before anything references it', async () => {
  await withArea(async ({ store }) => {
    const row = actionRow()
    const text = 'x'.repeat(12_000)
    const held = []
    const registered = []
    const prepared = await prepareActionReport(row, { ok: true, result: text }, {
      custody: async ({ bytes, mediaType, encoding }) => {
        const record = store.putResult({ bytes, mediaType, encoding })
        held.push(record)
        return record
      },
      register: async (record) => {
        // Custody first, always: a reference to bytes nobody has stored yet is a reference to
        // nothing, and the whole point of the acknowledgement is that it is true when it is made.
        assert.equal(held.length, 1, 'registration happened before the bytes were durable')
        assert.equal(store.verify(record.id).digest, record.digest, 'the registered object is not readable here')
        registered.push(record)
        return confirm(record)
      },
    })
    assert.equal(prepared.unavailable, undefined)
    assert.deepEqual(prepared.body.artifacts, [{ ref }])
    assert.equal(prepared.body.result, '', 'the receipt carried the data its reference stands for')
    assert.equal(registered.length, 1)
    assert.equal(held[0].totalBytes, text.length)

    // Calibration: a result that fits inline is still reported inline, and takes no custody.
    const small = await prepareActionReport(row, { ok: true, result: 'short' }, {
      custody: async () => assert.fail('a result that fits inline was taken into custody'),
      register: async () => assert.fail('a result that fits inline was registered'),
    })
    assert.equal(small.body.result, 'short')
    assert.equal(small.body.artifacts, undefined)
  })
})

test('ART-WK-2: required facts never become refs, and an unconfirmed reference never becomes a receipt', async () => {
  await withArea(async ({ store }) => {
    const row = actionRow()
    const facts = [{ predicate: 'order_total', args: { amount: 34 } }]
    const text = '中文'.repeat(9000)
    const custody = async ({ bytes, mediaType, encoding }) => store.putResult({ bytes, mediaType, encoding })
    const prepared = await prepareActionReport(row, { ok: true, result: text, facts }, {
      custody,
      register: async (record) => {
        // The manifest describes the bytes that landed, and carries none of them.
        assert.equal(record.totalBytes, Buffer.byteLength(text, 'utf8'))
        assert.equal(store.read(record.id, { modelDestination: 'http://127.0.0.1:1234' }).bytes.toString('utf8'), text)
        return confirm(record)
      },
    })
    assert.deepEqual(prepared.body.facts, facts, 'the exact business values did not survive the reference path')
    assert.equal(prepared.body.result, '')

    // A confirmation that describes other bytes is not a confirmation of these.
    for (const change of [{ digest: `sha256:${'b'.repeat(64)}` }, { totalBytes: 2 }, { ref: 'file:///secret' },
      { encoding: 'base64' }, { mediaType: 'application/octet-stream' }]) {
      const bad = await prepareActionReport(row, { ok: true, result: text }, {
        custody,
        register: async (record) => ({ accepted: true, payload: { ...confirm(record).payload, ...change } }),
      })
      assert.equal(bad.body, undefined, JSON.stringify(change))
      assert.equal(bad.unavailable, 'artifact_registration_unconfirmed', JSON.stringify(change))
    }

    // Facts that do not fit are a refusal, not something a reference may replace.
    const oversized = await prepareActionReport(row,
      { ok: true, result: text, facts: [{ predicate: 'required', args: { value: text } }] },
      { custody: async () => assert.fail('facts must not be taken into custody as replacements'),
        register: async () => assert.fail('facts must not be registered as replacements') })
    assert.equal(oversized.unavailable, 'required_facts_exceed_inline_budget')
  })
})

test('a selected effect can settle with fixed status when optional response registration is refused', async () => {
  await withArea(async ({ store }) => {
    const response = store.putResult({ mediaType: 'application/json', encoding: 'utf8',
      bytes: Buffer.from('{"done":true,"echo":"private bytes"}') })
    const safe = 'HTTP 200: terminal response confirmed.'
    const prepared = await prepareActionReport(actionRow(), { ok: true, result: safe,
      localArtifact: response, completionStage: 'terminal', optionalArtifact: true }, {
      register: async () => { throw new Error('source_material_denied') },
    })
    assert.equal(prepared.unavailable, undefined)
    assert.equal(prepared.body.result, safe)
    assert.equal(prepared.body.completionStage, 'terminal')
    assert.equal(prepared.body.artifacts, undefined)
    assert.equal(JSON.stringify(prepared.body).includes('private bytes'), false)
    const mismatched = await prepareActionReport(actionRow(), { ok: true, result: safe,
      localArtifact: response, completionStage: 'terminal', optionalArtifact: true }, {
      register: async () => ({ payload: { ref: `art_${'a'.repeat(32)}`,
        digest: `sha256:${'f'.repeat(64)}`, totalBytes: response.totalBytes,
        mediaType: response.mediaType, encoding: response.encoding } }),
    })
    assert.equal(mismatched.unavailable, undefined)
    assert.equal(mismatched.body.result, safe)
    assert.equal(mismatched.body.artifacts, undefined)
  })
})

test('ART-WK-3: nested policy and permission shapes are checked from the committed contract', () => {
  const boundary = contract.fixture.boundaries.find(row => row.id === 'worker-action-item')
  for (const row of boundary.valid) assert.deepEqual(actionRowFaults(row, row.connectionId), [])
  for (const entry of boundary.invalid) assert.ok(actionRowFaults(entry.value, entry.value.connectionId).length, entry.fault)
  const valid = actionRow()
  valid.executionGrant = 'signed.payload'
  for (const value of [NaN, Infinity, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.ok(actionRowFaults({ ...valid, artifactPolicy: { ...valid.artifactPolicy, inlineBytes: value } }, CONNECTION).length)
  }
})

for (const fail of [false, true]) test(`ART-WK-4: the real Worker registers before its receipt; registration failure=${fail}`, async () => {
  await withArea(async ({ env }) => {
    let polls = 0
    const registrations = []
    const run = await driveWorker({
      env,
      extraAdapters: { 'ship-adapter.mjs': "import { appendFileSync } from 'node:fs'; import { join } from 'node:path'; appendFileSync(join(process.env.RULITH_SOURCE_ACCESS, 'effects.log'), 'ship\\n'); console.log(JSON.stringify({result:'x'.repeat(12000)}));" },
      reply: operation => operation.kind === 'Poll'
        ? ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
        : { body: { accepted: true, revision: 'r2' } },
      materialReply: (path, payload) => {
        if (path === '/artifact/delivery') return { body: { accepted: true, delivery: null } }
        if (path !== '/artifact/register') return undefined
        registrations.push(payload)
        return fail
          ? { status: 503, body: { accepted: false, errorCode: 'rejected', reason: 'artifact_index_unconfirmed' } }
          : { body: { accepted: true, payload: {
            ref, mediaType: payload.mediaType, encoding: payload.encoding,
            totalBytes: payload.totalBytes, digest: payload.digest } } }
      },
      done: (seen, output) => seen.some(entry => entry.operation.kind === 'ReportWork') || /could not be delivered/.test(output),
    })
    assert.equal(run.timedOut, false, run.output)
    assert.deepEqual(run.effects, ['ship'], 'the actual external effect happens exactly once')
    assert.equal(registrations.length, 1, run.output)
    // A manifest, never a payload. The result text is 12 000 identical characters, so its
    // absence from every byte this Worker sent is a real assertion.
    assert.equal(registrations[0].chunkDigests.length, 1)
    assert.doesNotMatch(run.seen.map((entry) => entry.raw).join('\n'), /x{200}/u,
      'the result bytes were sent to the Gateway')
    assert.equal(run.of('ArtifactUpload').length, 0, 'the retired payload upload route was called')

    const reports = run.of('ReportWork')
    assert.equal(reports.length, fail ? 0 : 1, run.output)
    if (!fail) {
      assert.deepEqual(reports[0].operation.artifacts, [{ ref }])
      assert.equal(reports[0].operation.result, '')
      assert.equal(reports[0].operation.executionGrant, registrations[0].executionGrant)
    } else assert.match(run.output, /remains pending.*do not rerun/)
  })
})

test('ART-WK-5: capture overflow is unavailable data, never a fabricated executor failure', async () => {
  await withArea(async ({ env }) => {
    let polls = 0
    const row = actionRow()
    row.artifactPolicy.objectBytes = 1024
    const run = await driveWorker({
      env,
      extraAdapters: { 'ship-adapter.mjs': "import { appendFileSync } from 'node:fs'; import { join } from 'node:path'; appendFileSync(join(process.env.RULITH_SOURCE_ACCESS, 'effects.log'), 'ship\\n'); console.log('x'.repeat(12000));" },
      reply: operation => operation.kind === 'Poll'
        ? ++polls === 1 ? { body: { accepted: true, payload: { work: [row] } } } : HOLD
        : { body: { accepted: true, revision: 'r2' } },
      materialReply: (path) => (path === '/artifact/delivery' ? { body: { accepted: true, delivery: null } } : undefined),
      done: (_seen, output) => /could not be delivered|receipt committed/.test(output),
    })
    assert.equal(run.timedOut, false, run.output)
    assert.deepEqual(run.effects, ['ship'])
    assert.equal(run.seen.some((entry) => entry.path === '/artifact/register'), false,
      'an object over the policy ceiling was registered anyway')
    assert.equal(run.of('ReportWork').length, 0, run.output)
    assert.match(run.output, /adapter_output_exceeds_object_budget/)
  })
})

test('ART-WK-6: a Worker with no custody has no fallback that sends the bytes instead', async () => {
  // The absence of a byte-upload path is the point of the cutover, so it is asserted where it
  // would have been used: an over-budget result on a Worker that holds custody of nothing has
  // nowhere to put its object, and says so rather than putting it on the wire.
  let polls = 0
  const run = await driveWorker({
    extraAdapters: { 'ship-adapter.mjs': "import { appendFileSync } from 'node:fs'; import { join } from 'node:path'; appendFileSync(join(process.env.RULITH_SOURCE_ACCESS, 'effects.log'), 'ship\\n'); console.log(JSON.stringify({result:'x'.repeat(12000)}));" },
    reply: operation => operation.kind === 'Poll'
      ? ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      : { body: { accepted: true, revision: 'r2' } },
    done: (_seen, output) => /could not be delivered|receipt committed/.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.deepEqual(run.effects, ['ship'], 'the executor did not run (calibration)')
  // Named precisely: "this Worker was never given a material area" rather than a generic
  // custody failure, because the operator's fix is a deployment setting rather than a retry.
  assert.match(run.output, /materials_not_configured/)
  assert.equal(run.of('ReportWork').length, 0, 'a receipt was manufactured for an object nobody holds')
  assert.equal(run.of('ArtifactUpload').length, 0)
  assert.equal(run.seen.some((entry) => String(entry.path ?? '').startsWith('/artifact/')), false)
})


test('a document and public reference retain order, bytes and one immutable report identity', async () => {
  await withArea(async ({store}) => {
    const doc = store.putResult({bytes:Buffer.from('PRIVATE original document'),mediaType:'text/plain',encoding:'utf8'})
    const guide = store.putResult({bytes:Buffer.from('Public checker reference'),mediaType:'text/plain',encoding:'utf8'})
    const registrations = []
    const result = await prepareActionReport(actionRow(), {ok:true, localArtifact:doc, companionArtifacts:[guide]}, {
      register:async record => {registrations.push(record); return {...confirm(record),payload:{...confirm(record).payload,
        ref:'art_' + (record.digest === doc.digest ? 'a':'b').repeat(32)}}},
    })
    assert.deepEqual(registrations.map(x=>x.digest), [doc.digest,guide.digest])
    assert.deepEqual(result.body.artifacts, [{ref}, {ref:'art_'+'b'.repeat(32)}])
    assert.match(result.body.result, /public authoring reference/)
    assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE original document|Public checker reference/)
    assert.equal(store.read(doc.id,{modelDestination:'http://127.0.0.1:1234'}).bytes.toString(), 'PRIVATE original document')
    assert.equal(result.body.executionGrant, actionRow().executionGrant)
  })
})

test('installed reference carries the modern cue; a narrow receipt retains only the read instruction', async () => {
  await withArea(async ({store}) => {
    const doc = store.putResult({bytes:Buffer.from('PRIVATE document'),mediaType:'text/plain',encoding:'utf8'})
    const guide = store.putResult({bytes:Buffer.from('PUBLIC reference'),mediaType:'application/json',encoding:'utf8'})
    const second = {ref:'art_'+'b'.repeat(32)}
    const register = async record => ({...confirm(record),payload:{...confirm(record).payload,
      ref:record.digest===doc.digest?ref:second.ref}})
    const full = await prepareActionReport(actionRow(),
      {ok:true,localArtifact:doc,companionArtifacts:[guide],safeInlineGuidance:LOCAL_AUTHORING_MODERN_CUE}, {register})
    assert.equal(full.body.result, LOCAL_AUTHORING_MODERN_CUE)
    assert.deepEqual(full.body.artifacts,[{ref},second])
    assert.doesNotMatch(JSON.stringify(full.body), /PRIVATE document|PUBLIC reference/)
    const fallbackBytes = Buffer.byteLength(JSON.stringify({result:LOCAL_AUTHORING_REFERENCE_CUE,
      reason:'',facts:[],artifacts:[{ref},second]}))
    const narrow = await prepareActionReport({...actionRow(),artifactPolicy:{...actionRow().artifactPolicy,
      inlineBytes:fallbackBytes}},
    {ok:true,localArtifact:doc,companionArtifacts:[guide],safeInlineGuidance:LOCAL_AUTHORING_MODERN_CUE}, {register})
    assert.equal(narrow.body.result, LOCAL_AUTHORING_REFERENCE_CUE)
    const forged = await prepareActionReport(actionRow(),
      {ok:true,localArtifact:doc,safeInlineGuidance:LOCAL_AUTHORING_MODERN_CUE}, {register})
    assert.equal(forged.body.result, '', 'without the reference Artifact no modern cue is admitted')
  })
})

test('a failed companion registration or insufficient guide budget never reports partial success', async () => {
  await withArea(async ({store}) => {
    const doc=store.putResult({bytes:Buffer.from('doc'),mediaType:'text/plain',encoding:'utf8'})
    const guide=store.putResult({bytes:Buffer.from('guide'),mediaType:'text/plain',encoding:'utf8'})
    let calls=0
    const failed=await prepareActionReport(actionRow(),{ok:true,localArtifact:doc,companionArtifacts:[guide]}, {
      register:async record=>{if(++calls===2) throw new Error('source changed'); return confirm(record)},
    })
    assert.equal(calls,2)
    assert.equal(failed.body,undefined)
    assert.equal(failed.unavailable,'artifact_registration_unknown')
    const narrow=await prepareActionReport({...actionRow(),artifactPolicy:{...actionRow().artifactPolicy,inlineBytes:170}},
      {ok:true,localArtifact:doc,companionArtifacts:[guide]}, {register:async record=>({...confirm(record),payload:{...confirm(record).payload,
        ref:'art_'+(record.digest===doc.digest?'a':'b').repeat(32)}})})
    assert.equal(narrow.body,undefined)
    assert.ok(narrow.unavailable)
  })
})

test('identical document and reference bytes register once rather than duplicating an invocation digest', async () => {
  await withArea(async ({store}) => {
    const doc=store.putResult({bytes:Buffer.from('same bytes'),mediaType:'text/plain',encoding:'utf8'})
    const guide=store.putResult({bytes:Buffer.from('same bytes'),mediaType:'text/plain',encoding:'utf8'})
    for (const safeInlineGuidance of [undefined, LOCAL_AUTHORING_MODERN_CUE]) {
      let calls=0
      const result=await prepareActionReport(actionRow(),{ok:true,localArtifact:doc,companionArtifacts:[guide],safeInlineGuidance}, {
        register:async record=>{calls++;return confirm(record)},
      })
      assert.equal(calls,1)
      assert.deepEqual(result.body.artifacts,[{ref}])
      assert.match(result.body.result,/When bytes are identical, one Artifact serves both/)
    }
  })
})

// SPDX-License-Identifier: Apache-2.0
/**
 * The vendored Worker protocol, and the execution digests computed against its own vectors.
 *
 * `protocol/worker-contract.json` carries the v2 hop as the contract repository committed
 * it — schema, artifact definitions, and the conformance fixture — read out of Git with
 * `git show <commit>:<path>` and pinned by blob object id. It is a *separate* artefact from
 * the public MCP contract: that one is the Agent surface a model sees, this one is the
 * private execution hop, and folding either into the other would let a change to one ride
 * in under the other's pin.
 *
 * The digest arms are the point of the fixture. Two implementations that agree on a shape
 * but disagree on a serialization produce two identities for one execution, so the vectors
 * are checked byte for byte and digest for digest against the committed ones rather than
 * against anything computed here.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  WORKER_BUNDLE_PATH, WORKER_CONTRACT_FILES, WorkerContractError,
  assertPublishableRepository, checkProvenance, contractRepoPath, gitBlobOid, loadWorkerContract, readWorkerContract,
} from '../scripts/verify-worker-contract.mjs'
import { workerProjectionBlock, withWorkerProjection } from '../scripts/generate-worker-protocol.mjs'
import {
  assertAdvertisable, builtinSourceTools, builtinWorkspaceTools, canonicalJson, executionDigest,
  grantMismatch, parseLease, resultVectorOf, uploadDecision, workerArtifactReference, workerToolManifest,
} from '../worker/rulith-worker.mjs'
import { UNRESOLVED, shapeFaults } from './support/contract-shape.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')
const RAW = JSON.parse(readFileSync(join(ROOT, WORKER_BUNDLE_PATH), 'utf8'))
const bundleWith = (mutate) => {
  const copy = JSON.parse(JSON.stringify(RAW))
  mutate(copy)
  return copy
}
const CONTRACT = loadWorkerContract(ROOT)
const FIXTURE = CONTRACT.fixture

test('RT-WKC-1 the vendored Worker protocol is pinned to committed bytes', () => {
  assert.match(CONTRACT.sourceCommit, /^[0-9a-f]{40}$/u)
  for (const file of WORKER_CONTRACT_FILES) {
    assert.match(String(RAW.files[file].gitBlobOid), /^[0-9a-f]{40}$/u,
      `${file} carries no Git blob object id, so the pin cannot be checked against the repository`)
  }
  // The two vendored contracts are separate artefacts and stay separate — which is a statement
  // about **what each one carries**, not about which commit each names.
  //
  // This used to be `notEqual(mcp.sourceCommit, CONTRACT.sourceCommit)`, and that was the wrong
  // reading of the same rule. Both bundles are exported from one repository, so a commit that
  // genuinely changes both surfaces leaves both correctly pinned to it — and the assertion made
  // vendoring that commit impossible, which would have been resolved by pinning one of them to
  // a commit its bytes did not come from. A test that can only be satisfied by a false pin is
  // worse than no test.
  //
  // What must hold is that neither bundle can smuggle the other's bytes. The two overlap by one
  // file on purpose — the artifact-read schema is part of both surfaces — so the rule is not
  // "no overlap" but "the overlap is the same file": same Git blob, same content. A disjointness
  // assertion would have been false about a legitimate sharing, and would have taught the next
  // person to break the sharing rather than to check it.
  const mcp = JSON.parse(readFileSync(join(ROOT, 'protocol', 'mcp-contract.json'), 'utf8'))
  const workerFiles = Object.keys(RAW.files)
  const mcpFiles = mcp.files ?? {}
  assert.ok(workerFiles.length > 0 && Object.keys(mcpFiles).length > 0, 'a bundle that carries no files cannot be compared')
  for (const file of workerFiles.filter((name) => mcpFiles[name] !== undefined)) {
    assert.equal(RAW.files[file].gitBlobOid, mcpFiles[file].gitBlobOid,
      `${file} is carried by both bundles as two different Git objects, so one of them is not the committed file`)
    assert.equal(RAW.files[file].content, mcpFiles[file].content,
      `${file} is carried by both bundles with different bytes`)
  }
  // The one vector that would be smuggling rather than sharing: the public surface projection
  // is what the Agent's membership is generated from, and a private hop bundle carrying it
  // could move that membership under a pin nobody reads for it.
  assert.equal(RAW.files['protocol/mcp-surface.json'], undefined,
    'the Worker bundle carries the public MCP surface, so a private change could ride in under it')
})

test('RT-WKC-1b the two bundles really do share the Artifact schema, so the comparison above is not vacuous', () => {
  // The loop in RT-WKC-1 runs over the overlap, and an empty overlap would satisfy it without
  // comparing anything. Every other guard in this file states its extraction floor; this one
  // names the file it exists for. If the sharing ever ends the arm goes red and somebody
  // decides deliberately, rather than the check quietly becoming a no-op.
  const mcp = JSON.parse(readFileSync(join(ROOT, 'protocol', 'mcp-contract.json'), 'utf8'))
  const shared = Object.keys(RAW.files).filter((name) => (mcp.files ?? {})[name] !== undefined)
  assert.deepEqual(shared, ['docs/specs/schemas/rulith-artifact-read-v1.schema.json'],
    'the Artifact read schema is the one file both surfaces carry; the overlap check is about it')
  // And the digests are spelled differently in the two bundles — bare hex here, `sha256:`-
  // prefixed there — which is why the comparison is on the Git blob and the content, not on
  // the `sha256` field. Stated so nobody "simplifies" it into a false negative.
  assert.match(String(RAW.files[shared[0]].sha256), /^sha256:[0-9a-f]{64}$/u)
  assert.match(String(mcp.files[shared[0]].sha256), /^[0-9a-f]{64}$/u)
})

test('RT-WKC-1c a shipped bundle may not state a provenance only one machine can resolve', () => {
  // `sourceRepository` is generated from the export clone's `remote.origin.url`, so it is not a
  // hand-vendored value — and it still shipped as `D:/Work/…` when the clone had been made from
  // another directory on the same disk. The bundle travels in the npm package and the artifact
  // manifest; a provenance that resolves nowhere else is worse than none, because it reads as
  // one. The fix is to point the clone at the canonical upstream and re-export, which is why
  // the refusal says so.
  assert.equal(assertPublishableRepository(RAW.sourceRepository), RAW.sourceRepository)
  assert.match(RAW.sourceRepository, /^https:\/\//u,
    'the shipped bundle must name a repository somebody else can fetch')
  for (const [label, value, expected] of [
    ['a Windows path', 'D:/Work/rulith-psc024-core', /a path on one machine/],
    ['a drive-relative Windows path', 'D:rulith', /a path on one machine/],
    ['a relative path', '../rulith', /remote URL or scp-style/],
    ['an unresolvable bare name', 'rulith', /remote URL or scp-style/],
    ['a Windows path with backslashes', 'D:\\Work\\rulith-psc024-core', /a path on one machine/],
    ['a UNC share', '\\\\build01\\core', /a path on one machine/],
    ['an absolute POSIX path', '/home/victor/rulith', /a path on one machine/],
    ['a file URL', 'file:///D:/Work/rulith', /a path on one machine/],
    ['a URL carrying credentials', 'https://user:ghp_secret@github.com/nvwaonline/rulith.git', /must not\s+publish/],
    ['nothing at all', '', /states no sourceRepository/],
    ['a non-string', 42, /states no sourceRepository/],
  ]) {
    assert.throws(() => assertPublishableRepository(value), (error) => {
      assert.ok(error instanceof WorkerContractError, `${label} refused with the wrong error type: ${error}`)
      assert.match(error.message, expected, `${label}: ${error.message}`)
      assert.doesNotMatch(error.message, /ghp_secret/u, 'the refusal quoted the credential it was refusing')
      return true
    }, `${label} was accepted as a publishable provenance`)
  }
  // And the whole-bundle reader enforces it, not just the helper: a bundle carrying a local
  // path is refused where `npm run check` reads it.
  assert.throws(() => readWorkerContract(bundleWith((bundle) => { bundle.sourceRepository = 'D:/Work/rulith-psc024-core' })),
    /a path on one machine/)
})

test('RT-WKC-2 the Worker source is the projection of that bundle, and drift is caught', () => {
  const source = readFileSync(join(ROOT, 'worker', 'rulith-worker.mjs'), 'utf8')
  assert.equal(withWorkerProjection(source, workerProjectionBlock(CONTRACT)), source,
    'worker/rulith-worker.mjs has drifted from protocol/worker-contract.json; run node scripts/generate-worker-protocol.mjs')
  assert.ok(source.includes(`const RULITH_WORKER_CONTRACT_SOURCE_COMMIT = '${CONTRACT.sourceCommit}'`))
  // The Worker ships as one file: nothing it needs at runtime may live beside it. (The
  // generated block names the bundle in a comment, which is where the provenance belongs;
  // the scan is of the code.)
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '')
    .split(/\r?\n/u).filter((line) => !line.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(code, /verify-worker-contract|worker-contract\.json/u,
    'the Worker reads its contract from a sibling file at runtime instead of carrying the projection')
})

for (const [label, mutate, expected] of [
  ['a short commit id', (b) => { b.sourceCommit = 'abcdef0' }, /not a full 40-character commit id/],
  ['another bundle schema', (b) => { b.schema = 'rulith-worker-contract-bundle/v2' }, /this Runtime reads/],
  ['a missing blob id', (b) => { delete b.files[WORKER_CONTRACT_FILES[0]].gitBlobOid }, /carries no Git blob object id/],
  ['edited content', (b) => { b.files[WORKER_CONTRACT_FILES[2]].content += '\n' }, /does not match the digest recorded beside it/],
]) {
  test(`RT-WKC-3 a bundle with ${label} is refused`, () => {
    assert.throws(() => readWorkerContract(bundleWith(mutate)), (error) => {
      assert.ok(error instanceof WorkerContractError, `refused with the wrong error type: ${error}`)
      assert.match(error.message, expected)
      return true
    })
  })
}

test('RT-WKC-4 a fixture that canonicalizes by another rule is refused', () => {
  // One receipt may not carry two normalizations. If the schema and the fixture ever name
  // different rules, the digests this Worker computes stop meaning what Core reads. The
  // digest is restated deliberately here, so the arm is about the rule and not about a hash.
  assert.throws(() => readWorkerContract(bundleWith((bundle) => {
    const file = WORKER_CONTRACT_FILES[2]
    const fixture = JSON.parse(bundle.files[file].content)
    fixture.canonicalization.rule = 'something-else/1'
    bundle.files[file].content = JSON.stringify(fixture)
    // Both pins are moved with the bytes, so this arm reaches the rule it is about instead
    // of stopping at a digest mismatch it deliberately created.
    bundle.files[file].sha256 = `sha256:${createHash('sha256').update(bundle.files[file].content, 'utf8').digest('hex')}`
    bundle.files[file].gitBlobOid = gitBlobOid(bundle.files[file].content)
  })), /One receipt may not carry two normalizations/)
})

test('RT-WKC-5 every committed request vector canonicalizes and digests exactly', () => {
  // The serialization is the identity. A locale-sensitive sort, an extra space, or a
  // re-serialized `args` string would each produce a different digest for the same
  // execution — and the Gateway would then be looking at a receipt for something else.
  assert.ok(FIXTURE.requestVectors.length > 0)
  for (const vector of FIXTURE.requestVectors) {
    assert.equal(canonicalJson(vector.input), vector.canonicalJson,
      `the canonical form of ${vector.input.invocationId} differs from the committed one`)
    assert.equal(executionDigest(vector.input), vector.sha256)
  }
  // The Source-free vector is the one that must not quietly become the Connection's name.
  const sourceFree = FIXTURE.requestVectors.find((vector) => vector.input.sourceRecordId === '')
  assert.ok(sourceFree, 'the fixture no longer carries a Source-free request vector')
  assert.equal(executionDigest(sourceFree.input), sourceFree.sha256)
})

test('RT-WKC-6 every committed result vector digests exactly, defaults and all', () => {
  for (const vector of FIXTURE.resultVectors) {
    assert.equal(canonicalJson(vector.input), vector.canonicalJson, `${vector.id} canonicalizes differently`)
    assert.equal(executionDigest(vector.input), vector.sha256, `${vector.id} digests differently`)
    // And the Worker's own resolution of an omitted field reproduces the committed input:
    // an omitted reason is the empty string, omitted facts and artifacts empty arrays.
    const resolved = resultVectorOf({
      ok: vector.report.ok,
      result: vector.report.result,
      reason: vector.report.reason,
      facts: vector.report.facts,
      artifacts: vector.receiptArtifacts,
    })
    assert.deepEqual(resolved, vector.input, `${vector.id}: the Worker resolves the report to a different vector`)
    assert.equal(executionDigest(resolved), vector.sha256)
  }
})

test('RT-WKC-7 the same invocation digests the same whatever key order it arrives in', () => {
  // Object key order is not part of the value. If it were, one execution would have two
  // identities depending on how a serializer happened to walk it.
  const [first] = FIXTURE.requestVectors
  const shuffled = Object.fromEntries(Object.entries(first.input).reverse())
  assert.notDeepEqual(Object.keys(shuffled), Object.keys(first.input))
  assert.equal(executionDigest(shuffled), first.sha256)
})

test('RT-WKC-8 the committed grant matches the request vector it covers', () => {
  // The seam between the two committed artefacts: the fixture's grant carries the digest of
  // the fixture's own request vector, and this Runtime recomputes that digest rather than
  // copying it. If either moved without the other, the grant would license bytes nobody
  // serves. (Signature reading, refusals and the whole mismatch matrix are in
  // `worker-grant.test.mjs`, which drives the token the Gateway actually sends.)
  const held = parseLease({
    workerId: 'wkr_fixture_1', workerGeneration: 7,
    serverTime: '2026-09-06T00:00:00.000Z', expiresAt: '2026-09-06T00:01:00.000Z', heartbeatAfterMs: 10_000,
  })
  assert.ok(held, 'the fixture lease is not readable as an active lease')
  const grant = FIXTURE.grant
  const covered = FIXTURE.requestVectors.find((vector) => vector.sha256 === grant.requestDigest)
  assert.ok(covered, 'the committed grant covers no committed request vector')
  assert.equal(executionDigest(covered.input), grant.requestDigest,
    'this Runtime digests the covered request differently from the grant that licenses it')
  assert.equal(grantMismatch(grant, {
    connectionId: grant.connectionId,
    boardId: covered.input.boardId,
    invocationId: covered.input.invocationId,
    actionId: covered.input.actionId,
    toolContractId: covered.input.toolContractId,
    sourceRecordId: covered.input.sourceRecordId,
    adapterDigest: grant.adapterDigest,
    requestDigest: executionDigest(covered.input),
  }, held), undefined, 'the fixture grant does not match the fixture request vector it names')
})

test('RT-WKC-9 Artifact object upload needs an explicit granted permission', () => {
  for (const row of FIXTURE.sourcePermissions.rows) {
    const decided = uploadDecision(row.decision.permission, row.decision.sourceRecordId)
    assert.deepEqual(decided, row.decision, `${row.id}: this Runtime decides differently from the committed row`)
  }
})

test('RT-WKC-10 a Worker may reference an object and may not describe one', () => {
  assert.deepEqual(workerArtifactReference({ ref: 'art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), { ref: 'art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
  // Metadata is the Gateway's to resolve from the granted invocation; self-authored
  // metadata would be the Worker writing its own receipt evidence.
  assert.equal(workerArtifactReference({ ref: 'art_a', mediaType: 'text/plain' }), undefined)
  assert.equal(workerArtifactReference({ ref: '' }), undefined)
  assert.equal(workerArtifactReference({}), undefined)
})

// ── The Poll surface and the Manifest it carries ─────────────────────────────

/**
 * The protocol definitions, plus the artifact ones under their file-qualified names.
 *
 * The bundle carries two schemas and the report shape refs into both. It does not carry the
 * Board schema, so a ref into that one stays unresolved and is named as such below rather
 * than waved through — an unchecked rule that reports "valid" is the failure this whole
 * mechanism exists to avoid.
 */
const ARTIFACT_DEFS = CONTRACT.artifactSchema?.$defs ?? {}
const DEFS = {
  // Under the plain name too, because a ref *inside* the artifact schema is written the
  // local way and has to resolve against that file's own definitions. The protocol schema
  // is applied second so its own names win a tie.
  ...ARTIFACT_DEFS,
  ...CONTRACT.defs,
  ...Object.fromEntries(Object.entries(ARTIFACT_DEFS)
    .map(([name, def]) => [`rulith-artifact-read-v1.schema.json#/$defs/${name}`, def])),
}
test('RT-WKC-11a a name the two vendored schemas share means the same thing in both', () => {
  // The merge above puts both files' definitions in one table so a local ref inside either
  // resolves. That is only safe while a shared name is the same definition; if the two ever
  // diverged, one file's refs would silently be checked against the other file's rule.
  for (const [name, def] of Object.entries(ARTIFACT_DEFS)) {
    if (CONTRACT.defs[name] === undefined) continue
    assert.deepEqual(def, CONTRACT.defs[name],
      `${name} is defined differently in the protocol schema and the artifact schema`)
  }
})
const everyInstalledTool = () => ({ ...builtinWorkspaceTools('read-write'), ...builtinSourceTools() })

test('RT-WKC-11 the shape checker reads the contract, calibrated on every committed example', () => {
  // The checker is what lets the arms below say "the contract accepts this" instead of
  // "our fake accepted this". So it is calibrated first, against both halves of every
  // boundary the fixture carries: a checker that passed everything would make each of
  // those arms vacuous, and it would do it silently.
  let valid = 0, invalid = 0
  const unresolved = new Set()
  const outOfReach = []
  const checkable = (faults) => faults.filter((fault) => {
    if (!fault.includes(UNRESOLVED)) return true
    unresolved.add(fault.slice(fault.indexOf(UNRESOLVED) + UNRESOLVED.length).trim())
    return false
  })
  for (const boundary of FIXTURE.boundaries) {
    const schema = DEFS[boundary.schemaRef.split('/').pop()]
    if (schema === undefined) continue
    for (const example of boundary.valid ?? []) {
      assert.deepEqual(checkable(shapeFaults(example, schema, DEFS)), [],
        `${boundary.id}: the contract's own valid example is refused`)
      valid += 1
    }
    for (const example of boundary.invalid ?? []) {
      const faults = shapeFaults(example.value, schema, DEFS)
      const reachable = checkable(faults)
      if (reachable.length === 0 && faults.length > 0) {
        // The fault is real but lives behind a ref this bundle does not carry. Listed by
        // name below rather than counted as checked.
        outOfReach.push(`${boundary.id}: ${example.fault}`)
        continue
      }
      assert.notDeepEqual(reachable, [], `${boundary.id}: "${example.fault}" is accepted`)
      invalid += 1
    }
  }
  assert.ok(valid >= 20 && invalid >= 20, `only ${valid} valid and ${invalid} invalid examples were reached`)
  // The one shape this bundle cannot reach, named rather than skipped: the Board's own fact
  // definition lives in a schema the Worker hop does not vendor, so a fault inside a reported
  // fact is out of this checker's reach. Naming it is the point — a silent skip here would
  // read as coverage.
  assert.deepEqual([...unresolved], ['rulith-board-v1.schema.json#/$defs/ReportedFact'],
    'a boundary now refs a schema this bundle does not carry, so part of it is going unchecked')
  assert.deepEqual(outOfReach, ['result-vector: a fact argument that is not a scalar'],
    'the set of contract faults this bundle cannot reach has changed')
})

test('RT-WKC-12 what this Worker advertises is a Manifest the contract accepts', () => {
  const advertised = workerToolManifest(everyInstalledTool())
  assert.ok(advertised.length > 0)
  for (const descriptor of advertised) {
    assert.deepEqual(shapeFaults(descriptor, DEFS.WorkerToolDescriptor, DEFS), [],
      `the advertised descriptor for ${descriptor.id} is not one the contract accepts`)
  }
  // The shipped workspace read Tool is the entry the fixture calibrates against: same
  // declaration, only the pin differs, because a real pin belongs to one build.
  const shipped = FIXTURE.boundaries.find((b) => b.id === 'tool-descriptor').valid[0]
  const mine = advertised.find((row) => row.id === shipped.id)
  assert.ok(mine, `the fixture calibrates against ${shipped.id}, which this Worker no longer advertises`)
  assert.deepEqual({ ...mine, digest: shipped.digest }, shipped,
    'the shipped Tool advertises something other than what the contract fixture pins')

  // And the whole Manifest is a legal `tools` array, ceiling and uniqueness included.
  assert.deepEqual(shapeFaults(advertised, DEFS.PollRequest.properties.tools, DEFS), [])
})

test('RT-WKC-13 one Tool id names one implementation, checked before the poll is sent', () => {
  // `uniqueItems` cannot decide this: two descriptors differing only in their pin are
  // different objects, so the array constraint passes them and one Tool id would name two
  // local implementations that the Connection lock cannot tell apart.
  for (const row of FIXTURE.toolManifestInvariants.rows) {
    if (row.valid) {
      assert.deepEqual(assertAdvertisable(row.items), row.items, `${row.id}: a legal Manifest was refused`)
      continue
    }
    assert.throws(() => assertAdvertisable(row.items), (error) => {
      assert.ok(error.message.startsWith(`${row.refusal}:`),
        `${row.id}: refused as "${error.message.split(':')[0]}" rather than by the contract's name ${row.refusal}`)
      return true
    }, `${row.id}: ${row.reason}`)
  }
  // The ceiling is refused rather than trimmed to fit; a truncated Manifest would silently
  // un-advertise whichever Tools fell off the end.
  const ceiling = CONTRACT.maxAdvertisedTools
  const many = Array.from({ length: ceiling + 1 }, (unused, index) => ({ id: `acme.t${index}@1`, digest: 'a'.repeat(64) }))
  assert.throws(() => assertAdvertisable(many), /at most 128/)
  assert.equal(assertAdvertisable(many.slice(0, ceiling)).length, ceiling)
})

test('RT-WKC-14 every admission row carries a poll this contract calls well-formed', () => {
  // Admission is the Gateway's judgement and none of it is decided here. What is decided
  // here is that a refused poll is refused on admission and not on shape: each row's
  // request must be a legal PollRequest, including the acquiring one that states no
  // generation and the stale one that states a generation nothing can check.
  const rows = FIXTURE.pollLeaseAdmission.rows
  for (const row of rows) {
    assert.deepEqual(shapeFaults(row.request, DEFS.PollRequest, DEFS), [],
      `${row.id}: the row's own request is not a well-formed poll`)
  }
  // The two branches this Runtime's client behaviour turns on are both present.
  assert.ok(rows.some((row) => row.leaseAction === 'acquire' && row.request.workerGeneration === undefined),
    'the fixture no longer carries an acquiring poll that states no generation')
  assert.ok(rows.some((row) => row.admitted === false && row.request.workerGeneration !== undefined),
    'the fixture no longer carries a poll refused for stating a generation')
  // A refused poll leaves the advertisement and the lock exactly as they were.
  for (const row of rows.filter((candidate) => candidate.admitted === false)) {
    assert.equal(row.manifestProcessed, false, `${row.id}: a refused poll is recorded as having had its Manifest read`)
    assert.equal(row.toolLockMayMove, false, `${row.id}: a refused poll is recorded as able to move the Tool lock`)
  }
})

test('RT-WKC-16 every committed lease invariant is the one this Runtime enforces', () => {
  // `runtimeInvariants` is the section this Runtime owns: five rules `parseLease` implements
  // that the Lease *shape* cannot state. It was the only row set nobody iterated — the
  // end-to-end arms hand-wrote five spoilings of their own, so a committed row could change
  // and nothing would turn red. Both now run, and the ids are compared so neither drifts.
  const leaseRows = FIXTURE.runtimeInvariants.filter((row) => row.schemaRef.endsWith('/Lease'))
  assert.ok(leaseRows.length >= 5, `only ${leaseRows.length} committed lease invariant(s)`)
  for (const row of leaseRows) {
    const read = parseLease(row.value)
    if (row.valid) {
      assert.ok(read !== undefined, `${row.id}: a lease the contract calls valid was refused — ${row.reason}`)
      assert.equal(read.workerGeneration, row.value.workerGeneration)
    } else {
      assert.equal(read, undefined, `${row.id}: a lease the contract calls invalid was accepted — ${row.reason}`)
    }
  }
  // The policy rows are the same rule stated about configuration rather than about one
  // lease; a heartbeat that is not strictly shorter than the window is refused either way.
  for (const row of FIXTURE.runtimeInvariants.filter((entry) => entry.schemaRef.endsWith('/LeasePolicy'))) {
    assert.equal(row.value.heartbeatMs < row.value.leaseMs, row.valid,
      `${row.id}: the committed policy row and its own verdict disagree`)
  }
})

test('RT-WKC-17 the carried file set is closed, and each pin is recomputed from its bytes', () => {
  // "Every file I look for is present and correct" is not "these are the files": an extra
  // key used to be carried, published and hashed into the artifact manifest with nothing
  // checking its digest or its provenance.
  assert.throws(() => readWorkerContract(bundleWith((bundle) => {
    bundle.files['docs/specs/schemas/something-else.json'] = { content: '{}', sha256: 'sha256:x', gitBlobOid: 'a'.repeat(40) }
  })), /carries 4 file\(s\) and this Runtime reads exactly 3/)
  assert.throws(() => readWorkerContract(bundleWith((bundle) => {
    bundle.files[WORKER_CONTRACT_FILES[0]].note = 'unread'
  })), /carries note, which nothing here checks/)

  // A blob id that was merely recorded proves only that somebody typed it. Git's object id
  // is a pure function of the bytes, so the bytes in hand either produce it or they do not.
  for (const file of WORKER_CONTRACT_FILES) {
    assert.equal(gitBlobOid(RAW.files[file].content), RAW.files[file].gitBlobOid,
      `${file}: the carried content does not hash to the Git blob id recorded beside it`)
  }
  assert.throws(() => readWorkerContract(bundleWith((bundle) => {
    bundle.files[WORKER_CONTRACT_FILES[1]].gitBlobOid = 'b'.repeat(40)
  })), /is recorded as Git blob b{40} but its own bytes hash to/)
})

test('RT-WKC-17b the projection refuses a definition it cannot carry whole', () => {
  // Flattening a definition into a kind table can only carry what the table expresses. A
  // conditional or an unread constraint would be dropped in silence: the generated block
  // would look complete, the Worker would under-enforce, and `--check` would stay green
  // because nothing disagreed. `ClaimWorkRequest` is the live example — it carries
  // `if`/`then`/`else`, and it is deliberately *not* projected for exactly this reason.
  const withDef = (mutate) => bundleWith((bundle) => {
    const file = WORKER_CONTRACT_FILES[0]
    const schema = JSON.parse(bundle.files[file].content)
    mutate(schema.$defs)
    bundle.files[file].content = JSON.stringify(schema)
    bundle.files[file].sha256 = `sha256:${createHash('sha256').update(bundle.files[file].content, 'utf8').digest('hex')}`
    bundle.files[file].gitBlobOid = gitBlobOid(bundle.files[file].content)
  })
  assert.throws(() => readWorkerContract(withDef((defs) => {
    defs.WorkerActionWorkItem.if = { properties: { workType: { const: 'action' } } }
  })), /the action work item states if, which this projection does not read/)
  assert.throws(() => readWorkerContract(withDef((defs) => {
    defs.ExecutionGrant.allOf = []
  })), /the grant states allOf, which this projection does not read/)
  assert.throws(() => readWorkerContract(withDef((defs) => {
    defs.WorkerActionWorkItem.properties.target.maxLength = 64
  })), /field target states maxLength, which this projection does not read/)
  // The two `const` tables are per field name, and the grant's is no longer the version
  // constant standing in for every one of them.
  assert.deepEqual(CONTRACT.grantConst, { version: 2 })
  assert.deepEqual(CONTRACT.actionRowConst, { workType: 'action' })
})

test('RT-WKC-18 a repository that cannot resolve the commit is a failure, not a skip', () => {
  // The two must never collapse into one. "There is no contract repository here" is an
  // ordinary state — a downloaded package has none. "There is one and it has never heard of
  // this commit" means the pin names bytes nobody here can produce, and treating that as
  // absence is how a pin to a commit that does not exist passes as verified.
  const previous = process.env.RULITH_CONTRACT_REPO
  try {
    // This worktree is a real Git repository, and it is not the contract repository.
    process.env.RULITH_CONTRACT_REPO = ROOT
    assert.throws(() => checkProvenance(RAW, { root: ROOT }), (error) => {
      assert.ok(error instanceof WorkerContractError)
      assert.match(error.message, /cannot resolve [0-9a-f]{40} as a commit/)
      assert.match(error.message, /is not the same as no repository/)
      return true
    })
    // The message names the override, because the person who hits this is by definition
    // looking at a directory that is not the contract repository.
    assert.throws(() => checkProvenance(RAW, { root: ROOT }), /point RULITH_CONTRACT_REPO at the one that is/)
    // A directory that is not a repository at all is absence, and says so.
    process.env.RULITH_CONTRACT_REPO = join(ROOT, 'test')
    assert.deepEqual(checkProvenance(RAW, { root: ROOT }), { checked: false, reason: 'absent' })
    // And the *guessed* sibling is only believed when it looks like the contract repository:
    // an unrelated repo at `../rulith` would otherwise turn a hard failure on by accident.
    // (This tree's real sibling does carry the schema, which is why `npm run check` compares.)
    delete process.env.RULITH_CONTRACT_REPO
    assert.equal(contractRepoPath(join(ROOT, 'test')), undefined,
      'a sibling that carries no contract schema was accepted as the contract repository')
  } finally {
    if (previous === undefined) delete process.env.RULITH_CONTRACT_REPO
    else process.env.RULITH_CONTRACT_REPO = previous
  }
})

test('RT-WKC-15 the runtime-owned open scenarios are the ones this suite answers', () => {
  // The fixture is shared, and the scenarios name their owner. The ones owned here must
  // each have an arm; a new one arriving in a later vendor turns this red rather than
  // riding in as coverage nobody wrote.
  // Each entry names the arm that *drives* it. A name in this map is not the coverage; the
  // arm is. `worker-action-links.test.mjs` runs the committed `actionWorkLinks` and
  // `actionWorkSourceInvariants` through this Runtime's own token reader, request digest and
  // Source resolver, and `worker-action-row.test.mjs` keeps the two real-process arms.
  const answered = {
    'undeliverable-large-result': 'worker-artifacts.test.mjs: retention failure leaves the real executor effect with no manufactured receipt',
    'source-free-upload': 'RT-WKC-9 here: uploadDecision refuses a Source-free upload by name, before bytes leave',
    'action-work-source-bound': 'RT-WK-LINK-2/3/4/6 (committed sourced link: token, digest, receive path, live run)'
      + ' plus RT-WK-SRC-5 (served bytes not rewritten)',
    'action-work-source-free': 'RT-WK-LINK-2/3/4 (committed Source-free link) plus RT-WK-LINK-5'
      + ' (every committed Source invariant) and RT-WK-SRC-4 (real process: no Source manufactured)',
  }
  const mine = FIXTURE.runtimeScenarios
    .filter((scenario) => /rulith-runtime/u.test(String(scenario.owner)))
    .map((scenario) => scenario.id)
  assert.deepEqual(mine.sort(), Object.keys(answered).sort(),
    'a runtime-owned scenario appeared or disappeared; each one needs an arm that drives it, not a mention')
  // The two action-row scenarios are driven from the row sets those arms iterate, so the
  // sets must still be there to iterate.
  assert.ok(FIXTURE.actionWorkLinks.length >= 2, 'the committed action links are gone, and two scenarios rest on them')
  assert.ok(FIXTURE.actionWorkSourceInvariants.length >= 7, 'the committed Source invariants shrank')
  // And the upload scenario's runtime half holds: the refusal is by name, and it is not a
  // policy lookup that merely found nothing.
  assert.deepEqual(uploadDecision(undefined, ''),
    { sourceRecordId: '', permission: 'absent', upload: false, refusal: 'source_permission_required' })
})

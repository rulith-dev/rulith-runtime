// SPDX-License-Identifier: Apache-2.0
/**
 * Read the vendored Worker protocol, and refuse anything that is not it.
 *
 * `protocol/worker-contract.json` carries the v2 Worker hop as the contract repository
 * committed it: the protocol schema, the artifact read schema whose definitions the report
 * path references, and the conformance fixture whose vectors this Runtime is checked
 * against. It is the private execution hop — no model sees any of it — and it is kept
 * apart from the public MCP contract for that reason.
 *
 * ## What this checks
 *
 * Provenance is established at vendor time by `scripts/sync-worker-contract.mjs`, which
 * reads every file with `git show <commit>:<path>` and records the blob object id Git gives
 * for it. Nothing here re-does that; what it proves is that the vendored copy is coherent
 * and untampered:
 *
 *   · every carried file hashes to the digest recorded beside it;
 *   · every file names a blob object id, so the pin stays checkable against the repository;
 *   · the schema carries the definitions the Worker actually consumes, and the fixture
 *     names the same canonicalization rule the schema does;
 *   · the Poll surface still requires the Tool Manifest, and states the descriptor rules
 *     this Runtime enforces locally instead of a hand-written copy of them;
 *   · the fixture still carries the row sets the arms iterate, so coverage cannot vanish
 *     by a section going empty;
 *   · the retired hop fields the fixture lists are the ones this Runtime refuses.
 *
 * A missing bundle is an error. A Worker that cannot read its protocol does not know what
 * its hop looks like, and guessing is the failure this mechanism exists to prevent.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const WORKER_BUNDLE_SCHEMA = 'rulith-worker-contract-bundle/v1'
export const WORKER_BUNDLE_PATH = 'protocol/worker-contract.json'
export const WORKER_SCHEMA_FILE = 'docs/specs/schemas/rulith-worker-protocol-v2.schema.json'
export const ARTIFACT_SCHEMA_FILE = 'docs/specs/schemas/rulith-artifact-read-v1.schema.json'
export const WORKER_FIXTURE_FILE = 'tests/conformance/fixtures/worker-protocol-v2.json'
export const WORKER_CONTRACT_FILES = [WORKER_SCHEMA_FILE, ARTIFACT_SCHEMA_FILE, WORKER_FIXTURE_FILE]

/** The definitions this Runtime reads out of the protocol schema. */
const REQUIRED_DEFS = [
  'WorkerId', 'Generation', 'Digest', 'CanonicalizationRule', 'Lease', 'LeasePolicy',
  'RenewLease', 'ReleaseLease', 'PollRequest', 'ClaimWorkRequest', 'ReportWorkAction',
  'ToolDigest', 'SourceType', 'WorkerToolDescriptor', 'WorkerActionWorkItem',
  'ExecutionRequestVector', 'ExecutionResultVector', 'ExecutionGrant', 'WorkerHeaderNames',
]

/**
 * Fixture sections this Runtime is checked against.
 *
 * They are required rather than optional because their absence is invisible: a bundle
 * without `pollLeaseAdmission` would still verify, still generate, still ship — and the
 * arms that drive the acquire / reuse / expiry / withdrawal branches would quietly have
 * nothing to iterate. A row set that shrinks to zero is coverage lost in silence.
 */
const REQUIRED_FIXTURE_ROWS = [
  'requestVectors', 'resultVectors', 'boundaries', 'pollLeaseAdmission.rows',
  'toolManifestInvariants.rows', 'sourcePermissions.rows', 'runtimeInvariants',
  'actionWorkLinks', 'actionWorkShadowFields', 'actionWorkSourceInvariants',
]

export class WorkerContractError extends Error {}

const sha256 = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Git's own object id for these bytes as a blob: `sha1("blob " + byteLength + NUL + content)`.
 *
 * Written out rather than shelled out to, because it has to work where `git` does not exist —
 * a downloaded package on a customer's machine has the bundle and no repository, and the
 * content-to-pin agreement is checkable there too.
 */
export function gitBlobOid(content) {
  const bytes = Buffer.from(content, 'utf8')
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes]))
    .digest('hex')
}

/**
 * One closed object definition, field by field, as a kind per name.
 *
 * The Worker checks decoded documents against these instead of against lists retyped in its
 * own source: reading the kinds off the schema is what makes a field added upstream a build
 * failure here rather than a field nobody compares. The vocabulary is deliberately tiny —
 * `const`, `text` (non-empty string), `text?` (a string the contract lets be empty), and the
 * three named refs the hop uses — because a general JSON-Schema runtime inside the Worker
 * would be a second implementation of the contract, with its own bugs and no reviewer.
 *
 * "Closed" is checked, not assumed: an open shape has room for a field nothing reads, and a
 * declared-but-not-required field is one a document may omit while this Runtime compares it.
 */
const SHAPE_KEYWORDS = new Set(['type', 'required', 'properties', 'additionalProperties', 'description', '$comment', 'title'])
const FIELD_KEYWORDS = new Set(['$ref', 'type', 'const', 'enum', 'pattern', 'minLength', 'minimum', 'maximum', 'description', '$comment'])

function closedShapeKinds(definition, label, path) {
  if (definition?.additionalProperties !== false || !Array.isArray(definition?.required)) {
    throw new WorkerContractError(`${path}: the ${label} shape is open or states no required fields;`
      + ' a shape with room for an unread field is a shape that can carry one.')
  }
  // Flattening a definition into a kind table can only carry what the table can express. A
  // conditional (`if`/`then`/`allOf`/`not`) or a constraint this projection does not read
  // would be dropped in silence: the generated block would look complete, the Worker would
  // under-enforce, and `npm run check` would stay green because nothing disagreed. Refusing
  // the definition is the cheap version of noticing.
  const unread = Object.keys(definition).filter((keyword) => !SHAPE_KEYWORDS.has(keyword))
  if (unread.length > 0) {
    throw new WorkerContractError(`${path}: the ${label} states ${unread.join(', ')}, which this projection does not read.`
      + ' A rule that cannot be projected would be dropped silently and under-enforced; add it here before vendoring.')
  }
  const optional = Object.keys(definition.properties ?? {}).filter((name) => !definition.required.includes(name))
  if (optional.length > 0) {
    throw new WorkerContractError(`${path}: the ${label} declares ${optional.join(', ')} without requiring them,`
      + ' so a document could omit a field this Runtime compares against.')
  }
  const kinds = {}
  for (const name of definition.required) {
    const rule = definition.properties?.[name]
    const strayed = Object.keys(rule ?? {}).filter((keyword) => !FIELD_KEYWORDS.has(keyword))
    if (strayed.length > 0) {
      throw new WorkerContractError(`${path}: the ${label} field ${name} states ${strayed.join(', ')},`
        + ' which this projection does not read. It would be carried unchecked.')
    }
    const ref = typeof rule?.$ref === 'string' ? rule.$ref.split('/').pop() : undefined
    const kind = rule?.const !== undefined ? 'const'
      : ref === 'WorkerId' ? 'workerId'
        : ref === 'Generation' ? 'generation'
          : ref === 'Digest' ? 'digest'
            : ref === 'ToolDigest' ? 'toolPin'
              : rule?.type === 'string' ? (Number(rule.minLength ?? 0) > 0 ? 'text' : 'text?')
                : undefined
    if (kind === undefined) {
      throw new WorkerContractError(`${path}: the ${label} field ${name} is stated in a way this Runtime does not read`
        + ` (${JSON.stringify(rule)}). It would be carried unchecked, which is worse than not carried.`)
    }
    kinds[name] = kind
  }
  return kinds
}

/**
 * Where the canonical contract repository is, if it is on this machine.
 *
 * `RULITH_CONTRACT_REPO` names it explicitly; otherwise the sibling checkout is tried, which
 * is where it lives in a development tree. Absence is a real and ordinary state — a published
 * package has no repository beside it — and is reported as absence.
 *
 * A directory being *a* Git repository is not evidence of being *the* contract repository,
 * and the difference matters because the two outcomes are asymmetric: an unrelated repo at
 * `../rulith` would fail to resolve the pinned commit, and a repository that cannot answer is
 * a hard failure by design. So the guess — and only the guess — must also look like the
 * contract repository: it has to carry the schema the bundle vendors. An explicitly named
 * path is taken at its word, because naming it is the operator saying which one it is.
 */
export function contractRepoPath(root) {
  const named = process.env.RULITH_CONTRACT_REPO
  const isRepo = (at) => existsSync(resolve(at, '.git')) || existsSync(resolve(at, 'HEAD'))
  if (named !== undefined && named !== '') {
    const chosen = resolve(named)
    return isRepo(chosen) ? chosen : undefined
  }
  const sibling = resolve(root, '..', 'rulith')
  return isRepo(sibling) && existsSync(resolve(sibling, WORKER_SCHEMA_FILE)) ? sibling : undefined
}

/**
 * Compare the bundle's recorded blob ids against the commit it names, in the real repository.
 *
 * Three outcomes, and they are deliberately three rather than two:
 *
 *   · `{ checked: true }` — the commit resolved and every file's blob id matched it.
 *   · `{ checked: false, reason: 'absent' }` — no repository on this machine. Nothing is
 *     claimed and nothing is wrong; the local recomputation above still stands.
 *   · **throws** — a repository is here and the commit could not be resolved, or a blob id
 *     disagrees. This is the case that must never collapse into the second one: "I could not
 *     ask" and "I asked and the answer was no" are different, and treating them alike is how
 *     a pin to a commit that does not exist passes as verified.
 */
export function checkProvenance(bundle, { root, path = WORKER_BUNDLE_PATH } = {}) {
  const repo = contractRepoPath(root)
  if (repo === undefined) return { checked: false, reason: 'absent' }
  const named = process.env.RULITH_CONTRACT_REPO
  const how = named !== undefined && named !== '' ? 'RULITH_CONTRACT_REPO' : 'the sibling checkout'
  const git = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const type = git(['cat-file', '-t', bundle.sourceCommit])
  if (type.status !== 0 || type.stdout.trim() !== 'commit') {
    throw new WorkerContractError(`${path}: the contract repository at ${repo} (found via ${how})`
      + ` cannot resolve ${bundle.sourceCommit} as a commit`
      + ` (${type.status !== 0 ? String(type.stderr ?? '').trim().slice(0, 160) : `it is a ${type.stdout.trim()}`}).`
      + ' A repository that is present and cannot answer is not the same as no repository:'
      + ' the pin names bytes nobody here can produce.'
      + ' If that directory is not the contract repository, point RULITH_CONTRACT_REPO at the one that is,'
      + ' or at a path that is not a repository to skip the comparison.')
  }
  for (const file of WORKER_CONTRACT_FILES) {
    const oid = git(['rev-parse', `${bundle.sourceCommit}:${file}`])
    if (oid.status !== 0) {
      throw new WorkerContractError(`${path}: ${file} does not exist at ${bundle.sourceCommit} in ${repo}`
        + ` (${String(oid.stderr ?? '').trim().slice(0, 160)}).`)
    }
    const recorded = bundle.files[file]?.gitBlobOid
    if (oid.stdout.trim() !== recorded) {
      throw new WorkerContractError(`${path}: ${file} is recorded as Git blob ${recorded}, but ${bundle.sourceCommit}`
        + ` in ${repo} names ${oid.stdout.trim()}. The vendored copy is not what that commit holds.`)
    }
  }
  return { checked: true, repo }
}

/** Validate a parsed bundle and return everything the Worker and its tests consume. */
export function readWorkerContract(bundle, { path = WORKER_BUNDLE_PATH } = {}) {
  if (!isObject(bundle)) throw new WorkerContractError(`${path} is not an object.`)
  if (bundle.schema !== WORKER_BUNDLE_SCHEMA) {
    throw new WorkerContractError(`${path} declares schema ${JSON.stringify(bundle.schema)}; this Runtime reads ${WORKER_BUNDLE_SCHEMA}.`)
  }
  if (typeof bundle.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(bundle.sourceCommit)) {
    throw new WorkerContractError(`${path} carries sourceCommit ${JSON.stringify(bundle.sourceCommit)},`
      + ' which is not a full 40-character commit id.')
  }
  if (!isObject(bundle.files)) throw new WorkerContractError(`${path} carries no files.`)
  // The carried set is closed, not merely covered. A bundle with an extra key used to carry
  // it, publish it and hash it into the artifact manifest with nobody checking its digest or
  // its provenance — "every file I look for is present and correct" is not the same claim as
  // "these are the files".
  const carried = Object.keys(bundle.files).sort()
  const wanted = [...WORKER_CONTRACT_FILES].sort()
  if (carried.length !== wanted.length || carried.some((name, at) => name !== wanted[at])) {
    const extra = carried.filter((name) => !wanted.includes(name))
    const absent = wanted.filter((name) => !carried.includes(name))
    throw new WorkerContractError(`${path} carries ${carried.length} file(s) and this Runtime reads exactly ${wanted.length}.`
      + `${extra.length > 0 ? ` Unread: ${extra.join(', ')}.` : ''}${absent.length > 0 ? ` Missing: ${absent.join(', ')}.` : ''}`)
  }
  const parsed = new Map()
  for (const file of WORKER_CONTRACT_FILES) {
    const entry = bundle.files[file]
    if (!isObject(entry) || typeof entry.content !== 'string' || typeof entry.sha256 !== 'string') {
      throw new WorkerContractError(`${path}: ${file} is missing, or is missing its content or its sha256.`)
    }
    const extraKeys = Object.keys(entry).filter((key) => !['content', 'sha256', 'gitBlobOid'].includes(key))
    if (extraKeys.length > 0) {
      throw new WorkerContractError(`${path}: ${file} carries ${extraKeys.join(', ')}, which nothing here checks.`)
    }
    const actual = sha256(entry.content)
    if (actual !== entry.sha256) {
      throw new WorkerContractError(`${path}: ${file} does not match the digest recorded beside it`
        + ` (recorded ${entry.sha256}, computed ${actual}). The bundle is refused whole rather than in part.`)
    }
    // The blob id is what keeps the pin checkable against the repository that authored it —
    // and it is **recomputed** here, not merely read back. A recorded id nobody recomputes
    // proves only that someone once typed it; Git's object id is a pure function of the
    // bytes (`sha1("blob " + length + NUL + content)`), so the bytes in hand either produce
    // it or they do not.
    if (typeof entry.gitBlobOid !== 'string' || !/^[0-9a-f]{40}$/u.test(entry.gitBlobOid)) {
      throw new WorkerContractError(`${path}: ${file} carries no Git blob object id, so the pin cannot be checked`
        + ' against the repository it claims to come from.')
    }
    const recomputed = gitBlobOid(entry.content)
    if (recomputed !== entry.gitBlobOid) {
      throw new WorkerContractError(`${path}: ${file} is recorded as Git blob ${entry.gitBlobOid} but its own bytes`
        + ` hash to ${recomputed}. The content and the pin name two different objects.`)
    }
    try { parsed.set(file, JSON.parse(entry.content)) } catch (error) {
      throw new WorkerContractError(`${path}: ${file} is not readable JSON (${String(error?.message ?? error)}).`)
    }
  }

  const schema = parsed.get(WORKER_SCHEMA_FILE)
  const defs = schema?.$defs
  if (!isObject(defs)) throw new WorkerContractError(`${path}: ${WORKER_SCHEMA_FILE} declares no $defs.`)
  for (const name of REQUIRED_DEFS) {
    if (!isObject(defs[name])) throw new WorkerContractError(`${path}: ${WORKER_SCHEMA_FILE} is missing $defs.${name}.`)
  }

  const fixture = parsed.get(WORKER_FIXTURE_FILE)
  const rule = defs.CanonicalizationRule?.const
  if (typeof rule !== 'string' || rule === '') {
    throw new WorkerContractError(`${path}: the schema names no canonicalization rule.`)
  }
  if (fixture?.canonicalization?.rule !== rule) {
    throw new WorkerContractError(`${path}: the fixture canonicalizes by ${JSON.stringify(fixture?.canonicalization?.rule)}`
      + ` while the schema names ${JSON.stringify(rule)}. One receipt may not carry two normalizations.`)
  }
  const retired = Array.isArray(fixture?.retiredHopFields) ? fixture.retiredHopFields.map(String) : []
  if (retired.length === 0) throw new WorkerContractError(`${path}: the fixture lists no retired hop fields.`)
  for (const where of REQUIRED_FIXTURE_ROWS) {
    const rows = where.split('.').reduce((node, key) => (isObject(node) ? node[key] : undefined), fixture)
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new WorkerContractError(`${path}: the fixture carries no ${where}. This Runtime drives its arms from those rows,`
        + ' so an empty section is coverage that disappears without a single test turning red.')
    }
  }

  const workerIdPattern = defs.WorkerId?.pattern
  if (typeof workerIdPattern !== 'string' || workerIdPattern === '') {
    throw new WorkerContractError(`${path}: the schema states no WorkerId pattern.`)
  }
  const headerNames = {
    workerId: defs.WorkerHeaderNames?.properties?.workerId?.const,
    workerGeneration: defs.WorkerHeaderNames?.properties?.workerGeneration?.const,
  }
  if (typeof headerNames.workerId !== 'string' || typeof headerNames.workerGeneration !== 'string') {
    throw new WorkerContractError(`${path}: the schema names no protected Worker identity headers.`)
  }
  const requestVersion = defs.ExecutionRequestVector?.properties?.version?.const
  const resultVersion = defs.ExecutionResultVector?.properties?.version?.const
  const grantVersion = defs.ExecutionGrant?.properties?.version?.const
  if (typeof requestVersion !== 'string' || typeof resultVersion !== 'string' || grantVersion === undefined) {
    throw new WorkerContractError(`${path}: the schema does not version the execution vectors and the grant.`)
  }
  // Work types are the claim's discriminator, not a poll selector: Poll takes no
  // work-type filter, so reading them off the poll would read a field that is not there.
  const workTypes = defs.ClaimWorkRequest?.properties?.workType?.enum
  if (!Array.isArray(workTypes) || workTypes.length === 0) {
    throw new WorkerContractError(`${path}: the schema declares no work types.`)
  }

  // The Poll surface, and the descriptor shape its Manifest carries. Every rule below is
  // read out of the schema rather than restated here: a hand-written copy of an enum is a
  // second source of truth that goes stale without saying so.
  const poll = defs.PollRequest
  const pollKind = poll?.properties?.kind?.const
  if (typeof pollKind !== 'string' || pollKind === '') {
    throw new WorkerContractError(`${path}: the schema names no Poll verb.`)
  }
  const descriptor = defs.WorkerToolDescriptor
  const advertisement = {
    pollKind,
    pollRequired: Array.isArray(poll?.required) ? [...poll.required] : [],
    maxAdvertisedTools: poll?.properties?.tools?.maxItems,
    sourceTypes: defs.SourceType?.enum,
    toolIdPattern: descriptor?.properties?.id?.pattern,
    toolDigestPattern: defs.ToolDigest?.pattern,
    toolKinds: descriptor?.properties?.kind?.enum,
    paramTypes: descriptor?.properties?.params?.additionalProperties?.enum,
    paramNamePattern: descriptor?.properties?.params?.propertyNames?.pattern,
    returnPredicatePattern: descriptor?.properties?.returns?.items?.properties?.predicate?.pattern,
    maxReturnRows: descriptor?.properties?.returns?.maxItems,
  }
  for (const [name, value] of Object.entries(advertisement)) {
    const stated = Array.isArray(value) ? value.length > 0
      : typeof value === 'string' ? value !== ''
        : Number.isSafeInteger(value) && value > 0
    if (!stated) throw new WorkerContractError(`${path}: the schema states no ${name} for the Poll Manifest.`)
  }
  // The grant, field by field, so the Worker can check a decoded token against the contract
  // instead of against a list retyped in its own source. Reading the kinds off the schema is
  // what makes a field added upstream a build failure here rather than a field nobody checks.
  advertisement.grantShape = closedShapeKinds(defs.ExecutionGrant, 'grant', path)
  // The `const` fields of the grant, per field name — the same table the action row gets.
  // Comparing every `const` field against one projected value happened to be right while
  // `version` was the only one; a second would have been checked against the first's value.
  advertisement.grantConst = Object.fromEntries(Object.entries(defs.ExecutionGrant.properties)
    .filter(([, rule]) => rule?.const !== undefined).map(([name, rule]) => [name, rule.const]))
  // The dispatched action row, read the same way. The Worker's receive path checks a row
  // against this before it claims: every mandatory field present and non-empty where the
  // contract says non-empty, and nothing else carried at all.
  advertisement.actionRowShape = closedShapeKinds(defs.WorkerActionWorkItem, 'action work item', path)
  advertisement.actionRowConst = Object.fromEntries(Object.entries(defs.WorkerActionWorkItem.properties)
    .filter(([, rule]) => rule?.const !== undefined).map(([name, rule]) => [name, rule.const]))
  advertisement.digestPattern = defs.Digest?.pattern
  advertisement.generationMaximum = defs.Generation?.maximum
  advertisement.headerGenerationPattern = defs.WorkerHeaderValues?.properties?.workerGeneration?.pattern
  if (typeof advertisement.digestPattern !== 'string' || !Number.isSafeInteger(advertisement.generationMaximum)
    || typeof advertisement.headerGenerationPattern !== 'string' || advertisement.headerGenerationPattern === '') {
    throw new WorkerContractError(`${path}: the schema states no digest pattern, generation ceiling or header grammar.`)
  }

  if (!poll.required.includes('tools')) {
    throw new WorkerContractError(`${path}: the Poll shape does not require the Tool Manifest.`
      + ' A poll that may omit it leaves the previous advertisement standing unexamined,'
      + ' which is the state this Runtime must not be able to reach.')
  }

  return {
    sourceCommit: bundle.sourceCommit,
    schema,
    artifactSchema: parsed.get(ARTIFACT_SCHEMA_FILE),
    fixture,
    defs,
    canonicalizationRule: rule,
    retiredHopFields: retired,
    actionWorkShadowFields: fixture.actionWorkShadowFields,
    workerIdPattern,
    headerNames,
    requestVersion,
    resultVersion,
    grantVersion,
    workTypes: [...workTypes],
    ...advertisement,
    files: bundle.files,
  }
}

/** The vendored Worker contract. There is no fallback and no default. */
export function loadWorkerContract(root = resolve(import.meta.dirname, '..')) {
  const path = resolve(root, WORKER_BUNDLE_PATH)
  let text
  try { text = readFileSync(path, 'utf8') } catch (error) {
    throw new WorkerContractError(`${WORKER_BUNDLE_PATH} could not be read (${String(error?.message ?? error)}).`
      + ' It is what tells this Runtime what the Worker hop looks like; it is not optional.'
      + ' Re-vendor it with: node scripts/sync-worker-contract.mjs --repo <contract-repo> --commit <40-hex>')
  }
  let parsed
  try { parsed = JSON.parse(text) } catch (error) {
    throw new WorkerContractError(`${WORKER_BUNDLE_PATH} is not readable JSON: ${String(error?.message ?? error)}`)
  }
  const contract = readWorkerContract(parsed, { path: WORKER_BUNDLE_PATH })
  return { ...contract, provenance: checkProvenance(parsed, { root }) }
}

if (process.argv[1]?.endsWith('verify-worker-contract.mjs')) {
  const contract = loadWorkerContract(process.argv[2] === undefined ? undefined : resolve(process.argv[2]))
  const provenance = contract.provenance.checked
    ? `blob ids match ${contract.sourceCommit.slice(0, 12)} in ${contract.provenance.repo}`
    : 'no contract repository on this machine; blob ids recomputed from the carried bytes only'
  console.log(`${WORKER_BUNDLE_PATH}: worker hop from ${contract.sourceCommit}`
    + ` · ${contract.canonicalizationRule} · ${Object.keys(contract.files).length} file(s) verified against their digests`
    + ` · retired: ${contract.retiredHopFields.join(', ')}`
    + `\n  provenance: ${provenance}`)
}

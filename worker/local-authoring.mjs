// SPDX-License-Identifier: Apache-2.0
/** Local-only implementation of the versioned official-authoring Tools. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { MATERIAL_ID_PATTERN, MaterialError, materialTextOf, openMaterialStore } from './material-store.mjs'
import { discoverLocalAuthoringJar as discoveredJar } from '../local/authoring-checker.mjs'
import { runBounded } from '../local/process-tree.mjs'

export const LOCAL_AUTHORING_RELEASE = '2.0.0'
export const LOCAL_AUTHORING_LIMITS = Object.freeze({ documentBytes: 256 * 1024, draftBytes: 512 * 1024, outputBytes: 2 * 1024 * 1024, timeoutMs: 150_000, reportBytes: 32 * 1024 })
let checkerBusy = false
const IDS = Object.freeze({ ingest: 'rulith.official_authoring.ingest_document@2', check: 'rulith.official_authoring.check_draft@2' })
// The first check should test a business proposal, not teach the JSON envelope by
// rejecting it. The Worker sends this fixed cue beside the ingest Artifact reference;
// it never sends material bytes or a file name in that result. This is guidance, not
// a document claim or Board fact. The checker remains the authority.
export const LOCAL_AUTHORING_DRAFT_SHAPE = [
  'Draft format (guidance, not evidence): draft_json is a STRING containing one JSON object with exactly',
  'program, caseContracts, citations, examples, questions, notes.',
  'program is a JSON OBJECT, never DSL/Markdown/code; only outer draft_json is a string.',
  'program={id,title,summary,vocabulary:{defines:[{id,as,args}]},pins:[alias],rules:[{id,label,when:[{predicate,args}],then:[{predicate,args}]}]}.',
  'program.id is a lowercase package name of 2-32 characters such as shipping_policy, with no dots; it is NOT a namespaced predicate ID.',
  'vocabulary.defines[].id MUST be a canonical namespaced predicate (e.g. acme.shipping.order_amount); rules use local as aliases, never bare ids.',
  'Rule/example atom args MUST be JSON objects keyed by field (e.g. {order_id:"?id",yuan:"?yuan"}), never arrays.',
  'Rules use declared aliases/imports or built-ins eq, neq, lt, lte, gt, gte (NOT ge); comparison args={left:"?yuan",right:200}. No invented missing/invalid predicates: use forbidden-output examples and guard valid inputs.',
  'caseContracts=[{format:"rulith-case-contract/1",caseType,title,businessKey:{predicate,arguments},opening:{predicate,keyArguments},acceptance:{predicate,keyArguments,minimumGroundingFloor:"attested"},terminal:{cardinality:"once_per_case",disposition:"completed",requiresCertified:true}}].',
  'For each contract, businessKey.predicate and opening.predicate name the same document INPUT predicate; acceptance.predicate names a distinct OUTPUT predicate. Their arguments/keyArguments are the same array of business key FIELD NAMES, e.g. ["order_id"], not the material task_id unless the document says so.',
  'Each key field must exist in both locally defined INPUT and OUTPUT predicate args.',
  'citations=[{ruleId,quote}], examples=[{label,facts:[{predicate,args}],expect:[{predicate,args}],forbid:[],forbidPredicates:[]}], questions=[], notes="...".',
  'Use full namespaced predicates in examples, aliases in program rules, and exact document substrings as quotes. Do not treat this cue as validation; the local checker decides.',
].join(' ')
const orderedDigest = value => `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`
// Java OrderedJson preserves insertion order, including nested objects. Only the four
// top-level proposal fields are selected in this fixed order; missing values are null.
export const proposalDigest = draft => orderedDigest(Object.fromEntries(['program', 'caseContracts', 'citations', 'examples'].map(key => [key, Object.hasOwn(draft, key) ? draft[key] : null])))
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const checkerEnv = () => Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'JAVA_HOME', 'LANG', 'LC_ALL']
  .filter(name => typeof process.env[name] === 'string' && process.env[name] !== '').map(name => [name, process.env[name]]))

export async function discoverLocalAuthoringJava(env = process.env) {
  const explicit = String(env.RULITH_AUTHORING_JAVA ?? '').trim()
  const homes = explicit !== '' ? [explicit] : [
    process.platform === 'win32' ? 'C:/Program Files/Java/jdk-25/bin/java.exe' : '',
    String(env.JAVA_HOME ?? '').trim() && join(String(env.JAVA_HOME).trim(), process.platform === 'win32' ? 'bin/java.exe' : 'bin/java'),
    ...(process.platform === 'win32' ? [] : ['/usr/bin/java', '/usr/lib/jvm/java-25-openjdk/bin/java', '/opt/homebrew/opt/openjdk@25/bin/java']),
  ]
  for (const candidate of homes) {
    if (!candidate || !isAbsolute(candidate) || !existsSync(candidate)) continue
    const java = resolve(candidate)
    try {
      const version = await new Promise((accept, reject) => execFile(java, ['-version'], { timeout: 5_000, windowsHide: true, env: checkerEnv() }, (error, _out, stderr) => error ? reject(error) : accept(String(stderr))))
      if (/(?:version\s+"25[."]|\b25\.0)/.test(version)) return java
    } catch { /* Try the next installed JVM; no model-supplied executable is accepted. */ }
  }
  throw new Error('local_authoring_java_unavailable: Java 25 is required. Set JAVA_HOME or RULITH_AUTHORING_JAVA to an absolute Java 25 executable.')
}
export async function discoverLocalAuthoringJar(env = process.env) {
  const raw = String(env.RULITH_AUTHORING_JAR ?? '').trim()
  if (raw !== '') {
    if (!isAbsolute(raw) || !existsSync(raw)) throw new Error('local_authoring_jar_unavailable: RULITH_AUTHORING_JAR must name an installed absolute local-authoring.jar path.')
    return resolve(raw)
  }
  return discoveredJar()
}
export function builtinLocalAuthoringTools(root = process.env.RULITH_MATERIALS_ROOT ?? '') {
  const common = { adapter: 'local-authoring', sourceTypes: ['file'], implementationVersion: LOCAL_AUTHORING_RELEASE, release: LOCAL_AUTHORING_RELEASE }
  return {
    [IDS.ingest]: { ...common, entry: 'ingest', kind: 'read', params: { material: 'string' }, returns: [{ predicate: 'rulith.official_authoring.authoring_task', args: { node: '$node', task_id: '$task_id', document_digest: '$document_digest', characters: '$characters' } }] },
    [IDS.check]: { ...common, entry: 'check', kind: 'read', params: { node: 'string', task_id: 'string', draft_json: 'string' }, returns: [{ predicate: 'rulith.official_authoring.draft_check', args: { node: '$node', task_id: '$task_id', proposal_digest: '$proposal_digest', compiled: '$compiled', examples_total: '$examples_total', examples_passed: '$examples_passed', citations_total: '$citations_total', citations_verified: '$citations_verified', external_actions: '$external_actions', report: '$report' } }] },
  }
}
function material(root, binding, id) {
  if (!MATERIAL_ID_PATTERN.test(id)) throw new Error('local_authoring_material_invalid: material must be a host-issued mat_<32 hex> id.')
  const store = openMaterialStore(root, binding, { create: false })
  const read = store.read(id, { modelDestination: binding.modelDestination })
  const media = String(read.record.mediaType).split(';', 1)[0].trim().toLowerCase()
  if (!/\.(txt|md)$/i.test(read.record.name) || (media !== 'text/plain' && media !== 'text/markdown')) throw new Error('local_authoring_media_unsupported: only immutable .txt and .md material is supported.')
  if (read.bytes.byteLength > LOCAL_AUTHORING_LIMITS.documentBytes) throw new Error('local_authoring_document_too_large: document exceeds 256 KiB.')
  const text = materialTextOf(read.record, read.bytes)
  if (text === undefined) throw new Error('local_authoring_utf8_invalid: document must be strict UTF-8.')
  return { store, record: read.record, bytes: read.bytes, text }
}
// Node identity is stable for the exact immutable document version, never a path or a task alias.
export const authoringNode = (materialId, digest) => `node_${createHash('sha256').update(`${materialId}\u0000${digest}`, 'utf8').digest('hex').slice(0, 32)}`
async function recordResult(root, row) {
  const directory = join(root, 'local-authoring')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, 'results.json')
  let rows = []
  try { rows = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!Array.isArray(rows)) throw new Error('local_authoring_result_index_invalid: results index is not an array.')
  rows.push(row); if (rows.length > 200) rows = rows.slice(-200)
  const temporary = join(directory, `.results-${randomUUID()}.json`)
  await writeFile(temporary, `${JSON.stringify(rows)}\n`, { mode: 0o600, flag: 'wx' }); await rename(temporary, file)
}
export async function executeLocalAuthoring(tool, args, { materialRoot, binding }) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  if (tool.entry === 'ingest') {
    const found = material(materialRoot, binding, String(input.material ?? ''))
    const node = authoringNode(found.record.id, found.record.digest)
    const produced = found.store.deriveResult(found.record.id, { mediaType: found.record.mediaType, encoding: 'utf8' })
    return { result: 'Document ingested locally.', localArtifact: produced, rows: [{ node, task_id: found.record.id, document_digest: found.record.digest, characters: [...found.text].length }] }
  }
  if (tool.entry !== 'check') throw new Error('local_authoring_tool_unknown')
  const found = material(materialRoot, binding, String(input.task_id ?? ''))
  const node = authoringNode(found.record.id, found.record.digest)
  if (input.node !== node) throw new Error('local_authoring_node_mismatch: node does not name this immutable material version.')
  if (typeof input.draft_json !== 'string' || Buffer.byteLength(input.draft_json, 'utf8') > LOCAL_AUTHORING_LIMITS.draftBytes) throw new Error('local_authoring_draft_invalid: draft_json must be bounded JSON text.')
  let draft; try { draft = JSON.parse(input.draft_json) } catch { throw new Error('local_authoring_draft_invalid: draft_json is not JSON.') }
  if (!draft || Array.isArray(draft) || typeof draft !== 'object') throw new Error('local_authoring_draft_invalid: draft_json must be one object.')
  if (Object.keys(draft).some(key => !['program', 'caseContracts', 'citations', 'examples', 'questions', 'notes'].includes(key))) {
    throw new Error('local_authoring_draft_invalid: use only program, caseContracts, citations, examples, questions and notes.')
  }
  const [java, jar] = await Promise.all([discoverLocalAuthoringJava(), discoverLocalAuthoringJar()])
  if (checkerBusy) throw new Error('local_authoring_busy: this Worker already has one checker process running.')
  checkerBusy = true
  const directory = join(materialRoot, 'local-authoring', `check-${randomUUID()}`)
  const draftFile = join(directory, 'draft.json'), documentFile = join(directory, 'document.txt'), outputFile = join(directory, 'report.json')
  try {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(draftFile, JSON.stringify(draft), { mode: 0o600 }); await writeFile(documentFile, found.bytes, { mode: 0o600 })
  await runBounded(java, ['-Xmx256m', '-XX:MaxMetaspaceSize=128m', '-jar', jar, '--check', draftFile, documentFile, outputFile], { timeoutMs: LOCAL_AUTHORING_LIMITS.timeoutMs, maxBytes: LOCAL_AUTHORING_LIMITS.reportBytes, env: checkerEnv(), cwd: directory })
  const output = await readFile(outputFile); if (output.byteLength > LOCAL_AUTHORING_LIMITS.outputBytes) throw new Error('local_authoring_report_too_large')
  let envelope; try { envelope = JSON.parse(output) } catch { throw new Error('local_authoring_report_invalid: checker did not emit JSON.') }
  const report = envelope
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.format !== 'rulith-authoring-check/1') throw new Error('local_authoring_report_invalid: checker output must be a rulith-authoring-check/1 Report.document.')
  const proposal_digest = proposalDigest(draft)
  if (report.proposalDigest !== proposal_digest) throw new Error('local_authoring_report_mismatch: checker report names another proposal digest.')
  const counts = { examples_total: report.examples?.total ?? 0, examples_passed: report.examples?.passed ?? 0, citations_total: report.citations?.total ?? 0, citations_verified: report.citations?.verified ?? 0, external_actions: Array.isArray(report.externalActions) ? report.externalActions.length : -1 }
  if (![...Object.values(counts)].every(Number.isSafeInteger) || Object.values(counts).some(value => value < 0) || counts.examples_passed > counts.examples_total || counts.citations_verified > counts.citations_total || typeof report.compiled !== 'boolean') throw new Error('local_authoring_report_invalid: checker report has invalid mechanical counts.')
  const errors = Array.isArray(report.compileErrors) ? report.compileErrors.filter(error => typeof error === 'string').slice(0, 20).map(error => error.slice(0, 500)) : []
  const summary = JSON.stringify({ compiled: report.compiled, ...counts, errors })
  const result = found.store.putResult({ name: `authoring-check-${found.record.id}.json`, mediaType: 'application/json', encoding: 'utf8', bytes: Buffer.from(JSON.stringify({ draft, report }), 'utf8') })
  await recordResult(materialRoot, { profile: binding.profile, owner: binding.owner, materialId: found.record.id, documentDigest: found.record.digest, node, proposalDigest: proposal_digest, resultId: result.id, resultDigest: result.digest, checkedAt: new Date().toISOString() })
  return { result: 'Local mechanical authoring check completed.', localArtifact: result, rows: [{ node, task_id: found.record.id, proposal_digest, compiled: report.compiled, ...counts, report: summary }] }
  } finally {
    checkerBusy = false
    const root = resolve(materialRoot, 'local-authoring')
    if (dirname(resolve(directory)) === root) await rm(directory, { recursive: true, force: true })
  }
}

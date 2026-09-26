// SPDX-License-Identifier: Apache-2.0
/** Local-only implementation of the versioned official-authoring Tools. */
import { createHash, randomUUID } from 'node:crypto'
import { authoringDiagnostics, createAuthoringGuidance, createConstructionGuidance } from './authoring-diagnostics.mjs'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { link, mkdir, open, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { MATERIAL_ID_PATTERN, RESULT_ID_PATTERN, MaterialError, materialTextOf, openMaterialStore } from './material-store.mjs'
import { discoverLocalAuthoringJar as discoveredJar, authoringCheckerReferenceFormat } from '../local/authoring-checker.mjs'
import { runBounded } from '../local/process-tree.mjs'

export const LOCAL_AUTHORING_RELEASE = '3.1.0'
export const LOCAL_AUTHORING_LIMITS = Object.freeze({ documentBytes: 256 * 1024, draftBytes: 512 * 1024, outputBytes: 2 * 1024 * 1024, timeoutMs: 150_000, reportBytes: 32 * 1024 })
let checkerBusy = false
const IDS = Object.freeze({ ingest: 'rulith.official_authoring.ingest_document@2', check: 'rulith.official_authoring.check_draft@2', construct: 'rulith.official_authoring.construct_draft@3' })
// The first check should test a business proposal, not teach the JSON envelope by
// rejecting it. The Worker sends this fixed cue beside the ingest Artifact reference;
// it never sends material bytes or a file name in that result. This is guidance, not
// a document claim or Board fact. The checker remains the authority.
export const LOCAL_AUTHORING_DRAFT_SHAPE = [
  "Guidance, not evidence: use construct_rule_draft with construction_json as a STRING containing one rulith-authoring-construction/1 object. Fields:",
  "format,namespace,program,caseContracts,citations,examples,questions,notes. program is an object; only construction_json is a string.",
  "program={id,title,summary,predicates:[{name,as,args}],imports:[],pins:[alias],rules:[],ruleGroups:[{commonWhen:[{predicate,args}],validations:[{kind:\"nonnegative_integer\",value:\"?x\"}],branches:[{id,label,when:[{predicate,args}],then:[{predicate,args}]}]}],actions:[],acceptance:[]}.",
  "program.id is lowercase 2-32 chars without dots; namespace: acme.shipping. Predicate name is final name, as is alias; prefer {name:\"charge\",as:\"charge\",args:[\"amount\"]}; reference",
  "the exact as value. Atom args is an object keyed by field, not an array. Rules name declared aliases/imports or built-ins including eq,neq,lt,lte,gt,gte with",
  "args={left:\"?x\",right:200}. Calculations go in when: {predicate:\"add\",args:{left:\"?x\",right:1,result:\"?y\"}}; then can use ?y. sub,mul,div,min,max use the same keys. commonWhen",
  "repeats per branch; nonnegative_integer adds gte 0 and integer guards when required.",
  "caseContracts=[{caseType,title,businessKey:{predicate,arguments},opening:{predicate,keyArguments},acceptance:{predicate,keyArguments,minimumGroundingFloor:\"attested\"}}]. The",
  "constructor adds the certified terminal. caseType is a business name [a-z][a-z0-9_]{0,63}, not a version. Business key and opening name the document INPUT; acceptance names a",
  "distinct OUTPUT. Key arrays are field names; keys occur in both predicates, never material task_id.",
  "citations=[{ruleId,quote}],examples=[{label,facts:[{predicate,args}],expect:[{predicate,args}],forbid:[],forbidPredicates:[]}],questions=[],notes=\"...\". Each citation.ruleId must",
  "equal a rules[].id or ruleGroups[].branches[].id. Quote exactly; test invalid inputs too. naf:true tests absence in the current closure, not absence in the outside world. Bind",
  "variables positively; preserve observed versions on version-keyed inputs.",
].join(' ')
export const LOCAL_AUTHORING_REFERENCE_CUE = 'The first Artifact is the document or check result; the second is the installed checker public authoring reference. Read both before writing or repairing rules. The reference is guidance, not evidence. When bytes are identical, one Artifact serves both.'
let referenceCache

/** Read static guidance from the exact operator-selected or release-pinned executable, never material text. */
async function localReference(materialRoot) {
  // Old released checker pins do not advertise this CLI. They keep their original single-object contract.
  const advertised = await authoringCheckerReferenceFormat()
  if (!String(process.env.RULITH_AUTHORING_JAR ?? '').trim() && advertised === undefined) return undefined
  const [java, jar] = await Promise.all([discoverLocalAuthoringJava(), discoverLocalAuthoringJar()])
  const key = `${java}:${jar}:${sha(readFileSync(jar))}`
  if (!referenceCache || referenceCache.key !== key) {
    const promise = (async () => {
      const directory = join(materialRoot, 'local-authoring', `reference-${randomUUID()}`)
      try {
        await mkdir(directory, {recursive:true, mode:0o700})
        const output = join(directory, 'reference.json')
        await runBounded(java, ['-Xmx64m', '-XX:MaxMetaspaceSize=64m', '-jar', jar, '--reference', output],
          {timeoutMs:15_000, maxBytes:4096, env:checkerEnv(), cwd:directory})
        if (statSync(output).size > 64 * 1024) throw new Error('public reference exceeds its byte limit')
        const bytes = await readFile(output), value = JSON.parse(bytes.toString('utf8'))
        if (value?.format !== 'rulith-local-authoring-reference/1' || value.guidanceOnly !== true
          || !/^sha256:[a-f0-9]{64}$/.test(value.authoringContractDigest)
          || Object.keys(value).sort().join(',') !== 'authoringContractDigest,construction,draft,format,guidanceOnly'
          || !['construction','draft'].every(k=>typeof value[k]==='string' && value[k].trim()))
          throw new Error('installed checker returned an invalid public reference')
        return bytes
      } catch (error) {
        throw new Error(`local_authoring_reference_unavailable: Install the matching checker before authoring (${error.message}).`)
      } finally {
        const root = resolve(materialRoot, 'local-authoring')
        if (dirname(resolve(directory)) === root) await rm(directory, {recursive:true, force:true})
      }
    })()
    referenceCache = {key, promise}
  }
  const current = referenceCache
  try {return await current.promise} catch (error) {if(referenceCache===current)referenceCache=undefined;throw error}
}
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
    [IDS.construct]: { ...common, entry: 'construct', kind: 'read', params: { node: 'string', task_id: 'string', construction_json: 'string' }, returns: [{ predicate: 'rulith.official_authoring.draft_construction', args: { node: '$node', task_id: '$task_id', construction_digest: '$construction_digest', proposal_digest: '$proposal_digest', constructed: '$constructed', compiled: '$compiled', examples_total: '$examples_total', examples_passed: '$examples_passed', citations_total: '$citations_total', citations_verified: '$citations_verified', external_actions: '$external_actions', report: '$report' } }] },
  }
}
function material(root, binding, id) {
  if (!MATERIAL_ID_PATTERN.test(id)) throw new Error('local_authoring_material_invalid: material must be a host-issued mat_<32 hex> id.')
  const store = openMaterialStore(root, binding, { create: false })
  const selected = store.resolveSubmitted(id)
  let read
  try { read = store.read(selected.id, { modelDestination: binding.modelDestination }) }
  catch (error) { throw new Error(String(error?.message ?? error).replaceAll(selected.id, id)) }
  const media = String(read.record.mediaType).split(';', 1)[0].trim().toLowerCase()
  if (!/\.(txt|md)$/i.test(read.record.name) || (media !== 'text/plain' && media !== 'text/markdown')) throw new Error('local_authoring_media_unsupported: only immutable .txt and .md material is supported.')
  if (read.bytes.byteLength > LOCAL_AUTHORING_LIMITS.documentBytes) throw new Error('local_authoring_document_too_large: document exceeds 256 KiB.')
  const text = materialTextOf(read.record, read.bytes)
  if (text === undefined) throw new Error('local_authoring_utf8_invalid: document must be strict UTF-8.')
  return { store, selector: id, record: read.record, bytes: read.bytes, text }
}
// Node identity is stable for the exact immutable document version, never a path or a task alias.
export const authoringNode = (materialId, digest) => `node_${createHash('sha256').update(`${materialId}\u0000${digest}`, 'utf8').digest('hex').slice(0, 32)}`
export function localAuthoringIndexDirectory(root, identity) {
  const scope = createHash('sha256').update(JSON.stringify([identity.profile, identity.owner])).digest('hex')
  return join(root, 'local-authoring', 'checks', scope)
}

/** Read only this Agent's per-result records, plus the bounded pre-migration index. */
export function readLocalAuthoringResults(root, identity) {
  const old = join(root, 'local-authoring', 'results.json')
  const legacy = existsSync(old) ? JSON.parse(readFileSync(old, 'utf8')) : []
  if (!Array.isArray(legacy)) throw new Error('local_authoring_result_index_invalid: legacy index is not an array.')
  const directory = localAuthoringIndexDirectory(root, identity)
  if (!existsSync(directory)) return legacy
  const current = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^res_[0-9a-f]{32}\.json$/.test(entry.name)) continue
    const file = join(directory, entry.name)
    if (statSync(file).size > 8192) throw new Error('local_authoring_result_index_invalid: result entry exceeds its metadata limit.')
    const row = JSON.parse(readFileSync(file, 'utf8'))
    if (!row || Array.isArray(row) || typeof row !== 'object' || `${row.resultId}.json` !== entry.name
      || row.profile !== identity.profile || row.owner !== identity.owner)
      throw new Error('local_authoring_result_index_invalid: result entry differs from its Agent scope or filename.')
    current.push(row)
  }
  return [...legacy, ...current]
}

/** One immutable index entry per checked result; simultaneous Workers never rewrite a shared array. */
export async function recordLocalAuthoringResult(root, row) {
  if (!RESULT_ID_PATTERN.test(row?.resultId ?? '') || typeof row.profile !== 'string' || typeof row.owner !== 'string')
    throw new Error('local_authoring_result_index_invalid: checked result has no immutable identity.')
  const directory = localAuthoringIndexDirectory(root, row)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, `${row.resultId}.json`)
  const content = `${JSON.stringify(row)}\n`
  const temporary = join(directory, `.result-${randomUUID()}.json`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    try { await link(temporary, file) }
    catch (error) {
      if (error.code !== 'EEXIST' || readFileSync(file, 'utf8') !== content)
        throw new Error('local_authoring_result_index_conflict: checked result identity changed or could not be published.')
    }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  // Like the material store, file sync is mandatory and directory sync is best effort:
  // Windows does not support syncing every directory handle. No mutable list is rewritten.
  try {
    const handle = await open(directory, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch { /* Filesystem does not expose a syncable directory handle. */ }
}
export async function executeLocalAuthoring(tool, args, { materialRoot, binding }) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const reference = async store => {
    const bytes = await localReference(materialRoot)
    return bytes ? {companionArtifacts:[store.putResult({name:'authoring-reference.json', mediaType:'application/json', encoding:'utf8', bytes})]} : {}
  }
  if (tool.entry === 'ingest') {
    const found = material(materialRoot, binding, String(input.material ?? ''))
    const node = authoringNode(found.selector, found.record.digest)
    const produced = found.store.deriveResult(found.record.id, { mediaType: found.record.mediaType, encoding: 'utf8' })
    return { result: 'Document ingested locally.', localArtifact: produced, ...await reference(found.store), rows: [{ node, task_id: found.selector, document_digest: found.record.digest, characters: [...found.text].length }] }
  }
  const constructing = tool.entry === 'construct'
  if (!constructing && tool.entry !== 'check') throw new Error('local_authoring_tool_unknown')
  const found = material(materialRoot, binding, String(input.task_id ?? ''))
  const node = authoringNode(found.selector, found.record.digest)
  if (input.node !== node) throw new Error('local_authoring_node_mismatch: node does not name this immutable material version.')
  const inputName = constructing ? 'construction_json' : 'draft_json'
  const inputText = input[inputName]
  if (typeof inputText !== 'string' || Buffer.byteLength(inputText, 'utf8') > LOCAL_AUTHORING_LIMITS.draftBytes) throw new Error(`local_authoring_${constructing ? 'construction' : 'draft'}_invalid: ${inputName} must be bounded JSON text.`)
  let submitted; try { submitted = JSON.parse(inputText) } catch { throw new Error(`local_authoring_${constructing ? 'construction' : 'draft'}_invalid: ${inputName} is not JSON.`) }
  if (!submitted || Array.isArray(submitted) || typeof submitted !== 'object') throw new Error(`local_authoring_${constructing ? 'construction' : 'draft'}_invalid: ${inputName} must be one object.`)
  if (!constructing && Object.keys(submitted).some(key => !['program', 'caseContracts', 'citations', 'examples', 'questions', 'notes'].includes(key))) {
    throw new Error('local_authoring_draft_invalid: use only program, caseContracts, citations, examples, questions and notes.')
  }
  const [java, jar] = await Promise.all([discoverLocalAuthoringJava(), discoverLocalAuthoringJar()])
  if (checkerBusy) throw new Error('local_authoring_busy: this Worker already has one checker process running.')
  checkerBusy = true
  const directory = join(materialRoot, 'local-authoring', `check-${randomUUID()}`)
  const inputFile = join(directory, constructing ? 'construction.json' : 'draft.json'), documentFile = join(directory, 'document.txt'), outputFile = join(directory, constructing ? 'construction-report.json' : 'report.json')
  try {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(inputFile, inputText, { mode: 0o600 }); await writeFile(documentFile, found.bytes, { mode: 0o600 })
  await runBounded(java, ['-Xmx256m', '-XX:MaxMetaspaceSize=128m', '-jar', jar, constructing ? '--construct-check' : '--check', inputFile, documentFile, outputFile], { timeoutMs: LOCAL_AUTHORING_LIMITS.timeoutMs, maxBytes: LOCAL_AUTHORING_LIMITS.reportBytes, env: checkerEnv(), cwd: directory })
  const output = await readFile(outputFile); if (output.byteLength > LOCAL_AUTHORING_LIMITS.outputBytes) throw new Error('local_authoring_report_too_large')
  let envelope; try { envelope = JSON.parse(output) } catch { throw new Error('local_authoring_report_invalid: checker did not emit JSON.') }
  if (constructing) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.format !== 'rulith-authoring-construction-check/1' || envelope.constructorVersion !== '1' || typeof envelope.constructed !== 'boolean' || !Array.isArray(envelope.errors) || !/^sha256:[a-f0-9]{64}$/.test(envelope.constructionDigest)) throw new Error('local_authoring_report_invalid: constructor output must be a rulith-authoring-construction-check/1 envelope.')
    const inputDigest = sha(Buffer.from(inputText, 'utf8'))
    if (envelope.inputDigest !== inputDigest) throw new Error('local_authoring_report_mismatch: constructor output names another input byte stream.')
    const construction_digest = envelope.constructionDigest
    if (!envelope.constructed) {
      if (envelope.draft !== undefined || envelope.report !== undefined || envelope.errors.length === 0) throw new Error('local_authoring_report_invalid: refused construction has an invalid envelope.')
      const summary = JSON.stringify({ constructed: false, errors: envelope.errors.map(row => String(row?.code ?? 'construction_invalid')) })
      const result = found.store.putResult({ name: `authoring-construction-${found.selector}.json`, mediaType: 'application/json', encoding: 'utf8', bytes: Buffer.from(JSON.stringify({ construction_json: inputText, constructorVersion: envelope.constructorVersion, inputDigest, constructionDigest: construction_digest, errors: envelope.errors }), 'utf8') })
      return { result: 'Local deterministic draft construction was refused.', localArtifact: result, ...await reference(found.store), safeInlineGuidance: createConstructionGuidance(envelope.errors), rows: [{ node, task_id: found.selector, construction_digest, proposal_digest: '', constructed: false, compiled: false, examples_total: 0, examples_passed: 0, citations_total: 0, citations_verified: 0, external_actions: 0, report: summary }] }
    }
    if (!envelope.draft || Array.isArray(envelope.draft) || typeof envelope.draft !== 'object' || !envelope.report || Array.isArray(envelope.report) || typeof envelope.report !== 'object' || envelope.errors.length !== 0) throw new Error('local_authoring_report_invalid: successful construction has an invalid envelope.')
  }
  const draft = constructing ? envelope.draft : submitted
  const report = constructing ? envelope.report : envelope
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.format !== 'rulith-authoring-check/1') throw new Error('local_authoring_report_invalid: checker output must be a rulith-authoring-check/1 Report.document.')
  const proposal_digest = proposalDigest(draft)
  if (report.proposalDigest !== proposal_digest) throw new Error('local_authoring_report_mismatch: checker report names another proposal digest.')
  const counts = { examples_total: report.examples?.total ?? 0, examples_passed: report.examples?.passed ?? 0, citations_total: report.citations?.total ?? 0, citations_verified: report.citations?.verified ?? 0, external_actions: Array.isArray(report.externalActions) ? report.externalActions.length : -1 }
  if (![...Object.values(counts)].every(Number.isSafeInteger) || Object.values(counts).some(value => value < 0) || counts.examples_passed > counts.examples_total || counts.citations_verified > counts.citations_total || typeof report.compiled !== 'boolean') throw new Error('local_authoring_report_invalid: checker report has invalid mechanical counts.')
  const summary = JSON.stringify({ compiled: report.compiled, ...counts, errors: authoringDiagnostics(report).errors })
  const construction_digest = constructing ? envelope.constructionDigest : undefined
  const artifact = constructing ? { construction_json: inputText, constructorVersion: envelope.constructorVersion, inputDigest: envelope.inputDigest, constructionDigest: construction_digest, draft, report } : { draft, report }
  const result = found.store.putResult({ name: `${constructing ? 'authoring-construction' : 'authoring-check'}-${found.selector}.json`, mediaType: 'application/json', encoding: 'utf8', bytes: Buffer.from(JSON.stringify(artifact), 'utf8') })
  await recordLocalAuthoringResult(materialRoot, { profile: binding.profile, owner: binding.owner, materialId: found.selector, custodyId: found.record.id, documentDigest: found.record.digest, node, proposalDigest: proposal_digest, resultId: result.id, resultDigest: result.digest, checkedAt: new Date().toISOString() })
  return { result: constructing ? 'Local deterministic draft construction and mechanical check completed.' : 'Local mechanical authoring check completed.', localArtifact: result, ...await reference(found.store), safeInlineGuidance: createAuthoringGuidance(report), rows: [{ node, task_id: found.selector, ...(constructing ? { construction_digest, constructed: true } : {}), proposal_digest, compiled: report.compiled, ...counts, report: summary }] }
  } finally {
    checkerBusy = false
    const root = resolve(materialRoot, 'local-authoring')
    if (dirname(resolve(directory)) === root) await rm(directory, { recursive: true, force: true })
  }
}

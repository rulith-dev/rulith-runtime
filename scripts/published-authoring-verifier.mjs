// SPDX-License-Identifier: Apache-2.0
/** Post-publication checks for the immutable local authoring executables. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAXIMUM_MANIFEST_BYTES = 16 * 1024
const REFERENCE_FORMAT = 'rulith-local-authoring-reference/1'
const PROBE_DOCUMENT = 'Every submitted request is accepted for this release probe.'
const PROBE_CONSTRUCTION = {
  format: 'rulith-authoring-construction/1',
  namespace: 'example.release_probe',
  program: {
    id: 'release_probe', title: 'Published checker release probe',
    summary: 'Mechanical compatibility probe with no customer material.',
    predicates: [
      { name: 'request', as: 'request', args: ['request_id'] },
      { name: 'accepted', as: 'accepted', args: ['request_id'] },
    ],
    imports: [], pins: ['accepted'],
    rules: [{ id: 'accept_request', label: 'Accept a submitted request',
      when: [{ predicate: 'request', args: { request_id: '?request_id' } }],
      then: [{ predicate: 'accepted', args: { request_id: '?request_id' } }] }],
    actions: [], acceptance: [],
  },
  caseContracts: [{
    caseType: 'release_probe', title: 'One release probe request',
    businessKey: { predicate: 'request', arguments: ['request_id'] },
    opening: { predicate: 'request', keyArguments: ['request_id'] },
    acceptance: { predicate: 'accepted', keyArguments: ['request_id'], minimumGroundingFloor: 'attested' },
  }],
  citations: [{ ruleId: 'accept_request', quote: PROBE_DOCUMENT }],
  examples: [{ label: 'submitted request',
    facts: [{ predicate: 'request', args: { request_id: 'probe-1' } }],
    expect: [{ predicate: 'accepted', args: { request_id: 'probe-1' } }],
    forbid: [], forbidPredicates: [] }],
  questions: [], notes: 'Release compatibility only.',
}

function versionedProbeConstruction() {
  const probe = structuredClone(PROBE_CONSTRUCTION)
  for (const predicate of probe.program.predicates) predicate.args.push('input_version')
  probe.program.rules[0].when[0].args.input_version = '?input_version'
  probe.program.rules[0].then[0].args.input_version = '?input_version'
  const contract = probe.caseContracts[0]
  contract.format = 'rulith-case-contract/2'
  contract.businessKey.arguments.push('input_version')
  contract.opening.keyArguments.push('input_version')
  contract.acceptance.keyArguments.push('input_version')
  probe.examples[0].facts[0].args.input_version = 'probe-version-1'
  probe.examples[0].expect[0].args.input_version = 'probe-version-1'
  return probe
}

function manifestProjection(manifest) {
  return {
    format: manifest.format,
    sourceCommit: manifest.sourceCommit,
    referenceFormat: manifest.referenceFormat,
    files: [...manifest.files].sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, bytes, sha256, url }) => ({ name, bytes, sha256, url })),
  }
}

async function boundedBody(response, limit = MAXIMUM_MANIFEST_BYTES) {
  if (!response.body) throw new Error('The published authoring manifest has no body.')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit) {
      await response.body.cancel().catch(() => {})
      throw new Error('The published authoring manifest exceeds its byte limit.')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

export function publishedAuthoringManifestUrl(manifest) {
  return `https://console.rulith.ai/downloads/authoring/${manifest.sourceCommit}/manifest.json`
}

export function defaultAuthoringJavaCommand() {
  const executable = process.platform === 'win32' ? 'java.exe' : 'java'
  const explicit = [process.env.RULITH_AUTHORING_JAVA,
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', executable) : ''].filter(Boolean)
  for (const candidate of explicit) if (existsSync(candidate)) return candidate
  if (process.platform === 'win32') {
    const root = join(process.env.ProgramFiles || 'C:/Program Files', 'Java')
    if (existsSync(root)) {
      const jdks = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^jdk-\d/.test(entry.name))
        .map(entry => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      for (const directory of jdks) {
        const candidate = join(root, directory, 'bin', executable)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return executable
}

function requireCompatibleJava(javaCommand, runJava) {
  const run = runJava(javaCommand, ['-version'], {
    windowsHide: true, encoding: 'utf8', maxBuffer: 128 * 1024, timeout: 10_000,
  })
  if (run.error) throw run.error
  const text = `${run.stderr || ''}\n${run.stdout || ''}`
  const match = /version "(?:1\.)?(\d+)/.exec(text)
  if (run.status !== 0 || !match) throw new Error('The published authoring probe could not confirm the Java runtime version.')
  const major = Number(match[1])
  if (major < 17) throw new Error(`The published authoring probe requires Java 17 or newer; found Java ${major}.`)
  return major
}

/** Compare the public manifest with the pins shipped in the npm archive. */
export async function verifyPublishedAuthoringManifest(manifest, {
  fetchImpl = fetch,
  validate = value => value,
  signal = AbortSignal.timeout(15_000),
} = {}) {
  const pinned = validate(structuredClone(manifest))
  const url = publishedAuthoringManifestUrl(pinned)
  const response = await fetchImpl(url, {
    redirect: 'error', headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' }, signal,
  })
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`The published authoring manifest returned HTTP ${response.status}.`)
  }
  const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (type !== 'application/json') {
    await response.body?.cancel().catch(() => {})
    throw new Error('The published authoring manifest is not JSON.')
  }
  let remote
  try { remote = validate(JSON.parse((await boundedBody(response)).toString('utf8'))) }
  catch (error) { throw new Error(`The published authoring manifest is invalid: ${error.message}`) }
  assert.deepEqual(manifestProjection(remote), manifestProjection(pinned),
    'the public authoring manifest differs from the npm release pins')
  return { url, sourceCommit: pinned.sourceCommit, files: pinned.files.length }
}

/** Download the exact public JARs through the published downloader and execute a tiny constructor check. */
export async function downloadAndProbePublishedAuthoring(manifest, directory, {
  downloadFile,
  validate = value => value,
  fetchImpl = fetch,
  javaCommand = defaultAuthoringJavaCommand(),
  runJava = spawnSync,
  signal = AbortSignal.timeout(30 * 60_000),
} = {}) {
  if (typeof downloadFile !== 'function') throw new Error('The published checker downloader is unavailable.')
  const pinned = validate(structuredClone(manifest))
  if (pinned.referenceFormat !== undefined && pinned.referenceFormat !== REFERENCE_FORMAT)
    throw new Error('The published authoring manifest declares an unsupported reference format.')
  const javaMajor = requireCompatibleJava(javaCommand, runJava)
  await mkdir(directory, { recursive: true })
  let transferred = 0
  for (const file of pinned.files) {
    const bytes = await downloadFile(file, fetchImpl, { signal })
    assert.equal(bytes.length, file.bytes, `${file.name} has the wrong published length`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256,
      `${file.name} has the wrong published digest`)
    await writeFile(join(directory, file.name), bytes, { flag: 'wx' })
    transferred += bytes.length
  }
  const construction = join(directory, 'construction.json')
  const document = join(directory, 'document.txt')
  const output = join(directory, 'result.json')
  if (pinned.referenceFormat === REFERENCE_FORMAT) {
    const referenceOutput = join(directory, 'reference.json')
    const referenceRun = runJava(javaCommand,
      ['-jar', join(directory, 'local-authoring.jar'), '--reference', referenceOutput],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 128 * 1024, timeout: 30_000 })
    if (referenceRun.error) throw referenceRun.error
    if (referenceRun.status !== 0)
      throw new Error(`The published authoring reference probe failed: ${(referenceRun.stderr || referenceRun.stdout).slice(0, 800)}`)
    if ((await stat(referenceOutput)).size > 64 * 1024)
      throw new Error('The published authoring reference exceeds its byte limit.')
    const reference = JSON.parse(await readFile(referenceOutput, 'utf8'))
    if (reference?.format !== pinned.referenceFormat || reference.guidanceOnly !== true
      || !/^sha256:[a-f0-9]{64}$/.test(reference.authoringContractDigest)
      || Object.keys(reference).sort().join(',') !== 'authoringContractDigest,construction,draft,format,guidanceOnly'
      || !['construction', 'draft'].every(key => typeof reference[key] === 'string' && reference[key].trim()))
      throw new Error('The published checker returned an invalid public reference.')
  }
  await writeFile(construction, JSON.stringify(pinned.referenceFormat === REFERENCE_FORMAT
    ? versionedProbeConstruction() : PROBE_CONSTRUCTION), { flag: 'wx' })
  await writeFile(document, PROBE_DOCUMENT, { flag: 'wx' })
  const run = runJava(javaCommand,
    ['-jar', join(directory, 'local-authoring.jar'), '--construct-check', construction, document, output],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 60_000 })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`The published authoring checker probe failed: ${(run.stderr || run.stdout).slice(0, 800)}`)
  const result = JSON.parse(await readFile(output, 'utf8'))
  const outcome = { constructorVersion: result.constructorVersion, report: result.report }
  const diagnostic = JSON.stringify(outcome).slice(0, 1_600)
  assert.equal(result.constructorVersion, '1', diagnostic)
  assert.equal(result.report?.compiled, true, diagnostic)
  assert.equal(result.report?.examples?.total, 1, diagnostic)
  assert.equal(result.report?.examples?.passed, 1, diagnostic)
  assert.equal(result.report?.citations?.total, 1, diagnostic)
  assert.equal(result.report?.citations?.verified, 1, diagnostic)
  if (pinned.referenceFormat === REFERENCE_FORMAT) {
    assert.equal(result.draft?.caseContracts?.[0]?.format, 'rulith-case-contract/2', diagnostic)
    assert.equal(result.draft?.program?.acceptance?.length, 1, diagnostic)
    const accepted = result.draft.caseContracts[0].acceptance.predicate
    const definitions = result.draft.program.vocabulary?.defines?.filter(row => row.id === accepted) ?? []
    assert.equal(definitions.length, 1, diagnostic)
    assert.ok(result.draft.program.pins?.includes(definitions[0].as), diagnostic)
  }
  return { sourceCommit: pinned.sourceCommit, files: pinned.files.length, transferred, javaMajor }
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateAuthoringCheckerManifest } from '../local/authoring-checker.mjs'
import { downloadAndProbePublishedAuthoring, publishedAuthoringManifestUrl,
  verifyPublishedAuthoringManifest } from '../scripts/published-authoring-verifier.mjs'

const fixture = () => {
  const sourceCommit = 'a'.repeat(40)
  return { format: 'rulith-local-authoring-checker/1', sourceCommit, files: [
    { name: 'local-authoring.jar', bytes: 31, sha256: 'b'.repeat(64),
      url: `https://console.rulith.ai/downloads/authoring/${sourceCommit}/local-authoring.jar` },
    { name: 'rule-check.jar', bytes: 29, sha256: 'c'.repeat(64),
      url: `https://console.rulith.ai/downloads/authoring/${sourceCommit}/rule-check.jar` },
  ] }
}
const response = (value, options = {}) => new Response(
  typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
  { status: options.status ?? 200, headers: { 'content-type': options.type ?? 'application/json' } },
)

test('the public authoring manifest must exactly match the npm package pins', async () => {
  const manifest = fixture()
  let request
  const result = await verifyPublishedAuthoringManifest(manifest, { validate: validateAuthoringCheckerManifest,
    fetchImpl: async (url, options) => { request = { url, options }; return response(manifest) } })
  assert.equal(request.url, publishedAuthoringManifestUrl(manifest))
  assert.equal(request.options.redirect, 'error')
  assert.equal(request.options.headers['Accept-Encoding'], 'identity')
  assert.deepEqual(result, { url: request.url, sourceCommit: manifest.sourceCommit, files: 2 })
  const reordered = structuredClone(manifest)
  reordered.files.reverse()
  await verifyPublishedAuthoringManifest(manifest, { validate: validateAuthoringCheckerManifest,
    fetchImpl: async () => response(reordered) })
})

test('a public manifest with changed executable identity is refused', async () => {
  const manifest = fixture()
  const changed = structuredClone(manifest)
  changed.files[0].sha256 = 'd'.repeat(64)
  await assert.rejects(verifyPublishedAuthoringManifest(manifest, { validate: validateAuthoringCheckerManifest,
    fetchImpl: async () => response(changed) }), /differs from the npm release pins/)
  const mixed = structuredClone(manifest)
  mixed.files[0].url = `https://console.rulith.ai/downloads/authoring/${'e'.repeat(40)}/local-authoring.jar`
  await assert.rejects(verifyPublishedAuthoringManifest(manifest, { validate: validateAuthoringCheckerManifest,
    fetchImpl: async () => response(mixed) }), /published authoring manifest is invalid.*invalid executable pin/)
})

test('the published manifest must declare the same reference capability as the npm pin', async () => {
  const modern = { ...fixture(), referenceFormat: 'rulith-local-authoring-reference/1' }
  await verifyPublishedAuthoringManifest(modern, { validate: validateAuthoringCheckerManifest,
    fetchImpl: async () => response(modern) })
  await assert.rejects(verifyPublishedAuthoringManifest(modern, { validate: validateAuthoringCheckerManifest,
    fetchImpl: async () => response(fixture()) }), /differs from the npm release pins/)
  await assert.rejects(verifyPublishedAuthoringManifest(fixture(), { validate: validateAuthoringCheckerManifest,
    fetchImpl: async () => response(modern) }), /differs from the npm release pins/)
})

test('manifest transport is status, type and size bounded', async () => {
  const manifest = fixture()
  const verify = fetchImpl => verifyPublishedAuthoringManifest(manifest,
    { validate: validateAuthoringCheckerManifest, fetchImpl })
  await assert.rejects(verify(async () => response('unavailable', { status: 503 })), /HTTP 503/)
  await assert.rejects(verify(async () => response('{}', { type: 'text/plain' })), /not JSON/)
  await assert.rejects(verify(async () => response(Buffer.alloc(16 * 1024 + 1, 32))), /exceeds its byte limit/)
  await assert.rejects(verify(async () => response('{broken')), /published authoring manifest is invalid/)
})

test('the full probe checks Java before downloading either executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulith-published-java-'))
  let downloads = 0
  try {
    await assert.rejects(downloadAndProbePublishedAuthoring(fixture(), directory, {
      validate: validateAuthoringCheckerManifest,
      downloadFile: async () => { downloads++; return Buffer.alloc(1) },
      javaCommand: process.execPath,
    }), /could not confirm the Java runtime version/)
    assert.equal(downloads, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('only a declared reference capability runs the public reference and explicit pinned /2 probe', async () => {
  const binaries = new Map([['local-authoring.jar', Buffer.from('checker')],
    ['rule-check.jar', Buffer.from('rule checker')]])
  const pinned = fixture()
  for (const file of pinned.files) {
    file.bytes = binaries.get(file.name).length
    file.sha256 = createHash('sha256').update(binaries.get(file.name)).digest('hex')
  }
  const modern = { ...pinned, referenceFormat: 'rulith-local-authoring-reference/1' }
  for (const [manifest, pinnedAcceptance] of [[pinned, true], [modern, true], [modern, false]]) {
    const directory = await mkdtemp(join(tmpdir(), 'rulith-published-reference-'))
    const operations = []
    try {
      const runJava = (_command, args) => {
        if (args[0] === '-version') return { status: 0, stderr: 'openjdk version "25"' }
        const operation = args.find(arg => arg === '--reference' || arg === '--construct-check')
        operations.push(operation)
        if (operation === '--reference') {
          writeFileSync(args.at(-1), JSON.stringify({ format: modern.referenceFormat,
            guidanceOnly: true, authoringContractDigest: 'sha256:' + 'a'.repeat(64),
            construction: 'Use the installed constructor.', draft: 'Use the installed checker.' }))
        } else {
          const construction = JSON.parse(readFileSync(args[args.indexOf('--construct-check') + 1], 'utf8'))
          assert.equal(construction.program.pins[0], 'accepted')
          assert.equal(construction.caseContracts[0].format,
            manifest.referenceFormat ? 'rulith-case-contract/2' : undefined)
          if (manifest.referenceFormat) {
            assert.ok(construction.program.predicates.every(row => row.args.includes('input_version')))
            assert.equal(construction.program.rules[0].when[0].args.input_version, '?input_version')
            assert.equal(construction.program.rules[0].then[0].args.input_version, '?input_version')
            for (const field of ['businessKey', 'opening', 'acceptance'])
              assert.ok((construction.caseContracts[0][field].arguments
                ?? construction.caseContracts[0][field].keyArguments).includes('input_version'))
            assert.equal(construction.examples[0].facts[0].args.input_version, 'probe-version-1')
            assert.equal(construction.examples[0].expect[0].args.input_version, 'probe-version-1')
          }
          writeFileSync(args.at(-1), JSON.stringify({ constructorVersion: '1',
            draft: { caseContracts: [{ format: 'rulith-case-contract/2',
              acceptance: { predicate: 'example.release_probe.accepted' } }],
            program: { pins: [pinnedAcceptance ? 'accepted' : 'request'], acceptance: [{}],
              vocabulary: { defines: [{ id: 'example.release_probe.accepted', as: 'accepted' }] } } },
            report: { compiled: true, examples: { total: 1, passed: 1 },
              citations: { total: 1, verified: 1 } } }))
        }
        return { status: 0, stdout: '', stderr: '' }
      }
      const probe = () => downloadAndProbePublishedAuthoring(manifest, directory, {
        validate: validateAuthoringCheckerManifest, javaCommand: 'test-java', runJava,
        downloadFile: async file => binaries.get(file.name),
      })
      if (pinnedAcceptance) await probe()
      else await assert.rejects(probe(), { code: 'ERR_ASSERTION' })
      assert.deepEqual(operations, manifest.referenceFormat
        ? ['--reference', '--construct-check'] : ['--construct-check'])
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

test('a declared reference format refuses a checker that cannot return that public format', async () => {
  const checker = Buffer.from('checker'), rules = Buffer.from('rules')
  const manifest = { ...fixture(), referenceFormat: 'rulith-local-authoring-reference/1' }
  const binaries = [checker, rules]
  manifest.files.forEach((file, index) => {
    file.bytes = binaries[index].length
    file.sha256 = createHash('sha256').update(binaries[index]).digest('hex')
  })
  const directory = await mkdtemp(join(tmpdir(), 'rulith-published-no-reference-'))
  let constructed = false
  try {
    await assert.rejects(downloadAndProbePublishedAuthoring(manifest, directory, {
      validate: validateAuthoringCheckerManifest, javaCommand: 'test-java',
      downloadFile: async file => binaries[manifest.files.findIndex(row => row.name === file.name)],
      runJava: (_command, args) => {
        if (args[0] === '-version') return { status: 0, stderr: 'openjdk version "25"' }
        if (args.includes('--construct-check')) constructed = true
        if (args.includes('--reference')) writeFileSync(args.at(-1), JSON.stringify({
          format: 'old-reference', guidanceOnly: true,
          authoringContractDigest: 'sha256:' + 'a'.repeat(64), construction: 'guide', draft: 'guide',
        }))
        return { status: 0, stderr: '', stdout: '' }
      },
    }), /invalid public reference/)
    assert.equal(constructed, false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

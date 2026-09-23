import test from 'node:test'
import assert from 'node:assert/strict'
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

#!/usr/bin/env node
/**
 * Download the public Tool manifest and Adapters, then prepare a local verified
 * JSON calculation workspace. Agent capabilities are installed in Console;
 * credentials are never requested or written here.
 *
 * Every downloaded file is checked against `artifact-manifest.json` before anything
 * is written. Two of these files — `rulith-agent.mjs` and `rulith-worker.mjs` — are the
 * runtime itself: this script fetched them over the network and then executed them by
 * name, so whoever could answer `RULITH_DOWNLOAD_ORIGIN` (a typo, a stale mirror, a
 * proxy, a compromised host) decided what ran on the machine holding the Connection key
 * and the model key. The manifest ships in this repository and in the npm package, so
 * the comparison is against bytes the reader already has, not against the same server.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ORIGIN = process.env.RULITH_DOWNLOAD_ORIGIN ?? 'https://console.rulith.ai'
const target = resolve(process.argv[2] ?? 'rulith-verified-calculation')

/** Download path under the origin -> where it lands in the prepared workspace. */
const FILES = new Map([
  ['examples/verified-calculation/read-input.mjs', 'adapters/verified-calculation/read-input.mjs'],
  ['examples/verified-calculation/write-output.mjs', 'adapters/verified-calculation/write-output.mjs'],
  ['examples/verified-calculation/verify-output.mjs', 'adapters/verified-calculation/verify-output.mjs'],
  ['examples/verified-calculation/worker-tools.json', 'worker-tools.json'],
  ['examples/verified-calculation/data/input.json', 'runtime/input.json'],
  ['rulith-agent.mjs', 'rulith-agent.mjs'],
  ['rulith-worker.mjs', 'rulith-worker.mjs'],
])

/**
 * Download path -> the key that names it in `artifact-manifest.json`.
 *
 * A download with no entry here is refused rather than trusted: an unlisted file is
 * one nobody can check, and "we could not verify it" must not be the quiet path.
 */
const MANIFEST_KEYS = new Map([
  ['examples/verified-calculation/read-input.mjs', 'examples/verified-calculation/read-input.mjs'],
  ['examples/verified-calculation/write-output.mjs', 'examples/verified-calculation/write-output.mjs'],
  ['examples/verified-calculation/verify-output.mjs', 'examples/verified-calculation/verify-output.mjs'],
  ['examples/verified-calculation/worker-tools.json', 'examples/verified-calculation/worker-tools.json'],
  ['examples/verified-calculation/data/input.json', 'examples/verified-calculation/data/input.json'],
  ['rulith-agent.mjs', 'agent/rulith-agent.mjs'],
  ['rulith-worker.mjs', 'worker/rulith-worker.mjs'],
])

// The manifest sits at the package root in both shapes this script ships in: a git
// checkout (`examples/verified-calculation/setup.mjs` with `artifact-manifest.json` two
// levels up) and an installed npm package, whose `files` list keeps the same layout.
const MANIFEST_PATH = resolve(import.meta.dirname, '..', '..', 'artifact-manifest.json')

/** A refusal carries its own operator-facing text and always means exit 2. */
class Refusal extends Error {}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Refusal(`Cannot verify downloads: artifact-manifest.json was not found at ${MANIFEST_PATH}.
Run this script from a checkout of rulith-runtime or from an installed \`rulith\` package,
so the expected hashes come from something other than the server being downloaded from.`)
  }
  let parsed
  try { parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) } catch (error) {
    throw new Refusal(`Cannot verify downloads: ${MANIFEST_PATH} is not valid JSON (${error.message}).`)
  }
  if (parsed?.schema !== 'rulith-local-runtime-artifacts/v1' || !parsed.files || typeof parsed.files !== 'object') {
    throw new Refusal(`Cannot verify downloads: ${MANIFEST_PATH} is not a rulith-local-runtime-artifacts/v1 manifest.`)
  }
  return parsed.files
}

/** The manifest records the repository-canonical (LF) text form; checkouts and CDNs may
 *  serve CRLF. Normalize the same way the generator does, then hash. */
const canonicalSha256 = (bytes) =>
  createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex')

function verify(manifestFiles, file, bytes) {
  const key = MANIFEST_KEYS.get(file)
  const expected = key === undefined ? undefined : manifestFiles[key]?.sha256
  if (typeof expected !== 'string' || expected === '') {
    throw new Refusal(`Refusing ${file}: artifact-manifest.json has no hash for it, so nothing can attest to what was downloaded.`)
  }
  const actual = canonicalSha256(bytes)
  if (actual !== expected) {
    throw new Refusal(`Refusing ${file}: it does not match artifact-manifest.json.
  expected sha256 ${expected}
  received sha256 ${actual}  (${bytes.length} bytes from ${ORIGIN})
Nothing was written. Either RULITH_DOWNLOAD_ORIGIN is serving a different release than this
package expects — upgrade or pin one of them — or the download was modified in transit.`)
  }
}

async function main() {
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Refusal(`refusing to overwrite non-empty directory: ${target}`)
  }
  const manifestFiles = loadManifest()

  // Download and verify everything before creating the directory: a refusal must leave
  // no half-prepared workspace that a later run would decline to overwrite.
  const downloads = new Map()
  for (const file of FILES.keys()) {
    const response = await fetch(`${ORIGIN}/${file}`)
    if (!response.ok) throw new Refusal(`download failed (${response.status}): ${ORIGIN}/${file}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    verify(manifestFiles, file, bytes)
    downloads.set(file, bytes)
  }

  mkdirSync(target, { recursive: true })
  for (const [file, contents] of downloads) {
    const path = resolve(target, FILES.get(file))
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }

  console.log(`Verified ${downloads.size} downloads against artifact-manifest.json`)
  console.log(`Prepared ${target}`)
  console.log('The Capability comes from Console. worker-tools.json is the local Adapter Manifest that binds its versioned Tool ids to implementations; credentials stay local.')
  console.log('Next: set your Agent token, model credentials, Connection key, and run the two commands from the Rulith 5-minute quickstart.')
}

// The status is set rather than forced. `process.exit()` tears the loop down while the
// HTTP client's sockets are still closing, and on Windows libuv aborts on that
// (`!(handle->flags & UV_HANDLE_CLOSING)`), so the refusal exit code became a crash code
// and the last lines of output were lost with it.
try {
  await main()
} catch (error) {
  if (!(error instanceof Refusal)) throw error
  console.error(error.message)
  process.exitCode = 2
}

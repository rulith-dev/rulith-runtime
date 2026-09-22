#!/usr/bin/env node
/**
 * Download the public Tool manifest and Adapters, then prepare a local verified
 * JSON calculation workspace and an empty Local configuration. Agent capabilities
 * are installed in Console; credentials are never requested or copied here.
 *
 * Every downloaded file is checked before anything is written. An installed package or
 * checkout supplies `artifact-manifest.json`; the standalone Console download carries
 * the same immutable release pins inside this script. Installed npm packages use
 * their bundled files; the standalone Console script downloads the same assets.
 * Rulith Local itself always comes from npm, with its complete module layout.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ORIGIN = process.env.RULITH_DOWNLOAD_ORIGIN
  ?? 'https://raw.githubusercontent.com/rulith-dev/rulith-runtime/v0.8.9'
const target = resolve(process.argv[2] ?? 'rulith-verified-calculation')

/** Download path under the origin -> where it lands in the prepared workspace. */
const FILES = new Map([
  ['examples/verified-calculation/read-input.mjs', 'adapters/verified-calculation/read-input.mjs'],
  ['examples/verified-calculation/write-output.mjs', 'adapters/verified-calculation/write-output.mjs'],
  ['examples/verified-calculation/verify-output.mjs', 'adapters/verified-calculation/verify-output.mjs'],
  ['examples/verified-calculation/worker-tools.json', 'worker-tools.json'],
  ['examples/verified-calculation/data/input.json', 'runtime/input.json'],
])

// Standalone trust anchor. Keep this deliberately narrow: only the files setup writes.
// Packaging tests compare both success and tamper arms against these exact pins.
const EMBEDDED_MANIFEST_FILES = Object.freeze({
  'examples/verified-calculation/read-input.mjs': { sha256: 'cb3de45655ab25b8da0e7e0d575bf4fdfdaa106ecb4a03b434ae169f30d842c6' },
  'examples/verified-calculation/write-output.mjs': { sha256: '7ff5729d7f01fa3832e5b3328ae22085ab6d696c9b974f61eb2354b655841703' },
  'examples/verified-calculation/verify-output.mjs': { sha256: 'c02d9c6e9b63885fae007db399143d7aba551b9f689be5cd1b2941b776cb7026' },
  'examples/verified-calculation/worker-tools.json': { sha256: 'bc97ed124af5e7d086a4b1ac2bf36f34915d90345ba12471587e5cff91eadb2c' },
  'examples/verified-calculation/data/input.json': { sha256: '28090fb5874cb2d9eaf6df33c8d694ac5da078e53ce70d752045ca4ecb5481ec' },
})

// The manifest sits at the package root in both shapes this script ships in: a git
// checkout (`examples/verified-calculation/setup.mjs` with `artifact-manifest.json` two
// levels up) and an installed npm package, whose `files` list keeps the same layout.
const MANIFEST_PATH = resolve(import.meta.dirname, '..', '..', 'artifact-manifest.json')

/** A refusal carries its own operator-facing text and always means exit 2. */
class Refusal extends Error {}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    return EMBEDDED_MANIFEST_FILES
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
  const expected = manifestFiles[file]?.sha256
  if (typeof expected !== 'string' || expected === '') {
    throw new Refusal(`Refusing ${file}: artifact-manifest.json has no hash for it, so nothing can attest to what was downloaded.`)
  }
  const actual = canonicalSha256(bytes)
  if (actual !== expected) {
    throw new Refusal(`Refusing ${file}: it does not match artifact-manifest.json.
  expected sha256 ${expected}
  received sha256 ${actual}  (${bytes.length} bytes in the supplied asset)
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
  const bundled = process.env.RULITH_DOWNLOAD_ORIGIN === undefined && existsSync(MANIFEST_PATH)
  const downloads = new Map()
  for (const file of FILES.keys()) {
    let bytes
    if (bundled) {
      try { bytes = readFileSync(resolve(import.meta.dirname, '..', '..', file)) }
      catch { throw new Refusal(`Cannot read bundled asset ${file}. Reinstall the complete rulith npm package. Nothing was written.`) }
    }
    else {
      const response = await fetch(`${ORIGIN}/${file}`, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Refusal(`download failed (${response.status}): ${ORIGIN}/${file}`)
      bytes = Buffer.from(await response.arrayBuffer())
    }
    verify(manifestFiles, file, bytes)
    downloads.set(file, bytes)
  }

  mkdirSync(target, { recursive: true })
  for (const [file, contents] of downloads) {
    const path = resolve(target, FILES.get(file))
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }

  // The governed file Source is target/runtime. Config and Adapter code are outside
  // that data directory, so granting access to the demo input does not expose keys.
  writeFileSync(resolve(target, '.gitignore'), '/rulith-local.json\n/runtime/\n')
  const configPath = resolve(target, 'rulith-local.json')
  writeFileSync(configPath, JSON.stringify({
    roles: ['agent', 'worker'],
    agent: { env: {
      RULITH_URL: 'https://api.rulith.ai', RULITH_TOKEN: '',
      RULITH_MODEL_URL: 'http://127.0.0.1:1234', RULITH_MODEL: '<model-id>', RULITH_MODEL_KEY: '',
    } },
    worker: { env: {
      RULITH_WORK_URL: 'https://api.rulith.ai/work', RULITH_CONNECTION: '', RULITH_CONNECTION_KEY: '',
      RULITH_WORKER_ROOT: target, RULITH_TOOLS_FILE: resolve(target, 'worker-tools.json'),
    } },
  }, null, 2) + '\n', { mode: 0o600 })

  console.log(`Verified ${downloads.size} ${bundled ? 'bundled files' : 'downloads'} against artifact-manifest.json`)
  console.log(`Prepared ${target}`)
  console.log(`Edit ${configPath}: enter your Agent token, model settings, and Worker Connection credentials.`)
  console.log(`Source location for Console: ${resolve(target, 'runtime')}`)
  console.log('The Capability comes from Console; run the installed npm Rulith Local with this configuration. See the 5-minute quickstart.')
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

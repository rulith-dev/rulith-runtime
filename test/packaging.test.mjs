// SPDX-License-Identifier: Apache-2.0
/**
 * What a reader can check about the bytes they were given.
 *
 * Two claims in this repository are only worth what their enforcement is worth. The
 * manifest claims each shipped file hashes to a recorded value — but it hashes LF text
 * while `npm pack` ships working-tree bytes, so a release cut on a CRLF checkout ships
 * a tarball that fails its own manifest (the registry copy of 0.4.0 is CRLF throughout).
 * And `setup.mjs` downloaded `rulith-agent.mjs` and `rulith-worker.mjs` over the network
 * and wrote them to disk to be executed, without comparing them to anything at all.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

import { carriageReturnOffenders, teaching } from '../scripts/check-line-endings.mjs'

const ROOT = resolve(import.meta.dirname, '..')

// ── The manifest and the bytes that ship ─────────────────────────────────────

/**
 * Build a small tree that looks like a package: a manifest plus the files it lists.
 *
 * The subject of these arms is the rule, not the checkout they run in. A test that
 * asserted "the working tree I am in is LF" would fail for any contributor whose clone
 * predates .gitattributes, and it would be asserting the state of a machine rather than
 * the behaviour of the check. The pack step is where the checkout itself is judged, and
 * `npm run check` — which prepack runs — is where that judgement is wired up.
 */
function packageTree({ crlf }) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-crlf-'))
  const manifest = { schema: 'rulith-local-runtime-artifacts/v1', files: { 'a/one.mjs': { sha256: 'x' }, 'b/two.mjs': { sha256: 'y' } } }
  writeFileSync(join(dir, 'artifact-manifest.json'), JSON.stringify(manifest))
  mkdirSync(join(dir, 'a')); mkdirSync(join(dir, 'b'))
  writeFileSync(join(dir, 'a', 'one.mjs'), 'const a = 1\nconst b = 2\n')
  writeFileSync(join(dir, 'b', 'two.mjs'), crlf ? 'const c = 3\r\nconst d = 4\r\n' : 'const c = 3\nconst d = 4\n')
  return dir
}

test('the line-ending check finds a CR file and explains how to fix the checkout', () => {
  const dir = packageTree({ crlf: true })
  try {
    const offenders = carriageReturnOffenders(dir)
    assert.deepEqual(offenders, ['b/two.mjs'])
    const message = teaching(offenders)
    assert.match(message, /Refusing to pack/)
    assert.match(message, /git config core\.autocrlf false/)
    assert.match(message, /does not match\s+its own manifest/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the line-ending check passes an all-LF tree (calibration)', () => {
  // Without this arm a check that reported every file would satisfy the arm above.
  const dir = packageTree({ crlf: false })
  try { assert.deepEqual(carriageReturnOffenders(dir), []) } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the check refuses to pass vacuously when the manifest lists nothing', () => {
  // The shrunken-denominator failure: an empty list makes `every file is LF` true and
  // the guard silently stops guarding.
  const dir = mkdtempSync(join(tmpdir(), 'rulith-crlf-empty-'))
  try {
    writeFileSync(join(dir, 'artifact-manifest.json'), JSON.stringify({ schema: 'rulith-local-runtime-artifacts/v1', files: {} }))
    assert.throws(() => carriageReturnOffenders(dir), /lists no files; the check would pass vacuously/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('running the check as a command exits 1 with teaching on a CR tree and 0 on an LF tree', () => {
  for (const [crlf, status] of [[true, 1], [false, 0]]) {
    const dir = packageTree({ crlf })
    try {
      const run = spawnSync(process.execPath, ['scripts/check-line-endings.mjs', dir], { cwd: ROOT, encoding: 'utf8' })
      assert.equal(run.status, status, `crlf=${crlf}: ${run.stdout}\n${run.stderr}`)
      if (crlf) {
        assert.match(run.stderr, /Refusing to pack: 1 manifest-listed file\(s\) contain CR bytes/)
        assert.match(run.stderr, /b\/two\.mjs/)
      } else {
        assert.match(run.stdout, /all manifest-listed files are LF/)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('the check is wired into the script npm runs before packing', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.match(pkg.scripts.check, /node scripts\/check-line-endings\.mjs/)
  assert.match(pkg.scripts.prepack, /npm run check/)
  const attributes = readFileSync(join(ROOT, '.gitattributes'), 'utf8')
  assert.match(attributes, /^\* text=auto eol=lf$/m, 'a fresh clone must already be LF, or the check is only a wall')
})

// ── setup.mjs verifies what it downloads ─────────────────────────────────────

const SERVED = new Map([
  ['examples/verified-calculation/read-input.mjs', 'examples/verified-calculation/read-input.mjs'],
  ['examples/verified-calculation/write-output.mjs', 'examples/verified-calculation/write-output.mjs'],
  ['examples/verified-calculation/verify-output.mjs', 'examples/verified-calculation/verify-output.mjs'],
  ['examples/verified-calculation/worker-tools.json', 'examples/verified-calculation/worker-tools.json'],
  ['examples/verified-calculation/data/input.json', 'examples/verified-calculation/data/input.json'],
  ['rulith-agent.mjs', 'agent/rulith-agent.mjs'],
  ['rulith-worker.mjs', 'worker/rulith-worker.mjs'],
])

/** Run a child to completion without blocking this process: the download origin below
 *  is served from this event loop, so `spawnSync` would deadlock against it. */
function runChild(args, options) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', fail)
    child.on('close', (status) => done({ status, stdout, stderr }))
  })
}

/** Serve this checkout as if it were the download origin, optionally tampering with one file. */
async function withOrigin({ tamper }, run) {
  const requested = []
  const server = createServer((request, response) => {
    const path = String(request.url ?? '').replace(/^\//, '')
    requested.push(path)
    const source = SERVED.get(path)
    if (source === undefined) { response.writeHead(404); return void response.end('not found') }
    let bytes = readFileSync(join(ROOT, source))
    if (tamper === path) bytes = Buffer.concat([bytes, Buffer.from('\n// added on the way through\n')])
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end(bytes)
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  const dir = mkdtempSync(join(tmpdir(), 'rulith-setup-'))
  const target = join(dir, 'workspace')
  try {
    const result = await runChild(['examples/verified-calculation/setup.mjs', target], {
      cwd: ROOT,
      env: { ...process.env, RULITH_DOWNLOAD_ORIGIN: `http://127.0.0.1:${server.address().port}` },
    })
    await run({ result, target, requested })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await new Promise((closed) => server.close(closed))
    server.closeAllConnections()
  }
}

test('setup.mjs writes the workspace when every download matches the manifest (calibration)', async () => {
  await withOrigin({}, ({ result, target }) => {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /Verified 7 downloads against artifact-manifest\.json/)
    assert.equal(existsSync(join(target, 'rulith-agent.mjs')), true)
    assert.equal(existsSync(join(target, 'rulith-worker.mjs')), true)
    assert.equal(existsSync(join(target, 'worker-tools.json')), true)
    assert.equal(existsSync(join(target, 'adapters', 'verified-calculation', 'read-input.mjs')), true)
    // The bytes written are the bytes checked.
    const manifest = JSON.parse(readFileSync(join(ROOT, 'artifact-manifest.json'), 'utf8'))
    const written = readFileSync(join(target, 'rulith-worker.mjs'), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(createHash('sha256').update(written, 'utf8').digest('hex'), manifest.files['worker/rulith-worker.mjs'].sha256)
  })
})

// Both runtime files matter, and so does an example Adapter: a tampered `read-input.mjs`
// runs as a `run` Adapter on the Worker machine with the Source root in its environment.
for (const target of ['rulith-worker.mjs', 'rulith-agent.mjs', 'examples/verified-calculation/read-input.mjs']) {
  test(`setup.mjs refuses tampered ${target} and writes nothing`, async () => {
    await withOrigin({ tamper: target }, ({ result, target: dir }) => {
      assert.equal(result.status, 2, `tampered bytes were accepted:\n${result.stdout}\n${result.stderr}`)
      assert.match(result.stderr, new RegExp(`Refusing ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
      assert.match(result.stderr, /does not match artifact-manifest\.json/)
      assert.match(result.stderr, /expected sha256 [0-9a-f]{64}/)
      assert.match(result.stderr, /Nothing was written/)
      assert.equal(existsSync(dir) && readdirSync(dir).length > 0, false,
        'a refusal must leave no partially prepared workspace behind')
    })
  })
}

test('setup.mjs refuses to run at all when the manifest is not beside it', () => {
  // The manifest is the trust anchor. If it is missing, "verified" would silently become
  // "downloaded", which is the state this whole change exists to end.
  const dir = mkdtempSync(join(tmpdir(), 'rulith-setup-orphan-'))
  try {
    const nested = join(dir, 'examples', 'verified-calculation')
    mkdirSync(nested, { recursive: true })
    const orphan = join(nested, 'setup.mjs')
    writeFileSync(orphan, readFileSync(join(ROOT, 'examples', 'verified-calculation', 'setup.mjs')))
    const result = spawnSync(process.execPath, [orphan, join(dir, 'workspace')], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, RULITH_DOWNLOAD_ORIGIN: 'http://127.0.0.1:1' },
    })
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, /artifact-manifest\.json was not found/)
    assert.equal(existsSync(join(dir, 'workspace')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the npm package ships the manifest where setup.mjs looks for it', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('artifact-manifest.json'),
    'setup.mjs resolves ../../artifact-manifest.json; dropping it from files makes every install fail closed')
  assert.ok(pkg.files.includes('examples/verified-calculation/setup.mjs'))
  const setup = readFileSync(join(ROOT, 'examples', 'verified-calculation', 'setup.mjs'), 'utf8')
  assert.match(setup, /resolve\(import\.meta\.dirname, '\.\.', '\.\.', 'artifact-manifest\.json'\)/)
})

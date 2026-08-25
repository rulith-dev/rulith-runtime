import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

import { orderWork } from '../worker/rulith-worker.mjs'
import { applyEnvEdit, maskEnv, stationPage } from '../station/rulith-station.mjs'

const ROOT = resolve(import.meta.dirname, '..')

test('artifact manifest matches every downloadable local file', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'artifact-manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 'rulith-local-runtime-artifacts/v1')
  assert.ok(Object.keys(manifest.files).length >= 16)
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const canonical = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
    const actual = createHash('sha256').update(canonical, 'utf8').digest('hex')
    assert.equal(actual, entry.sha256, `${rel} drifted from artifact-manifest.json`)
  }
})

test('worker prioritizes world-changing actions while preserving stable order', () => {
  const rows = [
    { workType: 'verification', id: 'v1' },
    { workType: 'action', id: 'a1' },
    { workType: 'action', id: 'a2' },
    { workType: 'evidence', id: 'e1' },
  ]
  assert.deepEqual(orderWork(rows).map((x) => x.id), ['a1', 'a2', 'v1', 'e1'])
})

test('station masks secrets and never persists the mask as a credential', () => {
  const prior = { RULITH_TOKEN: 'token-123456', RULITH_URL: 'https://api.rulith.com' }
  const view = maskEnv(prior)
  assert.equal(view.RULITH_TOKEN, '••••3456')
  assert.deepEqual(applyEnvEdit(prior, view), prior)
})

test('agent help is available before credentials and documents the UI port', () => {
  const run = spawnSync(process.execPath, ['agent/rulith-agent.mjs', '--help'], {
    cwd: ROOT,
    env: { ...process.env, RULITH_TOKEN: '', RULITH_MODEL_KEY: '', ANTHROPIC_API_KEY: '' },
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /RULITH_UI_PORT/)
  assert.match(run.stdout, /--case-boards/)
  assert.doesNotMatch(run.stderr, /missing/i)
})

test('worker rejects bad credentials before claiming to be online and exits cleanly', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ accepted: false, teaching: 'credential rejected' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const child = spawn(process.execPath, ['worker/rulith-worker.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      RULITH_WORK_URL: `http://127.0.0.1:${port}/work`,
      RULITH_CHANNEL: 'test-channel',
      RULITH_CHANNEL_KEY: 'wrong-key',
      RULITH_TOOLS_FILE: join(ROOT, 'test', 'does-not-exist.json'),
      RULITH_SOURCES_FILE: join(ROOT, 'test', 'does-not-exist.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  const code = await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('worker did not exit after credential rejection')), 5000)),
  ]).finally(() => server.close())

  assert.equal(code, 3, stderr)
  assert.doesNotMatch(stdout, /online/)
  assert.match(stderr, /Connection credential rejected/)
  assert.doesNotMatch(stderr, /edge preserves|Assertion failed|UV_HANDLE_CLOSING/)
})

test('local recipe assembler fingerprints every package without overriding an explicit pin', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.match(source, /function fingerprintRecipePacks\(packs\)/)
  assert.match(source, /createHash\('sha256'\)\.update\(JSON\.stringify\(entry\.pack\)\)/)
  assert.match(source, /digest: `sha256:\$\{digest\}`/)
  assert.match(source, /digest must be a non-empty string when supplied/)
})

test('local recipe identity uses the same package-ledger digest as cloud audit', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.match(source, /function recipeDigestOver\(id, packs\)/)
  assert.match(source, /JSON\.stringify\(\{ id, packs: pairs \}\)/)
  assert.match(source, /digest: recipeDigestOver\(String\(j\.id \?\? agentName\), packs\)/)
  assert.doesNotMatch(source, /JSON\.stringify\(\{ packs, seed \}\)/)
})

test('agent lifecycle events shown to users use the English product vocabulary', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.match(source, /\[Verification\]/)
  assert.match(source, /Case "\$\{ctx\.board\}" sealed/)
  assert.doesNotMatch(source, /notes\.push\(`\[放电/)
  assert.doesNotMatch(source, /log\(`◎ 案卷/)
})

test('station presents the public local workflow in English', () => {
  const visible = stationPage.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
  assert.match(stationPage, /Local control room/)
  assert.match(stationPage, /Maximum concurrent cases/)
  assert.match(stationPage, /Worker activity/)
  assert.match(stationPage, /Board: action/)
  assert.doesNotMatch(visible, /本地站|智能体（脑）|手的流水|核验通过|还没开单/)
})

test('verified calculation example renders valid local files without credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-runtime-'))
  const example = join(ROOT, 'examples', 'verified-calculation')
  try {
    const run = spawnSync(process.execPath, ['prepare-runtime.mjs', 'public-test-channel'], {
      cwd: example,
      env: { ...process.env, RULITH_CALC_RUNTIME: dir },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr || run.stdout)
    const recipe = JSON.parse(readFileSync(join(dir, 'recipe.json'), 'utf8'))
    const tools = JSON.parse(readFileSync(join(dir, 'rulith-tools.json'), 'utf8'))
    assert.match(JSON.stringify(recipe), /public-test-channel/)
    assert.ok(Object.keys(tools).length >= 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('public runtime contains no private deployment addresses or credential material', () => {
  for (const rel of [
    'agent/rulith-agent.mjs',
    'worker/rulith-worker.mjs',
    'station/rulith-station.mjs',
  ]) {
    const source = readFileSync(join(ROOT, rel), 'utf8')
    assert.doesNotMatch(source, /-----BEGIN [A-Z ]*PRIVATE KEY-----/)
    assert.doesNotMatch(source, /(?:192\.168\.|43\.161\.|49\.51\.)/)
    assert.doesNotMatch(source, /michaltina|victor shaw/i)
  }
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { orderWork } from '../worker/rulith-worker.mjs'
import { applyEnvEdit, maskEnv } from '../station/rulith-station.mjs'

const ROOT = resolve(import.meta.dirname, '..')

test('artifact manifest matches every downloadable local file', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'artifact-manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 'rulith-local-runtime-artifacts/v1')
  assert.ok(Object.keys(manifest.files).length >= 16)
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const actual = createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex')
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

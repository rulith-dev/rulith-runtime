// SPDX-License-Identifier: Apache-2.0
/**
 * The calculation sample the setup wizard prepares must advertise the contracts of the
 * installed Release.
 *
 * The authority for a Tool contract is the installed Capability Release: kind, params, returns
 * and the Source types the Tool accepts. A Worker Tool Manifest only restates it, and the
 * Gateway compares the restatement exactly, reading an omitted params as {} and an omitted
 * returns as [] (rulith-java `SourceToolRequirements.abiField`). The wizard up to 0.9.0 copied
 * a manifest that stated none of the three and patched in `kind` alone, so the Worker
 * advertised `params: {}` and `returns: []` for all three Tools and the Gateway found none of
 * them compatible with Verified Calculation 1.0.2. No arm compared the prepared manifest with
 * the Release, so the defect only showed against a live Gateway.
 *
 * These arms run the wizard's own `example` step through the local host, start the real Worker
 * on what it wrote, and compare its Poll advertisement with a pinned copy of the 1.0.2
 * contracts. They also pin the manifest bytes to the file the Gateway serves to the Console
 * Quickstart, so the wizard, `setup.mjs` and the Quickstart produce the same Tool pins.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createLocalHost, defaultLocalConfig } from '../local/rulith-local.mjs'
import { sampleToolManifest } from '../local/setup-service.mjs'
import { HOLD, driveWorker } from './support/worker-harness.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const PACKAGED = join(ROOT, 'examples', 'verified-calculation', 'worker-tools.json')
const canonicalSha256 = (bytes) => createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex')

/**
 * The Verified Calculation Worker manifest the Gateway serves at
 * `/examples/verified-calculation/worker-tools.json`, as LF text: rulith-java 549eaa5,
 * `gateway/src/main/resources/examples/verified-calculation/worker-tools.json`.
 */
const GATEWAY_SERVED_SHA256 = 'e173b13818e54b7f9b07a9ad70fce2a4a7b6426abc514780efe41e080e14d244'

/**
 * The three Tool contracts of the official Verified Calculation 1.0.2 Release, as the Gateway
 * projects them for the `verified-calculation-local` Source after installing it (rulith-java
 * 549eaa5, `scripts/checks/console-source-requirements.test.mjs`). The Release states no
 * `returns` for write_output@1: that Tool attests nothing. None of the three states an `entry`
 * or a `fence`, the two other fields the Gateway compares when a contract states them.
 */
const OFFICIAL_1_0_2 = Object.freeze({
  'rulith.verified_calculation.read_input@1': {
    kind: 'read', sourceTypes: ['file'], params: {},
    returns: [{ predicate: 'rulith.verified_calculation.calculation_input', args: { node: '$node', job_id: '$job_id',
      unit_price_cents: '$unit_price_cents', quantity: '$quantity', shipping_cents: '$shipping_cents' } }],
  },
  'rulith.verified_calculation.write_output@1': {
    kind: 'write', sourceTypes: ['file'],
    params: { node: 'string', job_id: 'string', unit_price_cents: 'number', quantity: 'number',
      shipping_cents: 'number', subtotal_cents: 'number', total_cents: 'number' },
  },
  'rulith.verified_calculation.verify_output@1': {
    kind: 'read', sourceTypes: ['file'],
    params: { node: 'string', job_id: 'string', subtotal_cents: 'number', total_cents: 'number', status: 'string' },
    returns: [{ predicate: 'rulith.verified_calculation.output_record', args: { node: '$node', job_id: '$job_id',
      subtotal_cents: '$subtotal_cents', total_cents: '$total_cents', status: '$status' } }],
  },
})

/** One ABI field as the Gateway reads it: only an omitted params or returns is filled in. */
const abi = (contract, field) => Object.hasOwn(contract, field) ? contract[field]
  : field === 'params' ? {} : field === 'returns' ? [] : undefined

/** The Gateway's compatibility check for one advertised descriptor, field by field. */
function assertCompatible(id, contract, descriptor) {
  assert.ok(descriptor, `${id} is not advertised`)
  assert.match(descriptor.digest, /^[0-9a-f]{64}$/, `${id} has no valid implementation digest`)
  for (const field of ['kind', 'params', 'returns']) {
    assert.deepEqual(abi(descriptor, field), abi(contract, field),
      `${id}: the advertised Tool ${field} differs from the installed 1.0.2 contract`)
  }
  assert.deepEqual([...descriptor.sourceTypes].sort(), [...contract.sourceTypes].sort(),
    `${id}: the advertised Tool Source types differ from the installed 1.0.2 contract`)
}

/** Run the wizard's `example` step through the local host, against a Console that has the Capability installed. */
async function prepareSample(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-setup-sample-'))
  const connection = 'conn-setup-sample', connectionKey = 'setup-sample-connection-key'
  const cloud = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/local-setup/context' && request.headers['x-rulith-connection'] === connection
        && request.headers['x-rulith-connection-key'] === connectionKey) {
      return void response.end(JSON.stringify({ agentId: 'agent-setup-sample', agentName: 'Setup sample', connectionId: connection,
        sources: [{ name: 'verified-calculation-local', type: 'file' }] }))
    }
    response.writeHead(404)
    response.end('{}')
  })
  await new Promise((ready) => cloud.listen(0, '127.0.0.1', ready))
  const configFile = join(dir, 'local.json'), config = defaultLocalConfig()
  config.worker.env = { ...config.worker.env, RULITH_WORK_URL: `http://127.0.0.1:${cloud.address().port}/work`,
    RULITH_CONNECTION: connection, RULITH_CONNECTION_KEY: connectionKey }
  writeFileSync(configFile, JSON.stringify(config))
  const host = createLocalHost({ configFile, config, roles: config.roles, port: 0, autoStart: false })
  await host.listen()
  t.after(async () => {
    await host.close()
    await new Promise((closed) => cloud.close(closed))
    rmSync(dir, { recursive: true, force: true })
  })
  const target = join(dir, 'sample')
  const response = await fetch(`http://127.0.0.1:${host.port}/setup/example`, {
    method: 'POST', headers: { 'x-rulith-local': host.key, 'content-type': 'application/json' },
    body: JSON.stringify({ directory: target }),
  })
  return { target, configFile, status: response.status, body: await response.json() }
}

test('the pinned 1.0.2 contracts are the ones the official Verified Calculation recipe declares', () => {
  // The vendored recipe is byte-identical to the one the Gateway compiles into the official
  // Release (rulith-java 549eaa5, gateway/src/main/resources/examples/verified-calculation/recipe.json).
  // It names predicates by their local alias; the Release carries the full ids.
  const recipe = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'verified-calculation-recipe.json'), 'utf8'))
  assert.equal(recipe.capability.version, '1.0.2')
  const predicates = Object.fromEntries(recipe.program.vocabulary.defines.map((row) => [row.as, row.id]))
  const declared = Object.fromEntries(recipe.program.actions.map(({ execution }) => [execution.tool, {
    kind: execution.kind, sourceTypes: execution.sourceTypes,
    ...(execution.params === undefined ? {} : { params: execution.params }),
    ...(execution.returns === undefined ? {} : {
      returns: execution.returns.map((row) => ({ predicate: predicates[row.predicate] ?? row.predicate, args: row.args })),
    }),
  }]))
  assert.deepEqual(declared, OFFICIAL_1_0_2)
})

test('the wizard prepares a calculation sample whose Worker advertises exactly the installed 1.0.2 contracts', async (t) => {
  const packaged = readFileSync(PACKAGED)
  assert.equal(canonicalSha256(packaged), GATEWAY_SERVED_SHA256,
    'the packaged sample manifest is not the one the Gateway serves to the Console Quickstart')
  const artifacts = JSON.parse(readFileSync(join(ROOT, 'artifact-manifest.json'), 'utf8'))
  assert.equal(artifacts.files['examples/verified-calculation/worker-tools.json'].sha256, GATEWAY_SERVED_SHA256,
    'setup.mjs verifies its download against a different manifest than the one the Gateway serves')

  const prepared = await prepareSample(t)
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body))
  assert.equal(prepared.body.directory, resolve(prepared.target))
  const written = readFileSync(join(prepared.target, 'worker-tools.json'))
  assert.ok(written.equals(packaged), 'the wizard rewrote the packaged manifest instead of copying it')
  assert.equal(canonicalSha256(written), GATEWAY_SERVED_SHA256)
  const saved = JSON.parse(readFileSync(prepared.configFile, 'utf8')).worker.env
  assert.equal(saved.RULITH_WORKER_ROOT, resolve(prepared.target))
  assert.equal(saved.RULITH_TOOLS_FILE, join(resolve(prepared.target), 'worker-tools.json'))

  // The real Worker, started on exactly what the wizard configured, and its first Poll.
  const run = await driveWorker({
    env: { RULITH_WORKER_ROOT: saved.RULITH_WORKER_ROOT, RULITH_TOOLS_FILE: saved.RULITH_TOOLS_FILE },
    reply: (operation) => operation.kind === 'Poll' ? HOLD : undefined,
    done: (seen, _output, state) => seen.some((entry) => entry.operation.kind === 'Poll') || state.exited,
  })
  assert.equal(run.timedOut, false, run.output)
  const poll = run.seen.find((entry) => entry.operation.kind === 'Poll')?.operation
  assert.ok(poll, `the Worker never polled:\n${run.output}`)
  const advertised = Object.fromEntries(poll.tools.filter((tool) => Object.hasOwn(OFFICIAL_1_0_2, tool.id)).map((tool) => [tool.id, tool]))
  assert.deepEqual(Object.keys(advertised).sort(), Object.keys(OFFICIAL_1_0_2).sort())
  for (const [id, contract] of Object.entries(OFFICIAL_1_0_2)) assertCompatible(id, contract, advertised[id])
})

test('the wizard refuses a sample manifest that does not state every contract, and passes the packaged one through', () => {
  const packaged = readFileSync(PACKAGED)
  assert.equal(sampleToolManifest(packaged), packaged, 'the packaged bytes must be written as they are')
  const full = JSON.parse(packaged.toString('utf8'))
  const refusal = (mutate) => {
    const manifest = structuredClone(full)
    mutate(manifest)
    return () => sampleToolManifest(Buffer.from(JSON.stringify(manifest)))
  }
  // What the 0.9.0 wizard wrote: kind patched in, params and returns left out.
  assert.throws(refusal((manifest) => { for (const tool of Object.values(manifest.tools)) { delete tool.params; delete tool.returns } }),
    /does not state kind, params and returns for rulith\.verified_calculation\.read_input@1, rulith\.verified_calculation\.write_output@1, rulith\.verified_calculation\.verify_output@1,.*nothing was written/)
  // An empty returns is a declaration, not an omission: leaving it out is refused too.
  assert.throws(refusal((manifest) => { delete manifest.tools['rulith.verified_calculation.write_output@1'].returns }),
    /for rulith\.verified_calculation\.write_output@1, so/)
  assert.throws(refusal((manifest) => { delete manifest.tools['rulith.verified_calculation.verify_output@1'].kind }),
    /for rulith\.verified_calculation\.verify_output@1, so/)
  assert.throws(refusal((manifest) => { manifest.tools['rulith.verified_calculation.read_input@1'].params = [] }),
    /for rulith\.verified_calculation\.read_input@1, so/)
  assert.throws(refusal((manifest) => { delete manifest.tools['rulith.verified_calculation.read_input@1'] }),
    /for rulith\.verified_calculation\.read_input@1, so/)
  assert.throws(() => sampleToolManifest(Buffer.from('not json')), /does not state kind, params and returns/)
})

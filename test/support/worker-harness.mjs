// SPDX-License-Identifier: Apache-2.0
/**
 * Run the real Worker binary against a scripted Work endpoint.
 *
 * Shared by the Case-revision arms and the receipt-ladder arms because both ask the
 * same question — did the hand move, and did its receipt land — and both must answer it
 * from outside the Worker: the endpoint's request log and a file the Adapter appends
 * to. A Worker cannot fake an appended line, and it cannot un-write one.
 */
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import { canonicalJson, executionDigest, toolDigest } from '../../worker/rulith-worker.mjs'

export const ROOT = resolve(import.meta.dirname, '..', '..')
const contractBundle = JSON.parse(readFileSync(join(ROOT, 'protocol/worker-contract.json'), 'utf8'))
const contractFixture = JSON.parse(contractBundle.files['tests/conformance/fixtures/worker-protocol-v2.json'].content)
export function artifactWorkFields(sourceRecordId) {
  const permission = contractFixture.sourcePermissions.rows.find(row => row.id === (sourceRecordId === '' ? 'source-free-result' : 'granted-off-machine')).decision
  return { sourceUpload: { ...permission, sourceRecordId }, artifactPolicy: { ...contractFixture.artifactPolicies.rows[0].policy } }
}

/** Do not answer this request at all. Used to park the Worker on an idle long poll so it
 *  stops hammering the model Board once the scenario under test has played out. */
export const HOLD = Symbol('hold the response open')

/** Destroy the socket without answering: the connection-reset shape of a lost receipt,
 *  which reaches the Worker as a thrown `fetch` rather than as an unreadable response. */
export const RESET = Symbol('destroy the connection')

/**
 * End-of-flow markers, one per work type — the Worker's own last line for that item.
 *
 * Waiting for the *request* to arrive instead was a real defect in this file: the receipt
 * request reaches the model Board before the Worker has read the response and printed the
 * outcome, so killing the child at that moment lost the line and `receipt committed` failed
 * about a third of the time — on a correct Worker. An intermittent red that names the fix's
 * own subject is worse than no test: it reads exactly like the defect coming back.
 *
 * Each marker matches the committed and the refused wording, so a regression fails an
 * assertion rather than timing out.
 */
export const DONE = {
  action: /\| receipt (?:not )?committed/,
  verification: /Work report .*(?:accepted|rejected) by Board/,
  evidence: /Material report /,
  review: /Verdict /,
}

export const BOARD = 'board-p2'
export const CONNECTION = 'conn-p2'
export const CONNECTION_KEY = 'key-p2'
export const INVOCATION = 'inv_p2'
export const WORKER_GENERATION = 7

/**
 * Sign an execution grant the way the deployed Gateway signs one.
 *
 * The format is not invented here: `gateway/src/execution-grant.ts` emits
 * `base64url(JSON.stringify(grant)) . base64url(HMAC-SHA256(connectionKey, payload))`, and
 * that is the only production format there is. The candidate Gateway signs the committed v2
 * document; the retired v1 shape — `caseId`, no `workerGeneration` — is still producible here
 * so the arms can check that it is *refused* rather than assert it in prose.
 */
export function signGrant(grant, connectionKey = CONNECTION_KEY) {
  const payload = Buffer.from(JSON.stringify(grant)).toString('base64url')
  return `${payload}.${createHmac('sha256', connectionKey).update(payload).digest('base64url')}`
}

/**
 * The v2 grant for one work row, digesting exactly the bytes the row carries.
 *
 * `work` is the invocation and `tool` is the Action — read from nowhere else, because the row
 * carries them nowhere else. A helper that fell back to `row.invocationId` would sign the
 * shadow spelling the Worker is supposed to refuse, and the arm would pass for the wrong
 * reason.
 */
export function grantFor(row, { workerId, workerGeneration = WORKER_GENERATION, ...overrides } = {}) {
  return {
    version: 2,
    boardId: row.boardId,
    invocationId: row.work,
    actionId: row.tool,
    toolContractId: row.toolContractId,
    sourceRecordId: row.sourceRecordId,
    connectionId: CONNECTION,
    workerId,
    workerGeneration,
    adapterDigest: `sha256:${row.toolDigest}`,
    requestDigest: executionDigest({
      version: 'rulith-execution-request/2',
      boardId: row.boardId,
      invocationId: row.work,
      actionId: row.tool,
      toolContractId: row.toolContractId,
      sourceRecordId: row.sourceRecordId,
      args: row.args,
      target: row.target,
      toolSpec: row.toolSpec,
    }),
    ...overrides,
  }
}
// `canonicalJson` is re-exported so an arm can show which bytes a digest covers when it
// disagrees with the one the Worker computed.
export { canonicalJson, executionDigest, toolDigest }

/**
 * An active lease, as the contract defines one, anchored on the endpoint's own clock.
 *
 * `serverTime` is now and `expiresAt` is a minute later, so the window is real; the
 * heartbeat is strictly shorter than the window, which is the condition the shape alone
 * cannot state. A scenario that wants a lease the Worker must refuse says which field it
 * is spoiling.
 */
export function activeLease({ workerId, workerGeneration = 7, windowMs = 60_000, heartbeatAfterMs = 10_000, ...overrides } = {}) {
  const serverTime = new Date().toISOString()
  return {
    workerId,
    workerGeneration,
    serverTime,
    expiresAt: new Date(Date.parse(serverTime) + windowMs).toISOString(),
    heartbeatAfterMs,
    ...overrides,
  }
}

/**
 * A named fake `/work` endpoint that speaks the v2 hop.
 *
 * The deployed Gateway does not serve the lease, renewal or release operations yet, so the
 * client's behaviour is checked against this fake and the dependency is stated rather than
 * papered over with a compatibility path in the Worker. It admits a `Poll` the way the
 * committed admission rule does — first caller takes the line, a stated generation is
 * checked against the one held, a stated generation with no valid lease is refused by name —
 * accepts `RenewLease` for the current holder only, and acknowledges `ReleaseLease` by
 * returning no lease at all.
 */
export function leasingGateway({ generation = 7, refuseRenewAfter, onWork } = {}) {
  const state = { holder: undefined, generation, renewals: 0, released: false, manifests: [] }
  return (operation, seen) => {
    if (operation.kind === 'Poll') {
      state.manifests.push(operation.tools)
      if (state.holder === undefined) {
        // Admission comes first and completely: a poll that states a generation with no
        // valid lease has nothing current to be checked against, and is told so by name.
        if (operation.workerGeneration !== undefined) {
          return { body: { accepted: false, errorCode: 'worker_lease_expired',
            teaching: 'No lease is currently valid for this Connection; acquire one without stating a generation.' } }
        }
        state.holder = operation.workerId
      }
      if (operation.workerId !== state.holder) {
        return { body: { accepted: false, errorCode: 'worker_lease_held',
          teaching: 'Another instance holds this Connection.' } }
      }
      if (operation.workerGeneration !== undefined && operation.workerGeneration !== state.generation) {
        return { body: { accepted: false, errorCode: 'worker_lease_superseded',
          teaching: 'The generation stated is not the one this lease holds.' } }
      }
      return { body: { accepted: true, lease: activeLease({ workerId: state.holder, workerGeneration: state.generation }), payload: { work: [] } } }
    }
    if (operation.kind === 'RenewLease') {
      state.renewals += 1
      if (Number.isInteger(refuseRenewAfter) && state.renewals > refuseRenewAfter) {
        return { body: { accepted: false, errorCode: 'lease_expired', teaching: 'This lease is no longer active.' } }
      }
      if (operation.workerId !== state.holder || operation.workerGeneration !== state.generation) {
        return { body: { accepted: false, errorCode: 'worker_fenced', teaching: 'Not the current holder.' } }
      }
      return { body: { accepted: true, lease: activeLease({ workerId: state.holder, workerGeneration: state.generation }) } }
    }
    if (operation.kind === 'ReleaseLease') {
      state.released = true
      return { body: { accepted: true } }
    }
    return onWork?.(operation, seen, state)
  }
}

/** Three real local adapters. Each appends one line before producing output, so "did the
 *  external side effect happen" is answered by the filesystem rather than by a log line the
 *  Worker chose to print. */
export const ADAPTERS = {
  'ship-adapter.mjs':
    "import { appendFileSync } from 'node:fs'\n"
    + "appendFileSync(process.env.P2_EFFECT_LOG, 'ship\\n')\n"
    + "process.stdout.write(JSON.stringify({ rows: [] }))\n",
  'check-adapter.mjs':
    "import { appendFileSync } from 'node:fs'\n"
    + "appendFileSync(process.env.P2_EFFECT_LOG, 'check\\n')\n"
    + "process.stdout.write(JSON.stringify({ outcome: 'satisfied', evidence: 'probe read the backend' }))\n",
  'fetch-adapter.mjs':
    "import { appendFileSync } from 'node:fs'\n"
    + "appendFileSync(process.env.P2_EFFECT_LOG, 'fetch\\n')\n"
    + "process.stdout.write(JSON.stringify({ facts: [{ predicate: 'stock_level', args: { sku: 'A-1', qty: 7 } }] }))\n",
  // Purely computational: it reads through no Source, and it reports what the environment
  // handed it so an arm can check that no Source access or type was manufactured for it.
  'compute-adapter.mjs':
    "import { appendFileSync } from 'node:fs'\n"
    + "appendFileSync(process.env.P2_EFFECT_LOG, 'compute\\n')\n"
    + "process.stdout.write(JSON.stringify({\n"
    + "  args: process.argv[2] ?? '',\n"
    + "  sourceAccess: process.env.RULITH_SOURCE_ACCESS ?? null,\n"
    + "  sourceType: process.env.RULITH_SOURCE_TYPE ?? null,\n"
    + "}))\n",
}

export const TOOLS = {
  format: 'rulith-worker-tools/1',
  tools: {
    'acme.ship@1': { adapter: 'run', sourceTypes: ['file'], entry: 'ship-adapter.mjs' },
    'acme.check@1': { adapter: 'run', sourceTypes: ['file'], entry: 'check-adapter.mjs', handles: { verification: ['output_record'] } },
    'acme.fetch@1': { adapter: 'run', sourceTypes: ['file'], entry: 'fetch-adapter.mjs', handles: { evidence: ['inventory'] } },
    /** Source-free: no Source type at all, and therefore no Source, no credential, no root. */
    'acme.compute@1': { adapter: 'run', sourceTypes: [], entry: 'compute-adapter.mjs' },
  },
}

/**
 * Ask the endpoint to sign a conforming v2 grant for whichever instance polled.
 *
 * A row cannot carry a real grant as a literal: the grant names the Worker instance and the
 * generation it holds, and neither exists until the process starts and takes the line. So
 * the row carries this marker and the endpoint signs the grant when it answers the poll —
 * which is also what the Gateway does.
 */
export const SIGNED = Symbol('sign a conforming grant for the asking instance')

/**
 * One dispatched action, in the Gateway's own row shape.
 *
 * `work` is the sole invocation key and `tool` the sole Action name — no `invocationId` or
 * `actionId` shadow beside them, no Case, and no structured `grant` beside the signed token.
 * The Tool declaration states which Source *types* it accepts and pins no instance; the
 * invocation names the instance it wants in its own `source` argument, and it must be the
 * record the row was dispatched against.
 */
export function actionRow(overrides = {}) {
  return {
    workType: 'action',
    work: INVOCATION,
    tool: 'acme.ship',
    boardId: BOARD,
    toolContractId: 'acme.ship@1',
    sourceRecordId: 'orders',
    connectionId: CONNECTION,
    toolDigest: toolDigest({ adapter: 'run', sourceTypes: ['file'], entry: 'ship-adapter.mjs' }),
    executionGrant: SIGNED,
    args: '{"source":"orders"}',
    target: '',
    toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.ship@1', kind: 'act', params: {}, sourceTypes: ['file'] }),
    ...artifactWorkFields(overrides.sourceRecordId ?? 'orders'),
    ...overrides,
  }
}

/** The slow-adapter row the lease-window arms drive, in the same shape. */
export function slowActionRow(overrides = {}) {
  return actionRow({
    work: 'inv_slow',
    tool: 'acme.slow',
    toolContractId: 'acme.slow@1',
    toolDigest: toolDigest({ adapter: 'run', sourceTypes: ['file'], entry: 'slow-adapter.mjs' }),
    toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.slow@1', kind: 'act', params: {}, sourceTypes: ['file'] }),
    ...overrides,
  })
}

/** A Source-free action row: no Source record, no `source` argument, no credentials. */
export function sourceFreeActionRow(overrides = {}) {
  return actionRow({
    work: 'inv_pure',
    tool: 'acme.compute',
    toolContractId: 'acme.compute@1',
    sourceRecordId: '',
    toolDigest: toolDigest({ adapter: 'run', sourceTypes: [], entry: 'compute-adapter.mjs' }),
    args: '{}',
    toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.compute@1', kind: 'read', params: {}, sourceTypes: [] }),
    ...overrides,
  })
}

/**
 * The work-item shapes, read out of the vendored contract rather than restated here.
 *
 * A default row factory is a claim about what a Gateway sends. Twice now this suite has been
 * green on a field the wire does not have — `sourceType`, and then `connectionId` on a
 * verification row — and each time every arm downstream passed for the wrong reason: the code
 * under test only reached its interesting part because the fixture had handed it something no
 * deployment could. So the default rows are checked against the committed schema at
 * construction, and a row that grows a field the contract does not declare fails here rather
 * than teaching the whole file a fiction.
 *
 * This is a floor on the **defaults**. A test that wants a malformed row for a negative arm
 * builds it explicitly afterwards — `{...verificationRow(), connectionId: 'x'}` — which reads
 * as the deliberate mutation it is instead of hiding in the shared factory.
 */
const WORKER_SCHEMA = JSON.parse(JSON.parse(readFileSync(join(ROOT, 'protocol', 'worker-contract.json'), 'utf8'))
  .files['docs/specs/schemas/rulith-worker-protocol-v2.schema.json'].content)
export const workItemShape = (name) => {
  const shape = WORKER_SCHEMA.$defs[name]
  if (shape === undefined) throw new Error(`the vendored Worker contract declares no ${name}`)
  return shape
}
/** Keys the contract declares and requires, so a fixture cannot drift in either direction. */
function conforming(name, row) {
  const shape = workItemShape(name)
  const allowed = new Set(Object.keys(shape.properties))
  const extra = Object.keys(row).filter((key) => !allowed.has(key))
  if (extra.length > 0) {
    throw new Error(`${name} fixture carries ${extra.join(', ')}, which the contract does not declare`
      + ` (additionalProperties: ${shape.additionalProperties}). A Gateway cannot send this row.`)
  }
  const missing = (shape.required ?? []).filter((key) => row[key] === undefined)
  if (missing.length > 0) throw new Error(`${name} fixture states no ${missing.join(', ')}, which the contract requires`)
  return row
}

/**
 * One verification order, exactly as `WorkerVerificationWorkItem` admits it.
 *
 * `channel` is the carrying Connection and there is no `connectionId`: the schema declares one
 * and not the other, and its own note says the channel "is the transport, not the accreditation".
 * The row states `source` and not its type — the accredited type belongs to the governed Source
 * record the Worker reads from the Sources it was granted.
 */
export function verificationRow(overrides = {}) {
  return conforming('WorkerVerificationWorkItem', {
    workType: 'verification',
    work: 'wo_p2',
    boardId: BOARD,
    channel: CONNECTION,
    source: 'orders',
    claim: { predicate: 'output_record', args: { node: 'n1' } },
    ...overrides,
  })
}

/**
 * One material request, exactly as `WorkerEvidenceWorkItem` admits it.
 *
 * It carries no carrier field at all — not `channel`, not `connectionId`. An evidence order
 * reaches a Worker on that Worker's own authenticated Poll, and the Source it is filed under is
 * `source`. `tool` and `payload` are the only optional members.
 */
export function evidenceRow(overrides = {}) {
  return conforming('WorkerEvidenceWorkItem', {
    workType: 'evidence',
    work: 'ev_p2',
    material: 'inventory',
    source: 'orders',
    tool: 'acme.ship@1',
    ...overrides,
  })
}

/**
 * Run the real Worker binary against a scripted Work endpoint.
 *
 * `reply(operation, seen)` returns `{ body }`, `{ status, text }` (an unusable response, the
 * production shape of a lost receipt), `RESET` (a destroyed connection, the shape that
 * reaches the Worker as a thrown fetch) or `HOLD`. `done(seen, output)` decides when the
 * scenario has played out; it must also become true on the *broken* path, or a regression
 * would present as a timeout rather than as a failed assertion.
 *
 * `extraFiles` writes anything else the scenario needs inside the Worker root — Source data a
 * real Adapter reads, a fixture it writes back — and `sources(root)` replaces the Source rows
 * the endpoint publishes, so a scenario can drive a named governed Source of its own rather
 * than the default `orders`.
 */
export async function driveWorker({
  reply, artifactReply, done, reviewer, timeoutMs = 20_000, extraAdapters = {}, extraFiles = {}, extraTools = {}, env = {},
  leaseGeneration = 7, lease: leaseOverride, sources = (root) => [{ name: 'orders', type: 'file', access: root }],
}) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-p2-'))
  const effectLog = join(dir, 'effects.log')
  // A relative name may nest — a scenario that drives a shipped Tool Manifest writes its
  // Adapters at the paths that manifest really names, rather than at flattened stand-ins.
  for (const [name, source] of Object.entries({ ...ADAPTERS, ...extraAdapters, ...extraFiles })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), source, 'utf8')
  }
  writeFileSync(join(dir, 'worker-tools.json'), JSON.stringify({ ...TOOLS, tools: { ...TOOLS.tools, ...extraTools } }), 'utf8')
  const sourceRows = sources(dir)

  const seen = []
  const held = []
  /**
   * A conforming Gateway by default.
   *
   * Every `Poll` answer carries an active lease for whichever instance asked, and the
   * two lease control calls are answered, so a scenario that is about claims and receipts
   * does not have to restate the lease contract. `lease: null` models the endpoint that
   * confirms none — the state in which this Worker must do nothing at all — a function
   * receives the asking operation so a scenario can spoil one field of an otherwise valid
   * lease, and a scenario may answer any of these itself to model a specific fault.
   */
  const leased = (operation, log) => {
    const scripted = reply(operation, log)
    if (scripted !== undefined) return scripted
    if (operation.kind === 'RenewLease' || operation.kind === 'ReleaseLease') {
      return { body: {
        accepted: true,
        ...(operation.kind === 'RenewLease'
          ? { lease: activeLease({ workerId: operation.workerId, workerGeneration: leaseGeneration }) }
          : {}),
      } }
    }
    return undefined
  }
  const withLease = (out, operation) => {
    if (out === HOLD || out === RESET || out?.body === undefined || operation.kind !== 'Poll') return out
    // A refusal is a refusal: an endpoint that turns this instance away does not hand it a
    // lease in the same breath.
    if (leaseOverride === null || out.body.accepted === false || out.body.lease !== undefined) return out
    const lease = typeof leaseOverride === 'function'
      ? leaseOverride(operation)
      : leaseOverride ?? activeLease({ workerId: operation.workerId, workerGeneration: leaseGeneration })
    return { ...out, body: { ...out.body, lease } }
  }
  /**
   * Sign the grants a poll answer hands out, for the instance that asked.
   *
   * The Worker verifies the signature with the Connection key it already holds, so a grant
   * has to be signed rather than stubbed: a placeholder string would be refused, and every
   * arm below would then be testing the refusal instead of the thing it is about.
   */
  const withGrants = (out, operation) => {
    const rows = out?.body?.payload?.work
    if (out === HOLD || out === RESET || !Array.isArray(rows) || operation.kind !== 'Poll') return out
    const workerGeneration = out.body.lease?.workerGeneration ?? leaseGeneration
    const signed = rows.map((row) => (row.executionGrant !== SIGNED ? row : {
      ...row,
      executionGrant: signGrant(grantFor(row, { workerId: operation.workerId, workerGeneration })),
    }))
    return { ...out, body: { ...out.body, payload: { ...out.body.payload, work: signed } } }
  }
  const server = createServer((request, response) => {
    if ((request.method ?? 'GET') === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return void response.end(JSON.stringify({ sources: sourceRows }))
    }
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      if ((request.url ?? '').startsWith('/chat')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        return void response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reviewer ?? {}) } }] }))
      }
      if (request.url === '/work/artifact') {
        const payload = JSON.parse(raw)
        const entry = { raw, artifact: payload, operation: { kind: 'ArtifactUpload' }, headers: { ...request.headers } }
        seen.push(entry)
        const out = artifactReply?.(payload, entry) ?? { status: 503, body: { errorCode: 'artifact_unavailable' } }
        entry.reply = out
        response.writeHead(out.status ?? 200, { 'content-type': 'application/json' })
        return void response.end(JSON.stringify(out.body))
      }
      const operation = JSON.parse(raw).operation
      // The headers are kept beside the body because the Gateway authenticates the header
      // pair and Core records the operation pair. An arm that checked only one of them would
      // pass on a hop that stated two different identities.
      const entry = { raw, operation, headers: { ...request.headers } }
      seen.push(entry)
      const out = withGrants(withLease(leased(operation, seen), operation), operation)
      if (out === HOLD) return void held.push(response)
      entry.reply = out
      if (out === RESET) {
        entry.reply = { reset: true }
        return void response.socket.destroy()
      }
      if (out.text !== undefined) {
        response.writeHead(out.status ?? 500, { 'content-type': 'text/plain' })
        return void response.end(out.text)
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(out.body))
    })
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  const { port } = server.address()

  const child = spawn(process.execPath, ['worker/rulith-worker.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      RULITH_WORK_URL: `http://127.0.0.1:${port}/work`,
      RULITH_CONNECTION: CONNECTION,
      RULITH_CONNECTION_KEY: CONNECTION_KEY,
      RULITH_WORKER_ROOT: dir,
      RULITH_TOOLS_FILE: join(dir, 'worker-tools.json'),
      RULITH_SECRETS_FILE: join(dir, 'no-secrets.json'),
      P2_EFFECT_LOG: effectLog,
      ...(reviewer === undefined ? {} : {
        RULITH_REVIEWER_URL: `http://127.0.0.1:${port}/chat/completions`,
        RULITH_REVIEWER_MODEL: 'p2-reviewer',
      }),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk })

  const deadline = Date.now() + timeoutMs
  let timedOut = false
  while (!done(seen, output)) {
    if (Date.now() > deadline) { timedOut = true; break }
    await new Promise((tick) => setTimeout(tick, 25))
  }
  child.kill('SIGKILL')
  await new Promise((closed) => child.once('close', closed))
  for (const response of held) response.destroy()
  await new Promise((closed) => server.close(closed))

  const effects = existsSync(effectLog)
    ? readFileSync(effectLog, 'utf8').split('\n').filter((line) => line !== '')
    : []
  rmSync(dir, { recursive: true, force: true })
  const of = (kind) => seen.filter((entry) => entry.operation.kind === kind)
  return { seen, output, effects, timedOut, of, ran: (label) => effects.filter((line) => line === label).length }
}

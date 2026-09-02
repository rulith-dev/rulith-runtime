// SPDX-License-Identifier: Apache-2.0
/**
 * Run the real Worker binary against a scripted Work endpoint.
 *
 * Shared by the Case-revision arms and the receipt-ladder arms because both ask the
 * same question — did the hand move, and did its receipt land — and both must answer it
 * from outside the Worker: the endpoint's request log and a file the Adapter appends
 * to. A Worker cannot fake an appended line, and it cannot un-write one.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

export const ROOT = resolve(import.meta.dirname, '..', '..')

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

export const CASE = 'CASE_p2'
/** What the Poll row carries. */
export const POLLED = 'c4'
/** What the accepted `ClaimWork` returns, because claiming is a write. */
export const CLAIMED = 'c5'
/** What the Board is at after the receipt commits. */
export const REPORTED = 'c6'

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
}

export const TOOLS = {
  format: 'rulith-worker-tools/1',
  tools: {
    'acme.ship@1': { adapter: 'run', sourceTypes: ['file'], entry: 'ship-adapter.mjs' },
    'acme.check@1': { adapter: 'run', sourceTypes: ['file'], entry: 'check-adapter.mjs', handles: { verification: ['output_record'] } },
    'acme.fetch@1': { adapter: 'run', sourceTypes: ['file'], entry: 'fetch-adapter.mjs', handles: { evidence: ['inventory'] } },
  },
}

export function actionRow(overrides = {}) {
  return {
    workType: 'action',
    work: 'inv_p2',
    tool: 'acme.ship@1',
    connectionId: 'conn-p2',
    caseId: CASE,
    caseRevision: POLLED,
    source: 'orders',
    sourceType: 'file',
    executionGrant: 'grant_p2',
    toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.ship@1', source: 'orders', kind: 'act', params: {} }),
    args: '{}',
    ...overrides,
  }
}

export function verificationRow(overrides = {}) {
  return {
    workType: 'verification',
    work: 'wo_p2',
    connectionId: 'conn-p2',
    caseId: CASE,
    caseRevision: POLLED,
    source: 'orders',
    sourceType: 'file',
    claim: { predicate: 'output_record', args: { node: 'n1' } },
    ...overrides,
  }
}

/**
 * The Case-revision gate, transcribed from what core actually computes
 * (`rulith-server/src/lib.rs`: compare `case_ctx.expected_revision` against
 * `format!("c{}", case_state.revision)`; on a mismatch return `stale_case_revision` and the
 * current value). Writing the expectation from the real computation path is the point —
 * a gate invented to match the fix would make every arm here decorative.
 */
export function caseRevisionGate(current, onAccept) {
  return (operation) => {
    if (operation.caseRevision !== current) {
      return {
        body: {
          accepted: false,
          revision: 'b12',
          caseRevision: current,
          errorCode: 'stale_case_revision',
          teaching: `Case revision is stale: expected ${String(operation.caseRevision)}, current ${current}.`
            + ' Poll again and return caseId and caseRevision exactly as supplied.',
        },
      }
    }
    return onAccept(operation)
  }
}

/**
 * Run the real Worker binary against a scripted Work endpoint.
 *
 * `reply(operation, seen)` returns `{ body }`, `{ status, text }` (an unusable response, the
 * production shape of a lost receipt), `RESET` (a destroyed connection, the shape that
 * reaches the Worker as a thrown fetch) or `HOLD`. `done(seen, output)` decides when the
 * scenario has played out; it must also become true on the *broken* path, or a regression
 * would present as a timeout rather than as a failed assertion.
 */
export async function driveWorker({ reply, done, reviewer, timeoutMs = 20_000, extraAdapters = {}, extraTools = {}, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-p2-'))
  const effectLog = join(dir, 'effects.log')
  for (const [name, source] of Object.entries({ ...ADAPTERS, ...extraAdapters })) writeFileSync(join(dir, name), source, 'utf8')
  writeFileSync(join(dir, 'worker-tools.json'), JSON.stringify({ ...TOOLS, tools: { ...TOOLS.tools, ...extraTools } }), 'utf8')

  const seen = []
  const held = []
  const server = createServer((request, response) => {
    if ((request.method ?? 'GET') === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return void response.end(JSON.stringify({ sources: [{ name: 'orders', type: 'file', access: dir }] }))
    }
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      if ((request.url ?? '').startsWith('/chat')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        return void response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reviewer ?? {}) } }] }))
      }
      const operation = JSON.parse(raw).operation
      const entry = { raw, operation }
      seen.push(entry)
      const out = reply(operation, seen)
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
      RULITH_CONNECTION: 'conn-p2',
      RULITH_CONNECTION_KEY: 'key-p2',
      RULITH_WORKER_ID: 'wkr_p2',
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

// SPDX-License-Identifier: Apache-2.0
/**
 * RT-WK-CLAIMREV (2026-08-30): a receipt must be filed against the Case revision the
 * accepted `ClaimWork` returned — never the one the Poll row carried.
 *
 * ## The break these arms exist for
 *
 * `ClaimWork` is a **write**. Core names it in `operation_kind_writes`, and
 * `idem_cache::cache_put` advances the Case revision on any accepted write, so an accepted
 * claim moves the Case from `cN` to `cN+1` and returns the new value as `caseRevision`.
 * The Worker built every follow-up through `inCase(w, …)` — the Poll row's revision,
 * replayed unchanged — so its receipt arrived one revision behind and core answered
 *
 *   {"accepted":false,"errorCode":"stale_case_revision",
 *    "teaching":"Case revision is stale: expected c4, current c5 …"}
 *
 * `stale_case_revision` carries an `errorCode`, and the receipt retry loop breaks on
 * exactly that ("board semantics rejected it; resending is the same answer"). So the loop
 * gave up **after the executor had already changed the external system**. The claim had
 * already recorded a trusted `dispatched`, so the invocation is never dispatched again:
 * the world moved, no receipt exists, and the Case reads as unfinished work that was done.
 *
 * ## Where the assertions are placed, and why there
 *
 * On **ordering**, not on the return value of the fix. A change that made a receipt land by
 * taking the executor out of the path under test would satisfy any "the report carried c5"
 * assertion on its own, so every arm here also counts real executor runs through a file the
 * adapter appends to — the Worker cannot fake that line, and it cannot un-write it.
 *
 * The two negative arms are the calibration. `stale revision is refused` proves the model
 * Board is actually checking (without it, every arm would be equally green against a Board
 * that accepted anything), and `evidence and review keep the Poll revision` proves the fix
 * did not simply rewrite the revision everywhere — those two flows never claim, so there is
 * no newer revision for them to use and the Poll row's value is the correct one.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const ROOT = resolve(import.meta.dirname, '..')

/** Do not answer this request at all. Used to park the Worker on an idle long poll so it
 *  stops hammering the model Board once the scenario under test has played out. */
const HOLD = Symbol('hold the response open')

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
const DONE = {
  action: /\| receipt (?:not )?committed/,
  verification: /Work report .*(?:accepted|rejected) by Board/,
  evidence: /Material report /,
  review: /Verdict /,
}

const CASE = 'CASE_p2'
/** What the Poll row carries. */
const POLLED = 'c4'
/** What the accepted `ClaimWork` returns, because claiming is a write. */
const CLAIMED = 'c5'
/** What the Board is at after the receipt commits. */
const REPORTED = 'c6'

/** Three real local adapters. Each appends one line before producing output, so "did the
 *  external side effect happen" is answered by the filesystem rather than by a log line the
 *  Worker chose to print. */
const ADAPTERS = {
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

const TOOLS = {
  format: 'rulith-worker-tools/1',
  tools: {
    'acme.ship@1': { adapter: 'run', source: 'orders', entry: 'ship-adapter.mjs' },
    'acme.check@1': { adapter: 'run', source: 'orders', entry: 'check-adapter.mjs', handles: { verification: ['output_record'] } },
    'acme.fetch@1': { adapter: 'run', source: 'orders', entry: 'fetch-adapter.mjs', handles: { evidence: ['inventory'] } },
  },
}

function actionRow(overrides = {}) {
  return {
    workType: 'action',
    work: 'inv_p2',
    tool: 'acme.ship@1',
    connectionId: 'conn-p2',
    caseId: CASE,
    caseRevision: POLLED,
    executionGrant: 'grant_p2',
    toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.ship@1', source: 'orders', kind: 'act', params: {} }),
    args: '{}',
    ...overrides,
  }
}

function verificationRow(overrides = {}) {
  return {
    workType: 'verification',
    work: 'wo_p2',
    connectionId: 'conn-p2',
    caseId: CASE,
    caseRevision: POLLED,
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
function caseRevisionGate(current, onAccept) {
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
 * production shape of a lost receipt) or `HOLD`. `done(seen, output)` decides when the
 * scenario has played out; it must also become true on the *broken* path, or a regression
 * would present as a timeout rather than as a failed assertion.
 */
async function driveWorker({ reply, done, reviewer, timeoutMs = 20_000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-p2-'))
  const effectLog = join(dir, 'effects.log')
  for (const [name, source] of Object.entries(ADAPTERS)) writeFileSync(join(dir, name), source, 'utf8')
  writeFileSync(join(dir, 'worker-tools.json'), JSON.stringify(TOOLS), 'utf8')

  const seen = []
  const held = []
  const server = createServer((request, response) => {
    if ((request.method ?? 'GET') === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return void response.end(JSON.stringify({ sources: [] }))
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

test('RT-WK-CLAIMREV-1: an action receipt carries the revision ClaimWork returned, and the executor runs once', async () => {
  const gate = caseRevisionGate(CLAIMED, () => ({ body: { accepted: true, revision: 'b13', caseRevision: REPORTED } }))
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12', caseRevision: CLAIMED } }
      if (operation.kind === 'ReportWork') return gate(operation)
      throw new Error(`unexpected operation ${String(operation.kind)}`)
    },
    done: (seen, output) => DONE.action.test(output),
  })

  assert.equal(run.timedOut, false, `the action flow never finished:\n${run.output}`)
  // Ordering first: the world really did change, exactly once. Every assertion below is
  // about a receipt for an effect that has already happened.
  assert.equal(run.ran('ship'), 1, `the executor must run exactly once; effect log: ${JSON.stringify(run.effects)}`)

  const reports = run.of('ReportWork')
  assert.equal(reports.length, 1, `expected one receipt, saw ${reports.length}`)
  assert.equal(reports[0].operation.caseRevision, CLAIMED,
    'the receipt was filed against the Poll row revision. ClaimWork is a write: it moved the Case to '
    + `${CLAIMED}, so ${POLLED} is stale by one and the Board answers `
    + `${JSON.stringify(reports[0].reply?.body)} — after the executor already changed the external system.`)
  assert.equal(reports[0].reply?.body?.accepted, true,
    `the receipt did not commit: ${JSON.stringify(reports[0].reply?.body)}`)
  assert.match(run.output, /receipt committed/)
  assert.doesNotMatch(run.output, /stale_case_revision/)
})

test('RT-WK-CLAIMREV-2: a verification receipt carries the revision ClaimWork returned', async () => {
  const gate = caseRevisionGate(CLAIMED, () => ({ body: { accepted: true, revision: 'b13', caseRevision: REPORTED } }))
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [verificationRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12', caseRevision: CLAIMED } }
      if (operation.kind === 'ReportWork') return gate(operation)
      throw new Error(`unexpected operation ${String(operation.kind)}`)
    },
    done: (seen, output) => DONE.verification.test(output),
  })

  assert.equal(run.timedOut, false, `the verification flow never finished:\n${run.output}`)
  assert.equal(run.ran('check'), 1, `the verification Tool must run exactly once; effect log: ${JSON.stringify(run.effects)}`)
  const reports = run.of('ReportWork')
  assert.equal(reports.length, 1)
  assert.equal(reports[0].operation.caseRevision, CLAIMED,
    'verification claims are writes too, so this receipt is stale by one: '
    + `${JSON.stringify(reports[0].reply?.body)}`)
  assert.equal(reports[0].reply?.body?.accepted, true, JSON.stringify(reports[0].reply?.body))
  assert.match(run.output, /accepted by Board/)
})

test('RT-WK-CLAIMREV-3: the model Board really refuses a stale revision (calibration)', async () => {
  // Without this arm every other arm would read green against a Board that accepted any
  // revision at all, which is the exact shape of the defect under repair.
  const gate = caseRevisionGate(CLAIMED, () => ({ body: { accepted: true, revision: 'b13', caseRevision: REPORTED } }))
  const refused = gate({ kind: 'ReportWork', caseRevision: POLLED })
  assert.equal(refused.body.accepted, false)
  assert.equal(refused.body.errorCode, 'stale_case_revision')
  assert.match(refused.body.teaching, /expected c4, current c5/)
  assert.equal(gate({ kind: 'ReportWork', caseRevision: CLAIMED }).body.accepted, true)
})

for (const [label, claimBody] of [
  ['no caseRevision field', { accepted: true, revision: 'b12' }],
  ['an empty caseRevision', { accepted: true, revision: 'b12', caseRevision: '' }],
  ['a non-string caseRevision', { accepted: true, revision: 'b12', caseRevision: 5 }],
]) {
  test(`RT-WK-CLAIMREV-4: an accepted claim with ${label} stops the Worker before the executor runs`, async () => {
    let polls = 0
    const run = await driveWorker({
      timeoutMs: 10_000,
      reply: (operation) => {
        if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
        if (operation.kind === 'ClaimWork') return { body: claimBody }
        // Reaching here at all is the failure: a receipt can only be filed after the hand
        // has moved, and there is no revision to file it against.
        if (operation.kind === 'ReportWork') return { body: { accepted: true, revision: 'b13', caseRevision: REPORTED } }
        throw new Error(`unexpected operation ${String(operation.kind)}`)
      },
      // True on both paths, so a regression fails an assertion instead of timing out.
      done: (seen, output) => /without a Case revision/.test(output) || DONE.action.test(output),
    })

    assert.equal(run.timedOut, false, `neither the refusal nor an executed action appeared:\n${run.output}`)
    assert.equal(run.ran('ship'), 0,
      'the executor ran against a claim that returned no Case revision. Its receipt can only be filed'
      + ' against a guessed number, and a guess is how this defect stops being loud:'
      + ` effect log ${JSON.stringify(run.effects)}, receipts ${JSON.stringify(run.of('ReportWork').map((entry) => entry.operation.caseRevision))}`)
    assert.deepEqual(run.of('ReportWork'), [], 'no receipt may be filed against a revision the Board never returned')
    assert.match(run.output, /without a Case revision/,
      `the refusal must be visible; the Worker printed:\n${run.output}`)
    assert.doesNotMatch(run.output, /executing/, 'the Worker announced execution for work it must not execute')
  })
}

test('RT-WK-CLAIMREV-5: a lost receipt response is resent byte-identically and replays the committed receipt', async () => {
  // The production shape of a lost receipt is not a thrown socket error — it is a response
  // the Worker cannot read (a 500 with a non-JSON body), while the Board did commit. The
  // resend must reach the same idempotency slot, which upstream keys on the operation
  // identity including caseRevision, so the two bodies have to be equal byte for byte.
  let polls = 0
  let committed
  const run = await driveWorker({
    reply: (operation, seen) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12', caseRevision: CLAIMED } }
      if (operation.kind !== 'ReportWork') throw new Error(`unexpected operation ${String(operation.kind)}`)
      return caseRevisionGate(CLAIMED, () => {
        const first = seen.filter((entry) => entry.operation.kind === 'ReportWork').length === 1
        committed ??= { accepted: true, revision: 'b13', caseRevision: REPORTED }
        // First attempt: commit, then lose the response on the way back.
        return first ? { status: 500, text: 'upstream unavailable' } : { body: committed }
      })(operation)
    },
    done: (seen, output) => DONE.action.test(output),
  })

  assert.equal(run.timedOut, false, `the resend never resolved:\n${run.output}`)
  assert.equal(run.ran('ship'), 1,
    `a lost receipt response must not re-run the executor; effect log: ${JSON.stringify(run.effects)}`)
  const reports = run.of('ReportWork')
  assert.equal(reports.length, 2, `expected the original receipt and one resend, saw ${reports.length}`)
  assert.equal(reports[0].raw, reports[1].raw,
    `the resend was not byte-identical, so it lands in a different idempotency slot and the`
    + ` at-most-once gate answers already_reported:\n  ${reports[0].raw}\n  ${reports[1].raw}`)
  for (const report of reports) {
    assert.equal(report.operation.caseRevision, CLAIMED, `a receipt carried ${String(report.operation.caseRevision)}`)
  }
  assert.equal(reports[1].reply?.body?.accepted, true, JSON.stringify(reports[1].reply?.body))
  assert.match(run.output, /receipt committed/)
})

test('RT-WK-CLAIMREV-6: evidence and review never claim, so they keep the Poll row revision', async () => {
  // The opposite calibration. A fix that refreshed the revision everywhere would break these
  // two: neither flow claims, so no newer revision exists and the Poll row's value is right.
  let polls = 0
  const rows = [
    { workType: 'evidence', material: 'inventory', tool: 'acme.fetch@1', norm: 'norm_1', caseId: CASE, caseRevision: POLLED, payload: { snapshot: 's1' } },
    { workType: 'review', tool: 'acme.ship@1', norm: 'norm_1', caseId: CASE, caseRevision: POLLED, caseFile: { rendered: 'Action acme.ship@1 under clause norm_1.' } },
  ]
  const run = await driveWorker({
    reviewer: { verdict: 'allow', citedClause: 'norm_1', reason: 'the clause is satisfied' },
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: rows } } } : HOLD
      if (operation.kind === 'ClaimWork') throw new Error('evidence and review have no claim step; the Worker must not claim for them')
      if (operation.kind === 'ReportWork') return caseRevisionGate(POLLED, () => ({ body: { accepted: true, revision: 'b13', caseRevision: POLLED } }))(operation)
      throw new Error(`unexpected operation ${String(operation.kind)}`)
    },
    done: (seen, output) => DONE.evidence.test(output) && DONE.review.test(output),
  })

  assert.equal(run.timedOut, false, `one of the two non-claiming flows never finished:\n${run.output}`)
  assert.equal(run.ran('fetch'), 1, `effect log: ${JSON.stringify(run.effects)}`)
  assert.deepEqual(run.of('ClaimWork'), [], 'neither flow may claim')
  const reports = run.of('ReportWork')
  assert.equal(reports.length, 2, `expected an evidence receipt and a review receipt, saw ${reports.length}`)
  assert.deepEqual(reports.map((entry) => entry.operation.workType).sort(), ['evidence', 'review'])
  for (const report of reports) {
    assert.equal(report.operation.caseRevision, POLLED,
      `${String(report.operation.workType)} does not claim, so its receipt must carry the Poll row revision`)
    assert.equal(report.reply?.body?.accepted, true, JSON.stringify(report.reply?.body))
  }
})

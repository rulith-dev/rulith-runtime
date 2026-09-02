// SPDX-License-Identifier: Apache-2.0
/**
 * The receipt is the one edge that may not be dropped, whatever shape the failure has.
 *
 * `work()` wraps `r.json()` in a try, so an unreadable *response* was already handled:
 * `RT-WK-CLAIMREV-5` covers that path. A thrown `fetch` — connection reset, DNS gone,
 * the peer closing mid-request — was not. It escaped the retry ladder entirely and
 * landed in the poll loop's catch, which printed `Polling failed (…); retrying in 5
 * seconds` and moved on. The consequence is the worst one on this link and identical to
 * the covered case: `ClaimWork` has already recorded a trusted `dispatched`, so core's
 * `should_fire = ready && !dispatched` never dispatches this invocation again — the hand
 * moved, no receipt exists, and the Case can never complete.
 *
 * Two transports, one rule. The arms below assert on the endpoint's request log and on
 * a file the Adapter appends to, never on a line the Worker chose to print.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLAIMED, DONE, HOLD, REPORTED, RESET,
  actionRow, caseRevisionGate, driveWorker,
} from './support/worker-harness.mjs'

test('RT-WK-RECEIPT-1: a connection reset on the receipt is retried byte-identically until it commits', async () => {
  let polls = 0
  let committed
  const run = await driveWorker({
    timeoutMs: 25_000,
    reply: (operation, seen) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12', caseRevision: CLAIMED } }
      if (operation.kind !== 'ReportWork') throw new Error(`unexpected operation ${String(operation.kind)}`)
      const attempt = seen.filter((entry) => entry.operation.kind === 'ReportWork').length
      // The socket dies before any response: the Worker sees a thrown fetch, not a body.
      if (attempt === 1) return RESET
      return caseRevisionGate(CLAIMED, () => {
        committed ??= { accepted: true, revision: 'b13', caseRevision: REPORTED }
        return { body: committed }
      })(operation)
    },
    done: (seen, output) => DONE.action.test(output),
  })

  assert.equal(run.timedOut, false, `the receipt was never retried after the reset:\n${run.output}`)
  assert.equal(run.ran('ship'), 1,
    `a lost receipt must not re-run the executor; effect log: ${JSON.stringify(run.effects)}`)

  const reports = run.of('ReportWork')
  assert.equal(reports.length, 2, `expected the original receipt and one retry, saw ${reports.length}`)
  assert.equal(reports[0].raw, reports[1].raw,
    'the retry was not byte-identical, so it lands in a different idempotency slot upstream and the'
    + ` at-most-once gate answers already_reported:\n  ${reports[0].raw}\n  ${reports[1].raw}`)
  assert.equal(reports[1].reply?.body?.accepted, true, JSON.stringify(reports[1].reply?.body))
  assert.match(run.output, /receipt committed/)
  // The old path: the throw escaped into the poll loop and was reported as a polling
  // problem, which is a different subject and a different remedy.
  assert.doesNotMatch(run.output, /Polling failed/,
    'a thrown receipt must be handled by the receipt ladder, not reported as a poll failure')
})

test('RT-WK-RECEIPT-2: repeated resets exhaust the ladder and say plainly that the world may have moved', async () => {
  // Calibration for the retry bound: the ladder must not become an unbounded loop, and
  // the operator-facing line must separate "the hand did it" from "the ledger has it".
  let polls = 0
  const run = await driveWorker({
    timeoutMs: 40_000,
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12', caseRevision: CLAIMED } }
      if (operation.kind === 'ReportWork') return RESET
      throw new Error(`unexpected operation ${String(operation.kind)}`)
    },
    done: (seen, output) => DONE.action.test(output),
  })

  assert.equal(run.timedOut, false, `the ladder never gave up:\n${run.output}`)
  assert.equal(run.ran('ship'), 1, `effect log: ${JSON.stringify(run.effects)}`)
  assert.equal(run.of('ReportWork').length, 4, 'the ladder is one attempt plus three retries')
  assert.match(run.output, /receipt not committed \(transport unavailable; retry limit reached\)/)
  assert.match(run.output, /executor succeeded/)
  assert.match(run.output, /The executor may have changed the external system, but the Board has no receipt/)
})

test('RT-WK-RECEIPT-3: a Board verdict is still final and is not retried (calibration)', async () => {
  // The other half of the rule. `errorCode` means the Board decided; resending is the
  // same answer a hundred times, and a ladder that retried it would hammer the endpoint.
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') return ++polls === 1 ? { body: { accepted: true, payload: { work: [actionRow()] } } } : HOLD
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12', caseRevision: CLAIMED } }
      if (operation.kind === 'ReportWork') return { body: { accepted: false, revision: 'b13', errorCode: 'already_reported', teaching: 'this invocation already has a receipt' } }
      throw new Error(`unexpected operation ${String(operation.kind)}`)
    },
    done: (seen, output) => DONE.action.test(output),
  })

  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ReportWork').length, 1, 'a semantic rejection must not be retried')
  assert.match(run.output, /receipt not committed \(Board rejected: already_reported\)/)
})

test('RT-WK-RECEIPT-4: a run Adapter does not receive the Worker credentials it runs beside', async () => {
  // The end-to-end half of the environment fence. The harness starts the real Worker
  // with RULITH_CONNECTION_KEY set, which is exactly the deployment shape: an Adapter
  // shipped by a capability package would otherwise read the Connection key, the Agent
  // token and the model key out of its own process environment.
  // The probe reports under the UPPER-CASED name, and so must every assertion below.
  // Windows environment variables are case-insensitive: a shell that stores `Path` and a
  // fence that strips `RULITH_TOKEN` are talking about the same namespace, and a probe
  // that compared names exactly answered two different questions on two shells. It read
  // `PATH` as absent under PowerShell (which spells it `Path`), failing this test on a
  // correct Worker; and it would have read a credential arriving as `Rulith_Token` as
  // absent too, passing on a broken one.
  const probe = {
    'env-probe.mjs':
      "import { appendFileSync } from 'node:fs'\n"
      + "appendFileSync(process.env.P2_EFFECT_LOG, 'probe\\n')\n"
      + "const want = ['RULITH_CONNECTION_KEY','RULITH_TOKEN','RULITH_MODEL_KEY','ANTHROPIC_API_KEY',"
      + "'RULITH_DB_URL','RULITH_SERVE_KEY','RULITH_CASE_ID','RULITH_SOURCE_ACCESS','PATH']\n"
      + "const seen = Object.fromEntries(Object.entries(process.env)"
      + ".map(([name, value]) => [name.toUpperCase(), value]).filter(([name]) => want.includes(name)))\n"
      + "process.stdout.write(JSON.stringify({ rows: [], seen }))\n",
  }
  let polls = 0
  const run = await driveWorker({
    extraAdapters: probe,
    extraTools: { 'acme.probe@1': { adapter: 'run', sourceTypes: ['file'], entry: 'env-probe.mjs' } },
    env: {
      RULITH_TOKEN: `rlt_agt_${'z'.repeat(43)}`,
      RULITH_MODEL_KEY: 'model-provider-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      RULITH_DB_URL: 'postgres://user:dbpassword@db/orders',
      RULITH_SERVE_KEY: 'serve-secret',
    },
    reply: (operation) => {
      if (operation.kind === 'Poll') {
        return ++polls === 1
          ? { body: { accepted: true, payload: { work: [actionRow({
              work: 'inv_probe', tool: 'acme.probe@1',
              toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.probe@1', source: 'orders', kind: 'act', params: {} }),
            })] } } }
          : HOLD
      }
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12', caseRevision: CLAIMED } }
      if (operation.kind === 'ReportWork') return caseRevisionGate(CLAIMED, () => ({ body: { accepted: true, revision: 'b13', caseRevision: REPORTED } }))(operation)
      throw new Error(`unexpected operation ${String(operation.kind)}`)
    },
    done: (seen, output) => DONE.action.test(output),
  })

  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('probe'), 1, `the Adapter must actually have run; effect log: ${JSON.stringify(run.effects)}`)
  const report = run.of('ReportWork')[0]
  assert.ok(report, `no receipt was filed:\n${run.output}`)
  const seen = JSON.parse(String(report.operation.result)).seen
  for (const name of ['RULITH_CONNECTION_KEY', 'RULITH_TOKEN', 'RULITH_MODEL_KEY', 'ANTHROPIC_API_KEY', 'RULITH_DB_URL', 'RULITH_SERVE_KEY']) {
    assert.equal(seen[name], undefined, `the Adapter process received ${name}: ${JSON.stringify(seen)}`)
  }
  // Calibration: the probe really can read its environment, and the things an Adapter
  // legitimately needs are still handed to it.
  assert.equal(typeof seen.PATH, 'string', 'stripping must not empty the environment')
  assert.equal(seen.RULITH_CASE_ID, 'CASE_p2', 'the trusted Case id is still supplied explicitly')
  assert.equal(typeof seen.RULITH_SOURCE_ACCESS, 'string', 'the Source access root is still supplied explicitly')
})

test('RT-WK-RECEIPT-5: a run Tool that declares env.pass receives only what it declared', async () => {
  // The deny-list is the default and covers known credential patterns; it cannot cover a
  // name nobody has heard of. `env.pass` is the operator's opt-in for a Tool that should
  // see one specific variable and no other — including the harness's own effect log,
  // which has to be declared here precisely because the allow-list is exhaustive.
  const probe = {
    'env-allow-probe.mjs':
      "import { appendFileSync } from 'node:fs'\n"
      + "appendFileSync(process.env.P2_EFFECT_LOG, 'allow\\n')\n"
      + "const seen = Object.fromEntries(Object.entries(process.env).map(([n, v]) => [n.toUpperCase(), v]))\n"
      + "process.stdout.write(JSON.stringify({ rows: [], seen }))\n",
  }
  let polls = 0
  const run = await driveWorker({
    extraAdapters: probe,
    extraTools: {
      'acme.allow@1': {
        adapter: 'run', sourceTypes: ['file'], entry: 'env-allow-probe.mjs',
        env: { pass: ['ACME_REGION', 'P2_EFFECT_LOG'] },
      },
    },
    env: {
      ACME_REGION: 'eu-west-1',
      ACME_UNLISTED: 'ordinary-but-undeclared',
      RULITH_TOKEN: `rlt_agt_${'z'.repeat(43)}`,
    },
    reply: (operation) => {
      if (operation.kind === 'Poll') {
        return ++polls === 1
          ? { body: { accepted: true, payload: { work: [actionRow({
              work: 'inv_allow', tool: 'acme.allow@1',
              toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.allow@1', source: 'orders', kind: 'act', params: {} }),
            })] } } }
          : HOLD
      }
      if (operation.kind === 'ClaimWork') return { body: { accepted: true, revision: 'b12', caseRevision: CLAIMED } }
      if (operation.kind === 'ReportWork') return caseRevisionGate(CLAIMED, () => ({ body: { accepted: true, revision: 'b13', caseRevision: REPORTED } }))(operation)
      throw new Error(`unexpected operation ${String(operation.kind)}`)
    },
    done: (seen, output) => DONE.action.test(output),
  })

  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('allow'), 1, `the Adapter must actually have run; effect log: ${JSON.stringify(run.effects)}`)
  const report = run.of('ReportWork')[0]
  assert.ok(report, `no receipt was filed:\n${run.output}`)
  const seen = JSON.parse(String(report.operation.result)).seen

  assert.equal(seen.ACME_REGION, 'eu-west-1', 'a declared name must still be handed to the Adapter')
  // The arm that only an allow-list can produce: an ordinary variable no deny-list
  // pattern describes, which the default fence passes through and this Tool does not.
  assert.equal(seen.ACME_UNLISTED, undefined,
    `an undeclared variable reached a Tool with an allow-list: ${JSON.stringify(Object.keys(seen).sort())}`)
  assert.equal(seen.RULITH_TOKEN, undefined)
  assert.equal(seen.RULITH_CONNECTION_KEY, undefined)
  // Basics and the explicit hand-off survive, or the Tool could not run at all.
  assert.equal(typeof seen.PATH, 'string', 'the allow-list must keep the basics an Adapter needs to start')
  assert.equal(seen.RULITH_CASE_ID, 'CASE_p2')
  assert.equal(typeof seen.RULITH_SOURCE_ACCESS, 'string')
})

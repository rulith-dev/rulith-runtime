// SPDX-License-Identifier: Apache-2.0
/**
 * What one model turn is allowed to make this Agent Runtime do.
 *
 * The four defects these arms close share a shape: the runtime treated a model turn as
 * an instruction rather than as a proposal, or treated one task's failure as the
 * process's. Each arm therefore asserts on the wire — what reached the scripted Board,
 * and what the process did afterwards — rather than on a message the Agent printed.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultBoard, fenced, runAgent } from './support/agent-harness.mjs'

// ── D. The model may not speak governance ────────────────────────────────────

test('a fenced governance command from the model is refused locally and never reaches the authority', async () => {
  const run = await runAgent({
    argv: ['--case', 'case-guard-1', 'remove the pack'],
    model: (round) => (round === 1
      ? fenced({ kind: 'RemovePack', packType: 'domain', name: 'verified-calculation', expectedDigest: 'sha256:current' })
      : 'DONE:'),
  })

  assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
  assert.equal(run.kinds.includes('RemovePack'), false,
    `RemovePack was forwarded to the authority under the Agent's own credential. Operations seen: ${run.kinds.join(', ')}`)
  assert.match(run.stdout, /Refused locally/)
  assert.match(run.stdout, /RemovePack is not a command this Agent Runtime sends/)
})

// Every kind here is either governance, a lifecycle verb the host owns, or a receipt
// surface that belongs to the Worker. Enumerating the family is the point: a guard
// written against one name passes while the sibling that matters walks through.
for (const command of [
  { kind: 'SealBoard' },
  { kind: 'RegisterPack', packType: 'domain', pack: {} },
  { kind: 'SetBoardSuspended', suspended: true, reason: 'r' },
  { kind: 'MaintainBoardShared', operations: [] },
  // `abandoned`, not `completed`: the host closes a deliverable segment with
  // `completed`, so a model command carrying that disposition is indistinguishable
  // from the host's own and the arm would pass without proving anything.
  { kind: 'CloseCase', root: 'case-guard-2', disposition: 'abandoned' },
  { kind: 'PauseCase' },
  { kind: 'ReportWork', workType: 'action', id: 'inv_1', ok: true, result: 'shipped' },
  { kind: 'ClaimWork', workType: 'action', id: 'inv_1' },
  { kind: 'GrantClearance', norm: 'sql:destructive' },
  { kind: 'DefineRole', role: 'admin' },
]) {
  test(`the model cannot emit ${command.kind}`, async () => {
    const run = await runAgent({
      argv: ['--case', 'case-guard-2', 'do the thing'],
      model: (round) => (round === 1 ? fenced(command) : 'DONE:'),
    })
    assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
    const forwarded = run.operations.filter((operation) => operation.kind === command.kind)
    // CloseCase is issued by the host at the end of a deliverable segment, so the
    // question is never "did the string appear" but "did one carry the model's own
    // fields" — here, its disposition and root.
    const fromModel = forwarded.filter((operation) => JSON.stringify(operation) === JSON.stringify(command))
    assert.deepEqual(fromModel, [],
      `${command.kind} was forwarded verbatim from the model turn: ${JSON.stringify(fromModel)}`)
    assert.match(run.stdout, /Refused locally/)
  })
}

test('the commands the prompt actually teaches are still forwarded', async () => {
  // Calibration. Without this arm, an allow-list that refused everything would make
  // every assertion above green while breaking the runtime.
  const run = await runAgent({
    argv: ['--case', 'case-guard-3', 'apply an action'],
    model: (round) => (round === 1 ? fenced({ kind: 'ApplyAction', action: 'acme.ship', target: 'L1' }) : 'DONE:'),
    board: (args) => {
      const operation = args.operation ?? {}
      if (operation.kind === 'ApplyAction') return { accepted: true, revision: 'r5', caseRevision: 'c1', payload: { done: true, ok: true, result: 'shipped', invocation: 'inv_1' } }
      return defaultBoard()(args)
    },
  })
  assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
  assert.equal(run.kinds.filter((kind) => kind === 'ApplyAction').length, 1,
    `ApplyAction must still reach the Board; operations seen: ${run.kinds.join(', ')}`)
  assert.doesNotMatch(run.stdout, /Refused locally/)
})

test('a batch of board operations is still forwarded as ApplyBatch', async () => {
  const run = await runAgent({
    argv: ['--case', 'case-guard-4', 'assert a fact'],
    model: (round) => (round === 1
      ? fenced([{ op: 'assert_fact', id: 'F1', predicate: 'scratch.demo.value', args: { n: 1 } }])
      : 'DONE:'),
  })
  assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
  assert.ok(run.kinds.includes('ApplyBatch'), `operations seen: ${run.kinds.join(', ')}`)
  assert.doesNotMatch(run.stdout, /Refused locally/)
})

// ── E. One task's failure is not the process's ───────────────────────────────

test('a model-provider error in --serve fails the task and leaves the server accepting work', async () => {
  // The model service answers 500 for the first task and normally for the second. The
  // old behaviour called process.exit(1) from inside the first, discarding the queue.
  const { createServer } = await import('node:http')
  const { spawn } = await import('node:child_process')
  const { resolve } = await import('node:path')
  const ROOT = resolve(import.meta.dirname, '..')

  let modelCalls = 0
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if ((request.url ?? '').startsWith('/v1/chat/completions')) {
      modelCalls += 1
      if (modelCalls === 1) {
        response.writeHead(500, { 'content-type': 'application/json' })
        return void response.end(JSON.stringify({ error: 'model provider unavailable' }))
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      return void response.end(JSON.stringify({ choices: [{ message: { content: 'DONE:' } }] }))
    }
    response.setHeader('content-type', 'application/json')
    if (input.method === 'tools/list') {
      return void response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { tools: [{ name: 'agent_protocol' }] } }))
    }
    const args = input.params?.arguments ?? {}
    let result
    if (args.mode === 'identity') result = { ok: true, agentId: 'agent-public-1' }
    else if (args.mode === 'source_access') result = { ok: true, sources: [] }
    else if (args.mode === 'evidence_chase') result = { ok: true, plans: [] }
    else if (args.mode === 'trace') result = { ok: true }
    else result = defaultBoard()(args)
    response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }))
  })
  let port
  await new Promise((ready) => server.listen(0, '127.0.0.1', () => { port = server.address().port; ready() }))

  const servePort = port + 1
  const child = spawn(process.execPath, ['agent/rulith-agent.mjs', '--serve'], {
    cwd: ROOT,
    env: {
      ...process.env,
      RULITH_URL: `http://127.0.0.1:${port}`,
      RULITH_TOKEN: `rlt_agt_${'a'.repeat(43)}`,
      RULITH_MODEL_URL: `http://127.0.0.1:${port}`,
      RULITH_MODEL: 'test-model', RULITH_MODEL_KEY: '', ANTHROPIC_API_KEY: '',
      RULITH_TRACE: 'off', RULITH_AUTO_DISCHARGE: 'off', RULITH_MAX_ROUNDS: '2',
      RULITH_SETTLE_WAIT_MS: '0', RULITH_DELIVERABLE_WAIT_MS: '0',
      RULITH_SERVE_KEY: 'serve-key-e', RULITH_SERVE_PORT: String(servePort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk })

  const post = (text) => fetch(`http://127.0.0.1:${servePort}/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rulith-serve': 'serve-key-e' },
    body: JSON.stringify({ text }),
  })
  const waitFor = async (predicate, ms = 15_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await predicate()) return true
      await new Promise((tick) => setTimeout(tick, 50))
    }
    return false
  }

  try {
    assert.ok(await waitFor(() => /Task endpoint ready/.test(output)), `the task endpoint never came up:\n${output}`)

    const first = await post('this task hits the broken provider')
    assert.equal(first.status, 202, await first.text())
    assert.ok(await waitFor(async () => {
      const runs = await fetch(`http://127.0.0.1:${servePort}/runs?k=serve-key-e`).then((r) => r.json()).catch(() => null)
      return (runs?.runs ?? []).length >= 1
    }), `the failed task never produced a run record:\n${output}`)

    const afterFirst = await fetch(`http://127.0.0.1:${servePort}/runs?k=serve-key-e`).then((r) => r.json())
    assert.equal(afterFirst.runs.length, 1)
    assert.match(String(afterFirst.runs[0].note), /Model service error \(500\)/,
      `the failed task must be recorded with its reason: ${JSON.stringify(afterFirst.runs[0])}`)

    // The whole point: the process is still here and still takes work.
    assert.equal(child.exitCode, null, `the Agent exited (${child.exitCode}) instead of failing one task:\n${output}`)
    const second = await post('this task should still be served')
    assert.equal(second.status, 202, await second.text())
    assert.ok(await waitFor(async () => {
      const runs = await fetch(`http://127.0.0.1:${servePort}/runs?k=serve-key-e`).then((r) => r.json()).catch(() => null)
      return (runs?.runs ?? []).length >= 2
    }), `the second task never ran, so the queue did not survive:\n${output}`)
  } finally {
    child.kill('SIGKILL')
    await new Promise((closed) => child.once('close', closed))
    await new Promise((closed) => server.close(closed))
    server.closeAllConnections()
  }
})

test('a one-shot run whose Case never opened exits non-zero', async () => {
  const run = await runAgent({
    argv: ['--case', 'case-never-opens', 'do the work'],
    board: (args) => {
      const operation = args.operation ?? {}
      if (operation.kind === 'OpenCase') {
        return { accepted: false, revision: 'r2', errorCode: 'case_admission_refused', teaching: 'the Capability Release is not installed on this Board' }
      }
      return defaultBoard()(args)
    },
  })
  assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
  assert.equal(run.code, 1,
    `a task that never opened a Case must not report success; exit was ${run.code}:\n${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /No Case Context was opened, so this task never started/)
})

test('a one-shot run that completes still exits zero (calibration)', async () => {
  const run = await runAgent({ argv: ['--case', 'case-opens-fine', 'do the work'] })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
})

// ── F. A paused Case is resumable ────────────────────────────────────────────

const pausedRow = (id) => ({ id, root: id, status: 'paused', caseType: 'exploration', revision: 'c7', capabilityReleaseDigest: 'sha256:cap', caseContractDigest: 'sha256:contract' })
const runningRow = (id) => ({ ...pausedRow(id), status: 'running', revision: 'c8' })

test('a paused Case named with --case is resumed instead of reopened', async () => {
  let resumed = false
  const run = await runAgent({
    argv: ['--case', 'case-paused-1', 'continue the work'],
    board: (args) => {
      const operation = args.operation ?? {}
      if (operation.kind === 'GetBoardManifest') {
        return { accepted: true, revision: 'r1', payload: { status: 'open', cases: [resumed ? runningRow('case-paused-1') : pausedRow('case-paused-1')] } }
      }
      if (operation.kind === 'ResumeCase') { resumed = true; return { accepted: true, revision: 'r2', payload: {} } }
      return defaultBoard()(args)
    },
  })

  assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
  const resumes = run.boardCalls.filter((call) => call.operation?.kind === 'ResumeCase')
  assert.equal(resumes.length, 1, `expected exactly one ResumeCase; kinds seen: ${run.kinds.join(', ')}`)
  assert.equal(resumes[0].operation.caseId, 'case-paused-1')
  // ResumeCase is caseContext:"boardOnly" in protocol/operations.json: the Case is its
  // subject, not its execution scope, so a `case` binding on it is a protocol error.
  assert.equal(resumes[0].case, undefined,
    `ResumeCase is boardOnly and must carry no case binding: ${JSON.stringify(resumes[0])}`)
  assert.equal(run.kinds.includes('OpenCase'), false,
    'a paused Case must not be reopened; OpenCase answers id_reused and loses the work')
  assert.match(run.stdout, /Resumed paused Case "case-paused-1"/)
})

test('an OpenCase refused with id_reused resumes the Case when it turns out to be paused', async () => {
  // The manifest read and the OpenCase write are not one step. This is the race, and it
  // is also what happens whenever another party pauses the Case between them.
  let manifestReads = 0
  let resumed = false
  const run = await runAgent({
    argv: ['--case', 'case-paused-2', 'continue the work'],
    board: (args) => {
      const operation = args.operation ?? {}
      if (operation.kind === 'GetBoardManifest') {
        manifestReads += 1
        if (manifestReads === 1) return { accepted: true, revision: 'r1', payload: { status: 'open', cases: [] } }
        return { accepted: true, revision: 'r1', payload: { status: 'open', cases: [resumed ? runningRow('case-paused-2') : pausedRow('case-paused-2')] } }
      }
      if (operation.kind === 'OpenCase') return { accepted: false, revision: 'r2', errorCode: 'id_reused', teaching: 'a Case with this id already exists on this Board' }
      if (operation.kind === 'ResumeCase') { resumed = true; return { accepted: true, revision: 'r2', payload: {} } }
      return defaultBoard()(args)
    },
  })

  assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
  assert.equal(run.kinds.filter((kind) => kind === 'ResumeCase').length, 1, `kinds seen: ${run.kinds.join(', ')}`)
  assert.match(run.stdout, /Resumed paused Case "case-paused-2"/)
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
})

test('a Case that is neither running nor paused is still opened normally (calibration)', async () => {
  const run = await runAgent({ argv: ['--case', 'case-fresh', 'start the work'] })
  assert.equal(run.kinds.includes('OpenCase'), true, `kinds seen: ${run.kinds.join(', ')}`)
  assert.equal(run.kinds.includes('ResumeCase'), false, 'nothing was paused, so nothing may be resumed')
})

test('a refused ResumeCase stops the segment instead of silently reopening', async () => {
  const run = await runAgent({
    argv: ['--case', 'case-paused-3', 'continue the work'],
    board: (args) => {
      const operation = args.operation ?? {}
      if (operation.kind === 'GetBoardManifest') return { accepted: true, revision: 'r1', payload: { status: 'open', cases: [pausedRow('case-paused-3')] } }
      if (operation.kind === 'ResumeCase') return { accepted: false, revision: 'r2', errorCode: 'board_suspended', teaching: 'the Board is suspended' }
      return defaultBoard()(args)
    },
  })
  assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
  assert.equal(run.kinds.includes('OpenCase'), false)
  assert.match(run.stdout, /is paused and could not be resumed/)
  assert.equal(run.code, 1, 'no Case opened, so the one-shot run must not report success')
})

// ── G. One requestId per submission, reused by an unchanged retry ────────────

test('an unchanged retry after a failed MCP hop reuses the same requestId', async () => {
  const applyBatchIds = []
  let batchAttempts = 0
  const ops = [{ op: 'assert_fact', id: 'F1', predicate: 'scratch.demo.value', args: { n: 1 } }]
  const run = await runAgent({
    argv: ['--case', 'case-request-id', 'submit the batch'],
    env: { RULITH_MAX_ROUNDS: '4' },
    // The model is told to retry unchanged, and does: the identical block twice.
    model: (round) => (round <= 2 ? fenced(ops) : 'DONE:'),
    board: (args) => {
      const operation = args.operation ?? {}
      if (operation.kind === 'ApplyBatch') {
        applyBatchIds.push(args.requestId)
        batchAttempts += 1
        // First attempt: the hop fails, so no authoritative receipt comes back.
        if (batchAttempts === 1) return undefined
      }
      return defaultBoard()(args)
    },
  })

  assert.notEqual(run.code, 'timeout', run.stdout + run.stderr)
  assert.equal(applyBatchIds.length, 2, `expected the original submission and one unchanged retry, saw ${applyBatchIds.length}`)
  for (const id of applyBatchIds) {
    assert.match(String(id), /^[0-9a-f-]{36}$/, `requestId must be a UUID, saw ${JSON.stringify(id)}`)
  }
  assert.equal(applyBatchIds[0], applyBatchIds[1],
    'the retry presented a new requestId, so an upstream idempotency cache cannot recognize it as the same submission'
    + ` and may apply the write twice: ${applyBatchIds.join(' vs ')}`)
})

test('distinct submissions carry distinct requestIds, and an answered one is not reused', async () => {
  // The other half of the ledger. An id that never gets released would make every
  // repeated read share one identity, which is the same defect wearing the opposite sign.
  const byKind = new Map()
  const run = await runAgent({
    argv: ['--case', 'case-request-id-2', 'just finish'],
    board: (args) => {
      const kind = String(args.operation?.kind ?? '')
      if (!byKind.has(kind)) byKind.set(kind, [])
      byKind.get(kind).push(args.requestId)
      return defaultBoard()(args)
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const everyId = [...byKind.values()].flat()
  assert.ok(everyId.length >= 4, `only ${everyId.length} board submissions were observed`)
  assert.ok(everyId.every((id) => typeof id === 'string' && id !== ''), 'every board submission must carry a requestId')

  const health = byKind.get('GetHealth') ?? []
  const manifests = byKind.get('GetBoardManifest') ?? []
  assert.notEqual(manifests[0], health[0], 'different operations must not share one request identity')
  if (health.length >= 2) {
    assert.notEqual(health[0], health[1],
      'an answered submission released its id; a later identical read is a new request, not a retry')
  }
})

// ── J. A numeric knob with a typo falls back loudly ──────────────────────────

test('a non-numeric RULITH_MAX_ROUNDS warns and falls back instead of becoming NaN', async () => {
  const run = await runAgent({
    argv: ['--case', 'case-env-1', 'do the work'],
    env: { RULITH_MAX_ROUNDS: 'twelve' },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /RULITH_MAX_ROUNDS="twelve" is not an integer between 1 and 1000; using the default 12/)
  // NaN made every `round <= MAX_ROUNDS` false, so the loop ran zero rounds and the
  // segment ended without ever asking the model anything.
  assert.match(run.stdout, /— Round 1 —/, `the bound was not restored; the loop never ran:\n${run.stdout}`)
})

test('an out-of-range numeric knob is refused the same way', async () => {
  const run = await runAgent({
    argv: ['--case', 'case-env-2', 'do the work'],
    env: { RULITH_ATTENTION_FACTS: '-5' },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /RULITH_ATTENTION_FACTS="-5" is not an integer between 20 and 100000; using the default 80/)
})

test('a valid numeric knob is used and produces no warning (calibration)', async () => {
  const run = await runAgent({
    argv: ['--case', 'case-env-3', 'do the work'],
    env: { RULITH_MAX_ROUNDS: '5' },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.doesNotMatch(run.stderr, /RULITH_MAX_ROUNDS/)
})

// ── K. Trace never becomes the reason a finished run is still running ────────
//
// Trace is on by default and is fire-and-forget by design, which is exactly why its
// failure mode is quiet: the run is finished, the exit status is set, and the process
// is still there. Two handles did it — the unref'd-nothing 1.5s batching timer, and the
// socket under the flush's own request, which the 45s abort budget was the only thing
// bounding. Both arms below time the exit from the endpoint's own clock rather than
// from the harness's, so a slow machine cannot turn either into a flake.

test('a trace endpoint that never answers does not hold a finished one-shot run open', async () => {
  const started = Date.now()
  const run = await runAgent({
    argv: ['--case', 'case-trace-hang', 'do the work'],
    env: { RULITH_TRACE: '' },
    holdTrace: true,
    timeoutMs: 20_000,
  })
  assert.notEqual(run.code, 'timeout', `the run never exited:\n${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.ok(run.firstTraceAt !== undefined,
    'no trace batch was sent, so this arm proves nothing about the flush that used to hang')
  // The bound is 1500ms; 8s leaves room for a loaded machine while staying far below the
  // 45s MCP abort budget that was the only thing ending this before.
  const heldFor = run.exitedAt - run.firstTraceAt
  assert.ok(heldFor < 8_000,
    `the wedged trace endpoint held the process for ${heldFor}ms after the batch arrived`
    + ` (total run ${run.exitedAt - started}ms):\n${run.stdout}\n${run.stderr}`)
})

test('trace is still sent when the endpoint answers, and the run still exits promptly (calibration)', async () => {
  // Without this arm, an Agent that had simply stopped tracing would satisfy the one
  // above — and the fix under test is about when the batch leaves, not whether it does.
  const run = await runAgent({
    argv: ['--case', 'case-trace-ok', 'do the work'],
    env: { RULITH_TRACE: '' },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const traced = run.calls.filter((call) => call.mode === 'trace')
  assert.ok(traced.length >= 1, 'the run reported no trace batch at all')
  const types = traced.flatMap((call) => (call.events ?? []).map((event) => String(event.type ?? '')))
  assert.ok(types.includes('end'),
    `the final batch was dropped rather than flushed; types seen: ${JSON.stringify(types)}`)
})

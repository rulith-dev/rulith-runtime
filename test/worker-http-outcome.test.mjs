// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { DONE, HOLD, actionRow, driveWorker, sourceFreeActionRow, toolDigest } from './support/worker-harness.mjs'
import { actionRowFaults } from '../worker/rulith-worker.mjs'

const TOOL_ID = 'acme.http_write@1'
const ACTION = 'acme.http_write'
const SOURCE = 'remote-api'
const COMPLETION = { stage: 'terminal', statuses: [200], json: { field: 'status', equals: 'completed' } }
const TOOL = {
  adapter: 'http', sourceTypes: ['http'], entry: '/effect', kind: 'write',
  fence: { method: 'POST', completion: COMPLETION }, params: {}, returns: [],
}

function writeRow() {
  return actionRow({
    tool: ACTION,
    toolContractId: TOOL_ID,
    sourceRecordId: SOURCE,
    toolDigest: toolDigest(TOOL),
    args: JSON.stringify({ source: SOURCE }),
    toolSpec: JSON.stringify({ impl: 'worker-tool', exec: TOOL_ID, kind: 'write', params: {}, sourceTypes: ['http'] }),
    completionRequirement: { stage: 'terminal' },
  })
}

async function exerciseHttpWrite({ status, body, disconnect = false }) {
  const calls = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    calls.push({ method: request.method, path: request.url, raw })
    // The external effect is recorded after receiving the complete request and before
    // answering. A failed response or reset cannot undo it.
    if (disconnect) return void request.socket.destroy()
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}/`
  let polls = 0
  try {
    const run = await driveWorker({
      sources: () => [{ name: SOURCE, type: 'http', access: baseUrl }],
      extraTools: { [TOOL_ID]: TOOL },
      reply: (operation) => {
        if (operation.kind === 'Poll') {
          return ++polls === 1 ? { body: { accepted: true, payload: { work: [writeRow()] } } } : HOLD
        }
        if (operation.kind === 'ClaimWork' || operation.kind === 'ReportWork') {
          return { body: { accepted: true, revision: 'b12' } }
        }
        return undefined // Let the harness answer lease renewal and release.
      },
      // Either path is a completion barrier. If a regression manufactures a receipt,
      // finish the run and fail on the request log rather than waiting for a timeout.
      done: (_seen, output) => /Result data for acme\.http_write could not be delivered/.test(output)
        || DONE.action.test(output),
      timeoutMs: 20_000,
    })
    assert.equal(run.timedOut, false, run.output)
    assert.deepEqual(calls, [{ method: 'POST', path: '/effect', raw: '{}' }],
      `the HTTP write did not run exactly once: ${JSON.stringify(calls)}\n${run.output}`)
    assert.equal(run.of('ClaimWork').length, 1, run.output)
    assert.equal(run.of('ClaimWork')[0].reply?.body?.accepted, true, run.output)
    return run
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

for (const [label, response] of [
  ['202 acceptance', { status: 202, body: { status: 'accepted', jobId: 'job-1' } }],
  ['200 acceptance without terminal evidence', { status: 200, body: { status: 'accepted', jobId: 'job-2' } }],
  ['post-effect 500', { status: 500, body: { error: 'later step failed' } }],
  ['post-effect disconnect', { disconnect: true }],
]) {
  test(`RT-WK-HTTP ${label} leaves the claimed invocation pending`, async () => {
    const run = await exerciseHttpWrite(response)
    assert.equal(run.of('ReportWork').length, 0,
      `${label} manufactured a success or failure receipt: ${JSON.stringify(run.of('ReportWork').map(x => x.operation))}`)
    assert.match(run.output, /The invocation remains pending for operator reconciliation after Worker fencing; do not rerun it/)
    assert.doesNotMatch(run.output, /\| receipt (?:not )?committed/)
  })
}

test('RT-WK-HTTP 200 with terminal evidence reports success once', async () => {
  const run = await exerciseHttpWrite({ status: 200, body: { status: 'completed', jobId: 'job-3' } })
  const reports = run.of('ReportWork')
  assert.equal(reports.length, 1, run.output)
  assert.equal(reports[0].operation.workType, 'action')
  assert.equal(reports[0].operation.ok, true)
  assert.equal(reports[0].operation.completionStage, 'terminal')
  assert.equal(reports[0].reply?.body?.accepted, true)
  assert.match(run.output, /receipt committed/)
})

test('RT-WK-HTTP frozen terminal requirement refuses a non-HTTP Tool before ClaimWork', async () => {
  let polls = 0
  const run = await driveWorker({
    reply: operation => operation.kind === 'Poll'
      ? (++polls === 1 ? { body: { accepted: true, payload: { work: [sourceFreeActionRow({
          completionRequirement: { stage: 'terminal' },
        })] } } } : HOLD)
      : { body: { accepted: true, revision: 'b12' } },
    done: (_, output) => /Frozen terminal completion requires/.test(output) || DONE.action.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.ran('compute'), 0)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(run.of('ReportWork').length, 0)
})

test('RT-WK-HTTP frozen terminal requirement refuses a changed local completion pin before ClaimWork', async () => {
  let polls = 0
  const changed = { ...TOOL, fence: { ...TOOL.fence,
    completion: { ...COMPLETION, json: { field: 'status', equals: 'accepted' } } } }
  const run = await driveWorker({
    extraTools: { [TOOL_ID]: changed },
    reply: operation => operation.kind === 'Poll'
      ? (++polls === 1 ? { body: { accepted: true, payload: { work: [writeRow()] } } } : HOLD)
      : { body: { accepted: true, revision: 'b12' } },
    done: (_, output) => /digest does not match/.test(output) || DONE.action.test(output),
  })
  assert.equal(run.timedOut, false, run.output)
  assert.equal(run.of('ClaimWork').length, 0)
  assert.equal(run.of('ReportWork').length, 0)
})

test('RT-WK-HTTP malformed completion requirement is rejected as a row fault', () => {
  for (const completionRequirement of [null, { stage: 'accepted' }, { stage: 'terminal', other: true }]) {
    assert.match(actionRowFaults({ ...writeRow(), completionRequirement }).join('; '), /completionRequirement/)
  }
})

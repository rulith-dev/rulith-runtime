// SPDX-License-Identifier: Apache-2.0
/**
 * Run the real Agent binary against a scripted public-MCP endpoint and a scripted
 * model service.
 *
 * Everything under test here is a decision the Agent makes about what to put on the
 * wire, so the assertions are on what the endpoint received — not on a return value the
 * Agent computed and could compute correctly while sending something else. The endpoint
 * records every `agent_protocol` argument object in order, including the ones the
 * Agent decided not to send, by their absence.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '..', '..')
export const TEST_TOKEN = `rlt_agt_${'a'.repeat(43)}`

/** A Board that answers every operation this runtime issues, so a scenario only has to
 *  describe the rows it actually cares about. */
export function defaultBoard({ cases = [], caseType = 'exploration' } = {}) {
  return (args) => {
    const operation = args.operation ?? {}
    switch (operation.kind) {
      case 'GetBoardManifest':
        return { accepted: true, revision: 'r1', payload: { status: 'open', cases } }
      case 'OpenCase':
        return { accepted: true, revision: 'r2', caseRevision: 'c0', payload: {
          caseId: operation.caseId, caseRevision: 'c0',
          capabilityReleaseDigest: 'sha256:cap', caseContractDigest: 'sha256:contract',
        } }
      case 'GetProjection':
        return operation.format === 'json'
          ? { accepted: true, revision: 'r3', payload: { context: { facts: [{ atom: { predicate: 'root', args: { node: 'case-test' } } }] } } }
          : { accepted: true, revision: 'r3', payload: { text: `logic_context ${caseType}` } }
      case 'GetCompletion':
        return { accepted: true, revision: 'r3', payload: { state: 'done', certified: true, floor: 'attested', leaves: [], gaps: [], frontier: [], blocked: [] } }
      case 'QueryBoard':
        return { accepted: true, revision: 'r3', payload: { gaps: [] } }
      case 'GetHealth':
        return { accepted: true, revision: 'r3', payload: {} }
      case 'CloseCase':
        return { accepted: true, revision: 'r4', caseRevision: 'c1', payload: { disposition: operation.disposition } }
      case 'ApplyBatch':
        return { accepted: true, revision: 'r3', caseRevision: 'c1', payload: { text: '' }, delta: { added: [], removed: [] } }
      default:
        return { accepted: true, revision: 'r3', payload: {} }
    }
  }
}

/**
 * @param {object} options
 * @param {string[]} [options.argv]     Agent command line after the script path.
 * @param {object}   [options.env]      Extra environment; overrides the fast defaults.
 * @param {Function} [options.board]    (args, calls) => result | HTTP_FAILURE marker.
 * @param {Function} [options.model]    (round, body) => assistant text.
 * @param {boolean}  [options.holdTrace] Accept the trace request and never answer it.
 *   The shape of a trace endpoint that is up but wedged — the one that cannot be
 *   distinguished from a slow one, and the one that used to hold the process open.
 * @param {boolean}  [options.holdTraceBody] Send trace response headers, then never finish its body.
 * @param {boolean}  [options.oversizeMcpResponse] Return a tools/list body larger than the Agent limit.
 * @param {boolean}  [options.rejectBoardCredential] Reject board calls with HTTP 401.
 * @param {boolean}  [options.rejectAllCredential] Reject the public MCP surface with HTTP 401.
 * @param {number}   [options.rejectBoardAfter] Reject this and later board call with HTTP 401.
 * @param {number}   [options.rejectBoardDelayMs] Delay the credential rejection response.
 * @param {string[]} [options.serveTasks] Submit these tasks after a --serve endpoint is ready.
 * @param {string[]} [options.chatLines] Send these lines to interactive stdin.
 * @param {number}   [options.timeoutMs]
 */
export async function runAgent({ argv = ['test task'], env = {}, board, model, holdTrace = false, holdTraceBody = false, oversizeMcpResponse = false, rejectBoardCredential = false, rejectAllCredential = false, rejectBoardAfter, rejectBoardDelayMs = 0, serveTasks = [], chatLines = [], timeoutMs = 20_000 } = {}) {
  const answerBoard = board ?? defaultBoard()
  const calls = []
  const modelRequests = []
  const answerModel = model ?? (() => 'DONE:')
  /** Responses accepted and deliberately never sent; destroyed during cleanup. */
  const held = []
  let firstTraceAt
  let boardRequests = 0

  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if ((request.url ?? '').startsWith('/v1/chat/completions')) {
      modelRequests.push(input)
      const content = answerModel(modelRequests.length, input)
      response.writeHead(200, { 'content-type': 'application/json' })
      return void response.end(JSON.stringify({ choices: [{ message: { content } }] }))
    }
    response.setHeader('content-type', 'application/json')
    if (rejectAllCredential) {
      response.writeHead(401, { 'content-type': 'application/json' })
      return void response.end(JSON.stringify({ teaching: 'rotate the Agent token in Console' }))
    }
    if (input.method === 'tools/list') {
      if (oversizeMcpResponse) return void response.end(JSON.stringify({ padding: 'x'.repeat(1_048_576) }))
      return void response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { tools: [{ name: 'agent_protocol', inputSchema: { type: 'object' } }] } }))
    }
    const args = input.params?.arguments ?? {}
    if (args.mode === 'board') boardRequests += 1
    if ((rejectBoardCredential || (Number.isInteger(rejectBoardAfter) && boardRequests >= rejectBoardAfter)) && args.mode === 'board') {
      if (rejectBoardDelayMs > 0) await new Promise((ready) => setTimeout(ready, rejectBoardDelayMs))
      response.writeHead(401, { 'content-type': 'application/json' })
      return void response.end(JSON.stringify({ teaching: 'rotate the Agent token in Console' }))
    }
    calls.push(args)
    let result
    if (args.mode === 'identity') result = { ok: true, agentId: 'agent-public-1' }
    else if (args.mode === 'source_access') result = { ok: true, sources: [] }
    else if (args.mode === 'evidence_chase') result = { ok: true, plans: [] }
    else if (args.mode === 'trace') {
      firstTraceAt ??= Date.now()
      if (holdTrace) return void held.push(response)
      if (holdTraceBody) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.flushHeaders()
        return void held.push(response)
      }
      result = { ok: true, took: (args.events ?? []).length }
    }
    else result = answerBoard(args, calls)
    // A scenario may model an MCP hop that fails rather than a Board that answers.
    if (result === undefined) {
      response.writeHead(502, { 'content-type': 'text/plain' })
      return void response.end('upstream unavailable')
    }
    response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }))
  })

  let port
  await new Promise((ready) => server.listen(0, '127.0.0.1', () => { port = server.address().port; ready() }))

  const child = spawn(process.execPath, ['agent/rulith-agent.mjs', ...argv], {
    cwd: ROOT,
    env: {
      ...process.env,
      RULITH_URL: `http://127.0.0.1:${port}`,
      RULITH_TOKEN: TEST_TOKEN,
      RULITH_MODEL_URL: `http://127.0.0.1:${port}`,
      RULITH_MODEL: 'test-model',
      RULITH_MODEL_KEY: '',
      ANTHROPIC_API_KEY: '',
      RULITH_TRACE: 'off',
      RULITH_AUTO_DISCHARGE: 'off',
      RULITH_MAX_ROUNDS: '3',
      RULITH_SETTLE_WAIT_MS: '0',
      RULITH_DELIVERABLE_WAIT_MS: '0',
      RULITH_SERVE: '',
      ...env,
    },
    stdio: [chatLines.length > 0 ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })

  if (chatLines.length > 0) {
    const deadline = Date.now() + 10_000
    while (!/Interactive mode/.test(stdout) && Date.now() < deadline) {
      await new Promise((ready) => setTimeout(ready, 25))
    }
    if (!/Interactive mode/.test(stdout)) throw new Error(`interactive Agent did not become ready:\n${stdout}\n${stderr}`)
    child.stdin.end(`${chatLines.join('\n')}\n`)
  }

  const serveStatuses = []
  if (serveTasks.length > 0) {
    const deadline = Date.now() + 10_000
    while (!/Task endpoint ready/.test(stdout) && Date.now() < deadline) {
      await new Promise((ready) => setTimeout(ready, 25))
    }
    if (!/Task endpoint ready/.test(stdout)) throw new Error(`serve endpoint did not become ready:\n${stdout}\n${stderr}`)
    for (const task of serveTasks) {
      const response = await fetch(`http://127.0.0.1:${env.RULITH_SERVE_PORT}/task`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rulith-serve': String(env.RULITH_SERVE_KEY ?? '') },
        body: JSON.stringify({ text: task }),
      })
      serveStatuses.push(response.status)
      await response.arrayBuffer()
    }
  }

  let timer
  const code = await Promise.race([
    new Promise((exited) => child.on('exit', exited)),
    new Promise((late) => { timer = setTimeout(() => { child.kill('SIGKILL'); late('timeout') }, timeoutMs) }),
  ])
  const exitedAt = Date.now()
  clearTimeout(timer)
  // Held responses first: `server.close` waits for open connections, so a wedged
  // request the scenario asked for would otherwise wedge the harness's own cleanup.
  for (const response of held) response.destroy()
  const serverClosed = new Promise((closed) => server.close(closed))
  server.closeAllConnections()
  await serverClosed

  const operations = calls.filter((call) => call.mode === 'board').map((call) => call.operation ?? {})
  return {
    code, stdout, stderr, calls, modelRequests, operations, port, exitedAt, serveStatuses,
    /** When the endpoint first saw a trace batch, so a test can time the exit from it. */
    firstTraceAt,
    boardCalls: calls.filter((call) => call.mode === 'board'),
    kinds: operations.map((operation) => String(operation.kind ?? '')),
  }
}

/** A fenced JSON block, the exact shape the Agent's prompt teaches the model to emit. */
export const fenced = (value) => `Here is the submission.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``

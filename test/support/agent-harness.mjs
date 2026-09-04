// SPDX-License-Identifier: Apache-2.0
/**
 * Run the real Agent binary against a scripted public-MCP endpoint and a scripted
 * model service.
 *
 * Everything under test here is a decision the Agent makes about what to put on the
 * wire, so the assertions are on what the endpoint received — not on a return value the
 * Agent computed and could compute correctly while sending something else. The endpoint
 * records every `tools/call` in order, including the ones the Agent decided not to make,
 * by their absence.
 *
 * The gateway implements the six MCP tools of board-protocol-spec §6.0b: the four model
 * verbs `OpenCase` / `ApplyBatch` / `ApplyAction` / `CloseCase`, plus the two host tools
 * `GetCompletion` and `agent_protocol`. Every one of the five Board tools answers with a
 * single JSON text — `{ accepted, errorCode?, teaching?, case, view, receipt? }` — so a
 * scenario describes Board state, never wire plumbing.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '..', '..')
export const TEST_TOKEN = `rlt_agt_${'a'.repeat(43)}`

/** The four verbs the model may speak, and the two the host uses. */
export const MODEL_VERBS = ['OpenCase', 'ApplyBatch', 'ApplyAction', 'CloseCase']
export const HOST_TOOLS = ['GetCompletion', 'agent_protocol']

/**
 * Return this from a scenario's `tool` / `protocol` hook to model an MCP hop that failed
 * rather than a Board that answered. Returning `undefined` means "I have no opinion about
 * this call" and falls through to the default gateway — the distinction matters, because a
 * hook that only scripts one tool would otherwise silently break every other one.
 */
export const HOP_FAILURE = Symbol('hop-failure')

/** A bounded Case View with every field §6.0b requires it to carry. */
export const emptyView = (overrides = {}) => ({
  goal: '', state: 'running', certified: false, floor: 'asserted',
  frontier: [], acceptance: [], missingEvidence: [], blocked: [],
  hypotheses: [], inFlight: [], actions: [],
  ...overrides,
})

/**
 * The advertised tool surface.
 *
 * Each schema deliberately carries the host-owned `case` property (and `ApplyBatch`
 * carries `requestId`), because the assertion that matters is that the Agent removes
 * them before the model ever sees them. A gateway that never advertised them would make
 * that guard pass without proving anything.
 */
export const advertisedTools = () => [
  {
    name: 'OpenCase',
    description: 'Open a Case on this Agent Board.',
    inputSchema: {
      type: 'object',
      properties: {
        caseType: { type: 'string' },
        businessKey: { type: 'object' },
        caseId: { type: 'string' },
        case: { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'string' } } },
      },
    },
  },
  {
    name: 'ApplyBatch',
    description: 'Apply one atomic batch of working-memory operations.',
    inputSchema: {
      type: 'object',
      required: ['operations'],
      properties: {
        operations: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' }, id: { type: 'string' }, predicate: { type: 'string' }, args: { type: 'object' } } } },
        case: { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'string' } } },
        requestId: { type: 'string' },
      },
    },
  },
  {
    name: 'ApplyAction',
    description: 'Invoke one Action the Case View lists as available.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string' },
        target: { type: 'string' },
        args: { type: 'string' },
        case: { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'string' } } },
      },
    },
  },
  {
    name: 'CloseCase',
    description: 'Ask the Board to close the Case with an explicit disposition.',
    inputSchema: {
      type: 'object',
      properties: {
        disposition: { enum: ['completed', 'cancelled', 'failed', 'abandoned', 'superseded'] },
        reason: { type: 'string' },
        case: { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'string' } } },
      },
    },
  },
  { name: 'GetCompletion', description: 'Read the bounded Case View.', inputSchema: { type: 'object', properties: { case: { type: 'object' } } } },
  { name: 'agent_protocol', description: 'Host protocol path.', inputSchema: { type: 'object' } },
]

/**
 * A Board that answers every tool this runtime calls, so a scenario only has to describe
 * what it actually cares about.
 *
 * It keeps just enough state to be honest about the things the loop depends on: a Case
 * exists after `OpenCase`, its revision advances on every accepted write, `ApplyBatch`
 * puts derived facts in the view, `ApplyAction` reports pending work and clears it on the
 * next read, and `CloseCase completed` is refused while the view is uncertified.
 */
export function defaultGateway({ cases = [], caseType = 'exploration', certifyAfterBatch = true, actionSettles = true, lawLocked = false } = {}) {
  const state = {
    caseId: undefined, revision: 0, closed: false, disposition: undefined,
    view: emptyView(), cases: [...cases], pending: 0, lawLocked,
  }
  const envelope = (accepted, extra = {}) => ({
    accepted,
    ...(state.caseId === undefined ? {} : {
      case: { id: state.caseId, revision: `c${state.revision}`, status: state.closed ? 'closed' : 'running', caseType, root: state.caseId },
    }),
    view: state.view,
    ...extra,
  })
  return {
    state,
    tool(name, args) {
      switch (name) {
        case 'OpenCase': {
          state.caseId = String(args.caseId ?? 'case-default')
          state.revision = 0
          state.closed = false
          state.view = emptyView({ goal: state.caseId })
          state.cases.push({
            id: state.caseId, root: state.caseId, status: 'running', caseType: String(args.caseType ?? caseType),
            revision: 'c0', capabilityReleaseDigest: 'sha256:cap', caseContractDigest: 'sha256:contract',
          })
          return envelope(true)
        }
        case 'ApplyBatch': {
          state.revision += 1
          const added = (Array.isArray(args.operations) ? args.operations : [])
            .map((operation) => `${String(operation.predicate ?? operation.op ?? 'fact')}`)
          state.view = emptyView({
            ...state.view,
            goal: state.caseId ?? '',
            frontier: [...state.view.frontier, ...added],
            certified: certifyAfterBatch && state.pending === 0,
            floor: certifyAfterBatch && state.pending === 0 ? 'attested' : 'asserted',
            state: certifyAfterBatch && state.pending === 0 ? 'done' : 'running',
          })
          return envelope(true)
        }
        case 'ApplyAction': {
          state.revision += 1
          state.pending += 1
          state.view = emptyView({
            ...state.view,
            certified: false, floor: 'asserted', state: 'actuating',
            inFlight: [`inv_${state.pending}`],
            actions: [{ name: String(args.action ?? ''), state: 'dispatched', pre: [], effect: [], params: {} }],
          })
          return envelope(true, { receipt: { invocation: `inv_${state.pending}`, done: false } })
        }
        case 'CloseCase': {
          const disposition = String(args.disposition ?? 'completed')
          if (disposition === 'completed' && state.view.certified !== true) {
            return envelope(false, {
              errorCode: 'case_not_certified',
              teaching: 'The Case is not certified, so it cannot be closed as completed. Close the remaining acceptance obligations first.',
            })
          }
          state.revision += 1
          state.closed = true
          state.disposition = disposition
          const answer = envelope(true, { receipt: { disposition, completedAt: '2026-09-04T00:00:00Z' } })
          state.caseId = undefined
          return answer
        }
        case 'GetCompletion': {
          if (state.pending > 0 && actionSettles) {
            state.pending = 0
            state.view = emptyView({ ...state.view, inFlight: [], state: 'running' })
          }
          return envelope(true)
        }
        default:
          return envelope(true)
      }
    },
    protocol(args) {
      const operation = args.operation ?? {}
      switch (operation.kind) {
        case 'GetBoardManifest':
          return { accepted: true, revision: 'r1', payload: { status: 'open', lawLocked: state.lawLocked, cases: state.cases } }
        case 'RunDischarge':
          state.view = emptyView({ ...state.view, certified: true, floor: 'attested', state: 'done' })
          return { accepted: true, revision: 'r4', payload: { gaps: [] } }
        default:
          return { accepted: true, revision: 'r3', payload: {} }
      }
    },
  }
}

/** Turn a scripted model answer into the shape the requested provider would send. */
function renderModelAnswer(answer, provider) {
  const value = typeof answer === 'string' ? { text: answer } : (answer ?? { text: '' })
  const text = String(value.text ?? '')
  const calls = (Array.isArray(value.toolCalls) ? value.toolCalls : []).map((call, index) => ({
    id: String(call.id ?? `call_${index + 1}`),
    name: String(call.name ?? ''),
    input: call.input ?? {},
    rawArguments: call.rawArguments,
  }))
  if (provider === 'anthropic') {
    return {
      content: [
        ...(text === '' ? [] : [{ type: 'text', text }]),
        ...calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
      ],
    }
  }
  return {
    choices: [{
      message: {
        content: text === '' ? null : text,
        ...(calls.length === 0 ? {} : {
          tool_calls: calls.map((call) => ({
            id: call.id, type: 'function',
            function: { name: call.name, arguments: call.rawArguments ?? JSON.stringify(call.input) },
          })),
        }),
      },
    }],
  }
}

/**
 * @param {object} options
 * @param {string[]} [options.argv]     Agent command line after the script path.
 * @param {object}   [options.env]      Extra environment; overrides the fast defaults.
 * @param {object}   [options.gateway]  A `defaultGateway()`-shaped Board.
 * @param {Function} [options.tool]     (name, args, gateway) => result | undefined. Undefined models a failed MCP hop.
 * @param {Function} [options.protocol] (args, gateway) => agent_protocol result.
 * @param {Function} [options.model]    (round, body) => string | { text, toolCalls }.
 * @param {'openai'|'anthropic'} [options.provider] Which model wire the endpoint speaks.
 * @param {boolean}  [options.refuseTools] Answer 400 to any request carrying tool definitions.
 * @param {string[]} [options.advertise]  Tool names the endpoint advertises; defaults to all six.
 * @param {boolean}  [options.holdTrace] Accept the trace request and never answer it.
 * @param {boolean}  [options.holdTraceBody] Send trace response headers, then never finish its body.
 * @param {boolean}  [options.oversizeMcpResponse] Return a tools/list body larger than the Agent limit.
 * @param {boolean}  [options.rejectBoardCredential] Reject board calls with HTTP 401.
 * @param {boolean}  [options.rejectAllCredential] Reject the public MCP surface with HTTP 401.
 * @param {number}   [options.rejectBoardAfter] Reject this and later board call with HTTP 401.
 * @param {number}   [options.rejectToolAfter] Reject this and later model-verb tool call with HTTP 401.
 * @param {number}   [options.rejectBoardDelayMs] Delay the credential rejection response.
 * @param {(string|object|function)[]} [options.serveTasks] Submit these task bodies after a --serve endpoint is ready.
 * @param {boolean} [options.waitForServeCompletion] Wait for each accepted task's run record before submitting the next.
 * @param {boolean} [options.captureLocalEvents] Capture the Agent's IPC event stream.
 * @param {string[]} [options.chatLines] Send these lines to interactive stdin.
 * @param {number}   [options.timeoutMs]
 */
export async function runAgent({
  argv = ['test task'], env = {}, gateway, tool, protocol, model, provider = 'openai',
  refuseTools = false, advertise, holdTrace = false, holdTraceBody = false, oversizeMcpResponse = false,
  rejectBoardCredential = false, rejectAllCredential = false, rejectBoardAfter, rejectBoardDelayMs = 0, rejectToolAfter,
  serveTasks = [], waitForServeCompletion = false, captureLocalEvents = false, chatLines = [], timeoutMs = 20_000,
} = {}) {
  const board = gateway ?? defaultGateway()
  /** Every `tools/call` the Agent made, in order: { name, args }. */
  const toolCalls = []
  /** `agent_protocol` argument objects, in order. */
  const calls = []
  const modelRequests = []
  const localEvents = []
  const answerModel = model ?? (() => 'Nothing further is needed.')
  /** Responses accepted and deliberately never sent; destroyed during cleanup. */
  const held = []
  let firstTraceAt
  let boardRequests = 0

  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    const url = String(request.url ?? '')
    if (url.startsWith('/v1/chat/completions') || url.startsWith('/v1/messages')) {
      modelRequests.push(input)
      if (refuseTools && input.tools !== undefined) {
        response.writeHead(400, { 'content-type': 'application/json' })
        return void response.end(JSON.stringify({ error: { message: 'this endpoint does not support tools' } }))
      }
      const answer = answerModel(modelRequests.length, input)
      // A scripted `{ status }` models a provider outage rather than an answer.
      if (answer !== null && typeof answer === 'object' && Number.isInteger(answer.status)) {
        response.writeHead(answer.status, { 'content-type': 'application/json' })
        return void response.end(JSON.stringify(answer.body ?? { error: 'model provider unavailable' }))
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      return void response.end(JSON.stringify(renderModelAnswer(answer, provider)))
    }
    response.setHeader('content-type', 'application/json')
    if (rejectAllCredential) {
      response.writeHead(401, { 'content-type': 'application/json' })
      return void response.end(JSON.stringify({ teaching: 'rotate the Agent token in Console' }))
    }
    if (input.method === 'tools/list') {
      if (oversizeMcpResponse) return void response.end(JSON.stringify({ padding: 'x'.repeat(1_048_576) }))
      const tools = advertisedTools().filter((entry) => advertise === undefined || advertise.includes(entry.name))
      return void response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { tools } }))
    }
    const name = String(input.params?.name ?? '')
    const args = input.params?.arguments ?? {}
    if (name !== 'agent_protocol') {
      toolCalls.push({ name, args })
      if (Number.isInteger(rejectToolAfter) && toolCalls.length >= rejectToolAfter) {
        response.writeHead(401, { 'content-type': 'application/json' })
        return void response.end(JSON.stringify({ teaching: 'rotate the Agent token in Console' }))
      }
      const scripted = tool?.(name, args, board)
      const result = scripted === undefined ? board.tool(name, args) : scripted
      if (result === HOP_FAILURE) {
        response.writeHead(502, { 'content-type': 'text/plain' })
        return void response.end('upstream unavailable')
      }
      return void response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }))
    }
    if (args.mode === 'board') boardRequests += 1
    if ((rejectBoardCredential || (Number.isInteger(rejectBoardAfter) && boardRequests >= rejectBoardAfter)) && args.mode === 'board') {
      if (rejectBoardDelayMs > 0) await new Promise((ready) => setTimeout(ready, rejectBoardDelayMs))
      response.writeHead(401, { 'content-type': 'application/json' })
      return void response.end(JSON.stringify({ teaching: 'rotate the Agent token in Console' }))
    }
    calls.push(args)
    let result
    if (args.mode === 'identity') result = { ok: true, agentId: 'agent-public-1' }
    else if (args.mode === 'trace') {
      firstTraceAt ??= Date.now()
      if (holdTrace) return void held.push(response)
      if (holdTraceBody) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.flushHeaders()
        return void held.push(response)
      }
      result = { ok: true, took: (args.events ?? []).length }
    } else result = protocol?.(args, board) ?? board.protocol(args)
    if (result === HOP_FAILURE) {
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
      RULITH_MODEL_URL: provider === 'anthropic' ? `http://127.0.0.1:${port}/v1/messages` : `http://127.0.0.1:${port}`,
      RULITH_MODEL: 'test-model',
      RULITH_MODEL_KEY: '',
      ANTHROPIC_API_KEY: '',
      RULITH_TRACE: 'off',
      RULITH_AUTO_DISCHARGE: 'off',
      RULITH_MAX_ROUNDS: '3',
      RULITH_SETTLE_WAIT_MS: '0',
      RULITH_CASE_TYPE: '',
      RULITH_MODEL_TOOLS: '',
      RULITH_SERVE: '',
      ...(captureLocalEvents ? { RULITH_LOCAL_EVENTS: 'ipc' } : {}),
      ...env,
    },
    stdio: [chatLines.length > 0 ? 'pipe' : 'ignore', 'pipe', 'pipe', ...(captureLocalEvents ? ['ipc'] : [])],
  })
  if (captureLocalEvents) child.on('message', (message) => {
    if (message?.protocol === 'rulith-local-event' && message.event !== null && typeof message.event === 'object') localEvents.push(message.event)
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
  const serveResponses = []
  let serveSnapshot
  if (serveTasks.length > 0) {
    const deadline = Date.now() + 10_000
    while (!/Task endpoint ready/.test(stdout) && Date.now() < deadline) {
      await new Promise((ready) => setTimeout(ready, 25))
    }
    if (!/Task endpoint ready/.test(stdout)) throw new Error(`serve endpoint did not become ready:\n${stdout}\n${stderr}`)
    for (const task of serveTasks) {
      const resolvedTask = typeof task === 'function' ? task(serveResponses) : task
      const body = typeof resolvedTask === 'string' ? { text: resolvedTask } : resolvedTask
      const response = await fetch(`http://127.0.0.1:${env.RULITH_SERVE_PORT}/task`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rulith-serve': String(env.RULITH_SERVE_KEY ?? '') },
        body: JSON.stringify(body),
      })
      serveStatuses.push(response.status)
      const responseBody = await response.json().catch(() => ({}))
      serveResponses.push({ status: response.status, body: responseBody })
      if (waitForServeCompletion && response.ok && typeof responseBody.id === 'string') {
        const runDeadline = Date.now() + 10_000
        let completed = false
        while (Date.now() < runDeadline) {
          const snapshot = await fetch(`http://127.0.0.1:${env.RULITH_SERVE_PORT}/runs?k=${encodeURIComponent(String(env.RULITH_SERVE_KEY ?? ''))}`)
            .then((candidate) => candidate.json()).catch(() => undefined)
          if ((snapshot?.runs ?? []).some((candidate) => candidate.id === responseBody.id)) { completed = true; break }
          await new Promise((ready) => setTimeout(ready, 25))
        }
        if (!completed) throw new Error(`serve task ${responseBody.id} did not produce a run record:\n${stdout}\n${stderr}`)
      }
    }
    serveSnapshot = await fetch(`http://127.0.0.1:${env.RULITH_SERVE_PORT}/runs?k=${encodeURIComponent(String(env.RULITH_SERVE_KEY ?? ''))}`)
      .then((candidate) => candidate.json()).catch(() => undefined)
  }

  let timer
  const code = await Promise.race([
    new Promise((exited) => child.on('exit', exited)),
    new Promise((late) => { timer = setTimeout(() => { child.kill('SIGKILL'); late('timeout') }, timeoutMs) }),
  ])
  const exitedAt = Date.now()
  clearTimeout(timer)
  // Held responses first: `server.close` waits for open connections, so a wedged request
  // the scenario asked for would otherwise wedge the harness's own cleanup.
  for (const response of held) response.destroy()
  const serverClosed = new Promise((closed) => server.close(closed))
  server.closeAllConnections()
  await serverClosed

  const operations = calls.filter((call) => call.mode === 'board').map((call) => call.operation ?? {})
  return {
    code, stdout, stderr, calls, modelRequests, localEvents, operations, port, exitedAt,
    serveStatuses, serveResponses, serveSnapshot, board, toolCalls,
    /** When the endpoint first saw a trace batch, so a test can time the exit from it. */
    firstTraceAt,
    boardCalls: calls.filter((call) => call.mode === 'board'),
    /** Host protocol operation kinds, in order. */
    kinds: operations.map((operation) => String(operation.kind ?? '')),
    /** Model-facing tool names actually called, in order. */
    verbs: toolCalls.map((call) => call.name),
  }
}

/** One scripted tool call, in the shape `runAgent`'s `model` option expects. */
export const callTool = (name, input = {}, extra = {}) => ({ text: '', toolCalls: [{ name, input, ...extra }] })

/** The system prompt a recorded model request carried, whichever wire it used. */
export const systemTextOf = (request) => (typeof request?.system === 'string'
  ? request.system
  : String((request?.messages ?? []).find((message) => message.role === 'system')?.content ?? ''))

/** The tool definitions a recorded model request carried, normalised across providers. */
export const declaredToolsOf = (request) => (Array.isArray(request?.tools) ? request.tools : []).map((tool) => (
  tool.function === undefined
    ? { name: String(tool.name ?? ''), schema: tool.input_schema ?? {} }
    : { name: String(tool.function.name ?? ''), schema: tool.function.parameters ?? {} }))

// SPDX-License-Identifier: Apache-2.0
/**
 * Run the real Agent binary against a scripted `/mcp` endpoint and a scripted model
 * service.
 *
 * Everything under test here is a decision the Agent makes about what to put on the wire,
 * so the assertions are on what the endpoint received — not on a return value the Agent
 * computed and could compute correctly while sending something else. The endpoint records
 * every `initialize` and every `tools/call` in order, with the `_meta["rulith/v2"]` block
 * each call carried, including the calls the Agent decided not to make, by their absence.
 *
 * There is exactly one path: `/mcp`. The gateway speaks the MCP 2025-11-25 lifecycle
 * (`initialize` → `notifications/initialized` → `tools/list` → `tools/call`, plus `ping`
 * and a resumable GET stream), mints a session id per initialize, and answers the seven
 * tools — `OpenCase` / `ApplyBatch` / `ApplyAction` / `CloseCase` / `QueryBoard`,
 * `ReadArtifact`, and `ReadOperation`. Each answers with JSON text carrying the result,
 * and carries host metadata beside it in `_meta`, never inside the text.
 *
 * The recovery half of the contract is scriptable because it is where the interesting
 * defects live: `recovery` drives what `ping` and `initialize` publish, `readRecord` makes
 * ReadOperation return the original public result, `replaceAfter` produces the
 * 409 that means another client took over, and `breakStreamOnCall` cuts a response stream
 * so the answer has to be recovered with `Last-Event-ID` rather than re-decided.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { loadContractBundle } from '../../scripts/verify-mcp-contract.mjs'

export const ROOT = resolve(import.meta.dirname, '..', '..')
export const TEST_TOKEN = `rlt_agt_${'a'.repeat(43)}`
export const RULITH_META = 'rulith/v2'
export const TEST_AGENT_ID = 'agent-public-1'

/**
 * The surface this fixture serves is the **contract's own**, read from the vendored bundle.
 *
 * A scripted endpoint that advertised hand-written schemas would let every test pass
 * against a shape the real authority never sends — which is how a client's projection comes
 * to be exercised only on inputs nobody will ever give it. The negative fixtures below are
 * deliberate deviations *from* this, and say so in their own names.
 *
 * `BOARD_WRITES` is this fixture's own bookkeeping — which tools change Board state — and is
 * not a wire field.
 */
export const CONTRACT = loadContractBundle(ROOT)
export const MCP_SURFACE = CONTRACT.tools.map((tool) => ({ name: tool.name, target: tool.target }))
export const MODEL_TOOLS = MCP_SURFACE.map((entry) => entry.name)
export const BOARD_WRITES = CONTRACT.tools.filter((tool) => tool.target === 'core' && tool.name !== 'QueryBoard')
  .map((tool) => tool.name)
export const MCP_PROTOCOL_VERSION = CONTRACT.protocolVersion

/**
 * Return this from a scenario's `tool` hook to model an MCP hop that failed rather than a
 * Board that answered. Returning `undefined` means "I have no opinion about this call" and
 * falls through to the default gateway — the distinction matters, because a hook that only
 * scripts one tool would otherwise silently break every other one.
 */
export const HOP_FAILURE = Symbol('hop-failure')

/**
 * Answer with an explicit host metadata block instead of the gateway's own.
 *
 * The recovery record is filled in when the scenario does not state one: the contract makes
 * it required of every `rulith/v2` block, so a fixture that omitted it would be modelling a
 * non-conforming endpoint by accident. A scenario that wants that endpoint says so, by
 * passing `recovery: undefined` explicitly.
 */
export const withMeta = (core, meta) => ({ __core: core, __meta: { recovery: { state: 'none' }, ...meta } })

/**
 * The advertised tool surface a conforming authority publishes: the contract's own
 * materialized schemas, served exactly as the bundle carries them.
 *
 * They are the Gateway's obligation too — `tools[].inputSchema` is delivered from the
 * verified bundle rather than rebuilt — so serving anything else here would be testing this
 * client against a surface no deployment produces.
 */
export const advertisedTools = () => CONTRACT.schemas.map(({ name, inputSchema }) => ({
  name,
  description: `Rulith ${name}`,
  inputSchema,
}))

/**
 * A synthetic schema whose *business* arguments share names with envelope metadata.
 *
 * The contract has no such collision, and the projection rule still has to be right for the
 * day one appears: host metadata is an envelope concept, so a property of a business object
 * that happens to be called `sessionId` or `case` is business data and must survive. This
 * fixture exists to state that rule; it is not a claim about the real contract.
 */
export const businessNameCollisionTools = () => advertisedTools().map((tool) => (tool.name !== 'ApplyBatch' ? tool : {
  ...tool,
  inputSchema: {
    type: 'object',
    required: ['operations'],
    properties: {
      operations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['op', 'id'],
          properties: {
            op: { type: 'string' },
            id: { type: 'string' },
            predicate: { type: 'string' },
            args: {
              type: 'object',
              required: ['sessionId'],
              properties: { sessionId: { type: 'string' }, requestId: { type: 'string' }, amount: { type: 'number' } },
            },
          },
        },
      },
    },
  },
}))

/**
 * A non-conforming authority that offers host-owned and retired names as optional top-level
 * tool arguments. The client must keep them away from the model and say so, but may still
 * work: an endpoint offering a field is not the same as a contract requiring one.
 */
export const hostFieldTools = () => advertisedTools().map((tool) => (tool.name !== 'ApplyBatch' ? tool : {
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    properties: {
      ...tool.inputSchema.properties,
      case: { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'string' } } },
      viewToken: { type: 'string' },
      requestId: { type: 'string' },
    },
  },
}))

/**
 * A non-conforming authority that makes host envelope metadata **required**. No call this
 * client would carry can satisfy it, so the two contracts genuinely disagree.
 */
export const requiredHostFieldTools = () => advertisedTools().map((tool) => (tool.name !== 'ApplyBatch' ? tool : {
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    required: ['operations', 'viewToken'],
    properties: { ...tool.inputSchema.properties, viewToken: { type: 'string' } },
  },
}))

/**
 * A Board that answers every tool this runtime calls, so a scenario only has to describe
 * what it actually cares about.
 *
 * It keeps just enough state to be honest about what the loop depends on: Core mints Case
 * ids and acceptance roots, focus is per authenticated session, `ApplyAction` reports
 * pending work that a later read clears, and `CloseCase completed` is refused while a gap
 * is still open.
 *
 * There is no observation token and no first-write exception. A write presents no view and
 * pins no revision; the authority judges it against the state in force when it runs.
 *
 * @param {object} options
 * @param {Array}  [options.cases]        Pre-existing Cases: {caseId, root, status, caseType}.
 * @param {string} [options.caseType]     Default Case Type recorded on creation.
 * @param {boolean}[options.settleAfterBatch] Whether a batch clears the open gap.
 * @param {boolean}[options.actionSettles]    Whether the next read clears dispatched work.
 * @param {object} [options.artifacts]        ref -> {mediaType, text} readable by ReadArtifact.
 */
export function defaultGateway({
  cases = [], caseType = 'exploration', settleAfterBatch = true, actionSettles = true,
  artifacts = {}, queryIndependent = false,
} = {}) {
  const state = {
    cases: new Map(cases.map((row) => [String(row.caseId), {
      caseId: String(row.caseId), root: String(row.root ?? row.caseId),
      status: String(row.status ?? 'running'), caseType: String(row.caseType ?? caseType),
    }])),
    revision: 0, caseSeq: 0, pending: 0, gaps: [],
    artifacts: new Map(Object.entries(artifacts).map(([ref, value]) => [ref, {
      mediaType: String(value?.mediaType ?? 'text/plain'), text: String(value?.text ?? ''),
    }])),
  }
  const directory = () => [...state.cases.values()].map((row) => ({ caseId: row.caseId, root: row.root, status: row.status }))
  const focusRows = (session) => [...session.focus]
    .map((caseId) => state.cases.get(caseId))
    .filter(Boolean)
    .map((row) => ({ caseId: row.caseId, root: row.root, status: row.status }))
  const view = (session, extra = {}) => ({
    roots: focusRows(session),
    cases: { directory: directory(), total: state.cases.size },
    gaps: state.gaps.slice(),
    nodes: [],
    actions: [],
    ...extra,
  })
  const accept = (session, extra = {}) => ({
    accepted: true, revision: `r${++state.revision}`, payload: view(session), ...extra,
  })
  const refuse = (session, errorCode, teaching, extra = {}) => ({
    accepted: false, errorCode, teaching, payload: view(session), ...extra,
  })
  return {
    state,
    /** Host metadata for a result the gateway itself produced. */
    meta(session, extra = {}) {
      return {
        agentId: TEST_AGENT_ID,
        boardRevision: `r${state.revision}`,
        focusedRoots: focusRows(session).map((row) => ({ caseId: row.caseId, root: row.root })),
        ...extra,
      }
    },
    tool(name, args, session) {
      switch (name) {
        case 'OpenCase': {
          const focusForm = typeof args.caseId === 'string' && args.caseId.trim() !== ''
          const createForm = typeof args.caseType === 'string' || args.businessKey !== undefined
          if (focusForm && createForm) {
            return refuse(session, 'bad_command', 'OpenCase takes {caseType, businessKey?} to create, or {caseId} to focus. A mixed form is refused.')
          }
          if (focusForm) {
            const row = state.cases.get(args.caseId.trim())
            if (row === undefined) return refuse(session, 'unknown_case', `No Case ${args.caseId} exists on this Board.`)
            if (row.status === 'closed' || row.status === 'archived') {
              return refuse(session, 'case_closed', `Case ${row.caseId} is ${row.status} and cannot be focused.`)
            }
            if (row.status === 'paused') row.status = 'running'
            session.focus.add(row.caseId)
            return accept(session)
          }
          state.caseSeq += 1
          const row = {
            caseId: `CASE_${state.caseSeq}`, root: `ROOT_${state.caseSeq}`, status: 'running',
            caseType: String(args.caseType ?? caseType),
          }
          state.cases.set(row.caseId, row)
          session.focus.add(row.caseId)
          state.gaps = ['acceptance']
          return accept(session)
        }
        case 'ApplyBatch': {
          // `case_context_required` is a retired code: under one shared graph a write is
          // not scoped by focus. What it still needs is somewhere to land — this fixture's
          // Board has no roots until one is opened.
          if (session.focus.size === 0) return refuse(session, 'no_acceptance_root', 'This Board has no acceptance root for this write to reach.')
          if (settleAfterBatch && state.pending === 0) state.gaps = []
          return accept(session)
        }
        case 'ApplyAction': {
          if (session.focus.size === 0) return refuse(session, 'no_acceptance_root', 'This Board has no acceptance root for this Action to advance.')
          state.pending += 1
          state.gaps = [`invocation:inv_${state.pending}`]
          return accept(session, { receipt: { invocation: `inv_${state.pending}`, done: false } })
        }
        case 'CloseCase': {
          const disposition = String(args.disposition ?? 'completed')
          const target = [...session.focus].map((id) => state.cases.get(id)).find((row) =>
            row !== undefined && (args.root === undefined || row.root === args.root))
          if (target === undefined) return refuse(session, 'unknown_case', 'No such acceptance root is open for this session.')
          if (disposition === 'completed' && state.gaps.length > 0) {
            return refuse(session, 'case_not_certified',
              'The Case is not certified, so it cannot be closed as completed. Close the remaining acceptance obligations first.')
          }
          target.status = 'closed'
          session.focus.delete(target.caseId)
          return accept(session, { receipt: { disposition, completedAt: '2026-09-06T00:00:00Z' } })
        }
        case 'QueryBoard': {
          if (!queryIndependent && state.pending > 0 && actionSettles) { state.pending = 0; state.gaps = [] }
          return accept(session)
        }
        case 'ReadArtifact': {
          // Gateway wraps the bounded data result in its public admission envelope.
          const object = state.artifacts.get(String(args.ref ?? ''))
          if (object === undefined) {
            return { errorCode: 'artifact_unavailable', teaching: 'That reference is not readable by this Agent.' }
          }
          const bytes = Buffer.from(object.text, 'utf8')
          const offset = Number.isInteger(args.offset) ? args.offset : 0
          const maxBytes = Number.isInteger(args.maxBytes) ? Math.max(1, args.maxBytes) : 64
          const slice = bytes.subarray(offset, offset + maxBytes)
          const nextOffset = offset + slice.byteLength
          const complete = nextOffset >= bytes.byteLength
          return { accepted: true, result: {
            ref: String(args.ref), mediaType: object.mediaType, encoding: 'utf8',
            data: slice.toString('utf8'), offset, nextOffset: complete ? null : nextOffset,
            totalBytes: bytes.byteLength, complete, truncated: !complete,
          } }
        }
        default:
          return refuse(session, 'unknown_operation', `${name} is not an advertised tool.`)
      }
    },
  }
}

/**
 * The response text the provider sends. A raw tool input (`rawInput`, a JSON text) is
 * spliced into that text after serialization: `JSON.stringify` would round a literal
 * beyond 2^53 before the runtime ever saw it, and what the exactness arms test is
 * precisely the text on the wire.
 */
function serializeModelAnswer(answer, provider) {
  const value = typeof answer === 'string' ? { text: answer } : (answer ?? { text: '' })
  const raws = (Array.isArray(value.toolCalls) ? value.toolCalls : [])
    .map((call, index) => [String(call.id ?? `call_${index + 1}`), call.rawInput])
    .filter(([, raw]) => typeof raw === 'string')
  let body = JSON.stringify(renderModelAnswer(answer, provider))
  for (const [id, raw] of raws) body = body.replace(JSON.stringify(`__RAW_INPUT_${id}__`), () => raw)
  return body
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
    rawInput: call.rawInput,
  }))
  if (provider === 'anthropic') {
    return {
      ...(value.usage ? { usage: value.usage } : {}),
      content: [
        ...(text === '' ? [] : [{ type: 'text', text }]),
        // A raw input is a marker here; `serializeModelAnswer` splices the text in after
        // JSON.stringify, which would otherwise round any literal beyond 2^53.
        ...calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.rawInput === undefined ? call.input : `__RAW_INPUT_${call.id}__` })),
      ],
    }
  }
  return {
    choices: [{
      message: {
        content: text === '' ? null : text,
        ...(Object.hasOwn(value, 'reasoningContent') ? { reasoning_content: value.reasoningContent } : {}),
        ...(calls.length === 0 ? {} : {
          tool_calls: calls.map((call) => ({
            id: call.id, type: 'function',
            function: { name: call.name, arguments: call.rawArguments ?? JSON.stringify(call.input) },
          })),
        }),
      },
    }],
    ...(value.usage ? { usage: value.usage } : {}),
  }
}

/**
 * @param {object} options
 * @param {string[]} [options.argv]     Agent command line after the script path.
 * @param {object}   [options.env]      Extra environment; overrides the fast defaults.
 * @param {object}   [options.gateway]  A `defaultGateway()`-shaped Board.
 * @param {Function} [options.tool]     (name, args, gateway, session, meta) => result | undefined.
 * @param {Function} [options.model]    (round, body) => string | { text, toolCalls }.
 * @param {'openai'|'anthropic'} [options.provider] Which model wire the endpoint speaks.
 * @param {boolean}  [options.refuseTools] Answer 400 to any request carrying tool definitions.
 * @param {string[]} [options.advertise]  Tool names the endpoint advertises; defaults to all five.
 * @param {object[]} [options.extraTools] Additional tool descriptors the endpoint advertises.
 * @param {object[]} [options.toolSchemas] Replace the advertised descriptors entirely.
 * @param {string}   [options.duplicateTool] Advertise this approved tool a second time.
 * @param {'id'|'jsonrpc'|'sse-other'|'sse-preamble'|'sse-open'|'sse-split'} [options.corruptResponse]
 *   One deliberate wire deviation, for the negative protocol arms.
 * @param {number}   [options.swapSessionOnCall] Answer this and later tools/call under a different session id.
 * @param {boolean}  [options.omitAgentId] Authenticate but never return an Agent identity.
 * @param {boolean}  [options.sseResults]  Answer tools/call as an SSE stream.
 * @param {boolean}  [options.dropSessionHeader] Never return an MCP session id.
 * @param {boolean}  [options.rotateSession] Answer a presented session id with a different one.
 * @param {boolean}  [options.oversizeMcpResponse] Return a tools/list body larger than the Agent limit.
 * @param {boolean}  [options.rejectAllCredential] Reject the public MCP surface with HTTP 401.
 * @param {number}   [options.rejectToolAfter] Reject this and later model tool call with HTTP 401.
 * @param {string}   [options.sessionFile] Durable session store path handed to the Agent.
 * @param {string}   [options.protocolVersion] The version the endpoint negotiates in initialize.
 * @param {Function|object} [options.recovery] The recovery record `ping`/`initialize` publish;
 *   a function receives `{pings, toolCalls}` so a scenario can move waiting → result_ready.
 *   Defaults to `{state:'none'}`, because a conforming Gateway always publishes one — pass
 *   `null` to model an endpoint that omits it, which a host must refuse to read as "nothing
 *   outstanding".
 * @param {object|function} [options.readRecord] Public ReadOperation state/result. Its optional
 *   `__localDelivery` fixture field travels only in the private local delivery metadata namespace.
 *   `__operationTarget` overrides the private target selected by the read before delivery.
 * @param {number}   [options.replaceAfter] Answer this and every later request with HTTP 409
 *   `connection_replaced`, as the Gateway does once another client has taken over.
 * @param {object|function} [options.conflictBody] Replace the 409 body, for the arms that prove the
 *   reason string — not the bare -32000 — is what stops a host reconnecting.
 * @param {string|null} [options.conflictSessionId] Override the echoed session header on that 409;
 *   null omits it, and undefined echoes the request as the real Gateway does.
 * @param {number}   [options.expireSessionAfter] Answer exactly this request with HTTP 404, as a
 *   server whose session has gone does. One request only, so the client can re-initialize.
 * @param {number}   [options.breakStreamOnCall] Cut the response stream of this tools/call after a
 *   preamble event, keeping the answer for a `Last-Event-ID` resume.
 * @param {boolean}  [options.refuseResume] Answer the resuming GET with 405, as a server with no
 *   replayable stream does.
 * @param {number}   [options.pageTools] Answer `tools/list` in pages of this size, with the
 *   `nextCursor` the base protocol defines.
 * @param {number}   [options.listenPort]  Fixed endpoint port, so two runs share one endpoint identity.
 * @param {(string|object|function)[]} [options.serveTasks] Submit these task bodies after --serve is ready.
 * @param {boolean} [options.waitForServeCompletion] Wait for each accepted task's run record.
 * @param {boolean} [options.waitForServeReady] Wait for the Agent endpoint even when no task is submitted.
 * @param {boolean} [options.captureLocalEvents] Capture the Agent's IPC event stream.
 * @param {string[]} [options.chatLines] Send these lines to interactive stdin.
 * @param {number}   [options.timeoutMs]
 */
export async function runAgent({
  argv = ['test task'], env = {}, gateway, tool, model, provider = 'openai',
  refuseTools = false, advertise, extraTools = [], toolSchemas, duplicateTool,
  omitAgentId = false, sseResults = false, corruptResponse, swapSessionOnCall,
  dropSessionHeader = false, rotateSession = false, oversizeMcpResponse = false,
  rejectAllCredential = false, rejectToolAfter, sessionFile, listenPort = 0,
  protocolVersion = MCP_PROTOCOL_VERSION, recovery = { state: 'none' }, readRecord,
  serverBoardObservation = false, replaceAfter, conflictBody, conflictSessionId,
  expireSessionAfter, breakStreamOnCall, refuseResume = false, pageTools,
  serveTasks = [], serveTaskHeaders = {}, waitForServeCompletion = false, waitForServeReady = false,
  captureLocalEvents = false, chatLines = [], timeoutMs = 20_000,
} = {}) {
  const board = gateway ?? defaultGateway({ queryIndependent: serverBoardObservation })
  /** Every `tools/call` the Agent made, in order: { name, args, meta, id, sessionId }. */
  const toolCalls = []
  /** Every `initialize` the Agent made: { meta, capabilities, protocolVersion, presentedSession, issuedSession }. */
  const initializes = []
  /** Every JSON-RPC method the endpoint saw, in order. */
  const methods = []
  const paths = []
  /** Every request the endpoint saw on `/mcp`: { httpMethod, method, sessionId, lastEventId, status }. */
  const requests = []
  const modelRequests = []
  const localEvents = []
  const answerModel = model ?? (() => 'Nothing further is needed.')
  /** Authenticated MCP sessions this endpoint issued. */
  const mcpSessions = new Map()
  /** SSE responses a probe deliberately kept open; destroyed during cleanup. */
  const heldStreams = []
  let sessionSeq = 0
  /** The Agent's one effective client, and the sessions a later one took over from. */
  let activeSession
  const replaced = new Set()
  let pings = 0
  let readsDelivered = 0
  const storeDir = sessionFile === undefined ? mkdtempSync(join(tmpdir(), 'rulith-session-')) : undefined
  const store = sessionFile ?? join(storeDir, 'agent-sessions.json')

  const newSession = () => {
    // A rotating endpoint issues ids that cannot collide with the ones a previous run
    // stored, so a client that failed to notice the swap would keep using the old record.
    const session = { id: `${rotateSession ? 'rotated' : 'mcp'}-${++sessionSeq}`, focus: new Set(), events: [], eventSeq: 0 }
    mcpSessions.set(session.id, session)
    // One Agent, one effective client. Establishing a connection *takes over* from the one
    // before it, exactly as the Gateway does — so a host that opens a session per
    // conversation is not isolating them here either, it is replacing itself, and the arm
    // that asserts otherwise goes red instead of passing against a permissive fixture.
    if (activeSession !== undefined && activeSession.id !== session.id) replaced.add(activeSession.id)
    activeSession = session
    return session
  }
  const sessionOf = (request, input) => {
    // The header is the only carrier. A client that could name its session in the body
    // could name somebody else's, so an echoed id is not read here at all.
    const header = request.headers['mcp-session-id']
    const named = typeof header === 'string' ? header : ''
    // A rotating endpoint models the session having expired: the presented session is
    // authenticated but is no longer the one this Agent will be answered under.
    if (rotateSession && input?.method === 'initialize') return newSession()
    if (named !== '' && mcpSessions.has(named)) return mcpSessions.get(named)
    return newSession()
  }
  /** The recovery record this endpoint publishes right now, or nothing. */
  const recoveryNow = () => {
    const value = typeof recovery === 'function'
      ? recovery({ pings, requests: requests.length, toolCalls: toolCalls.length, readsDelivered }) : recovery
    return value === undefined || value === null ? undefined : { recovery: value }
  }

  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    const url = String(request.url ?? '')
    paths.push(url)
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
      return void response.end(serializeModelAnswer(answer, provider))
    }
    if (rejectAllCredential) {
      response.writeHead(401, { 'content-type': 'application/json' })
      return void response.end(JSON.stringify({ teaching: 'rotate the Agent token in Console' }))
    }
    const httpMethod = String(request.method ?? 'POST').toUpperCase()
    const lastEventId = typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : undefined
    requests.push({
      httpMethod, method: String(input.method ?? ''), sessionId: request.headers['mcp-session-id'],
      protocolHeader: request.headers['mcp-protocol-version'], lastEventId,
      // The whole header map, because host-to-host negotiation travels in headers rather than
      // in the JSON-RPC body — an arm about whether a call negotiated something cannot read it
      // anywhere else, and a hand-picked subset would go stale the moment another one is added.
      headers: { ...request.headers },
    })
    // Connection control and session lifetime are decided before anything is answered, and
    // they are two different answers: 409 says another client owns this Agent now, 404 says
    // this transport session is gone. A host that conflated them would either reconnect
    // into a fight or refuse to reconnect when it should.
    // A request under a session another client has taken over: the Gateway's own answer,
    // produced by the fixture rather than only by a scripted `replaceAfter`.
    if (replaced.has(String(request.headers['mcp-session-id'] ?? ''))) {
      response.writeHead(409, { 'content-type': 'application/json' })
      return void response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: input.id ?? null,
        error: {
          code: -32000,
          message: 'This Agent connection was replaced by a newer authenticated client.',
          data: { reason: 'connection_replaced' },
        },
      }))
    }
    if (Number.isInteger(replaceAfter) && requests.length >= replaceAfter) {
      const echoedSession = conflictSessionId === undefined
        ? request.headers['mcp-session-id'] : conflictSessionId
      response.writeHead(409, { 'content-type': 'application/json',
        ...(echoedSession === null || echoedSession === undefined ? {} : { 'mcp-session-id': echoedSession }) })
      return void response.end(JSON.stringify((typeof conflictBody === 'function'
        ? conflictBody(input) : conflictBody) ?? {
        jsonrpc: '2.0',
        id: input.id ?? null,
        error: {
          code: -32000,
          message: 'This Agent connection was replaced by a newer authenticated client.',
          data: { reason: 'connection_replaced' },
        },
      }))
    }
    if (Number.isInteger(expireSessionAfter) && requests.length === expireSessionAfter) {
      response.writeHead(404, { 'content-type': 'application/json' })
      return void response.end(JSON.stringify({
        jsonrpc: '2.0', id: input.id ?? null, error: { code: -32001, message: 'Session not found' },
      }))
    }
    if (httpMethod === 'DELETE') {
      // Terminating the session is the client's side of not leaving half-open sessions
      // behind. The fixture records it and forgets the session, as a server does.
      const ending = String(request.headers['mcp-session-id'] ?? '')
      mcpSessions.delete(ending)
      if (activeSession?.id === ending) activeSession = undefined
      response.writeHead(204)
      return void response.end()
    }
    if (httpMethod === 'GET') {
      // The resumable stream. A conforming server replays what followed the cursor; one
      // that has no such stream says 405, and the client must treat that as "not recovered"
      // rather than as an empty answer.
      const resuming = mcpSessions.get(String(request.headers['mcp-session-id'] ?? ''))
      if (refuseResume || resuming === undefined) {
        response.writeHead(405, { 'content-type': 'application/json' })
        return void response.end(JSON.stringify({ error: { message: 'this endpoint serves no standalone stream' } }))
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': resuming.id })
      const after = resuming.events.findIndex((event) => event.id === lastEventId)
      for (const event of resuming.events.slice(after + 1)) {
        response.write(`id: ${event.id}\nevent: message\ndata: ${JSON.stringify(event.payload)}\n\n`)
      }
      response.end()
      return
    }
    methods.push(String(input.method ?? ''))
    const session = sessionOf(request, input)
    const swapSession = typeof swapSessionOnCall === 'number' && input.method === 'tools/call'
      && toolCalls.length + 1 >= swapSessionOnCall
    const sessionHeaders = dropSessionHeader ? {} : { 'mcp-session-id': swapSession ? `${session.id}-swapped` : session.id }
    /**
     * Answer this request — or, when a probe asks for it, answer something else.
     *
     * `corrupt` names one deliberate deviation so a negative arm reads as itself:
     * `id` replies under a different JSON-RPC id, `jsonrpc` sends the wrong protocol tag,
     * `sse-other` streams a response to a *different* id, `sse-preamble` puts a
     * server-initiated notification ahead of the real answer (legal, and the client must
     * skip it), `sse-open` sends the answer and then holds the stream open (also legal —
     * closing is a SHOULD — so a client that waits for EOF hangs).
     */
    const record = (payload) => {
      const id = `e${++session.eventSeq}`
      session.events.push({ id, payload })
      return id
    }
    const send = (result, { sse = false, corrupt = corruptResponse } = {}) => {
      const envelope = {
        jsonrpc: corrupt === 'jsonrpc' ? '1.0' : '2.0',
        id: corrupt === 'id' ? 'a-different-request' : input.id,
        result,
      }
      const body = JSON.stringify(envelope)
      if (breakStreamOnCall !== undefined && input.method === 'tools/call' && toolCalls.length === breakStreamOnCall) {
        // A stream that dies after a preamble event, with the answer kept for replay. The
        // client has a cursor and a way back to the same answer; re-deciding instead would
        // turn one command into two.
        response.writeHead(200, { 'content-type': 'text/event-stream', ...sessionHeaders })
        const preamble = { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'dispatched' } }
        // Flush the preamble before cutting the socket. Destroying in the same tick can
        // discard the buffered bytes, and then the client has no cursor — which would make
        // this fixture test "no event id" rather than "the stream broke after one".
        response.write(`id: ${record(preamble)}\nevent: message\ndata: ${JSON.stringify(preamble)}\n\n`, () => {
          setTimeout(() => response.destroy(), 25).unref?.()
        })
        record(envelope)
        return
      }
      if (!sse && corrupt !== 'sse-other' && corrupt !== 'sse-preamble' && corrupt !== 'sse-open' && corrupt !== 'sse-split') {
        response.writeHead(200, { 'content-type': 'application/json', ...sessionHeaders })
        return void response.end(body)
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', ...sessionHeaders })
      if (corrupt === 'sse-other') {
        response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'someone-elses-request', result })}\n\n`)
        return
      }
      if (corrupt === 'sse-preamble') {
        // A server-initiated notification and a server->client request, both legal before
        // the response, then the answer. A client that takes the first frame with a
        // `result` would take the wrong one.
        response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'working' } })}\n\n`)
        response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'server-initiated-1', result: { unrelated: true } })}\n\n`)
        response.end(`event: message\ndata: ${body}\n\n`)
        return
      }
      if (corrupt === 'sse-split') {
        // One event whose data is split across several `data:` lines, as a pretty-printed
        // or chunk-split payload legitimately is. Joined by newline, it is the answer.
        const pretty = JSON.stringify(envelope, null, 2).split('\n').map((line) => `data: ${line}`).join('\n')
        response.end(`event: message\n${pretty}\n\n`)
        return
      }
      if (corrupt === 'sse-open') {
        // Answer, then keep the stream open. Closing after the response is a SHOULD, not a
        // MUST, so this is a conforming server and the client must not wait for EOF.
        response.write(`event: message\ndata: ${body}\n\n`)
        heldStreams.push(response)
        const keepalive = setInterval(() => { try { response.write(': keepalive\n\n') } catch { clearInterval(keepalive) } }, 50)
        keepalive.unref?.()
        return
      }
      response.end(`id: ${record(envelope)}\nevent: message\ndata: ${body}\n\n`)
    }

    if (input.method === 'initialize') {
      initializes.push({
        meta: input.params?._meta?.[RULITH_META],
        capabilities: input.params?.capabilities,
        protocolVersion: input.params?.protocolVersion,
        presentedSession: request.headers['mcp-session-id'],
        issuedSession: session.id,
      })
      return send({
        protocolVersion,
        capabilities: { tools: {}, ...(serverBoardObservation ? { experimental: {
          [RULITH_META]: { operationRecovery: 1, boardObservation: 1 },
        } } : {}) },
        serverInfo: { name: 'rulith-gateway-test', version: '0' },
        ...(omitAgentId && recoveryNow() === undefined ? {} : {
          _meta: { [RULITH_META]: { ...(omitAgentId ? {} : { agentId: TEST_AGENT_ID }), focusedRoots: [], ...recoveryNow() } },
        }),
      })
    }
    if (input.method === 'ping') {
      // The empty result plus recovery metadata. It touches no Board state and returns at
      // once: a host waiting on an unresolved call must be able to ask without spending a
      // model turn or reading anything it is not entitled to.
      pings += 1
      const meta = recoveryNow()
      return send(meta === undefined ? {} : { _meta: { [RULITH_META]: {
        agentId: TEST_AGENT_ID, focusedRoots: [], ...meta } } })
    }
    if (input.method === 'notifications/initialized') {
      response.writeHead(202, sessionHeaders)
      return void response.end()
    }
    if (input.method === 'tools/list') {
      if (oversizeMcpResponse) {
        response.writeHead(200, { 'content-type': 'application/json', ...sessionHeaders })
        return void response.end(JSON.stringify({ padding: 'x'.repeat(9 * 1_048_576) }))
      }
      const base = (toolSchemas ?? advertisedTools())
        .filter((entry) => advertise === undefined || advertise.includes(entry.name))
      const all = [...base, ...extraTools, ...(duplicateTool === undefined ? [] : base.filter((entry) => entry.name === duplicateTool))]
      // Paged, when a scenario asks for it. The base protocol allows `tools/list` to answer
      // in pages with a `nextCursor`, and a client that reads only the first page sees a
      // surface the endpoint never claimed to be complete.
      if (Number.isInteger(pageTools) && pageTools > 0) {
        const from = Number.parseInt(String(input.params?.cursor ?? '0'), 10) || 0
        const page = all.slice(from, from + pageTools)
        const next = from + pageTools
        return send({
          tools: page,
          ...(next < all.length ? { nextCursor: String(next) } : {}),
          ...(omitAgentId && recoveryNow() === undefined ? {} : {
            _meta: { [RULITH_META]: { ...(omitAgentId ? {} : { agentId: TEST_AGENT_ID }), focusedRoots: [], ...recoveryNow() } },
          }),
        })
      }
      return send({
        tools: all,
        ...(omitAgentId && recoveryNow() === undefined ? {} : {
          _meta: { [RULITH_META]: { ...(omitAgentId ? {} : { agentId: TEST_AGENT_ID }), focusedRoots: [], ...recoveryNow() } },
        }),
      })
    }
    if (input.method !== 'tools/call') {
      response.writeHead(400, { 'content-type': 'application/json', ...sessionHeaders })
      return void response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, error: { code: -32601, message: `unknown method ${input.method}` } }))
    }

    const name = String(input.params?.name ?? '')
    const args = input.params?.arguments ?? {}
    const meta = input.params?._meta?.[RULITH_META]
    toolCalls.push({ name, args, meta, id: input.id, sessionId: session.id })
    if (Number.isInteger(rejectToolAfter) && toolCalls.length >= rejectToolAfter) {
      response.writeHead(401, { 'content-type': 'application/json', ...sessionHeaders })
      return void response.end(JSON.stringify({ teaching: 'rotate the Agent token in Console' }))
    }
    // A read record is a separate public operation. It does not consume the pending
    // business slot or ask the Board to execute anything. A scripted transport failure
    // leaves the same read RPC available for a retry under its original identity.
    if (name === 'ReadOperation') {
      const scripted = tool?.(name, args, board, session, meta)
      if (scripted === HOP_FAILURE) {
        response.writeHead(502, { 'content-type': 'text/plain', ...sessionHeaders })
        return void response.end('upstream unavailable')
      }
      const value = typeof readRecord === 'function'
        ? readRecord({ pings, toolCalls: toolCalls.length, readsDelivered }) : readRecord ?? { state: 'none' }
      const { __localDelivery: localDelivery, __isError: readIsError = false,
        __omitHostMeta: omitHostMeta = false, __recovery: readRecovery,
        __operationTarget: targetOverride, ...publicRecord } = value
      const selected = recoveryNow()?.recovery
      const operationTarget = targetOverride === undefined
        ? (selected?.state !== 'none' && selected?.callRef !== undefined && selected?.tool !== undefined
          ? { callRef: selected.callRef, tool: selected.tool } : undefined)
        : targetOverride
      if (!readIsError) readsDelivered += 1
      return send({ isError: readIsError, content: [{ type: 'text', text: JSON.stringify(publicRecord) }],
        _meta: { ...(omitHostMeta ? {} : { [RULITH_META]: {
          agentId: TEST_AGENT_ID, focusedRoots: [], ...(readRecovery === undefined ? recoveryNow() : { recovery: readRecovery }),
          ...(operationTarget === null || operationTarget === undefined ? {} : { operationTarget }) } }),
        ...(localDelivery === undefined ? {} : { 'rulith/local-delivery/v1': localDelivery }) } }, { sse: sseResults })
    }
    // The serial gate, on the server side. While the authority says a call is still
    // executing, a new `tools/call` does not run: it is refused with the state, exactly as
    // §5.2 requires. A host that sent one anyway gets an error rather than an execution,
    // which is what makes "the host must not send it" testable at all.
    const pendingState = recoveryNow()?.recovery?.state
    if (pendingState === 'waiting' && !(serverBoardObservation && name === 'QueryBoard')) {
      return send({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({
          accepted: false,
          errorCode: 'call_in_flight',
          requestExecuted: false,
          teaching: 'This Agent has a call in flight; nothing further runs until it settles.',
        }) }],
        _meta: { [RULITH_META]: { agentId: TEST_AGENT_ID, focusedRoots: [], ...recoveryNow() } },
      }, { sse: sseResults })
    }
    const scripted = tool?.(name, args, board, session, meta)
    if (scripted === HOP_FAILURE) {
      response.writeHead(502, { 'content-type': 'text/plain', ...sessionHeaders })
      return void response.end('upstream unavailable')
    }
    const explicit = scripted !== null && typeof scripted === 'object' && Object.hasOwn(scripted, '__core')
    const admitted = recoveryNow()?.recovery ?? { state: 'none' }
    const core = explicit ? scripted.__core : (scripted === undefined ? board.tool(name, args, session, meta) : scripted)
    // Default fixture responses follow the new decoded-result contract. A scripted
    // QueryBoard response is served verbatim so negative arms can test a nonconforming
    // endpoint rather than having this fixture silently repair its disclosure mistake.
    const publicCore = serverBoardObservation && name === 'QueryBoard' && scripted === undefined && core?.accepted === true
      ? { accepted: true, view: core.view ?? core.payload,
        observation: { consistency: 'committed', operationAtAdmission: {
          state: admitted.state,
          ...(admitted.state === 'none' ? {} : { originalTool: admitted.tool }),
        } } }
      : core
    const wireIsError = explicit && scripted.__isError === true
    const hostMeta = explicit ? scripted.__meta : board.meta(session)
    const withRecovery = hostMeta === undefined ? recoveryNow() : { ...hostMeta, ...recoveryNow() }
    const { ['rulith/local-delivery/v1']: localDelivery, ...ordinaryMeta } = withRecovery ?? {}
    return send({
      ...(wireIsError ? { isError: true } : {}),
      content: [{ type: 'text', text: JSON.stringify(publicCore) }],
      ...(withRecovery === undefined ? {} : { _meta: { [RULITH_META]: ordinaryMeta,
        ...(localDelivery === undefined ? {} : { 'rulith/local-delivery/v1': localDelivery }) } }),
    }, { sse: sseResults })
  })

  // A fixed port lets two runs share one endpoint identity, which is what the durable
  // session store is keyed on: a session issued by one endpoint is not a session at another.
  let port, child, childClosed, timer
  try {
  await new Promise((ready, reject) => {
    server.once('error', reject)
    server.listen(listenPort, '127.0.0.1', () => { server.off('error', reject); port = server.address().port; ready() })
  })

  child = spawn(process.execPath, ['agent/rulith-agent.mjs', ...argv], {
    cwd: ROOT,
    env: {
      ...process.env,
      RULITH_URL: `http://127.0.0.1:${port}`,
      RULITH_TOKEN: TEST_TOKEN,
      RULITH_MODEL_URL: provider === 'anthropic' ? `http://127.0.0.1:${port}/v1/messages` : `http://127.0.0.1:${port}`,
      RULITH_MODEL: 'test-model',
      RULITH_MODEL_KEY: '',
      ANTHROPIC_API_KEY: '',
      RULITH_SESSION_FILE: store,
      RULITH_MAX_ROUNDS: '3',
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
  let stdinFailure
  // Listen before readiness polling or writing stdin: a fast child can exit while
  // those await, and a late exit listener would wait until the artificial timeout.
  childClosed = new Promise(resolve => {
    child.once('close', code => resolve(code))
    child.once('error', error => { stderr += 'Agent fixture spawn failed: ' + error.message })
  })
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  child.stdin?.on('error', error => { stdinFailure = error })

  if (chatLines.length > 0) {
    const deadline = Date.now() + 10_000
    while (!/Interactive mode/.test(stdout) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((ready) => setTimeout(ready, 25))
    }
    if (!/Interactive mode/.test(stdout)) throw new Error(`interactive Agent did not become ready:\n${stdout}\n${stderr}`)
    child.stdin.end(`${chatLines.join('\n')}\n`)
  }

  const serveStatuses = []
  const serveResponses = []
  let serveSnapshot
  if (serveTasks.length > 0 || waitForServeReady) {
    const deadline = Date.now() + 10_000
    while (!/Task endpoint ready/.test(stdout) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((ready) => setTimeout(ready, 25))
    }
    if (!/Task endpoint ready/.test(stdout)) throw new Error(`serve endpoint did not become ready:\n${stdout}\n${stderr}`)
    for (const [taskIndex, task] of serveTasks.entries()) {
      const resolvedTask = typeof task === 'function' ? task(serveResponses) : task
      const body = typeof resolvedTask === 'string' ? { text: resolvedTask } : resolvedTask
      const response = await fetch(`http://127.0.0.1:${env.RULITH_SERVE_PORT}/task`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rulith-serve': String(env.RULITH_SERVE_KEY ?? ''),
          ...(typeof serveTaskHeaders === 'function' ? serveTaskHeaders(taskIndex) : serveTaskHeaders) },
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

  const code = await Promise.race([
    childClosed,
    new Promise((late) => { timer = setTimeout(() => { child.kill('SIGKILL'); late('timeout') }, timeoutMs) }),
  ])
  const exitedAt = Date.now()
  clearTimeout(timer)
  if (stdinFailure) throw new Error(`Agent fixture input failed (${stdinFailure.code}):\n${stdout}\n${stderr}`)
  return {
    code, stdout, stderr, modelRequests, localEvents, port, exitedAt,
    serveStatuses, serveResponses, serveSnapshot, board, toolCalls, initializes, methods, paths, requests,
    sessionStore: store,
    /** How many `ping` calls the endpoint answered. */
    pings,
    /** Model-facing tool names actually called, in order. */
    verbs: toolCalls.map((call) => call.name),
    /** The `_meta["rulith/v2"]` block each tool call carried, in order. */
    sentMeta: toolCalls.map((call) => call.meta),
  }
  } finally {
    clearTimeout(timer)
    // An assertion/readiness/transport failure must not strand the fixture server
    // and keep the whole parallel test run alive after its test already failed.
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const stream of heldStreams) { try { stream.destroy() } catch { /* already gone */ } }
    const serverClosed = new Promise(resolve => server.close(resolve))
    server.closeAllConnections()
    await serverClosed
    if (childClosed) {
      let deadline
      try {
        await Promise.race([childClosed, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Agent fixture did not exit during cleanup')), 3000)
        })])
      } finally { clearTimeout(deadline) }
    }
    if (storeDir !== undefined) rmSync(storeDir, { recursive: true, force: true })
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

/** A loopback port that is free right now, for tests that must pin the endpoint identity. */
export async function freePort() {
  const server = createServer()
  let port
  await new Promise((ready) => server.listen(0, '127.0.0.1', () => { port = server.address().port; ready() }))
  await new Promise((ready) => server.close(ready))
  return port
}

#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Local execution runtime for Rulith Cloud.
 *
 * The model proposes; the Board validates, derives, and explains rejection.
 * External execution belongs to the Worker. Configuration and governance
 * belong to Console. The Agent remains a normal conversational Agent; Rulith
 * is an optional tool it may call when work benefits from governed state,
 * evidence, Actions, or an auditable conclusion. A conversation may use no
 * Case, or may advance a persistent Case one explicit tool step at a time.
 *
 * The transcript and model credential remain local. The Board stores work,
 * evidence, decisions, receipts, and the Case lifecycle.
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'

/**
 * Numeric knobs fall back to their default, loudly, instead of becoming NaN.
 *
 * `Number(process.env.RULITH_MAX_ROUNDS ?? 12)` on a typo produced NaN, and every
 * comparison against NaN is false: `round <= MAX_ROUNDS` was false on the first
 * iteration, so the segment loop ran zero rounds and the run reported "stopped at the
 * NaN-round limit" as if it had worked. A bound that silently stops bounding is the
 * worse half — the same shape in a wait budget or a slot ceiling removes the limit
 * rather than the work. Out-of-range values are refused on the same grounds: a
 * concurrency of -3 is a typo, not a request.
 */
function envNumber(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER, integer = true } = {}) {
  const raw = process.env[name]
  if (raw === undefined || String(raw).trim() === '') return fallback
  const value = Number(raw)
  const bad = !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max
  if (bad) {
    console.error(`⚠ ${name}="${String(raw)}" is not ${integer ? 'an integer' : 'a number'} between ${min} and ${max};`
      + ` using the default ${fallback}. Fix the value or unset the variable.`)
    return fallback
  }
  return value
}

const URL_BASE = (process.env.RULITH_URL ?? 'https://api.rulith.ai').replace(/\/$/, '')
// The host surface. `/mcp` is the model surface — the four verbs and nothing else, which
// is what a generic MCP client shows its model. A protocol-native host connects one
// path deeper and also gets the two host tools (`GetCompletion`, `agent_protocol`).
// Same token, same authority; the split is about what a model is offered, not about
// who may do what.
const MCP_URL = `${URL_BASE}/mcp/host`
const TOKEN = process.env.RULITH_TOKEN ?? ''
// Compatibility hint for Cloud versions before agent_protocol identity. It is
// never authorization: every operation still crosses authenticated MCP and a
// current Cloud response overrides this unverified legacy JWT display hint.
const legacyAgentIdHint = (token) => {
  const payload = String(token ?? '').split('.')[1]
  if (payload === undefined) return undefined
  let decoded
  try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return undefined }
  return typeof decoded.agent === 'string' && decoded.agent.trim() !== '' ? decoded.agent : undefined
}
const MODEL_KEY = process.env.ANTHROPIC_API_KEY ?? process.env.RULITH_MODEL_KEY ?? ''
const MODEL = process.env.RULITH_MODEL ?? 'claude-sonnet-5'
const MODEL_URL_INPUT = process.env.RULITH_MODEL_URL ?? 'https://api.anthropic.com/v1/messages'
const MAX_ROUNDS = envNumber('RULITH_MAX_ROUNDS', 12, { min: 1, max: 1000 })
const LOCAL_REQUEST_MAX_BODY = 64 * 1024
const SERVE_PORT = envNumber('RULITH_SERVE_PORT', 7799, { min: 1, max: 65_535 })
const SERVE_KEY = (process.env.RULITH_SERVE_KEY ?? '').trim() || randomUUID().replace(/-/g, '')
const SERVE_RUNS_MAX = envNumber('RULITH_SERVE_RUNS', 200, { min: 1, max: 100_000 })
// 会话槽上界(只数 sessionKey 槽,缺省槽不占位): 一个进程服务几万客户、活跃 1% 是这个形态的常态,
// 内存里的转录必须有上界。到界优先 LRU 驱逐没有活跃 Case 的闲置槽；若只能回收一个
// 已被用户放弃的闲置对话，则不改变 Board 上的 Case 状态，而是把 Case ID 写入事件与 run
// 记录后脱离本地转录。运行中的槽绝不被驱逐；若所有槽都在忙，新会话 fail visibly。
const SERVE_SLOTS_MAX = envNumber('RULITH_SERVE_SLOTS_MAX', 64, { min: 1, max: 10_000 })
// sessionKey 长度上限: 它要参与板名推导,也要当 Map 键。**教学拒不截断**——静默截断会把两个
// 不同客户的长 key 折成同一块板(串板),那比拒绝一单严重得多。
const SESSION_KEY_MAX = 128
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`rulith-agent — local Agent Runtime for Rulith Cloud

Usage:
  node agent/rulith-agent.mjs [options] [task]

Options:
  --serve            Accept tasks through the local service endpoint
  --case <id>        Select a running Case or resume a paused Case for the first message
  --case-type <id>   Case Type from the installed Capability catalog (default: exploration)
  --business-key <json>  Contract business-key values, for example {"job_id":"calc-001"}
  --shadow           Run the configured shadow verification path
  -h, --help         Show this help without requiring credentials

Required environment:
  RULITH_TOKEN       Agent token from Console

Common optional environment:
  RULITH_URL         Cloud API base (default: https://api.rulith.ai)
  RULITH_MODEL       Model identifier
  RULITH_MODEL_URL   Model API endpoint
  RULITH_MODEL_KEY   Provider key (optional only for a loopback model endpoint)
  RULITH_MAX_ROUNDS  Maximum model/tool turns per user message (default: 12)
  RULITH_MODEL_TOOLS emulated = describe the same tools in the prompt, for an endpoint
                     that rejects tool definitions (also auto-detected on HTTP 400)
  RULITH_SERVE_PORT  Local task endpoint port (default: 7799)
`)
  process.exit(0)
}
let withShadow = false
let withServe = (process.env.RULITH_SERVE ?? '') === 'on'
/** Resume one existing Case Context for the first segment only. */
let resumeCase = (process.env.RULITH_RESUME_CASE ?? '').trim()
let selectedCaseType = (process.env.RULITH_CASE_TYPE ?? 'exploration').trim() || 'exploration'
/**
 * Whether the operator pinned a Case Type, rather than falling back to the default.
 *
 * `OpenCase` offers `caseType` on the model surface, and with nothing pinned the model
 * may choose from its Agent's catalogue. But a Case Type is a governance contract, so an
 * operator who named one on the command line or in the environment has selected it: a
 * model turn — which can carry a task description, a document, or a tool result — must
 * not be able to move governed work onto a different contract by asking.
 */
let caseTypePinned = (process.env.RULITH_CASE_TYPE ?? '').trim() !== ''
let selectedBusinessKeyRaw = (process.env.RULITH_BUSINESS_KEY_JSON ?? '').trim()
const rest = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--serve') { withServe = true; continue }
  if (argv[i] === '--shadow') { withShadow = true; continue }
  if (argv[i] === '--case' && argv[i + 1] !== undefined) { resumeCase = argv[++i]; continue }
  if (argv[i] === '--case-type' && argv[i + 1] !== undefined) { selectedCaseType = argv[++i]; caseTypePinned = true; continue }
  if (argv[i] === '--business-key' && argv[i + 1] !== undefined) { selectedBusinessKeyRaw = argv[++i]; continue }
  if (argv[i].startsWith('-')) {
    console.error(`Unknown option: ${argv[i]}. Run with --help to see the supported execution surface.`)
    process.exit(1)
  }
  rest.push(argv[i])
}
const TASK = rest.join(' ').trim()
const SERVE = withServe
const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1) }
class AgentCredentialRejectedError extends Error {}
/**
 * A failure that belongs to one task, not to the process.
 *
 * Outside `--serve` a model-provider outage is the whole run, so exiting non-zero is
 * the honest answer for CI and scripts. Inside `--serve` the same outage used to call
 * `process.exit(1)` from inside one queued task: every other queued and in-flight Case
 * was discarded, the HTTP callers that received `202 Queued` never heard anything, and
 * the supervisor saw a clean exit. An unattended server's first duty is to stay up and
 * report the failure of the one thing that failed — `runOne` already records a thrown
 * segment as a completed run with its reason and keeps serving.
 */
const failTask = (msg) => {
  if (SERVE) throw new Error(msg)
  die(msg)
}

const businessKeyOf = (raw, label = 'businessKey') => {
  if (raw === '' || raw === undefined || raw === null) return undefined
  let value = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { die(`${label} must be a JSON object of finite scalar values.`) }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0
    || !Object.values(value).every((v) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) {
    die(`${label} must be a non-empty JSON object whose values are strings, booleans, or finite numbers.`)
  }
  return value
}
const selectedBusinessKey = businessKeyOf(selectedBusinessKeyRaw, 'RULITH_BUSINESS_KEY_JSON / --business-key')

if (TOKEN === '') die('RULITH_TOKEN is missing. Create this Agent\'s MCP token under Agent → Runtime in Console; it is shown only once.')
let agentId = ''
let parsedModelUrl
try { parsedModelUrl = new URL(MODEL_URL_INPUT) } catch { die('RULITH_MODEL_URL must be one absolute HTTP(S) model service URL.') }
if (!['http:', 'https:'].includes(parsedModelUrl.protocol)) die('RULITH_MODEL_URL must use HTTP or HTTPS.')
const keylessLoopbackModel = ['127.0.0.1', 'localhost', '[::1]'].includes(parsedModelUrl.hostname)
if (MODEL_KEY === '' && !keylessLoopbackModel) {
  die('A remote model key is missing. Set ANTHROPIC_API_KEY or RULITH_MODEL_KEY. A key may be omitted only for a loopback model endpoint.')
}
const pathNoSlash = parsedModelUrl.pathname.replace(/\/+$/, '')
const MODEL_URL = pathNoSlash.endsWith('/chat/completions') || pathNoSlash.endsWith('/messages')
  ? parsedModelUrl.toString().replace(/\/$/, '')
  : pathNoSlash === '' ? new URL('/v1/chat/completions', parsedModelUrl).toString()
    : pathNoSlash.endsWith('/v1') ? new URL(`${pathNoSlash}/chat/completions`, parsedModelUrl.origin).toString()
      : die('OpenAI-compatible model service URLs must be the server root, end in /v1, or end in /chat/completions.')
// 无任务=进入多轮对话;带任务=显式 one-shot/autopilot,一次办完后退出(CI/脚本兼容)。
// `--serve` is conversational too: an HTTP message is not authority to create a Case.
// The model chooses whether to call the optional Rulith tool, one step at a time.
const CHAT = TASK === '' && !SERVE
// Case IDs identify accounting, acceptance, distillation, and audit atoms.
// They are not Board IDs: all compatible Cases for an Agent share its Board.
const CASE_PREFIX = ((process.env.RULITH_CASE_PREFIX ?? 'case').replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 24)) || 'case'
let caseSeq = 0
const nextCaseId = () => {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  caseSeq += 1
  return `${CASE_PREFIX}-${ymd}-${String(caseSeq).padStart(2, '0')}-${randomUUID().slice(0, 4)}`
}
// ── 事件总线：终端与界面看同一份流（界面晚开也能补看，历史全留） ──────────
const events = []
const clients = new Set()

// ── Public MCP client ───────────────────────────────────────────────────────
// First-party and third-party Agent hosts cross the exact same tools/list and
// tools/call membrane. The one Agent token is a client configuration secret,
// sent only as an Authorization header; it never appears in a URL.
let mcpSeq = 0
const MCP_RESPONSE_MAX_BYTES = 1_048_576
class McpResponseLimitError extends Error {}
async function readMcpResponseBody(response) {
  const announced = Number(response.headers.get('content-length') ?? 0)
  if (announced > MCP_RESPONSE_MAX_BYTES) {
    await response.body?.cancel()
    throw new McpResponseLimitError(`MCP response exceeded the ${MCP_RESPONSE_MAX_BYTES}-byte limit`)
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MCP_RESPONSE_MAX_BYTES) {
      await reader.cancel()
      throw new McpResponseLimitError(`MCP response exceeded the ${MCP_RESPONSE_MAX_BYTES}-byte limit`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}
async function mcpRpc(method, params = {}, { timeoutMs = 45_000 } = {}) {
  let response
  let raw
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  try {
    response = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        connection: 'close',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: `runtime_${++mcpSeq}`, method, params }),
      signal: controller.signal,
    })
    // Keep the same deadline over the response body. `fetch` resolves as soon as headers
    // arrive; clearing here left a peer free to send 200 and hold `response.text()` forever.
    try {
      raw = await readMcpResponseBody(response)
    } catch (error) {
      // Status is already authoritative. Preserve the credential-specific 401 teaching
      // even if its optional body is truncated or fails while being read.
      if (response.status === 401) raw = ''
      else throw error
    }
  } catch (error) {
    if (error instanceof McpResponseLimitError) throw error
    throw new Error(`Cannot reach the public MCP endpoint ${MCP_URL}: ${error?.cause?.code ?? error?.message ?? error}`)
  } finally {
    clearTimeout(timeout)
  }
  let body
  try { body = JSON.parse(raw) } catch { body = undefined }
  if (response.status === 401) throw new AgentCredentialRejectedError(`Agent MCP token rejected (401): ${body?.teaching ?? 'rotate the Agent token in Console and update this client configuration.'}`)
  if (!response.ok || body === undefined || body.error !== undefined) {
    const teaching = body?.error?.message ?? body?.teaching ?? raw.replace(/\s+/g, ' ').trim().slice(0, 240)
    throw new Error(`MCP ${method} failed (HTTP ${response.status}): ${teaching || 'empty response'}`)
  }
  return body.result
}

// ── Public MCP tool surface ─────────────────────────────────────────────────
//
// `tools/list` is the whole discovery step. This runtime is an ordinary MCP client of
// the same six tools every third-party client sees: four model verbs and two host
// tools. Nothing here is privileged, and nothing is invented — a tool the authority
// does not advertise cannot be reached from this process at all.
//
// The four names are the machine authority's own (`agentVerb: true` in
// protocol/operations.json). This list is the vendored copy of it; RT-TOOLS-1 compares
// the two, so a fifth verb appearing on either side turns a guard red instead of
// quietly widening what one model turn is allowed to say.
const MODEL_VERBS = ['OpenCase', 'ApplyBatch', 'ApplyAction', 'CloseCase']
const HOST_TOOLS = ['GetCompletion', 'agent_protocol']
/**
 * Fields the host owns, removed from every schema the model sees.
 *
 * Case identity, request identity, revision and epoch are the host's side of the
 * contract: it fills them from its own Case context on every call. Leaving them in the
 * advertised schema would teach the model to address a Case, present a revision it
 * never saw, or mint an identity — and a model that can name another Case can reach
 * work that was never handed to it.
 */
const HOST_OWNED_TOOL_FIELDS = ['case', 'requestId', 'expectedRevision', 'expectedBoardSharedEpoch']
/** Strip host-owned properties at any depth: a nested copy is as reachable as a top-level one. */
function withoutHostFields(schema) {
  if (Array.isArray(schema)) return schema.map(withoutHostFields)
  if (schema === null || typeof schema !== 'object') return schema
  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.properties = Object.fromEntries(Object.entries(value)
        .filter(([name]) => !HOST_OWNED_TOOL_FIELDS.includes(name))
        .map(([name, child]) => [name, withoutHostFields(child)]))
      continue
    }
    if (key === 'required' && Array.isArray(value)) {
      out.required = value.filter((name) => !HOST_OWNED_TOOL_FIELDS.includes(String(name)))
      continue
    }
    out[key] = withoutHostFields(value)
  }
  return out
}
/** A public surface that cannot serve this client. It is not a credential failure. */
class McpSurfaceError extends Error {}
let mcpSurfacePromise
/** The four model-facing tools, in the order the authority names them. */
let modelTools = []
async function requirePublicMcpSurface() {
  mcpSurfacePromise ??= (async () => {
    const listed = await mcpRpc('tools/list')
    const advertised = new Map((Array.isArray(listed?.tools) ? listed.tools : [])
      .filter((tool) => typeof tool?.name === 'string' && tool.name !== '')
      .map((tool) => [String(tool.name), tool]))
    const missing = [...MODEL_VERBS, ...HOST_TOOLS].filter((name) => !advertised.has(name))
    if (missing.length > 0) {
      throw new McpSurfaceError(`The public MCP endpoint does not advertise ${missing.join(', ')} in tools/list.`
        + ' Upgrade the Cloud endpoint. This Runtime will not fall back to a native privileged route,'
        + ' and it will not offer the model a tool the authority never advertised.')
    }
    modelTools = MODEL_VERBS.map((name) => {
      const tool = advertised.get(name)
      return {
        name,
        description: String(tool.description ?? `Rulith Board ${name}`).slice(0, 1024),
        schema: withoutHostFields(tool.inputSchema ?? tool.input_schema ?? { type: 'object', properties: {} }),
      }
    })
  })()
  return await mcpSurfacePromise
}

async function mcpTool(name, args = {}, options = {}) {
  await requirePublicMcpSurface()
  const result = await mcpRpc('tools/call', { name, arguments: args }, options)
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter((item) => item?.type === 'text').map((item) => String(item.text ?? '')).join('\n')
  if (text === '') throw new Error(`MCP tool ${name} returned no text result.`)
  return text
}

async function agentProtocol(mode, args = {}, options = {}) {
  const text = await mcpTool('agent_protocol', { mode, ...args }, options)
  try { return JSON.parse(text) } catch { throw new Error(`agent_protocol returned invalid JSON: ${text.slice(0, 240)}`) }
}

/**
 * One `requestId` per board submission, reused by an unchanged retry.
 *
 * When the MCP hop fails there is no authoritative receipt: the runtime cannot tell a
 * request that never arrived from one that was applied and whose answer was lost, and
 * it tells the model to "retry unchanged". Without a caller-supplied identity, an
 * upstream idempotency cache has to key on whatever it can reconstruct, and a retried
 * write can be applied twice. The id is minted per distinct submission payload and
 * held until an authoritative answer arrives, so:
 *   · retrying the same submission after a transport failure reuses the id;
 *   · a genuinely new submission with identical bytes (the next round's Case View read,
 *     a second identical batch) gets a fresh one, because the previous id was released
 *     when the Board answered.
 *
 * Older Cloud endpoints accept the field and ignore it: `agent_protocol` validates a
 * non-strict object, so an unknown property is dropped rather than refused.
 */
const REQUEST_IDS_MAX = 256
const requestIds = new Map()
const submissionKey = (value) => JSON.stringify(value, (_key, item) =>
  (item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]]))
    : item))
function requestIdFor(key) {
  const held = requestIds.get(key)
  if (held !== undefined) return held
  const minted = randomUUID()
  requestIds.set(key, minted)
  // The map is a retry ledger, not a history. Bound it: a runtime whose upstream is
  // down must not grow one entry per attempt for the life of the process.
  while (requestIds.size > REQUEST_IDS_MAX) requestIds.delete(requestIds.keys().next().value)
  return minted
}
function emit(type, data) {
  const ev = { t: Date.now(), type, ...data }
  if (process.env.RULITH_LOCAL_EVENTS === 'ipc' && typeof process.send === 'function') {
    try { process.send({ protocol: 'rulith-local-event', event: ev }) } catch { /* Local display must never block a Case. */ }
  } else {
    events.push(ev)
    if (events.length > 2000) events.splice(0, events.length - 1500)
    const line = `data: ${JSON.stringify(ev)}\n\n`
    for (const res of clients) { try { res.write(line) } catch { clients.delete(res) } }
  }
  // Lifecycle observations serve the local inspector, not a second cloud state feed.
  if (type !== 'case-state') traceForward(ev)
}

// ── 事件上云（实时交互，2026-08-18）: 控制台智能体页「实时交互」面板的喂料 ──
// RULITH_TRACE=off 关。fire-and-forget 批量（1.5s 或攒到 50 条），失败静默丢——
// 上报是视窗不是义务，绝不拦办案主流程，也绝不重试成风暴。
// 体积纪律: propose 的 ops 全文**不出进程**（只带条数 opsN）;长文本截断;
// start/end 的板面投影不上传（板上真有什么，控制台自己会去板上读）。
const TRACE_ON = (process.env.RULITH_TRACE ?? '') !== 'off'
/**
 * Trace is a window, not an obligation — and it may not become the reason a run is
 * still alive. Two handles held the process open after the work was finished:
 *
 *   · the 1.5s batching timer. It is a plain `setTimeout`, so a one-shot run that
 *     emitted its `end` event 40ms before finishing waited out the full window before
 *     exiting. A run that took ~150ms to do its work took ~1600ms to leave;
 *   · the flush's own request. `mcpRpc`'s 45s abort timer is unref'd, but the socket
 *     under an in-flight `fetch` is not, so a trace endpoint that accepted the
 *     connection and never answered kept the process up until that abort fired.
 *
 * So: the timer is unref'd (a pending batch never delays exit on its own) and the
 * request carries its own short bound. The one-shot path flushes explicitly when the
 * run ends, which is what keeps the last events from being dropped by the unref.
 */
const TRACE_FLUSH_TIMEOUT_MS = 1500
let traceBuf = []
let traceTimer = null
function traceForward(ev) {
  if (!TRACE_ON) return
  const e = { ...ev }
  if (Array.isArray(e.ops)) { e.opsN = e.ops.length; delete e.ops }
  for (const k of ['say', 'text', 'note']) if (typeof e[k] === 'string' && e[k].length > 400) e[k] = e[k].slice(0, 400) + '…'
  if (typeof e.teaching === 'string' && e.teaching.length > 300) e.teaching = e.teaching.slice(0, 300) + '…'
  if (typeof e.projection === 'string') delete e.projection
  if (Array.isArray(e.notes)) e.notes = e.notes.map((n) => String(n).slice(0, 200)).slice(0, 8)
  traceBuf.push(e)
  if (traceBuf.length >= 50) flushTrace()
  else if (traceTimer === null) { traceTimer = setTimeout(flushTrace, 1500); traceTimer.unref?.() }
}
function flushTrace() {
  if (traceTimer !== null) { clearTimeout(traceTimer); traceTimer = null }
  if (traceBuf.length === 0) return
  const batch = traceBuf.splice(0, 200)
  agentProtocol('trace', { events: batch }, { timeoutMs: TRACE_FLUSH_TIMEOUT_MS }).catch(() => {})
}
/** 段内事件带上**槽/任务**标注(2026-08-07 跨槽并发): 一条 SSE 流上现在会有几个段交叉着发
 *  round/propose/verdict,不标注的话读流的人分不清哪一行属于哪位客户。缺省槽不带 `session`
 *  字段——不带 sessionKey 的形态下事件形状与从前逐字节一致(旧 UI/旧测试零回归)。 */
const emitOn = (ctx, type, data) => emit(type, {
  ...(ctx.key === '' ? {} : { session: ctx.key }),
  ...(ctx.taskId === undefined ? {} : { task: ctx.taskId }),
  // 板名随段事件走(2026-08-18): 云上「处理记录」按板合流,不带板的 round/propose/verdict
  // 到了那边就归不进任何一件案卷。data 里已带 board 的事件(case-open 等)以 data 为准。
  ...(ctx.board === undefined || ctx.board === '' ? {} : { board: ctx.board }),
  ...data,
})

// ── Host protocol path ────────────────────────────────────────────────────
//
// The four model verbs travel as MCP tool calls. What is left here are the operations
// the *host* performs and the model is never taught: reading the Board Manifest, arming
// verification, and resuming a Case the operator selected.
//
// Which of them carry a Case envelope is not a style choice. `RunDischarge` is
// CaseRequired. `GetBoardManifest` is CaseOptional and is read here for Board-level
// facts — the Case list and the legislation lock — so binding it would scope the answer
// to one Case and quietly answer a different question. `ResumeCase` is BoardOnly: the
// Case is its subject, not its execution scope, and a binding on it is a protocol error.
const CASE_CONTEXT_OPERATIONS = new Set(['RunDischarge'])
const STALE_CASE = new Set(['stale_case_revision', 'case_paused', 'case_closed', 'unknown_case'])
/** The only Case command adapter in the runtime. It calls the public MCP tool
 * advertised to every client; Agent and Case identities never enter the URL. */
async function board(operation, ctx, staleRetries = 5) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.board !== 'string' || ctx.board === '') {
    throw new Error(`board(): missing execution context for ${String(operation?.kind ?? '?')}.`)
  }
  const bound = CASE_CONTEXT_OPERATIONS.has(String(operation?.kind ?? '')) ? ctx.case : undefined
  const submission = {
    operation,
    ...(bound !== undefined ? { case: { id: bound.id, expectedRevision: bound.revision } } : {}),
  }
  // expectedRevision is an optimistic-concurrency precondition, not request
  // identity. If a write commits but its response is lost, the next Case read
  // advances this value. The unchanged retry must still present the original
  // requestId so Core can replay its authoritative receipt instead of executing
  // an outward action twice.
  const idKey = `${ctx.board}\u0000${bound?.id ?? ''}\u0000${submissionKey(operation)}`
  const requestId = requestIdFor(idKey)
  let r
  let authoritative = true
  try {
    r = await agentProtocol('board', { ...submission, requestId })
  } catch (error) {
    const teaching = String(error?.message ?? error)
    if (error instanceof AgentCredentialRejectedError) throw error
    authoritative = false
    r = {
      accepted: false,
      errorCode: 'upstream_unavailable',
      teaching: `The public MCP hop failed; no authoritative receipt was returned. Retry unchanged. ${teaching.slice(0, 240)}`,
    }
  }
  if (typeof r?.accepted !== 'boolean' && typeof r?.errorCode !== 'string') {
    authoritative = false
    r = { accepted: false, errorCode: 'upstream_unavailable', teaching: 'agent_protocol returned no authoritative receipt. Retry unchanged.' }
  }
  // Release the id only once the Board has actually answered. While the answer is
  // unknown the submission is still in flight, and the next unchanged attempt must
  // present the same identity.
  if (transportAmbiguous(r)) authoritative = false
  if (authoritative) requestIds.delete(idKey)
  if (!authoritative && ctx.case !== undefined) observeCase(ctx, ctx.case.id, 'unavailable', undefined, 'unknown')
  if (authoritative && bound !== undefined && STALE_CASE.has(String(r?.errorCode ?? ''))) {
    const observedStatus = r.errorCode === 'case_closed' ? 'closed' : r.errorCode === 'case_paused' ? 'paused' : 'unavailable'
    observeCase(ctx, bound.id, observedStatus)
    ctx.case = undefined
    if (staleRetries > 0) {
      const manifest = await board({ kind: 'GetBoardManifest' }, ctx, 0)
      const current = (manifest.payload?.cases ?? []).find((candidate) => candidate?.id === bound.id && candidate?.status === 'running')
      if (current !== undefined && current.root === bound.root && current.caseType === bound.caseType && typeof current.revision === 'string' && current.revision !== '') {
        ctx.case = { ...bound, revision: current.revision }
        observeCase(ctx, bound.id, current.status)
        return await board(operation, ctx, staleRetries - 1)
      }
    }
  }
  if (bound !== undefined && r?.accepted === true && typeof r.caseRevision === 'string') {
    ctx.case = { ...bound, revision: r.caseRevision }
  }
  return r
}
/**
 * Bring a paused Case back to running, or report why it cannot be.
 *
 * A paused Case used to be a dead end for this runtime: `PauseCase` is issued
 * elsewhere, `ResumeCase` appeared nowhere, and `--case <id>` on a paused Case fell
 * through the "running" filter to `OpenCase`, which answered `id_reused`. The Case was
 * recoverable in the Console and unreachable from the thing that had been working it.
 *
 * `ResumeCase` is `caseContext: "boardOnly"` in the protocol registry
 * (`protocol/operations.json`): it takes `caseId` on the operation and must not carry a
 * `case: {id, expectedRevision}` binding — the Case is not the execution scope of the
 * command that resumes it. `CASE_CONTEXT_OPERATIONS` therefore does not list it, and
 * `board()` attaches no binding. The revision is read back from the Board Manifest
 * afterwards rather than assumed, so a resume that did not actually take is visible.
 *
 * Returns the manifest row of the now-running Case, or undefined.
 */
async function resumePausedCase(ctx, caseId) {
  const before = await board({ kind: 'GetBoardManifest' }, ctx)
  if (before.accepted !== true) return undefined
  const paused = (before.payload?.cases ?? []).find((row) => row?.id === caseId && row?.status === 'paused')
  if (paused === undefined) return undefined
  const resumed = await board({ kind: 'ResumeCase', caseId }, ctx)
  if (resumed.accepted !== true) {
    log(`✗ Case "${caseId}" is paused and could not be resumed: ${String(resumed.teaching ?? resumed.errorCode ?? '').slice(0, 240)}`)
    return undefined
  }
  const after = await board({ kind: 'GetBoardManifest' }, ctx)
  if (after.accepted !== true) return undefined
  const running = (after.payload?.cases ?? []).find((row) => row?.id === caseId && row?.status === 'running')
  if (running === undefined) {
    log(`✗ ResumeCase for "${caseId}" was accepted, but the Board Manifest still does not report it as running. Inspect the Case in Console.`)
    return undefined
  }
  log(`◎ Resumed paused Case "${caseId}" on Agent Board "${ctx.board}".`)
  return running
}

/** Select a Case that is already running, or resume it when it is paused. */
async function selectExistingCase(ctx, caseId) {
  const manifest = await board({ kind: 'GetBoardManifest' }, ctx)
  if (manifest.accepted !== true) return undefined
  const row = (manifest.payload?.cases ?? []).find((candidate) => candidate?.id === caseId)
  if (row?.status === 'running') {
    log(`◎ Selected running Case "${caseId}" on Agent Board "${ctx.board}".`)
    return row
  }
  if (row?.status === 'paused') return await resumePausedCase(ctx, caseId)
  if (row !== undefined) log(`✗ Case "${caseId}" is ${String(row.status)} and cannot be selected for execution.`)
  else log(`✗ Case "${caseId}" was not found on Agent Board "${ctx.board}".`)
  return undefined
}

/** Bind one manifest row as this segment's Case Context, refusing an identity mismatch. */
function bindCaseRow(ctx, caseId, caseType, row) {
  if (row.root !== caseId) {
    log(`✗ Case Context "${caseId}" has root "${String(row.root)}". Case identity and acceptance root must be identical.`)
    return undefined
  }
  if (row.caseType !== caseType) {
    log(`✗ Case Context "${caseId}" is pinned to Case Type "${String(row.caseType)}", not "${caseType}".`)
    return undefined
  }
  ctx.case = { id: caseId, root: caseId, revision: String(row.revision), caseType,
    capabilityReleaseDigest: String(row.capabilityReleaseDigest), caseContractDigest: String(row.caseContractDigest) }
  observeCase(ctx, caseId, row.status)
  return ctx.case
}

// ── The bounded Case View ───────────────────────────────────────────────────
//
// Every tool result carries it (board-protocol-spec §6.0b): goal, state, certified,
// floor, frontier, acceptance, missingEvidence, blocked, hypotheses, inFlight, actions.
// So the host never reads the Board a second time to learn what just happened, and it
// ranks nothing locally. `floor` is a string the authority chose. The table of tiers
// that used to live here had to be edited whenever Core added one, and an unknown tier
// read as the weakest — a silent downgrade in the direction that looks safe.
const viewOf = (result) => (result?.view !== null && typeof result?.view === 'object' ? result.view : undefined)
const listOf = (view, key) => (Array.isArray(view?.[key]) ? view[key] : [])
/** Dispatched and unreceipted work. The host waits on this; the model is never asked to. */
const inFlightOf = (view) => listOf(view, 'inFlight')
const certifiedOf = (view) => view?.certified === true
const viewText = (view) => (view === undefined ? '(no Case View was returned)' : JSON.stringify(view, null, 2))
/** How long the host will wait for other people's work before spending a model turn. */
const SETTLE_WAIT_MS = envNumber('RULITH_SETTLE_WAIT_MS', 60_000, { min: 0, max: 3_600_000 })
const SETTLE_POLL_MS = 1000

/** One bounded local snapshot, without protocol cursors or inferred lifecycle changes. */
function observeCase(ctx, caseId, caseStatus, view, contact = 'observed') {
  const observation = { caseId, caseStatus,
    ...(typeof view?.certified === 'boolean' ? { certified: view.certified } : {}),
    ...(typeof view?.floor === 'string' ? { floor: view.floor } : {}),
    ...(contact === 'unknown' ? { contact } : {}) }
  const identity = JSON.stringify(observation)
  if (ctx.lastCaseObservation === identity) return
  ctx.lastCaseObservation = identity
  emitOn(ctx, 'case-state', observation)
}

/** Track the authority's Case pointer and wire revision; a closed Case clears it. */
function trackCase(ctx, result) {
  const bound = result?.case
  if (bound === null || typeof bound !== 'object') return
  const id = String(bound.id ?? '')
  if (id === '') return
  // A refused opening can describe a Case without selecting it. A refusal for the
  // already selected Case may still carry its authoritative state (e.g. stale).
  if (result.accepted !== true && ctx.case?.id !== id) return
  const status = ['open', 'running', 'paused', 'closed', 'archived'].includes(bound.status)
    ? bound.status : 'unavailable'
  observeCase(ctx, id, status, result?.view)
  if (status === 'closed' || status === 'archived') {
    if (ctx.case !== undefined) {
      const disposition = String(result?.receipt?.disposition ?? bound.disposition ?? 'closed')
      log(`◎ Closed Case "${id}" with disposition "${disposition}". Its record remains available in Console.`)
      emitOn(ctx, 'case-closed', { caseId: id, disposition })
    }
    ctx.case = undefined
    return
  }
  ctx.case = {
    id,
    root: String(bound.root ?? ctx.case?.root ?? id),
    revision: String(bound.revision ?? ctx.case?.revision ?? ''),
    caseType: String(bound.caseType ?? ctx.case?.caseType ?? selectedCaseType),
  }
}

const transportAmbiguous = (value) => value?.errorCode === 'upstream_unavailable'
const transportRetryTeaching = (value) => 'No authoritative Board receipt was returned, so the outcome of this step is'
  + ' unknown. This is not a refusal. Retry the identical step so it keeps the same request identity; do not change'
  + ` the body and do not infer that it failed. ${String(value?.teaching ?? '').slice(0, 320)}`

/**
 * Call one advertised tool the way any MCP client would, with the two things the host
 * owns attached: the Case envelope and the request identity.
 *
 * `requestId` is minted per distinct submission and held until the Board answers, so a
 * retry after a failed hop reaches the same idempotency slot instead of applying an
 * outward action twice. `OpenCase` deliberately carries no Case envelope: the Case it
 * asks for does not exist yet, and presenting the previous one would bind new work to
 * the wrong context.
 */
async function callTool(name, input, ctx) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.board !== 'string' || ctx.board === '') {
    throw new Error(`callTool(): missing execution context for ${String(name)}.`)
  }
  const bound = name === 'OpenCase' ? undefined : ctx.case
  const idKey = `${ctx.board}\u0000${bound?.id ?? ''}\u0000${name}\u0000${submissionKey(input)}`
  const requestId = requestIdFor(idKey)
  const args = {
    ...input,
    ...(bound === undefined ? {} : { case: { id: bound.id, expectedRevision: bound.revision } }),
    requestId,
  }
  let result
  let text = ''
  let authoritative = true
  try {
    text = await mcpTool(name, args)
    try { result = JSON.parse(text) } catch { result = undefined }
    if (result === null || typeof result !== 'object' || Array.isArray(result)) result = undefined
  } catch (error) {
    if (error instanceof AgentCredentialRejectedError) throw error
    authoritative = false
    result = { accepted: false, errorCode: 'upstream_unavailable', teaching: String(error?.message ?? error).slice(0, 320) }
  }
  if (result === undefined || (typeof result.accepted !== 'boolean' && typeof result.errorCode !== 'string')) {
    authoritative = false
    result = { accepted: false, errorCode: 'upstream_unavailable', teaching: `${name} returned no authoritative receipt.` }
  }
  // Release the identity only once the Board has actually answered. While the answer is
  // unknown the submission is still in flight and the next attempt must present the same id.
  // The Gateway can return an MCP result with this code after losing the Core
  // response. A successful HTTP/MCP hop is not itself a Board receipt.
  if (transportAmbiguous(result)) authoritative = false
  if (authoritative) requestIds.delete(idKey)
  if (!authoritative) text = JSON.stringify({ ...result, teaching: transportRetryTeaching(result) })
  const previous = bound?.revision
  if (authoritative) trackCase(ctx, result)
  else if (ctx.case !== undefined) observeCase(ctx, ctx.case.id, 'unavailable', undefined, 'unknown')
  // A stale revision is not retried here. The Case moved under the model — a Worker
  // receipt landed, a discharge ran, another session wrote — and the step it just chose was
  // formed against a view that no longer holds. Replaying that step against the new
  // revision would be the host judging on the model's behalf. The refusal already carries
  // the current view, so the model re-reads and decides again; only a transport failure
  // (no authoritative answer) is retried, and then unchanged, with the same requestId.
  void previous
  return { result, text, authoritative, view: viewOf(result) }
}

/**
 * The host's own read of the bounded Case View.
 *
 * `GetCompletion` is a host tool, not a model verb: waiting, polling and resuming are
 * mechanics, and a model taught to poll spends a full model call saying "still waiting".
 */
async function hostView(ctx) {
  if (ctx.case === undefined) return undefined
  let answer = await callTool('GetCompletion', {}, ctx)
  // Older Cloud builds bind the read to the Case envelope; newer ones also accept the
  // acceptance root explicitly. Ask again with the root rather than reporting no view.
  if (answer.result?.accepted !== true && String(answer.result?.errorCode ?? '') === 'bad_command') {
    answer = await callTool('GetCompletion', { root: ctx.case.root }, ctx)
  }
  return answer.view
}

/**
 * Verification discharge is a mechanical step, not a model verb (spec §6.0b): the host
 * arms it once obligations are clear. It travels the host protocol path, so it never
 * appears in the model's tool list and the model is never taught to trigger it.
 */
async function runDischarge(ctx, view) {
  if ((process.env.RULITH_AUTO_DISCHARGE ?? '') === 'off') return ''
  const root = String(view?.goal ?? ctx.case?.root ?? '')
  if (root === '') return ''
  const answer = await board({ kind: 'RunDischarge', root }, ctx)
  if (answer.accepted !== true) {
    // A refused discharge is never silent: "no verification bridge installed" is the
    // most common cause, and the authority's own words are the interface.
    const note = `[Verification rejected] ${String(answer.teaching ?? answer.errorCode ?? '').slice(0, 180)}`
    log(note)
    emitOn(ctx, 'discharge', { notes: [note] })
    return note
  }
  const gaps = Array.isArray(answer.payload?.gaps) ? answer.payload.gaps : []
  const note = gaps.length === 0
    ? '[Verification] every acceptance leaf is closed'
    : `[Verification] still open: ${gaps.map((gap) => String(gap.node ?? '')).filter(Boolean).join(' · ')}`
  log(note)
  emitOn(ctx, 'discharge', { notes: [note] })
  return note
}

/**
 * Host settlement: wait for what someone else is doing, then arm verification once.
 *
 * A dispatched Action or a verification work item takes seconds to tens of seconds, and
 * every round spent asking the model about it is a full model call that produces
 * nothing. The host waits instead — reading the same bounded view the model would see —
 * and the model is woken with the landed result. The expensive thing is the model turn,
 * not the HTTP hop.
 */
async function settle(ctx, view) {
  let current = view ?? await hostView(ctx)
  const notes = []
  let waited = false
  if (ctx.case === undefined) return { view: current, notes, waited }
  const until = Date.now() + SETTLE_WAIT_MS
  let announced = false
  let discharged = false
  for (;;) {
    if (certifiedOf(current)) break
    if (inFlightOf(current).length > 0) {
      if (Date.now() >= until) break
      if (!announced) { log('◌ Waiting locally for receipts; no model turn is being consumed.'); announced = true }
      waited = true
      await new Promise((ready) => setTimeout(ready, SETTLE_POLL_MS))
      current = (await hostView(ctx)) ?? current
      continue
    }
    if (discharged) break
    discharged = true
    const note = await runDischarge(ctx, current)
    // Nothing was armed (discharge disabled, or no acceptance root yet), so re-reading
    // the view would spend a round trip to learn what this loop already knows.
    if (note === '') break
    notes.push(note)
    waited = true
    current = (await hostView(ctx)) ?? current
  }
  if (announced) log(`◌ Settlement complete (certified=${certifiedOf(current)} · ${String(current?.state ?? '')}). The next model turn receives the landed result.`)
  if (current !== undefined) {
    emitOn(ctx, 'board', {
      caseId: ctx.case?.id, certified: certifiedOf(current), floor: String(current.floor ?? '—'),
      state: String(current.state ?? ''),
    })
  }
  return { view: current, notes, waited }
}

// ── Model client (your key, straight to your model service; Rulith never sees it) ──
//
// Native tool use is the model surface. The four schemas the authority advertises are
// the templates, so this runtime never writes a second grammar for the model to get
// subtly wrong — the last one was a fenced-JSON dialect whose templates the client's own
// parser could not read back, and four real runs dispatched nothing at all.
//
// Two provider shapes are spoken directly: Anthropic Messages (`tools` with
// `input_schema`, `tool_use` blocks, `tool_result` replies) and OpenAI Chat Completions
// (`tools` with `function.parameters`, `tool_calls`, role `tool` replies). An endpoint
// that rejects `tools` outright gets the emulated transport: the same schemas rendered
// into the system prompt, one JSON object read back as one call. That is a transport,
// not a second surface — the names, the schemas and the refusals are identical.
const MAIN_CFG = { url: MODEL_URL, key: MODEL_KEY, model: MODEL }
const SHADOW_CFG = {
  url: process.env.RULITH_SHADOW_URL ?? MODEL_URL,
  key: process.env.RULITH_SHADOW_KEY ?? MODEL_KEY,
  model: process.env.RULITH_SHADOW_MODEL ?? MODEL,
}
const openaiStyle = (cfg) => /\/chat\/completions\/?$/.test(cfg.url)
/** Emulation is sticky once chosen: a mixed transcript is a malformed one. */
let emulatedTools = (process.env.RULITH_MODEL_TOOLS ?? '') === 'emulated'
let emulatedSeq = 0

// The transcript is kept in one neutral shape and rendered per provider at send time.
// Holding provider-shaped messages instead would make the fallback below unusable: the
// turns already recorded in one dialect cannot be replayed in another.
const userEntry = (text) => ({ role: 'user', text: String(text) })
const assistantEntry = (text, toolCalls = []) => ({ role: 'assistant', text: String(text ?? ''), toolCalls })
const resultsEntry = (results) => ({ role: 'tool_results', results })

function renderMessages(entries, style) {
  const out = []
  for (const entry of entries) {
    if (entry.role === 'user') {
      out.push(style === 'anthropic' ? { role: 'user', content: [{ type: 'text', text: entry.text }] } : { role: 'user', content: entry.text })
      continue
    }
    if (entry.role === 'assistant') {
      const calls = Array.isArray(entry.toolCalls) ? entry.toolCalls : []
      if (style === 'anthropic') {
        const content = []
        if (entry.text !== '') content.push({ type: 'text', text: entry.text })
        for (const call of calls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} })
        out.push({ role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '(no content)' }] })
        continue
      }
      if (style === 'openai') {
        out.push({
          role: 'assistant',
          // `null` content is only legal beside tool_calls. A turn with neither is a
          // model that answered nothing, and the endpoint refuses the whole request.
          content: entry.text !== '' ? entry.text : calls.length === 0 ? '(no content)' : null,
          ...(calls.length === 0 ? {} : { tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } })) }),
        })
        continue
      }
      const spoken = calls.map((call) => JSON.stringify({ tool: call.name, input: call.input ?? {} })).join('\n')
      out.push({ role: 'assistant', content: [entry.text, spoken].filter((part) => part !== '').join('\n') || '(no content)' })
      continue
    }
    const results = Array.isArray(entry.results) ? entry.results : []
    if (style === 'anthropic') {
      out.push({ role: 'user', content: results.map((result) => ({ type: 'tool_result', tool_use_id: result.id, content: result.text })) })
      continue
    }
    if (style === 'openai') {
      for (const result of results) out.push({ role: 'tool', tool_call_id: result.id, content: result.text })
      continue
    }
    out.push({ role: 'user', content: results.map((result) => `[${result.name} result]\n${result.text}`).join('\n\n') })
  }
  return out
}

/**
 * Fold adjacent same-role messages into one.
 *
 * The Anthropic wire expects alternating turns, and the loop legitimately produces two
 * user messages in a row — the tool results, then what the host settled while the model
 * was not being asked. Merging here means the loop never has to think about it, and no
 * future caller can reintroduce the malformed shape by pushing one more message.
 */
function mergeAdjacent(messages) {
  const out = []
  for (const message of messages) {
    const previous = out[out.length - 1]
    if (previous === undefined || previous.role !== message.role || previous.tool_calls !== undefined) { out.push(message); continue }
    if (Array.isArray(previous.content) && Array.isArray(message.content)) previous.content = [...previous.content, ...message.content]
    else if (typeof previous.content === 'string' && typeof message.content === 'string') previous.content = `${previous.content}\n\n${message.content}`
    else out.push(message)
  }
  return out
}

/** The emulated transport's only addition: the same schemas, described instead of sent. */
const emulatedToolGuide = (tools) => [
  'This model endpoint cannot receive tool definitions, so the same tools are described here.',
  'To call one, reply with exactly one JSON object and nothing else: {"tool":"<name>","input":{...}}',
  'To answer instead, reply with ordinary text and no JSON object.',
  '',
  ...tools.map((tool) => `${tool.name}: ${tool.description}\ninput schema: ${JSON.stringify(tool.schema)}`),
].join('\n')

/**
 * The first number literal in a JSON text that the exact number domain cannot hold, or
 * undefined. The Board holds integers within ±(2^53 − 1) and finite numbers only
 * (exact-or-fail), and a literal beyond that has already lost precision by the time
 * `JSON.parse` returns — 9007199254740993 comes back as 9007199254740992 — so the look
 * happens on the text, before parsing. Strings are skipped: a number inside a string is
 * text, and writing a large identifier as a string is exactly what the teaching asks for.
 */
export function inexactNumberLiteral(text) {
  const s = String(text ?? '')
  const number = /-?\d+(\.\d+)?([eE][+-]?\d+)?/y
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '"') {
      i += 1
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      number.lastIndex = i
      const m = number.exec(s)
      if (m === null) { i += 1; continue }
      const literal = m[0]
      i += literal.length
      if (m[1] === undefined && m[2] === undefined) {
        const digits = literal.startsWith('-') ? literal.slice(1) : literal
        if (digits.length >= 16 && BigInt(digits) > 9007199254740991n) return literal
      } else {
        const value = Number(literal)
        if (!Number.isFinite(value) || (Number.isInteger(value) && Math.abs(value) > 9007199254740991)) return literal
        // Underflow is the same disease in the other direction: `1e-400` parses to 0, a
        // value the model never wrote. A mantissa with a non-zero digit that lands on zero
        // is refused too.
        if (value === 0 && /[1-9]/.test(literal.split(/[eE]/)[0])) return literal
      }
      continue
    }
    i += 1
  }
  return undefined
}

/** One JSON object is one call; anything else is an ordinary answer. */
function parseEmulated(text) {
  const trimmed = String(text ?? '').trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/.exec(trimmed)
  const candidate = fenced === null ? trimmed : fenced[1].trim()
  if (!candidate.startsWith('{')) return { text: trimmed, toolCalls: [] }
  let value
  try { value = JSON.parse(candidate) } catch { return { text: trimmed, toolCalls: [] } }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof value.tool !== 'string') {
    return { text: trimmed, toolCalls: [] }
  }
  const input = value.input !== null && typeof value.input === 'object' && !Array.isArray(value.input) ? value.input : {}
  const inexact = inexactNumberLiteral(candidate)
  return { text: '', toolCalls: [{ id: `emulated_${++emulatedSeq}`, name: value.tool, input, ...(inexact === undefined ? {} : { inexact }) }] }
}

/** Tool arguments that are not a JSON object are refused locally rather than guessed at. */
function parseToolArguments(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  // Several OpenAI-compatible endpoints send `""` for a tool with no arguments. That is
  // an empty object, not a malformed call; refusing it would refuse every no-arg verb.
  if (typeof raw === 'string' && raw.trim() === '') return {}
  try {
    const value = JSON.parse(String(raw))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch { return undefined }
}

/**
 * One model turn.
 *
 * Returns `{ text, toolCalls }`: prose the user should see, and the calls the model
 * decided to make. Which of the three transports carried it is not visible above this
 * line, and must not be — the loop reasons about tool calls, never about wire shapes.
 */
async function ask(entries, system, { tools = [], cfg = MAIN_CFG } = {}) {
  const wire = openaiStyle(cfg) ? 'openai' : 'anthropic'
  const style = emulatedTools ? 'emulated' : wire
  const declared = !emulatedTools && tools.length > 0
  const systemText = emulatedTools && tools.length > 0 ? `${system}\n\n${emulatedToolGuide(tools)}` : system
  const baseHeaders = { 'content-type': 'application/json' }
  const headers = wire === 'openai'
    ? (cfg.key === '' ? baseHeaders : { ...baseHeaders, authorization: `Bearer ${cfg.key}` })
    : (cfg.key === '' ? baseHeaders : { ...baseHeaders, 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' })
  const body = wire === 'openai'
    ? {
        model: cfg.model, max_tokens: 6000,
        // Hybrid reasoning models burn the budget on reasoning and answer with empty
        // content unless thinking is turned off; twelve empty rounds is how that shows up.
        ...(process.env.RULITH_MODEL_THINKING === 'enabled' ? { thinking: { type: 'enabled' } } : {}),
        messages: [{ role: 'system', content: systemText }, ...renderMessages(entries, style)],
        ...(declared ? { tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.schema } })) } : {}),
      }
    : {
        model: cfg.model, max_tokens: 6000, system: systemText, messages: mergeAdjacent(renderMessages(entries, style)),
        ...(declared ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.schema })) } : {}),
      }
  let response
  try {
    response = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch (error) {
    // A user-facing tool does not print a raw stack: say who was called and how to change it.
    failTask(`Cannot reach model service ${cfg.url}: ${error?.cause?.code ?? error?.message ?? error}.
   Set RULITH_MODEL_URL for a self-hosted or proxy endpoint. Leave it unset when using the default provider endpoint.`)
    return { text: '', toolCalls: [] }
  }
  const raw = await response.text().catch(() => '')
  let payload
  try { payload = JSON.parse(raw) } catch { payload = {} }
  if (!response.ok) {
    if (response.status === 400 && declared && /tool/i.test(raw)) {
      // The endpoint refuses tool definitions. Describe the identical schemas in the
      // prompt instead of dropping the tools: a model with no tools is not a fallback,
      // it is an agent that can no longer reach the Board.
      emulatedTools = true
      log('The model endpoint refused a request carrying tool definitions. The same four tools are now described in the prompt; their names and schemas are unchanged.')
      return await ask(entries, system, { tools, cfg })
    }
    failTask(`Model service error (${response.status}): ${raw.replace(/\s+/g, ' ').slice(0, 300)}`)
    return { text: '', toolCalls: [] }
  }
  if (emulatedTools) {
    const spoken = wire === 'openai'
      ? String(payload.choices?.[0]?.message?.content ?? '')
      : (Array.isArray(payload.content) ? payload.content : []).filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n')
    return parseEmulated(spoken)
  }
  if (wire === 'openai') {
    const message = payload.choices?.[0]?.message ?? {}
    return {
      text: String(message.content ?? ''),
      toolCalls: (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((call, index) => {
        // Chat Completions carries the arguments as JSON *text*, so the exactness look
        // is on that text; a literal beyond the exact domain is refused before parsing.
        const inexact = typeof call.function?.arguments === 'string' ? inexactNumberLiteral(call.function.arguments) : undefined
        return {
          id: String(call.id ?? `call_${index}`),
          name: String(call.function?.name ?? ''),
          input: parseToolArguments(call.function?.arguments),
          ...(inexact === undefined ? {} : { inexact }),
        }
      }),
    }
  }
  // Messages carries `input` as parsed JSON inside the response, so the only place a
  // literal beyond the exact domain is still visible is the response text itself. Provider
  // metadata carries small integers only; a hit is attributed to the calls of this turn.
  const inexact = inexactNumberLiteral(raw)
  const blocks = Array.isArray(payload.content) ? payload.content : []
  return {
    text: blocks.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n'),
    toolCalls: blocks.filter((block) => block?.type === 'tool_use').map((block, index) => ({
      id: String(block.id ?? `call_${index}`),
      name: String(block.name ?? ''),
      input: parseToolArguments(block.input),
      ...(inexact === undefined ? {} : { inexact }),
    })),
  }
}

/**
 * One system prompt.
 *
 * It carries no JSON. A hand-written template beside an authoritative schema is a second
 * grammar, and the two drift — the schemas the authority advertises are the templates.
 * What is left is what a schema cannot say: who the model is, what the Board does with a
 * proposal, which shapes a step of reasoning may take, and which claims are never the
 * model's to make.
 */
const SYSTEM_PROMPT = `You are an agent working with a Rulith Board. The Board derives, checks and certifies; you propose. Your tools are the only things you can say to it, and their schemas are the templates.

Inside ApplyBatch a step of reasoning takes one of five shapes. assert_fact states a material fact and names the source it came from. add_axiom offers a rule the Board may derive with. declare_hypothesis puts a claim under test, and the Board reports its status. record_result records a conclusion together with the evidence it rests on. retract_node or revise_fact withdraws or corrects an assertion of your own that turned out wrong. Explanation, argument and narration stay in your reply to the user; they are not Board material.

Never assert acceptance_met, test_result, certification or rulith.exploration.completed. Whether the work is accepted is the Board's decision, not yours to state.

Every tool result carries the current Case View. Read it before choosing the next step.`

const EXPLORATION_LINE = 'This Case Type is exploration: add_axiom and define_action are permitted inside this Case, are Case-local, and disappear when the Case closes.'
const LOCKED_LINE = 'Legislation is locked on this Board: do not use add_axiom or define_action. Use the installed vocabulary and the Actions the Case View lists.'

/** The base prompt plus at most one conditional line. Before a Case exists neither
 *  applies: an unscoped turn is not shown a provisional-law handle it cannot use. */
const systemFor = (ctx) => {
  if (ctx.case === undefined) return SYSTEM_PROMPT
  if (ctx.lawLocked) return `${SYSTEM_PROMPT}\n\n${LOCKED_LINE}`
  if (String(ctx.case.caseType ?? '') === 'exploration') return `${SYSTEM_PROMPT}\n\n${EXPLORATION_LINE}`
  return SYSTEM_PROMPT
}

// ── 主循环：提议 → 裁决 → 教学回流 ──────────────────────────────────
const log = (s) => console.log(s)
let identityCredentialRejected = false
try {
  const identity = await agentProtocol('identity')
  if (identity?.ok !== true || typeof identity.agentId !== 'string' || identity.agentId.trim() === '') {
    throw new Error('agent_protocol identity returned no Agent ID.')
  }
  agentId = identity.agentId
} catch (error) {
  if (error instanceof AgentCredentialRejectedError) {
    console.error(`\n✗ ${error.message}\n`)
    process.exitCode = 3
    identityCredentialRejected = true
  } else if (error instanceof McpSurfaceError) {
    // An endpoint that cannot serve this client is not a credential problem. Reporting
    // it as one sends the reader to rotate a token that was never the cause.
    die(error.message)
  } else {
    const legacy = legacyAgentIdHint(TOKEN)
    if (legacy === undefined) die(`Cloud could not resolve this opaque Agent MCP token: ${error?.message ?? error}`)
    agentId = legacy
    console.warn('Cloud does not yet expose authenticated Agent identity over public MCP; using the legacy JWT scope as a non-authoritative display hint until Cloud is upgraded.')
  }
}
if (!identityCredentialRejected) {
log(`
rulith-agent · Agent "${agentId}" · ${URL_BASE}`)
const consoleUrlOf = (name) => `https://console.rulith.ai/agents/${encodeURIComponent(name)}`
const consoleUrl = consoleUrlOf(agentId)
/** 停轮未结时终端上的那一句(三张脸共用一份措辞——同一件事三种说法比不说更糟)。 */
const pendingLine = (id) => (id === null || id === undefined ? '' : ` · Case remains open: pending_case_id=${id}. Resume with --case ${id}, or resolve it in Console.`)
// A slot owns only local conversation and scheduler state. All slots address
// the same persistent Agent Board; each queued task receives an independent
// Case Context before any task-scoped operation is sent.
const makeSlot = (key) => ({
  key,                              // sessionKey; '' is the local/default conversation
  board: agentId,                   // public Agent identity; Gateway resolves its Board
  case: undefined,                  // the currently selected Case Context, if any
  detachedCase: undefined,          // bounded recovery hint after local transcript reclamation
  messages: [],                     // 转录(**只在本机**,不上板);中性形状,发送时才按线型渲染
  segmentTrail: [],                 // 段留痕(压缩后唯一留下来的东西)
  lawProbed: false,                 // board governance is stable across Case Contexts
  lawLocked: false,
  queue: [],                        // 本槽待办(同槽 FIFO)
  busy: false,                      // 本槽是否有段在跑
  taskId: undefined,                // 在办任务号(事件标注用)
  lastUsed: Date.now(),             // LRU 用
})
const defaultSlot = makeSlot('')
// 锁态只读 GetBoardManifest.lawLocked 的权威端真相;协议清单不承载实例状态。
//
// 锁态是**板的属性**(锁来自这块板上装了什么包),不是单个 Case 的: 一块 durable Agent Board 上的每个
// Case Context 读到的都是同一个锁态,每开一件活再探一遍纯属给开案成本添砖。
// 所以每槽"首次可探时探一次,探过就记住"。
async function probeLawLock(ctx) {
  if (ctx.lawProbed) return
  ctx.lawProbed = true
  const manifest = await board({ kind: 'GetBoardManifest' }, ctx)
  ctx.lawLocked = manifest.accepted === true && manifest.payload?.lawLocked === true
  if (ctx.lawLocked) {
    log(`Board legislation is locked. Rules come from packages installed by the board owner; this Agent executes under them.${ctx.key === '' ? '' : ` (session ${ctx.key})`}`)
  }
}
// Board state is not part of conversational startup. Identity is authenticated above, but
// the first GetBoardManifest is deferred until the Agent explicitly chooses a Rulith tool.
// Otherwise even "hello" touches the Board before the model has decided whether Rulith is
// useful, which makes the tool mandatory in everything but name.

// ── 转录压缩：滚动窗 + 段边界留痕（2026-08-06 用户裁定）────────────────────
//
// CHAT 形态下 `messages` 跨段累积、**从不裁剪**。企业里这个进程要跑一整天、办几十单,
// 撑爆是时间问题——而撑爆的形状是模型服务 400/超长计费,不是干净的报错。
//
// 走滚动窗不走摘要压缩(用户裁定): 摘要要多一次模型调用(长跑下是持续成本),而且**摘要本身会失真**,
// 失真的摘要没有板那样的诚实档可查。板才是权威记录——细节本来就该在板上,不在转录里。
// 丢掉的段各留一行痕,模型知道"之前办过这些",要当前状态自己刷新 Case View。
//
// **切口必须落在 user 上**: 模型线型要求首条是 user,切在 assistant/user 配对中间会 400。
const KEEP_MESSAGES = envNumber('RULITH_KEEP_MESSAGES', 24, { min: 2, max: 10_000 })
function compactTranscript(ctx) {
  const messages = ctx.messages
  if (messages.length <= KEEP_MESSAGES) return
  let drop = messages.length - KEEP_MESSAGES
  // The cut must land on a user turn. A tool result that outlives its own tool call is a
  // malformed conversation on both provider shapes, and the endpoint answers 400.
  while (drop < messages.length && messages[drop]?.role !== 'user') drop += 1
  if (drop >= messages.length || drop <= 0) return // 切不出干净的口就不切(宁可长,不可发坏形状)
  const cut = messages.splice(0, drop)
  const trail = ctx.segmentTrail.length ? ctx.segmentTrail.map((entry, index) => `${index + 1}. ${entry}`).join('\n') : '(none)'
  // 留痕**并进**第一条 user,不新增消息——不动角色结构,任何线型都不会因此变形
  messages[0] = {
    ...messages[0],
    text: `[Transcript compacted] ${cut.length} earlier message(s) were removed. The Case View in the next tool result remains authoritative.
Earlier segments:
${trail}

───
${messages[0].text}`,
  }
  log(`Transcript compacted: dropped ${cut.length}, kept ${messages.length} message(s) and ${ctx.segmentTrail.length} segment marker(s).`)
  emitOn(ctx, 'compact', { dropped: cut.length, kept: messages.length, segments: ctx.segmentTrail.length })
}
/** 插话取件口（viz 的 pollUserMsg 在协议面的对应）。CHAT 形态由收件箱挂上；
 *  CLI 形态**故意留空**——一次办完的脚本/CI 没有第二个说话的人,给它一个空钩比给它半个功能诚实。
 *
 *  **只喂缺省槽**(2026-08-07 分槽): stdin belongs to the one local terminal operator,
 *  他说的话属于他自己那条对话,不属于某位远程客户的会话槽。把它散给所有槽=把本机操作者的
 *  插话注进别人的案子;随便挑一个槽=更糟(不确定注给了谁)。所以判据是"槽是不是缺省槽"。 */
let pollInterject = null
// ── One loop, two policies ──────────────────────────────────────────────────
//
// `return` is a conversation: the model may take tool steps, and the moment it answers
// with text and no tool call, control goes back to the user. `continue` is the autopilot
// (`--task`): the same loop, the same four tools, the same refusals. What differs is only
// what the host does when the model falls silent while a Case is open and uncertified.
//
// These were two loops with two grammars. A defect fixed in one survived, silently, in
// the other — and neither could be exercised by the other's tests.

/** Dispositions that say the work did not succeed. In autopilot they end the run. */
const VOID_DISPOSITIONS = new Set(['cancelled', 'failed', 'abandoned', 'superseded'])

/** Every local refusal wears the same envelope the Board's own refusals wear, so the
 *  model never has to tell "the host would not carry this" from "the Board said no" by
 *  the shape of the answer — the errorCode says which. */
const refusal = (errorCode, teaching) => JSON.stringify({ accepted: false, errorCode, teaching })

/**
 * A tool this runtime will not carry.
 *
 * The four verbs are the whole allow-list. A refusal that travels has already spent the
 * Agent's credential on it, and Cloud authorization is the second line, not the first:
 * the runtime must not offer to speak governance, lifecycle selection or Worker receipts
 * on a model's behalf at all. The model's turn is untrusted input — a task description,
 * a fetched document or a tool result can all reach it.
 */
const unknownToolTeaching = (name) => `${name === '' ? '(missing tool name)' : name} is not a tool this Agent Runtime`
  + ` carries, so it was refused locally and never reached the authority. This Agent may call: ${MODEL_VERBS.join(', ')}.`
  + ' Case selection, verification, work receipts, clearance, and package or Board governance belong to the host and to Console.'

function emitVerdict(ctx, name, answer) {
  const result = answer.result ?? {}
  const payload = result.receipt ?? result.payload ?? {}
  const invocation = String(payload.invocation ?? payload.invocationId ?? result.invocation ?? '')
  if (result.accepted === true) {
    emitOn(ctx, 'verdict', {
      accepted: true, cmd: name,
      ...(typeof payload.done === 'boolean' ? { done: payload.done } : {}),
      ...(typeof payload.ok === 'boolean' ? { ok: payload.ok } : {}),
      ...(invocation === '' ? {} : { invocation }),
    })
    const state = payload.done === true ? (payload.ok === false ? 'completed with failure' : 'completed') : 'accepted'
    log(`Board: ${name} ${state}${invocation === '' ? '' : ` · ${invocation}`}.`)
    return
  }
  const teaching = transportAmbiguous(result) ? transportRetryTeaching(result) : String(result.teaching ?? result.errorCode ?? 'Board rejected the step.')
  emitOn(ctx, 'verdict', { accepted: false, cmd: name, teaching, ...(transportAmbiguous(result) ? { transportAmbiguous: true } : {}) })
  if (transportAmbiguous(result)) log(`Board outcome unknown for ${name}: retry the unchanged step; no authoritative receipt was returned.`)
  else log(`Board rejected ${name}: ${teaching.slice(0, 240)}`)
}

/**
 * Execute one model-chosen tool call.
 *
 * Everything the host owns is attached here and nowhere else: the Case envelope, the
 * request identity, and the governance selection that decides which contract a new Case
 * runs under. The tool result text handed back is the authority's own JSON, unedited —
 * it already carries the bounded Case View, and a client that summarised it would be
 * teaching the model a picture of the Board rather than the Board.
 */
async function executeToolCall(ctx, call, options) {
  const name = String(call.name ?? '')
  if (!MODEL_VERBS.includes(name)) {
    const teaching = unknownToolTeaching(name)
    log(`Refused locally: ${teaching.slice(0, 200)}`)
    emitOn(ctx, 'verdict', { accepted: false, cmd: name, teaching, refusedLocally: true })
    return { text: refusal('tool_not_carried', teaching), accepted: false }
  }
  if (call.inexact !== undefined) {
    // Exact-or-fail, at the first membrane the literal crosses. Forwarding the parsed value
    // would send the Board a number the model never wrote, and the Board would then judge
    // (and possibly ground) that other number.
    const teaching = `${name}: the number ${call.inexact} is outside the exact number domain, so nothing was sent.`
      + ' Integers must stay within \u00b19007199254740991 (2^53-1) and every number must be finite.'
      + ' Pass large identifiers as strings (for example "1234567890123456789"); strings compare by exact text and are never rounded.'
    log(`Refused locally: ${teaching.slice(0, 200)}`)
    emitOn(ctx, 'verdict', { accepted: false, cmd: name, teaching, refusedLocally: true })
    return { text: refusal('bad_command', teaching), accepted: false }
  }
  if (call.input === undefined) {
    const teaching = `${name} arguments were not a JSON object, so nothing was sent. Send arguments matching the tool schema.`
    emitOn(ctx, 'verdict', { accepted: false, cmd: name, teaching, refusedLocally: true })
    return { text: refusal('bad_tool_arguments', teaching), accepted: false }
  }
  let input = { ...call.input }
  if (name === 'OpenCase') {
    if (ctx.case !== undefined) {
      const teaching = `Case "${ctx.case.id}" is already selected for this conversation. Advance or close it before opening another.`
      emitOn(ctx, 'verdict', { accepted: false, cmd: name, teaching, refusedLocally: true })
      return { text: refusal('case_already_selected', teaching), accepted: false }
    }
    // Governance selection is the operator's, not the model's: when a Case Type is pinned
    // on the command line or in the environment, that is the contract the Case opens
    // under. With nothing pinned the model may choose from its Agent's catalogue and the
    // host only supplies the default.
    const asked = typeof input.caseType === 'string' && input.caseType.trim() !== '' ? input.caseType.trim() : ''
    const caseType = options.caseTypePinned || asked === '' ? options.caseType : asked
    input = {
      ...input,
      caseType,
      ...(options.businessKey === undefined ? {} : { businessKey: options.businessKey }),
      caseId: typeof input.caseId === 'string' && input.caseId.trim() !== '' ? input.caseId.trim() : options.caseId,
    }
  } else if (ctx.case === undefined) {
    const teaching = `${name} needs a selected Case, and none is open. Call OpenCase first; nothing was forwarded.`
    emitOn(ctx, 'verdict', { accepted: false, cmd: name, teaching, refusedLocally: true })
    return { text: refusal('case_context_required', teaching), accepted: false }
  }
  const before = ctx.case?.id
  const answer = await callTool(name, input, ctx)
  emitVerdict(ctx, name, answer)
  // Local reads acceptance state from `board` events. The view arrives with every tool
  // result now, so this fires in conversation as well as autopilot — the panel used to go
  // blank in conversation mode because only the autopilot path ever published one.
  if (answer.view !== undefined) {
    emitOn(ctx, 'board', {
      caseId: ctx.case?.id ?? before, certified: certifiedOf(answer.view),
      floor: String(answer.view.floor ?? '—'), state: String(answer.view.state ?? ''),
    })
  }
  const accepted = answer.result?.accepted === true
  if (name === 'OpenCase' && accepted && ctx.case !== undefined) {
    log(`\nCase Context opened: "${ctx.case.id}" · Case Type "${ctx.case.caseType}" on Agent Board "${ctx.board}".`)
    emitOn(ctx, 'case-open', { board: ctx.board, caseId: ctx.case.id, caseType: ctx.case.caseType, ok: true })
    ctx.detachedCase = undefined
    await probeLawLock(ctx)
  }
  return {
    text: answer.text,
    accepted,
    view: answer.view,
    closed: before !== undefined && ctx.case === undefined,
    disposition: String(input.disposition ?? ''),
  }
}

/**
 * One turn of work: a user message, or one autopilot task.
 *
 * `policy: 'return'` hands control back as soon as the model answers with text.
 * `policy: 'continue'` keeps going while the Board still has something to say — but the
 * continuation condition is never "the model did not say DONE". It is the Board's own
 * view: certified, or an explicit close, or the round budget.
 *
 * Returns `{ note, caseId, activeCaseId, pendingCaseId, opened }`. `opened` is the
 * machine-readable half of `note`: callers used to have to read prose to tell "the Case
 * ran and did not certify" from "no Case ever existed", and the one-shot CLI did not
 * read it at all — it exited 0 for a task that never started.
 */
async function runCaseTurn(ctx, userText, {
  policy = 'return',
  caseType = selectedCaseType,
  caseTypePinnedForTurn = caseTypePinned,
  businessKey = selectedBusinessKey,
  requestedCaseId = '',
} = {}) {
  compactTranscript(ctx)
  const messages = ctx.messages
  let opened = ctx.case !== undefined
  let note = ''
  let outcome = 'pending'
  let nudged = false
  let selectionNotice = ''
  let lastCaseId = ctx.case?.id ?? null
  const detachedPendingCaseId = ctx.detachedCase?.caseId ?? null
  const configuredResume = resumeCase
  resumeCase = '' // Resume applies to the first segment only.
  const explicitResume = requestedCaseId || configuredResume
  const mintedCaseId = ctx.taskId || nextCaseId()

  // Selecting or resuming a Case is a host feature, reached through `--case` and the
  // Local UI. The model has no pause/resume verb: which Case this conversation is on is
  // not a decision a model turn may make on the operator's behalf.
  if (explicitResume !== '') {
    if (ctx.case !== undefined) {
      if (ctx.case.id !== explicitResume) {
        selectionNotice = `Rulith Case ${JSON.stringify(explicitResume)} was not selected because this conversation already owns active Case ${JSON.stringify(ctx.case.id)}. Finish the active Case before selecting another.`
      }
    } else {
      await probeLawLock(ctx)
      const row = await selectExistingCase(ctx, explicitResume)
      if (row !== undefined && bindCaseRow(ctx, explicitResume, String(row.caseType ?? caseType), row) !== undefined) {
        opened = true
        lastCaseId = explicitResume
        ctx.detachedCase = undefined
      } else {
        selectionNotice = `The requested existing Rulith Case ${JSON.stringify(explicitResume)} could not be selected. Answer the user normally; do not claim that Case is active.`
      }
    }
  }

  const openingView = ctx.case === undefined ? undefined : await hostView(ctx)
  messages.push(userEntry([
    `${policy === 'continue' ? 'Task' : 'User message'}: ${userText}`,
    selectionNotice === '' ? '' : `\n\n${selectionNotice}`,
    openingView === undefined ? '' : `\n\nCase View:\n${viewText(openingView)}`,
  ].join('')))

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    emitOn(ctx, 'round', { n: round, ...(policy === 'return' ? { conversational: true } : {}) })
    // 轮号也上终端: 从前它只进事件流,于是任何按 stdout 数轮数的量具恒读 0。
    if (policy === 'continue') log(`— Round ${round} —`)
    // 插话不打断: 本机操作者在段跑着时说的话当轮就进对话。只有缺省槽有这条线——
    // stdin 属于那一个本机操作者,不属于某位远程客户的会话槽。
    const interject = policy === 'continue' && ctx === defaultSlot ? pollInterject?.() : undefined
    if (interject) {
      log(`\n[User interjection] ${interject}`)
      emitOn(ctx, 'user', { text: interject, interject: true })
      messages.push(userEntry(`[User] ${interject}`))
    }

    const reply = await ask(messages, systemFor(ctx), { tools: modelTools })
    const say = String(reply.text ?? '').trim()
    if (say !== '') log(`\n${say.slice(0, 1200)}`)
    messages.push(assistantEntry(reply.text, reply.toolCalls))
    emitOn(ctx, 'propose', {
      say,
      ...(reply.toolCalls.length === 0 ? {} : {
        cmd: reply.toolCalls.map((call) => String(call.name ?? '')).join('+'),
        tool: { action: String(reply.toolCalls[0].name ?? '') },
      }),
    })

    if (reply.toolCalls.length === 0) {
      // A plain answer is a complete conversational turn. An open Case is deliberately
      // left exactly as it is; the next user message may continue it, ask about it, or
      // ignore it. The host never continues merely because a Case is not certified.
      if (policy === 'return') {
        outcome = 'conversation'
        note = ctx.case === undefined
          ? 'Response delivered without opening a Rulith Case.'
          : `Response delivered; Rulith Case "${ctx.case.id}" remains open.`
        break
      }
      if (ctx.case === undefined) { outcome = 'no-case'; note = 'Response only; no Case was opened on the Board.'; break }
      const settled = await settle(ctx, undefined)
      if (certifiedOf(settled.view)) {
        outcome = 'certified'
        note = `Board certified the case as deliverable (floor=${String(settled.view?.floor ?? '—')}).`
        break
      }
      if (nudged) {
        note = `The model stopped, but the board did not certify the case (floor=${String(settled.view?.floor ?? '—')} · ${String(settled.view?.state ?? '')}).`
        break
      }
      // One nudge, once — never an unbounded retry. The judgement is the Board's, not a
      // guess about the prose: it is the view that says the work is not finished.
      nudged = true
      messages.push(userEntry(`The Case is open and the Board has not certified it. Current Case View:\n${viewText(settled.view)}\n\nTake the next step, or close the Case with a disposition that says why it cannot be finished.`))
      continue
    }

    const results = []
    let lastView
    let closedDisposition
    for (let index = 0; index < reply.toolCalls.length; index++) {
      const call = reply.toolCalls[index]
      if (index > 0) {
        // One step per turn. An accepted step changes the closure and therefore the set of
        // steps available next, so a second call in the same turn was chosen against a
        // Board state that no longer exists. Every tool_use still receives a tool_result:
        // an unanswered one is a malformed conversation on the Anthropic wire.
        results.push({
          id: call.id,
          name: String(call.name ?? ''),
          text: refusal('one_step_per_turn', 'Only the first tool call in a turn is executed; this one was not sent. An accepted step changes the Board closure and the set of steps available next. Read the Case View in the first result, then reissue this step.'),
        })
        continue
      }
      const executed = await executeToolCall(ctx, call, { caseType, caseTypePinned: caseTypePinnedForTurn, businessKey, caseId: mintedCaseId })
      results.push({ id: call.id, name: String(call.name ?? ''), text: executed.text })
      if (ctx.case !== undefined) { opened = true; lastCaseId = ctx.case.id }
      if (executed.view !== undefined) lastView = executed.view
      if (executed.closed) closedDisposition = executed.disposition === '' ? 'completed' : executed.disposition
    }
    messages.push(resultsEntry(results))

    if (policy !== 'continue') continue
    if (closedDisposition !== undefined) {
      outcome = VOID_DISPOSITIONS.has(closedDisposition) ? 'void' : 'completed'
      note = VOID_DISPOSITIONS.has(closedDisposition)
        ? `The Case was closed as ${closedDisposition}.`
        : 'The Board accepted closure and the Case is completed.'
      break
    }
    if (ctx.case === undefined) continue
    const settled = await settle(ctx, lastView)
    if (settled.waited || settled.notes.length > 0) {
      messages.push(userEntry([
        settled.notes.join('\n'),
        settled.notes.length === 0 ? '' : '\n\n',
        `Case View after settlement:\n${viewText(settled.view)}`,
      ].join('')))
    }
    if (certifiedOf(settled.view)) log(`[Completion] certified=true floor=${String(settled.view?.floor ?? '—')} ${String(settled.view?.state ?? '')}`)
  }

  if (note === '') note = `Stopped at the ${MAX_ROUNDS}-round limit.`
  if (policy === 'continue') {
    // 影子人格(--shadow): 段尾对抗审阅——同一智能体的内外人格。它只能落异议事实,
    // 牙齿在板上(confirmed_defect 挡 certify),不在这个进程的流程分支里。
    if (withShadow && ctx.case !== undefined) await shadowReview(ctx, userText)
    if (note === `Stopped at the ${MAX_ROUNDS}-round limit.`) {
      log(`\n⚠ ${note} Increase RULITH_MAX_ROUNDS only after reviewing why the workflow did not converge.`)
    }
  }
  const activeCaseId = ctx.case?.id ?? null
  const pendingCaseId = policy === 'continue' ? activeCaseId : detachedPendingCaseId
  if (policy === 'continue' && activeCaseId !== null) {
    log(outcome === 'certified'
      ? `\nCase "${activeCaseId}" is certified and still open, because closing it is the model's step and it did not take one.\n   Resume with --case ${activeCaseId}, or close it in Console.`
      : `\nCase "${activeCaseId}" remains open: ${note}\n   Stopping is not completion. Resume with --case ${activeCaseId}, or close it explicitly in Console.`)
    emitOn(ctx, 'case-pending', { board: ctx.board, caseId: activeCaseId, reason: note, note })
  }
  ctx.segmentTrail.push(`[${policy === 'continue' ? 'case' : 'conversation'}${activeCaseId === null ? '' : ` · case ${activeCaseId} open`}] ${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''} → ${note}`)
  if (ctx.segmentTrail.length > 40) ctx.segmentTrail.splice(0, ctx.segmentTrail.length - 40)
  return { note, outcome, caseId: activeCaseId ?? lastCaseId, activeCaseId, pendingCaseId, opened }
}

/** 影子审阅: 对抗立场读板与本段经过,专挑真缺陷。发现→落板 shadow_finding + 返回 false(拦结案)。
 *  审不出问题回 PASS。影子**只能落异议事实,不能改主人格写的任何东西**——它是审的,不是改的。
 *
 *  两个时机（viz 逐义，2026-08-06 补上第一个）：
 *    - `inline`（每轮，板变过才跑）——**牙齿在这里**：异议落板后紧接着就是同一轮的放电，
 *      影子的缺陷主张与主人格的叶子一起接地，confirmed_defect 赶得上在 certify 之前挡门。
 *    - 段尾【关门审计】——最后一道,牙齿是拦下本段的 `CloseCase`:有异议的活不算收尾,板上留着。
 *  只有段尾那次的返回值被用来拦结案;inline 那次不拦(它靠板机制生效,不靠流程分支)。 */
async function shadowReview(ctx, userText) {
  const view = await hostView(ctx)
  const verdict = await ask(
    [userEntry(`Completed segment: ${userText}\n\nCurrent Case View:\n${viewText(view)}`)],
    `You are the Agent's adversarial shadow reviewer. Assume the primary Agent may be wrong and identify only concrete defects:
- Is every conclusion actually supported? Are values abnormal, sources doubtful, or expected materials missing?
- Did claims that require verification go through a trusted computation or source, or were they merely stated?
- Is unfinished work being presented as complete?
Do not invent criticism. If no issue is substantiated, reply with exactly PASS.
Otherwise return at most three lines, each formatted FINDING: <one precise issue with a node or value>.`,
    { cfg: SHADOW_CFG },
  )
  const findings = String(verdict.text ?? '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('FINDING:')).slice(0, 3)
  if (findings.length === 0) { log('◆ Shadow review: PASS'); emitOn(ctx, 'shadow', { pass: true }); return true }
  for (const finding of findings) log(`◆ Shadow review: ${finding.slice(0, 200)}`)
  emitOn(ctx, 'shadow', { pass: false, findings })
  // 异议落板(asserted 档如实——影子的话也是话,不是证据)。**牙齿在板上**:
  // confirmed_defect 在 certify 之前挡门,不靠这个进程的流程分支。
  const operations = findings.map((finding, index) => ({
    op: 'assert_fact', id: `SF_${Date.now().toString(36)}_${index}`,
    predicate: 'shadow_finding', args: { text: finding.slice(9, 240).trim() },
  }))
  const answer = await callTool('ApplyBatch', { operations }, ctx)
  if (answer.result?.accepted !== true) log(`◆ Board rejected the shadow finding: ${String(answer.result?.teaching ?? '').slice(0, 120)}`)
  return false
}

if (SERVE) {
  // ── 接单脑(批7 起,2026-08-07 分槽): 回环收单 → **按槽**跑 → 结果留内存环形队列 ──
  //
  // 这是「网站后端可直接嵌的无人值守闭环」的最小形态: 它不读 stdin、不弹界面,
  // 只把 **runSegment** 这一个循环挂到一个 HTTP 口上。前面那些器官(开案/放电/影子/结案)
  // 一行都不改——接单脑只负责**排队、分槽与留痕**,不负责办事。
  //
  // **同槽恒串行,跨槽按 SERVE_CONCURRENCY 并行**。旧门牌写的是"并发恒为 1",前提是四处
  // 进程级单例(尤其 messages 转录);那四处已全部入槽(见 makeSlot),前提失效 ⇒ 裁决作废。
  // 留下来的那半条仍然成立: **一个客户的两单不能织进同一条转录**,所以每槽自己一条 FIFO。
  const wantedConcurrency = envNumber('RULITH_SERVE_CONCURRENCY', 1, { min: 1, max: 1000 })
  // 上限 8 是**保守的闸不是测出来的极限**: 每个并行段都在烧模型配额与云上写配额,
  // 一个手滑的 =200 会把这两样同时打爆,而爆的形状是 429/超时,不是干净的报错。
  // 要更高的并发,形态仍是多开进程(那样每个进程的资源账是分开的)。
  const SERVE_CONCURRENCY = !Number.isFinite(wantedConcurrency) || wantedConcurrency < 1
    ? 1 : Math.min(8, Math.floor(wantedConcurrency))
  if (Number.isFinite(wantedConcurrency) && Math.floor(wantedConcurrency) > 8) {
    console.error(`⚠ RULITH_SERVE_CONCURRENCY=${wantedConcurrency} exceeds the supported maximum and was clamped to 8.
   Cross-slot concurrency is real, but every slot consumes model and Cloud capacity. Eight is a conservative guardrail, not a measured limit. Run additional processes for higher concurrency.`)
  }

  const runs = []       // 环形队列: 最近 SERVE_RUNS_MAX 条(内存里的东西必须有上界)
  // 在跑的段(按开跑先后),`inFlight.length` 即跨槽并发数,上界 = SERVE_CONCURRENCY。
  // 它同时是 /runs 快照里 running/runningAll 的来源——**一份状态一处存**。
  const inFlight = []
  const pushRun = (r) => { runs.push(r); while (runs.length > SERVE_RUNS_MAX) runs.shift() }
  let acceptingTasks = true

  // Session slots isolate local transcripts, queues, and the currently selected Case.
  // They do not create Boards: every slot opens Case Contexts on the same persistent Agent Board.
  const sessions = new Map()
  const detachedCases = new Map()
  const rememberDetachedCase = (session, recovery) => {
    detachedCases.delete(session)
    detachedCases.set(session, recovery)
    while (detachedCases.size > SERVE_SLOTS_MAX) detachedCases.delete(detachedCases.keys().next().value)
  }
  const detachIdleCase = (session, slot) => {
    const recovery = slot.case === undefined ? slot.detachedCase : {
      caseId: slot.case.id, caseType: slot.case.caseType, detachedAt: Date.now(),
    }
    if (recovery === undefined) return
    rememberDetachedCase(session, recovery)
    // A recovery hint that was already detached is merely moving between bounded maps.
    // Emit the public recovery record once, when an actively selected Case first leaves its slot.
    if (slot.case === undefined) return
    const caseId = recovery.caseId
    const at = Date.now()
    const note = `Conversation "${session}" was reclaimed at the local session limit. Rulith Case "${caseId}" remains unchanged on the Board and may be selected explicitly later.`
    const rec = {
      id: `detached-${randomUUID()}`, text: '(conversation reclaimed)', at,
      startedAt: at, endedAt: at, note, board: slot.board, sessionKey: session,
      caseId, pendingCaseId: caseId, console: consoleUrl,
    }
    pushRun(rec)
    emit('session-detached', { session, caseId, pendingCaseId: caseId, note, board: slot.board, console: consoleUrl })
    log(`◎ ${note}`)
  }
  const evictIfNeeded = () => {
    while (sessions.size >= SERVE_SLOTS_MAX) {
      let victim
      for (const [k, s] of sessions) {
        if (!s.busy && s.queue.length === 0 && s.case === undefined) { victim = k; break }
      }
      if (victim === undefined) {
        for (const [k, s] of sessions) {
          if (!s.busy && s.queue.length === 0) { victim = k; break }
        }
      }
      if (victim === undefined) {
        log(`All ${SERVE_SLOTS_MAX} session slots are busy. Refusing a new conversation rather than interrupting an Agent turn.`)
        return false
      }
      const slot = sessions.get(victim)
      detachIdleCase(victim, slot)
      sessions.delete(victim)
      if (slot.case === undefined) log(`Evicted least-recently-used idle conversation "${victim}" at the ${SERVE_SLOTS_MAX}-slot limit. It had no active Rulith Case.`)
      emit('slot-evicted', { session: victim, slots: sessions.size })
    }
    return true
  }
  const slotFor = (sessionKey) => {
    if (sessionKey === '') return defaultSlot
    const hit = sessions.get(sessionKey)
    if (hit !== undefined) {
      sessions.delete(sessionKey); sessions.set(sessionKey, hit) // LRU: 命中即挪到队尾
      hit.lastUsed = Date.now()
      return hit
    }
    if (!evictIfNeeded()) return undefined
    const slot = makeSlot(sessionKey)
    const recovery = detachedCases.get(sessionKey)
    if (recovery !== undefined) {
      detachedCases.delete(sessionKey)
      slot.detachedCase = recovery
    }
    sessions.set(sessionKey, slot)
    log(`Opened session "${sessionKey}" (${sessions.size}/${SERVE_SLOTS_MAX} slots).`)
    emit('slot-open', { session: sessionKey, slots: sessions.size })
    return slot
  }

  // The local service uses a random key, a loopback Host/Origin gate, and a 64KB JSON body cap.
  const serveGate = (req) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const key = req.headers['x-rulith-serve'] ?? url.searchParams.get('k') ?? ''
    if (key !== SERVE_KEY) return 'Missing or invalid task key. Use the startup key in the x-rulith-serve header, or ?k= for SSE.'
    const origin = req.headers.origin
    if (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return `Cross-origin request rejected (Origin: ${origin}). The task endpoint accepts local origins only.`
    const host = String(req.headers.host ?? '')
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return `Non-local Host rejected (${host}) to prevent DNS rebinding.`
    return null
  }
  /** 全体槽(缺省槽在前,会话槽按 LRU 顺序在后)——排队/调度/快照都读这一个视图。 */
  const allSlots = () => [defaultSlot, ...sessions.values()]
  const snapshot = () => ({
    ok: true, agentId, url: URL_BASE,
    concurrency: SERVE_CONCURRENCY,
    slotsMax: SERVE_SLOTS_MAX, sessions: sessions.size,
    // `running`: **单条或 null**——批7 的形状,调用方与既有回归网都按它读。并发之后它是
    // "最早开跑的那一条";全部在跑的看 `runningAll`(不改旧字段语义 = 不悄悄换合同)。
    running: inFlight[0] ?? null,
    runningAll: inFlight.slice(),
    queued: allSlots().flatMap((s) => s.queue.map((q) => ({ id: q.id, text: q.text, at: q.at, ...(s.key === '' ? {} : { sessionKey: s.key }) }))),
    runs: runs.slice(-SERVE_RUNS_MAX),
  })
  const terminalizeQueuedTasks = (reason) => {
    for (const slot of allSlots()) {
      for (const item of slot.queue.splice(0)) {
        const rec = {
          id: item.id, text: item.text, at: item.at,
          startedAt: item.at, endedAt: Date.now(),
          note: `Task never started: ${reason}`,
          board: slot.board,
          ...(slot.key === '' ? {} : { sessionKey: slot.key }),
          ...(slot.case === undefined ? {} : { console: consoleUrl }),
        }
        pushRun(rec)
        emit('task-done', rec)
        log(`✗ ${rec.note} (task ${item.id})`)
      }
    }
  }

  const serveSrv = http.createServer((req, res) => {
    const deny = (why, status = 403) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, teaching: why }))
    }
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'POST' && path === '/task') {
      const bad = serveGate(req)
      if (bad !== null) return deny(bad)
      if (!acceptingTasks) return deny('The Agent credential was rejected. Rotate it in Console and restart Rulith Local.', 503)
      const ct = String(req.headers['content-type'] ?? '')
      if (!ct.startsWith('application/json')) return deny('Only application/json is accepted; plain-text bodies can bypass browser preflight checks.')
      // 按字节收、收完再解码（同 /say）：逐块拼字符串会把跨块的多字节字符切坏。
      const bodyChunks = []
      let size = 0
      let over = false
      req.on('data', (c) => { size += c.length; if (size > LOCAL_REQUEST_MAX_BODY) { over = true; req.destroy(); return } bodyChunks.push(c) })
      req.on('end', () => {
        if (over) return deny('Request body exceeds 64KB.')
        const raw = Buffer.concat(bodyChunks).toString('utf8')
        let text = ''
        let sessionKey = ''
        let requestedCaseId = ''
        let requestedCaseIdValue
        let caseType = selectedCaseType
        // A caller that names a Case Type has made the governance selection for this task,
        // exactly as `--case-type` does for the process. The model may not move off it.
        let caseTypeGiven = caseTypePinned
        let businessKey = selectedBusinessKey
        try {
          const b = JSON.parse(raw || '{}')
          text = String(b.text ?? '').trim()
          sessionKey = String(b.sessionKey ?? '').trim()
          requestedCaseIdValue = b.caseId
          caseTypeGiven = caseTypeGiven || (typeof b.caseType === 'string' && b.caseType.trim() !== '')
          caseType = String(b.caseType ?? selectedCaseType).trim()
          businessKey = b.businessKey ?? selectedBusinessKey
        } catch { return deny('Body is not valid JSON. Expected {"text":"...","caseType":"exploration","businessKey":{"id":"..."},"sessionKey":"optional","caseId":"optional-existing-case"}.') }
        if (text === '') return deny('Missing text. Expected {"text":"process this task","caseType":"exploration"}.', 400)
        if (requestedCaseIdValue !== undefined && typeof requestedCaseIdValue !== 'string') return deny('caseId must be a string copied exactly from /runs or Console.', 400)
        requestedCaseId = String(requestedCaseIdValue ?? '').trim()
        if (!/^[a-z][a-z0-9_-]{1,63}$/.test(caseType)) return deny('caseType must be a 2-64 character lowercase identifier from the Agent Case Type catalog.', 400)
        if (businessKey !== undefined && (businessKey === null || typeof businessKey !== 'object' || Array.isArray(businessKey)
          || Object.keys(businessKey).length === 0 || !Object.values(businessKey).every((v) => typeof v === 'string'
            || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))))) {
          return deny('businessKey must be a non-empty JSON object whose keys match the selected Case Contract and whose values are finite JSON scalars.', 400)
        }
        // Missing keys start independent conversations. The caller receives the generated
        // key and must echo it on follow-ups; unrelated clients never share a default Case.
        if (sessionKey === '') sessionKey = `ctx-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
        // Session keys select bounded local transcript/queue slots. They never select a Board.
        if (sessionKey.length > SESSION_KEY_MAX) {
          return deny(`sessionKey exceeds ${SESSION_KEY_MAX} characters (${sessionKey.length} received). It cannot be truncated because it identifies a local conversation slot. Use a short opaque identifier.`, 400)
        }
        if (requestedCaseId.length > 256) return deny('caseId exceeds 256 characters. Use the exact Case ID returned by /runs or shown in Console.', 400)
        const slot = slotFor(sessionKey)
        if (slot === undefined) return deny(`Conversation capacity is full (${SERVE_SLOTS_MAX} slots), and every slot is busy. Retry later or continue an existing sessionKey.`, 429)
        const item = { id: nextCaseId(), text, caseType, caseTypePinned: caseTypeGiven, businessKey, caseId: requestedCaseId, at: Date.now(), sessionKey }
        slot.queue.push(item)
        slot.lastUsed = item.at
        const depth = allSlots().reduce((n, s) => n + s.queue.length, 0)
        emit('task-queued', { id: item.id, text: item.text, depth, session: sessionKey })
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, id: item.id, queued: depth, sessionKey,
          teaching: 'Queued. Read GET /runs?k=<key>, or add &stream=1 for SSE.' }))
        pump()
      })
      return
    }
    if (path === '/runs') {
      const bad = serveGate(req)
      if (bad !== null) return deny(bad)
      const wantsStream = new URL(req.url, 'http://127.0.0.1').searchParams.get('stream') === '1'
        || String(req.headers.accept ?? '').includes('text/event-stream')
      if (!wantsStream) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        return void res.end(JSON.stringify(snapshot()))
      }
      // Standalone automation may observe the same bounded event stream that Local receives over IPC.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    return deny('Available endpoints: POST /task {"text":"...","caseType":"exploration","businessKey":{"id":"..."},"sessionKey":"optional","caseId":"optional-existing-case"} and GET /runs?k=<key> (add &stream=1 for SSE).', 404)
  })
  await new Promise((r) => serveSrv.listen(SERVE_PORT, '127.0.0.1', r))
  log(`
Task endpoint ready (serial within a session · ${SERVE_CONCURRENCY} concurrent Case Context(s) · ${SERVE_SLOTS_MAX} session limit): http://127.0.0.1:${SERVE_PORT}
  Submit: curl -s -XPOST http://127.0.0.1:${SERVE_PORT}/task -H 'content-type: application/json' -H 'x-rulith-serve: ${SERVE_KEY}' -d '{"text":"…","caseType":"exploration"}'
  Contracted Case Types also send businessKey with the exact Case Contract argument names.
  Continue a conversation by echoing the sessionKey returned by the first request: -d '{"text":"…","sessionKey":"conversation-1"}'
  Select an existing running or paused Case without advancing it: add "caseId":"<id>" from /runs or Console.
  Messages are ordinary conversation. The Agent opens or advances a Rulith Case only when it calls one of the four Board tools.
  Inspect: curl -s 'http://127.0.0.1:${SERVE_PORT}/runs?k=${SERVE_KEY}'
  The key is randomized on every start. Loopback alone is not an authorization boundary.`)
  emit('start', { agentId, url: URL_BASE, task: '(task endpoint)', projection: '', concurrency: SERVE_CONCURRENCY })

  /** 办一单(某个槽的队首)。**同槽恒串行**由 `slot.busy` 保证,跨槽由 `inFlight` 的长度封顶。 */
  async function runOne(slot) {
    const item = slot.queue.shift()
    if (item === undefined) return
    slot.busy = true
    slot.lastUsed = Date.now()
    slot.taskId = item.id
    const flight = { id: item.id, text: item.text, startedAt: Date.now(),
      ...(slot.key === '' ? {} : { sessionKey: slot.key }) }
    inFlight.push(flight)
    emit('task-start', { id: item.id, text: item.text,
      ...(slot.key === '' ? {} : { session: slot.key }) })
    log(`
▶ Message ${item.id}${slot.key === '' ? '' : ` (session ${slot.key})`}: ${item.text}`)
    let note = ''
    let pendingCaseId = null
    let activeCaseId = null
    let actualCaseId = null
    try {
      const seg = await runCaseTurn(slot, item.text, {
        policy: 'return',
        caseType: item.caseType,
        caseTypePinnedForTurn: item.caseTypePinned === true || caseTypePinned,
        businessKey: item.businessKey,
        requestedCaseId: item.caseId,
      })
      note = seg.note
      pendingCaseId = seg.pendingCaseId
      activeCaseId = seg.activeCaseId
      actualCaseId = seg.caseId
    } catch (e) {
      const credentialRejected = e instanceof AgentCredentialRejectedError
      note = credentialRejected
        ? `Agent credential rejected: ${e.message}`
        : `Task aborted with an unexpected error: ${e?.message ?? e}`
      actualCaseId = slot.case?.id ?? null
      activeCaseId = actualCaseId
      pendingCaseId = actualCaseId
      if (credentialRejected) {
        // A revoked/rotated credential belongs to the whole host, not one task. Stop
        // admission and let the supervisor restart with new configuration after every
        // already-running slot has recorded its real outcome.
        acceptingTasks = false
        process.exitCode = 3
        terminalizeQueuedTasks(note)
      }
      log(`✗ ${note}`)
    } finally {
      // 清账落 **finally**: 上面任何一处炸了都不许把这个槽永久钉成 busy——那位客户从此再也
      // 办不了单,而症状是"投单回 202、结果永远不来",没有一行日志说得清为什么。
      const at = inFlight.indexOf(flight)
      if (at >= 0) inFlight.splice(at, 1)
      slot.busy = false
      slot.taskId = undefined
      slot.lastUsed = Date.now()
    }
    const rec = {
      id: item.id, text: item.text, at: item.at,
      startedAt: flight.startedAt, endedAt: Date.now(), note,
      board: slot.board,
      ...(actualCaseId === null ? {} : { caseId: actualCaseId }),
      ...(activeCaseId === null ? {} : { activeCaseId }),
      ...(slot.key === '' ? {} : { sessionKey: slot.key }),
      // pendingCaseId is reserved for a detached/paused Case. A healthy Case selected by
      // this conversation is activeCaseId; callers must not escalate ordinary dialogue.
      ...(pendingCaseId === null ? {} : { pendingCaseId }),
      ...(actualCaseId === null ? {} : { console: consoleUrl }),
    }
    pushRun(rec)
    emit('task-done', rec)
    log(`· ${note}${activeCaseId === null ? '' : ` · Active Rulith Case: ${activeCaseId}.`}${pendingLine(pendingCaseId)}${actualCaseId === null ? '' : ` · Verify in Console: ${consoleUrl}`}
`)
    if (!acceptingTasks && inFlight.length === 0) {
      for (const client of clients) client.end()
      serveSrv.close()
      serveSrv.closeAllConnections()
    }
  }
  // 泵(槽感知调度): 扫一遍槽,把**空闲且有排队**的槽开起来,直到跨槽并发到顶。
  // 段是 async 的,这里**不 await**——await 一条就等于把并发压回 1。每条办完再泵一次,
  // 于是"有空位就立刻开下一条"这件事不需要定时器。
  function pump() {
    if (!acceptingTasks) return
    for (const slot of allSlots()) {
      if (inFlight.length >= SERVE_CONCURRENCY) return
      if (slot.busy || slot.queue.length === 0) continue
      // `.catch` 不是装饰: node 里一个没接住的 rejection 会**结束进程**,而无人值守形态下
      // 那等于整台服务因为某一单的意外而下线。runOne 自己已经把办事那段包严了,这一层兜的是
      // 它之外(记档/发事件)万一出的岔子。
      void runOne(slot)
        .catch((e) => log(`✗ Scheduler error; the queue will continue: ${e?.message ?? e}`))
        .finally(pump)
    }
  }
  // 带任务参数启动 = 第一单已经在手上(脚本可以"起进程即办一单,之后接着收单")。
  // 它没有 sessionKey,所以进缺省槽——与从前一字不差。
  if (TASK !== '') { defaultSlot.queue.push({ id: nextCaseId(), text: TASK, caseType: selectedCaseType, businessKey: selectedBusinessKey, at: Date.now(), sessionKey: '' }); pump() }
} else if (!CHAT) {
  // ── 一次办完(CI/脚本形态,行为不变) ──
  try {
  log(`Task: ${TASK}
`)
  emit('start', { agentId, url: URL_BASE, task: TASK, projection: '' })
  const { note, outcome, caseId, pendingCaseId, opened } = await runCaseTurn(defaultSlot, TASK, { policy: 'continue' })
  // The run's own verdict, on the terminal. It used to travel only in the `end` event, so
  // the one interface this form actually has never said how the run ended.
  log(`\n· ${note}`)
  // A closed or rejected Case has no active execution envelope. Do not fall back
  // to an unscoped Agent Board read: the Console case record is the authority.
  const after = pendingCaseId !== null && defaultSlot.case?.id === pendingCaseId
    ? viewText(await hostView(defaultSlot))
    : ''
  const seen = consoleUrl
  log('\n──────── Final authoritative board state ────────')
  log(after === '' ? '(Case Context is not active; inspect its record in Console.)' : after)
  if (pendingCaseId !== null) log(`⚠ This case remains open: pending_case_id=${pendingCaseId}. Resume with --case ${pendingCaseId}, or resolve it in Console.`)
  log(`
Verify the task tree, work items, and conclusions in Console: ${seen}
`)
  emit('end', {
    // The success bit is read from the loop's own outcome, not from the prose it printed.
    // A note is for a person; a caller that greps it is one rewording away from silence.
    ok: outcome === 'completed',
    outcome,
    note,
    caseId,
    board: defaultSlot.board,
    projection: after,
    console: seen,
    ...(pendingCaseId === null ? {} : { pendingCaseId }),
  })
  // Send the last trace batch now instead of leaving it to the 1.5s timer, which is
  // unref'd and would simply be dropped when the loop drains. The request is bounded by
  // TRACE_FLUSH_TIMEOUT_MS, so a trace endpoint that hangs delays this exit by that
  // much and no more — reporting is never the reason a finished run is still running.
  flushTrace()
  // A task that never opened a Case did not run. Exiting 0 told every caller — CI step,
  // shell script, cron wrapper — that the work was attempted and finished.
  //
  // The status is set rather than forced. `process.exit()` here tore the loop down
  // while pipe writes and the HTTP client's sockets were still closing, and on Windows
  // libuv aborts on that (`!(handle->flags & UV_HANDLE_CLOSING)`, src/win/async.c):
  // roughly half of successful runs on this platform reported 3221226505 — a crash
  // code — instead of 0, and the tail of stdout was lost with it. Verified against
  // 1e39d55, so it predates this change. What remains on the loop is the trace request
  // above and nothing else, so the process leaves as soon as that settles.
  if (opened !== true) {
    console.error(`\n✗ No Case Context was opened, so this task never started: ${note}`
      + '\n   Nothing was executed and no Case record exists. Fix the reported cause and run the task again.\n')
    process.exitCode = 1
  } else {
    process.exitCode = 0
  }
  } catch (error) {
    if (!(error instanceof AgentCredentialRejectedError)) throw error
    console.error(`\n✗ ${error.message}\n`)
    process.exitCode = 3
  }
} else {
  // Interactive terminal client. Browser interaction belongs to the Rulith Local host.
  const inbox = []
  let wake = null
  let stdinOpen = true
  const pushInput = (text) => {
    const t = String(text ?? '').trim()
    if (t === '') return
    inbox.push(t)
    if (wake) { const w = wake; wake = null; w() }
  }
  const nextInput = async () => {
    for (;;) {
      if (inbox.length > 0) return inbox.shift()
      // stdin 关了(管道用完)且没有别的脸在喂 → 如实收工,不是炸(ERR_USE_AFTER_CLOSE 真机踩过)
      if (!stdinOpen) return null
      await new Promise((r) => { wake = r })
    }
  }
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (l) => pushInput(l))
  rl.on('close', () => { stdinOpen = false; if (wake) { const w = wake; wake = null; w() } })
  // 插话不打断: 段跑着的时候来的话,当轮就进对话——不必排队等本段跑完(viz 逐义)。
  // 取自**同一个收件箱**,所以终端/管道/浏览器三张脸都自动获得这个能力,无需各自接线。
  //
  // **水位线是命门**(2026-08-06 真机第一次跑就撞): 收件箱里本来就排着的行是**下一段**,
  // 不是插话。不设水位线直接 shift(),管道喂三行会被吞成一段——`printf '一\n二\nexit\n'`
  // 里的"二"当场被当成"一"的插话。判据是**到达时刻**: 只有段开跑之后才进来的才算插话。
  let queuedAtSegmentStart = 0
  pollInterject = () => (inbox.length > queuedAtSegmentStart ? inbox.splice(queuedAtSegmentStart, 1)[0] : undefined)

  log(`Interactive mode. This is a normal Agent conversation; Rulith is an optional tool. Cases are created only when the Agent chooses governed work on "${defaultSlot.board}". Verify any resulting Cases and conclusions in Console: ${consoleUrl}`)
  log('The transcript stays on this machine and is not written to the board. Empty lines are ignored. Use exit, quit, or Ctrl+C to stop.\n')
  emit('start', { agentId, url: URL_BASE, task: '(interactive)', projection: '' })
  for (;;) {
    if (inbox.length === 0 && stdinOpen) process.stdout.write('You> ')
    const line = await nextInput()
    if (line === null) break
    if (line === 'exit' || line === 'quit') break
    emit('user', { text: line }) // 每张脸都看得到谁问了什么(晚开的浏览器也补得到)
    queuedAtSegmentStart = inbox.length // 水位线: 此刻排着的都是「下一段」,之后到的才是插话
    let segment
    try {
      segment = await runCaseTurn(defaultSlot, line, { policy: 'return' })
    } catch (error) {
      if (!(error instanceof AgentCredentialRejectedError)) throw error
      console.error(`\n✗ ${error.message}\n`)
      process.exitCode = 3
      break
    }
    const { note, caseId, activeCaseId, pendingCaseId } = segment
    emit('segment-end', { note, board: defaultSlot.board, caseId,
      ...(activeCaseId === null ? {} : { activeCaseId }),
      ...(pendingCaseId === null ? {} : { pendingCaseId }) })
    log(`
· ${note}${activeCaseId === null ? '' : ` · Active Rulith Case: ${activeCaseId}.`}${pendingLine(pendingCaseId)}${caseId === null ? '' : ` · Verify in Console: ${consoleUrl}`}
`)
  }
  rl.close()
  log('Stopped.')
  if (process.exitCode === undefined) process.exitCode = 0
}
}

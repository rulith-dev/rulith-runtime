// SPDX-License-Identifier: Apache-2.0
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createHash } from 'node:crypto'

const MAX_BYTES = 1_048_576
const TIMEOUT_MS = 30_000
const MAX_TOOLS = 200
const sessions = new Map()

/** 已发起的外部调用丢失回答，只能保留未知；关闭 MCP 会话不等于回滚业务。 */
export class McpExecutionUnknownError extends Error {}

function limit(values, fallback, label) {
  for (const value of values) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`MCP ${label} must be a positive integer`)
  }
  return Math.min(fallback, ...values.filter(value => value !== undefined))
}

function connectionConfig(source, environment) {
  const transport = source.transport ?? 'streamable-http'
  if (transport === 'stdio') {
    if (typeof source.command !== 'string' || !source.command.trim()) throw new Error('MCP stdio Source requires a local command')
    if (source.args !== undefined && (!Array.isArray(source.args) || source.args.some(arg => typeof arg !== 'string'))) throw new Error('MCP stdio args must be a string array')
    if (source.cwd !== undefined && typeof source.cwd !== 'string') throw new Error('MCP stdio cwd must be a local directory')
    if (source.env !== undefined && (!source.env || typeof source.env !== 'object' || Array.isArray(source.env))) throw new Error('MCP stdio env must be a local credential map')
    for (const [name, value] of Object.entries(source.env ?? {})) {
      if (/^RULITH_/i.test(name) || typeof value !== 'string') throw new Error('MCP Source env must contain strings and cannot set the Rulith namespace')
    }
    return { transport, command: source.command, args: source.args ?? [], cwd: source.cwd,
      env: { ...environment, ...source.env } }
  }
  if (transport !== 'streamable-http') throw new Error('MCP transport must be stdio or streamable-http')
  let url
  try { url = new URL(source.url) } catch { throw new Error('MCP HTTP Source requires a valid endpoint URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('MCP endpoint requires HTTP(S), with credentials in local headers')
  const headers = new Headers(source.headers ?? {})
  for (const name of ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
    if (headers.has(name)) throw new Error(`MCP Source headers cannot replace protocol header ${name}`)
  }
  return { transport, url: url.href, headers: Object.fromEntries(headers) }
}

/** 一次操作共用时限和字节预算，分页、SSE 和通知都不能重置预算。 */
function charge(session, bytes) {
  const operation = session.operation
  if (!operation) return
  operation.bytes += bytes
  if (operation.bytes > operation.maxBytes) throw new Error(`MCP response exceeds the ${operation.maxBytes}-byte limit`)
}

function boundedFetch(session) {
  return async (url, init) => {
    // SDK 的可选 GET 是会话通知流，不属于某次 tools/call。它关闭时不能打断下一次调用。
    const operation = init.method === 'GET' ? undefined : session.operation
    const signal = AbortSignal.any([init.signal, operation?.controller.signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean))
    // MCP endpoint redirects must not move a Source credential or repeat a write elsewhere.
    const response = await fetch(url, { ...init, redirect: 'error', signal })
    if (!response.body) return response
    const reader = response.body.getReader()
    let cancelled = false
    let streamBytes = 0
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { value, done } = await reader.read()
          if (cancelled) return
          if (done) { controller.close(); return }
          streamBytes += value.byteLength
          if (operation && session.operation === operation) charge(session, value.byteLength)
          else if (streamBytes > MAX_BYTES) throw new Error(`MCP response exceeds the ${MAX_BYTES}-byte limit`)
          controller.enqueue(value)
        } catch (error) {
          if (cancelled) return
          controller.error(error)
          if (session.operation === operation) operation?.fail(error)
          await reader.cancel().catch(() => {})
        }
      },
      cancel: reason => { cancelled = true; return reader.cancel(reason) },
    })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}

function createSession(config, fingerprint) {
  const session = { config, fingerprint, connected: false, operation: undefined }
  session.client = new Client({ name: 'rulith-worker', version: '1' }, { capabilities: {} })
  session.transport = config.transport === 'stdio'
    ? new StdioClientTransport({ ...config, stderr: 'pipe', maxBufferSize: MAX_BYTES })
    : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers },
        fetch: boundedFetch(session), reconnectionOptions: { maxRetries: 0 } })
  // stderr 可以包含来源密钥，不回传到云端或 Local 事件；持续排空以免阻塞服务。
  session.transport.stderr?.resume()
  const send = session.transport.send.bind(session.transport)
  session.transport.send = (message, options) => {
    if (message.method === 'tools/call' && session.operation) session.operation.callId = message.id
    return send(message, options)
  }
  session.transport.onmessage = message => {
    if (config.transport === 'stdio') {
      try { charge(session, Buffer.byteLength(JSON.stringify(message))) }
      catch (error) { session.operation?.fail(error); throw error }
    }
    if (message.id === session.operation?.callId && message.error) session.operation.refused = true
  }
  // HTTP request failures reject their own request or bounded body; optional GET failures
  // must not reject an unrelated tool. Stdio has one ordered stream for this Source.
  session.client.onerror = error => { if (config.transport === 'stdio') session.operation?.fail(error) }
  session.client.onclose = () => { session.connected = false }
  return session
}

async function closeSession(session) {
  session.connected = false
  if (session.config.transport === 'streamable-http' && session.transport.sessionId) {
    // Terminate only transport state. It does not cancel or undo any business action.
    await session.transport.terminateSession().catch(() => {})
  }
  await session.client.close().catch(() => {})
}

export async function closeMcpClients() {
  const closing = [...sessions.values()]
  sessions.clear()
  await Promise.all(closing.map(closeSession))
}

/** 连接配置只来自本机 Source vault；模型只能传具名 Tool 的业务参数。 */
export async function invokeMcp({ sourceName, source, tool, args, discovering, environment, fence = {} }) {
  if (typeof sourceName !== 'string' || !sourceName) throw new Error('MCP requires a named governed Source')
  const config = connectionConfig(source, environment)
  const timeoutMs = limit([source.timeoutMs, fence.timeoutMs], TIMEOUT_MS, 'timeoutMs')
  const maxBytes = limit([source.maxResponseBytes, fence.maxResponseBytes], MAX_BYTES, 'maxResponseBytes')
  const fingerprint = createHash('sha256').update(JSON.stringify(config)).digest('hex')
  let session = sessions.get(sourceName)
  if (session?.operation) throw new Error('This MCP Source already has a serial operation in progress')
  if (session && (session.fingerprint !== fingerprint || !session.connected)) {
    await closeSession(session); sessions.delete(sourceName); session = undefined
  }
  if (!session) {
    if (sessions.size >= 128) throw new Error('Worker MCP connection limit reached')
    session = createSession(config, fingerprint); sessions.set(sourceName, session)
  }
  let rejectOperation
  const failed = new Promise((_, reject) => { rejectOperation = reject })
  const operation = { controller: new AbortController(), maxBytes, bytes: 0,
    fail: error => { rejectOperation(error); operation.controller.abort(error) } }
  session.operation = operation
  const timer = setTimeout(() => operation.fail(new Error('MCP operation timeout')), timeoutMs)
  const options = { signal: operation.controller.signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs }
  try {
    return await Promise.race([failed, (async () => {
      if (!session.connected) {
        await session.client.connect(session.transport, options)
        if (!session.client.getServerCapabilities()?.tools) throw new Error('MCP server does not advertise tools')
        session.connected = true
      }
      if (!discovering) return await session.client.callTool({ name: tool, arguments: args }, undefined, options)
      const tools = [], cursors = new Set()
      let cursor
      do {
        const page = await session.client.listTools(cursor === undefined ? {} : { cursor }, options)
        const remaining = MAX_TOOLS - tools.length
        tools.push(...page.tools.slice(0, remaining))
        if (page.tools.length > remaining || (tools.length === MAX_TOOLS && page.nextCursor !== undefined)) return { tools, truncated: true }
        cursor = page.nextCursor
        if (cursor !== undefined) {
          if (cursors.has(cursor) || cursors.size >= MAX_TOOLS) throw new Error('MCP discovery returned a repeated or excessive pagination cursor')
          cursors.add(cursor)
        }
      } while (cursor !== undefined)
      return { tools, truncated: false }
    })()])
  } catch (error) {
    sessions.delete(sourceName)
    operation.controller.abort()
    await closeSession(session)
    if (operation.callId !== undefined && !operation.refused) {
      throw new McpExecutionUnknownError(`MCP execution outcome unknown (${error.message}); do not repeat the external action`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    session.operation = undefined
    operation.controller.abort()
  }
}

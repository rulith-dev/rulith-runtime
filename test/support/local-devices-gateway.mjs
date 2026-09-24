// SPDX-License-Identifier: Apache-2.0
/**
 * A real HTTP Gateway + Console for the Local manager's device authorization.
 *
 * It implements the contract's device routes, the existing `/local-setup` pairing routes the
 * device grant approves, the public MCP surface an Agent token authenticates against, and a
 * model endpoint — over one listening socket, so the tests drive Local through real requests
 * rather than through stubs of its own client.
 *
 * What it is strict about is what the contract says Local must get right:
 *
 *   · the proof is checked against the digest published at grant time, and a wrong one is
 *     refused rather than tolerated;
 *   · unexpected body fields, secrets in query strings and browser `Origin` headers are
 *     refused on the server-to-server routes;
 *   · the token is delivered encrypted to the public key that came with the grant, and only
 *     until it is acknowledged;
 *   · revocation denies the exact Agent token issued under the revoked grant — by its own
 *     identifier, at the authentication boundary — and denies nothing else.
 *
 * The Console half is an in-process function rather than a page: approving a device is a
 * browser session action, and these tests are about what Local does with the result.
 */
import { createServer } from 'node:http'
import { constants, createHash, publicEncrypt, randomUUID } from 'node:crypto'
import { advertisedTools, defaultGateway, MCP_PROTOCOL_VERSION, RULITH_META } from './agent-harness.mjs'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const code8 = () => randomUUID().replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8)

/**
 * A refusal carries a code, because Local has to tell two different refusals apart.
 *
 * "This device is finished" and "this device may not do that with that Agent" arrive on the
 * same status line, and a client that cannot distinguish them signs the computer out when an
 * operator picks the wrong Agent. The real service names the reason; so does this.
 */
class Refusal extends Error {
  constructor(status, teaching, errorCode) { super(teaching); this.status = status; this.errorCode = errorCode }
}
const refuse = (status, teaching, errorCode) => { throw new Refusal(status, teaching, errorCode) }

/** Exactly these fields, no more: an unexpected one is a different request. */
function onlyFields(body, allowed) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) refuse(400, 'A JSON object is required.')
  const extra = Object.keys(body).filter((key) => !allowed.includes(key))
  if (extra.length > 0) refuse(400, `Unexpected fields: ${extra.join(', ')}.`)
  return body
}

export function createDevicesGateway({
  accountId = 'acct-1', accountName = 'Test Account',
  agents = [{ id: 'agent-alpha', name: 'Alpha' }, { id: 'agent-beta', name: 'Beta' }, { id: 'agent-gamma', name: 'Gamma' }],
  model = () => ({ text: 'Nothing further is needed.' }),
} = {}) {
  /** Every request the server saw: path, whether it carried an Origin, and its body. */
  const requests = []
  const devices = new Map()
  const codes = new Map()
  const pairings = new Map()
  /** Issued Agent tokens, by token. `jti` identifies the exact credential a revoke denies. */
  const agentTokens = new Map()
  const connections = new Map()
  /** Per-Agent Boards, so two instances drive genuinely separate state. */
  const boards = new Map()
  const sessions = new Map()
  const materialSubmissions = new Map()
  const enabled = new Map(agents.map((row) => [row.id, { ...row, enabled: true }]))
  /** Paths whose next request answers 503, for the recoverable-delivery arms. */
  const faults = new Map()
  /** Paths whose next request takes effect and then loses its answer on the way back. */
  const dropAfterEffect = new Map()
  /** An Agent id the next pairing delivery claims instead of the approved one. */
  let mispair
  let modelAnswer = model

  const boardFor = (agentId) => {
    if (!boards.has(agentId)) boards.set(agentId, defaultGateway())
    return boards.get(agentId)
  }
  const deviceByToken = (token) => (token === '' ? undefined : [...devices.values()].find((row) => row.tokenHash === sha256(token)))
  const grantUsable = (device) => {
    if (device === undefined) refuse(401, 'Unknown device authorization.', 'device_unknown')
    if (device.state === 'revoked') refuse(401, 'This device authorization was revoked.', 'device_revoked')
    if (Date.parse(device.expiresAt) <= Date.now()) refuse(401, 'This device authorization has expired.', 'device_expired')
    return device
  }
  /** The device bearer returns its account's current enabled Agent directory. */
  const grantedAgents = (_device) => [...enabled.values()]
    .filter((row) => row !== undefined && row.enabled)
    .map((row) => ({ id: row.id, name: row.name }))

  const deviceRoutes = {
    'POST /local-devices/start': (body) => {
      onlyFields(body, ['requestId', 'deviceDigest', 'name', 'publicKey'])
      if (!/^[0-9a-f]{64}$/.test(String(body.deviceDigest ?? ''))) refuse(400, 'deviceDigest must be a SHA-256 hex digest.')
      if (!String(body.publicKey ?? '').includes('BEGIN PUBLIC KEY')) refuse(400, 'A device public key is required.')
      const existing = [...devices.values()].find((row) => row.requestId === body.requestId)
      if (existing !== undefined) return { deviceId: existing.id, code: existing.code, expiresAt: existing.codeExpiresAt }
      const id = 'dev-' + randomUUID().slice(0, 8)
      const code = code8()
      const row = { id, requestId: String(body.requestId), deviceDigest: String(body.deviceDigest),
        name: String(body.name ?? ''), publicKey: String(body.publicKey), code,
        codeExpiresAt: new Date(Date.now() + 600_000).toISOString(), state: 'pending', agentIds: [], accountId }
      devices.set(id, row)
      codes.set(code, id)
      return { deviceId: id, code, expiresAt: row.codeExpiresAt, consoleUrl: base() + '/console/#/devices?code=' + encodeURIComponent(code) }
    },
    'POST /local-devices/poll': (body) => {
      onlyFields(body, ['deviceId', 'deviceSecret'])
      const row = devices.get(String(body.deviceId ?? ''))
      if (row === undefined) refuse(404, 'No such device request.')
      if (sha256(String(body.deviceSecret ?? '')) !== row.deviceDigest) refuse(403, 'The device proof does not match this request.')
      if (row.state === 'pending' && Date.parse(row.codeExpiresAt) <= Date.now()) return { state: 'expired' }
      if (row.state !== 'approved') return { state: row.state }
      // The ciphertext is kept until the acknowledgement, so a Local that crashed between
      // persisting and acknowledging can still finish — and it is bound to the key and proof
      // this grant was created with.
      if (row.ciphertext === undefined) return { state: 'approved', expiresAt: row.expiresAt,
        account: { id: row.accountId, name: accountName }, agents: grantedAgents(row) }
      return { state: 'approved', encryptedDeviceToken: row.ciphertext, expiresAt: row.expiresAt,
        account: { id: row.accountId, name: accountName }, agents: grantedAgents(row) }
    },
    'POST /local-devices/ack': (body) => {
      onlyFields(body, ['deviceId', 'deviceSecret'])
      const row = devices.get(String(body.deviceId ?? ''))
      if (row === undefined) refuse(404, 'No such device request.')
      if (sha256(String(body.deviceSecret ?? '')) !== row.deviceDigest) refuse(403, 'The device proof does not match this request.')
      if (row.state !== 'approved') refuse(409, 'This device request is not approved.')
      delete row.ciphertext
      row.delivered = true
      return { state: 'delivered' }
    },
    'GET /local-devices/context': (_body, { bearer }) => {
      const row = grantUsable(deviceByToken(bearer))
      return { deviceId: row.id, account: { id: row.accountId, name: accountName }, agents: grantedAgents(row), expiresAt: row.expiresAt }
    },
    'POST /local-devices/material-submissions': (body, { bearer }) => {
      onlyFields(body, ['agentId', 'submissionId', 'requestId', 'sessionKey', 'attachments', 'proofDigest'])
      if (!/^sha256:[0-9a-f]{64}$/.test(body.proofDigest ?? '')) refuse(400, 'Invalid task proof digest.', 'bad_command')
      const device = grantUsable(deviceByToken(bearer))
      if (!device.agentIds.includes(body.agentId) || !grantedAgents(device).some(row => row.id === body.agentId)) {
        refuse(403, 'That Agent is outside this device authorization.', 'agent_out_of_scope')
      }
      if (!Array.isArray(body.attachments) || body.attachments.length === 0
        || body.attachments.some(row => {
          onlyFields(row, ['selector', 'digest', 'totalBytes'])
          return !/^mat_[0-9a-f]{32}$/.test(row.selector)
            || !/^sha256:[0-9a-f]{64}$/.test(row.digest)
            || !Number.isSafeInteger(row.totalBytes) || row.totalBytes <= 0
        })) refuse(400, 'Invalid material submission.', 'bad_command')
      const key = `${device.id}:${body.agentId}:${body.requestId}`
      const existing = materialSubmissions.get(key)
      if (existing !== undefined) {
        if (JSON.stringify(existing.body) !== JSON.stringify(body)) refuse(409, 'Submission identity changed.', 'request_conflict')
        return existing.reply
      }
      const reply = { deviceId: device.id, agentId: body.agentId, submissionId: body.submissionId,
        requestId: body.requestId, sessionKey: body.sessionKey, registeredAt: new Date().toISOString(), state: 'registered',
        attachments: body.attachments.map(row => ({ ...row })), proofDigest: body.proofDigest }
      materialSubmissions.set(key, { body: structuredClone(body), reply })
      return reply
    },
    'POST /local-devices/pair': (body, { bearer }) => {
      onlyFields(body, ['pairingId', 'deviceSecret', 'agentId', 'replaceAgentToken'])
      const device = grantUsable(deviceByToken(bearer))
      const pairing = pairings.get(String(body.pairingId ?? ''))
      if (pairing === undefined) refuse(404, 'No such pairing request.')
      if (sha256(String(body.deviceSecret ?? '')) !== pairing.deviceDigest) refuse(403, 'The pairing proof does not match this request.')
      if (pairing.state === 'cancelled') refuse(409, 'This pairing was cancelled.', 'local_setup_cancelled')
      const agentId = String(body.agentId ?? '')
      // Out of scope for this grant — and *not* a statement about the grant itself, which is
      // why it carries its own code.
      if (!grantedAgents(device).some((row) => row.id === agentId)) refuse(403, 'That Agent is outside this device authorization.', 'agent_out_of_scope')
      // Approving a pairing id that is already approved, for the same Agent, is the same
      // request arriving twice — a retry after a lost response. It answers with the approval
      // that exists rather than minting a second credential for one attachment.
      if (pairing.state === 'approved') {
        if (pairing.agentId !== agentId) refuse(409, 'This pairing was already approved for a different Agent.', 'pairing_conflict')
        if (pairing.deviceId !== device.id) refuse(409, 'This pairing was already approved for a different device.', 'pairing_conflict')
        return { pairingId: pairing.id, agentId, connectionId: pairing.connectionId, state: 'approved', alreadyApproved: true }
      }
      const issued = [...agentTokens.values()].find((row) => row.agentId === agentId && !row.revoked)
      if (issued !== undefined && body.replaceAgentToken !== true) {
        refuse(409, 'This Agent already has a token. Replacing it must be explicit.', 'runtime_credential_exists')
      }
      if (issued !== undefined) issued.superseded = true
      // Ordinary issuance, on the ordinary pairing path. The device grant decided *that* this
      // pairing may proceed; it does not carry the credential.
      const token = 'rlt_agt_' + randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
      const jti = 'jti-' + randomUUID().slice(0, 8)
      agentTokens.set(token, { jti, agentId, deviceId: device.id, revoked: false })
      const connectionId = 'conn-' + randomUUID().slice(0, 8)
      const connectionKey = randomUUID().replace(/-/g, '')
      connections.set(connectionId, { id: connectionId, key: connectionKey, agentId, deviceId: device.id, revoked: false })
      Object.assign(pairing, { state: 'approved', agentId, token, connectionId, connectionKey, deviceId: device.id, jti })
      device.issued = [...(device.issued ?? []), { jti, connectionId, agentId }]
      return { pairingId: pairing.id, agentId, connectionId, state: 'approved' }
    },
    /**
     * Self-revoke: the one route a finished grant may still reach.
     *
     * Every other device route refuses a revoked or expired grant, and must. This one cannot,
     * because the state that most needs a retry is exactly "the service already refuses us and
     * this computer does not know whether the revocation happened". A Bearer that matches the
     * grant's own token is therefore accepted while `revoked` or `expired`, and only to finish
     * this.
     *
     * A grant Console revoked first answers a *different* requestId with the fact and
     * `alreadyRevoked: true`, leaving the audit record attributed to whoever actually made it.
     * The same requestId arriving twice is one request retried, and is likewise not a second
     * revocation.
     */
    'POST /local-devices/revoke': (body, { bearer }) => {
      onlyFields(body, ['requestId'])
      const requestId = String(body.requestId ?? '').trim()
      if (!requestId) refuse(400, 'requestId is required.', 'bad_request')
      const row = deviceByToken(bearer)
      if (row === undefined) refuse(401, 'Unknown device authorization.', 'device_unknown')
      if (row.state === 'revoked') {
        return { state: 'revoked', alreadyRevoked: true,
          revokedBy: row.revokedBy, requestId: row.revokeRequestId ?? null }
      }
      row.state = 'revoked'
      row.revokeRequestId = requestId
      row.revokedBy = 'device'
      row.revokedAt = new Date(0).toISOString()
      for (const entry of row.issued ?? []) {
        for (const token of agentTokens.values()) if (token.jti === entry.jti) token.revoked = true
        const connection = connections.get(entry.connectionId)
        if (connection !== undefined) connection.revoked = true
      }
      return { state: 'revoked', alreadyRevoked: false, requestId }
    },
  }

  const setupRoutes = {
    'POST /local-setup/start': (body) => {
      onlyFields(body, ['requestId', 'deviceDigest', 'name', 'clientMode', 'publicKey'])
      const id = String(body.requestId ?? '')
      const existing = pairings.get(id)
      if (existing?.state === 'cancelled') refuse(409, 'This pairing was cancelled and cannot be started again.', 'local_setup_cancelled')
      if (existing !== undefined) return { code: existing.code, expiresAt: existing.expiresAt }
      const row = { id, deviceDigest: String(body.deviceDigest), publicKey: String(body.publicKey),
        clientMode: String(body.clientMode), name: String(body.name ?? ''), code: code8(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(), state: 'pending' }
      pairings.set(id, row)
      return { code: row.code, expiresAt: row.expiresAt }
    },
    /**
     * Cancel an unfinished pairing, atomically, and durably refuse to replay it.
     *
     * The contract root specified: the same proof as poll and ack; only an *unapproved*
     * pairing is cancelled; a repeat with the same proof answers `cancelled` again; an
     * approved one answers 409 `local_setup_already_approved` and nothing is touched; and a
     * later start or approval against a cancelled pairing is refused.
     */
    'POST /local-setup/cancel': (body) => {
      onlyFields(body, ['pairingId', 'deviceSecret'])
      const row = pairings.get(String(body.pairingId ?? ''))
      if (row === undefined) refuse(404, 'No such pairing request.', 'local_setup_unknown')
      if (sha256(String(body.deviceSecret ?? '')) !== row.deviceDigest) refuse(403, 'The pairing proof does not match this request.', 'local_setup_proof_mismatch')
      if (row.state === 'approved') {
        refuse(409, 'This pairing was already approved and a credential exists for it.', 'local_setup_already_approved')
      }
      row.state = 'cancelled'
      return { pairingId: row.id, state: 'cancelled' }
    },
    'POST /local-setup/poll': (body) => {
      onlyFields(body, ['pairingId', 'deviceSecret'])
      const row = pairings.get(String(body.pairingId ?? ''))
      if (row === undefined) refuse(404, 'No such pairing request.', 'local_setup_unknown')
      if (sha256(String(body.deviceSecret ?? '')) !== row.deviceDigest) refuse(403, 'The pairing proof does not match this request.')
      if (row.state === 'cancelled') refuse(409, 'This pairing was cancelled.', 'local_setup_cancelled')
      if (row.state !== 'approved' && Date.parse(row.expiresAt) <= Date.now()) refuse(409, 'This pairing expired.', 'local_setup_expired')
      if (row.state !== 'approved') return { state: row.state }
      const claimed = mispair ?? row.agentId
      mispair = undefined
      return {
        pairingId: row.id, clientMode: row.clientMode, agentId: claimed,
        connectionId: row.connectionId, key: row.connectionKey,
        ...(row.clientMode === 'local_agent' ? { encryptedAgentToken: publicEncrypt(
          { key: row.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          Buffer.from(row.token)).toString('base64') } : {}),
      }
    },
    'POST /local-setup/ack': (body) => {
      onlyFields(body, ['pairingId', 'deviceSecret'])
      const row = pairings.get(String(body.pairingId ?? ''))
      if (row === undefined) refuse(404, 'No such pairing request.')
      if (sha256(String(body.deviceSecret ?? '')) !== row.deviceDigest) refuse(403, 'The pairing proof does not match this request.')
      if (row.state === 'cancelled') refuse(409, 'This pairing was cancelled.', 'local_setup_cancelled')
      row.acked = true
      return { state: 'delivered' }
    },
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const method = String(request.method ?? 'GET').toUpperCase()
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = {}
    try { body = raw === '' ? {} : JSON.parse(raw) } catch { body = {} }
    const bearer = String(request.headers.authorization ?? '').replace(/^Bearer /, '')
    requests.push({ path: url.pathname, method, origin: request.headers.origin, query: url.search, body })
    const reply = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(value))
    }
    try {
      const remaining = faults.get(url.pathname) ?? 0
      if (remaining > 0) {
        faults.set(url.pathname, remaining - 1)
        return void reply(503, { teaching: 'The account service is temporarily unavailable.' })
      }
      if (url.pathname.startsWith('/local-devices') || url.pathname.startsWith('/local-setup')) {
        // Server-to-server only: a browser origin, or a secret smuggled through the query
        // string, is a different request than the one this route accepts.
        if (request.headers.origin !== undefined) refuse(403, 'This route does not accept browser requests.')
        if (url.search !== '') refuse(400, 'This route takes no query parameters.')
      }
      const handler = deviceRoutes[`${method} ${url.pathname}`] ?? setupRoutes[`${method} ${url.pathname}`]
      if (handler !== undefined) {
        const value = handler(body, { bearer }) ?? {}
        // The effect happened and the answer never arrived — the shape a client must not read
        // as "nothing happened". Applied after the handler, deliberately.
        const drops = dropAfterEffect.get(url.pathname) ?? 0
        if (drops > 0) {
          dropAfterEffect.set(url.pathname, drops - 1)
          return void request.socket.destroy()
        }
        return void reply(200, value)
      }
      if (url.pathname === '/local-setup/context' && method === 'GET') {
        const connection = [...connections.values()].find((row) => row.id === request.headers['x-rulith-connection'])
        if (connection === undefined || connection.key !== request.headers['x-rulith-connection-key']) return void reply(401, { teaching: 'Unknown connection.' })
        if (connection.revoked) return void reply(401, { teaching: 'This Connection was revoked with its device.' })
        return void reply(200, { agentId: connection.agentId, connectionId: connection.id, agentName: enabled.get(connection.agentId)?.name ?? '', sources: [] })
      }
      if (url.pathname === '/local-setup/resources' && method === 'POST') {
        const connection = [...connections.values()].find((row) => row.id === request.headers['x-rulith-connection'])
        if (connection === undefined || connection.key !== request.headers['x-rulith-connection-key'] || connection.revoked) return void reply(401, { teaching: 'Unknown connection.' })
        return void reply(200, { revision: 'rev-1', state: 'awaiting_authorization' })
      }
      if (url.pathname === '/v1/messages' && method === 'POST') {
        const answer = modelAnswer(body)
        return void reply(200, { content: [
          ...(answer.text ? [{ type: 'text', text: answer.text }] : []),
          ...(answer.toolCalls ?? []).map((call, index) => ({ type: 'tool_use', id: call.id ?? `call_${index + 1}`, name: call.name, input: call.input ?? {} })),
        ] })
      }
      if (url.pathname === '/mcp') {
        // The one authentication boundary an Agent crosses. A revoked grant's token is denied
        // here, by the credential's own identity, rather than by hiding a button somewhere.
        const issued = agentTokens.get(bearer)
        if (issued === undefined) return void reply(401, { teaching: 'Unknown Agent token.' })
        if (issued.revoked) return void reply(401, { teaching: 'This Agent token was revoked with its device.' })
        const presented = String(request.headers['mcp-session-id'] ?? '')
        const session = sessions.get(presented) ?? { id: 'mcp-' + randomUUID().slice(0, 8), focus: new Set(), agentId: issued.agentId }
        sessions.set(session.id, session)
        const headers = { 'content-type': 'application/json', 'mcp-session-id': session.id }
        const meta = { [RULITH_META]: { agentId: issued.agentId, recovery: { state: 'none' } } }
        const send = (result) => { response.writeHead(200, headers); response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, result })) }
        if (body.method === 'initialize') {
          return void send({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} },
            serverInfo: { name: 'rulith-devices-fixture', version: '0' }, _meta: meta })
        }
        if (body.method === 'notifications/initialized') { response.writeHead(202, headers); return void response.end() }
        if (body.method === 'ping') return void send({ _meta: meta })
        if (body.method === 'tools/list') return void send({ tools: advertisedTools(), _meta: meta })
        if (body.method === 'tools/call') {
          const board = boardFor(issued.agentId)
          const core = board.tool(String(body.params?.name ?? ''), body.params?.arguments ?? {}, session)
          return void send({ content: [{ type: 'text', text: JSON.stringify(core) }],
            _meta: { [RULITH_META]: { ...board.meta(session), agentId: issued.agentId, recovery: { state: 'none' } } } })
        }
        response.writeHead(200, headers)
        return void response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: 'unsupported' } }))
      }
      reply(404, { teaching: 'Not found.' })
    } catch (error) {
      if (error instanceof Refusal) return void reply(error.status, { teaching: error.message, ...(error.errorCode === undefined ? {} : { errorCode: error.errorCode }) })
      reply(500, { teaching: String(error?.message ?? error) })
    }
  })

  let port = 0
  const base = () => `http://127.0.0.1:${port}`

  return {
    requests,
    materialSubmissions,
    devices,
    pairings,
    agentTokens,
    connections,
    boards,
    get origin() { return base() },
    listen: () => new Promise((accept) => server.listen(0, '127.0.0.1', () => { port = server.address().port; accept(base()) })),
    close: () => new Promise((accept) => server.close(accept)),
    setModel: (next) => { modelAnswer = next },
    /** Answer the next `count` requests to this path with 503. */
    failNext: (path, count = 1) => faults.set(path, count),
    /**
     * Apply the next `count` requests to this path and then drop the connection.
     *
     * The failure mode that separates "did not happen" from "I did not hear": the server
     * state changes and the client is told nothing. A client that treats silence as absence
     * of effect gets this wrong in the direction that loses credentials.
     */
    dropResponseAfterEffect: (path, count = 1) => dropAfterEffect.set(path, count),
    /** Deliver the next pairing under a different Agent than the one that was approved. */
    mispairNext: (agentId) => { mispair = agentId },

    /** The Console browser session approving one device for an explicit set of Agents. */
    approve(code, agentIds) {
      const id = codes.get(code)
      if (id === undefined) throw new Error('No device request has that code.')
      const row = devices.get(id)
      if (!Array.isArray(agentIds) || agentIds.length === 0) throw new Error('Select at least one Agent.')
      if (agentIds.some((agentId) => !enabled.has(agentId))) throw new Error('Select Agents this account owns.')
      if (row.state === 'approved') {
        const same = row.agentIds.length === agentIds.length && agentIds.every((agentId) => row.agentIds.includes(agentId))
        if (!same) throw new Error('This device was already approved for a different set of Agents.')
        return { deviceId: row.id, agentIds: row.agentIds }
      }
      const token = 'rlt_dev_' + randomUUID().replace(/-/g, '')
      Object.assign(row, {
        state: 'approved', agentIds: [...agentIds], token, tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
        ciphertext: publicEncrypt({ key: row.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          Buffer.from(token)).toString('base64'),
      })
      return { deviceId: row.id, agentIds: row.agentIds }
    },
    /** Console-side directory changes after this device signed in. */
    disableAgent(agentId) { const row = enabled.get(agentId); if (row !== undefined) row.enabled = false },
    enableAgent(agentId) { const row = enabled.get(agentId); if (row !== undefined) row.enabled = true },
    /** Console has already invalidated the old key; Local must prove and save this replacement. */
    replaceConnectionKey(connectionId, key) {
      const row = connections.get(connectionId)
      if (row === undefined) throw new Error('No Connection has that id.')
      row.key = String(key)
    },
    /** Expire a grant without revoking it, as the clock would. */
    expireDevice(deviceId) { devices.get(deviceId).expiresAt = new Date(Date.now() - 1000).toISOString() },
    /** The owner revoking this device from the Console device list, before Local asks to. */
    revokeDeviceFromConsole(deviceId) {
      const row = devices.get(deviceId)
      row.state = 'revoked'
      row.revokedBy = 'console'
      row.revokeRequestId = 'console-' + deviceId
      for (const entry of row.issued ?? []) {
        for (const token of agentTokens.values()) if (token.jti === entry.jti) token.revoked = true
        const connection = connections.get(entry.connectionId)
        if (connection !== undefined) connection.revoked = true
      }
    },
    /** What the audit record says, so a test can prove a retry did not rewrite it. */
    revocationRecord(deviceId) {
      const row = devices.get(deviceId)
      return { state: row.state, revokedBy: row.revokedBy, requestId: row.revokeRequestId }
    },
    deviceToken(deviceId) { return devices.get(deviceId).token },
    tokenFor(agentId) { return [...agentTokens.entries()].find(([, row]) => row.agentId === agentId && !row.revoked && !row.superseded)?.[0] },
    /** Delete the account, as the lifecycle does: grants and retained ciphertext go with it. */
    deleteAccount() {
      for (const row of devices.values()) { row.state = 'revoked'; delete row.ciphertext; delete row.token; delete row.tokenHash }
      for (const token of agentTokens.values()) token.revoked = true
      for (const connection of connections.values()) connection.revoked = true
    },
  }
}

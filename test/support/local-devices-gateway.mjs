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
import { CONTRACT, advertisedTools, defaultGateway, MCP_PROTOCOL_VERSION, RULITH_META } from './agent-harness.mjs'

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
/** A route's answer with a status other than 200 (opening a project answers 202 in progress, 409 at a terminal state). */
class Answer {
  constructor(status, value) { this.status = status; this.value = value }
}

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
  /** Conversation settings by conversation key (ACC-CONV-05/06). */
  const conversationModes = new Map()
  const conversationReview = new Map()
  const conversationEnded = new Set()
  const conversationRow = (key) => ({ boardId: 'board-' + sha256(String(key)).slice(0, 12), createdAt: '2026-10-17T00:00:00Z', lastActivityAt: null,
    postCallReview: conversationReview.get(key) ?? true, explorationModes: { 'conn-1': conversationModes.get(key) ?? 'strict' } })
  /**
   * Opened projects by Agent, Connection and folder (PSC 0.2.24), as the real Gateway keeps them: an opening is recorded
   * only when its configuration step commits. Until then an open answers 202 at stage `configuration` and records nothing
   * (a state read says `not_open`); once recorded it walks `program` -> `mode` -> ready on each read or retry. State reads
   * always answer 200; only `open` answers 202 (in progress) or 409 (this opening reached a terminal state).
   */
  const projects = new Map()
  let projectConfigurationWaits = 0
  let projectSteps = 0
  let projectTerminal
  const projectTools = [{ id: 'eng.read', digest: 'sha256:' + 'a'.repeat(64), directUse: true },
    { id: 'eng.write', digest: 'sha256:' + 'b'.repeat(64), directUse: true },
    { id: 'eng.run', digest: 'sha256:' + 'c'.repeat(64), directUse: true }]
  const enabled = new Map(agents.map((row) => [row.id, { ...row, enabled: true }]))
  /** Paths whose next request answers 503, for the recoverable-delivery arms. */
  const faults = new Map()
  /** Paths whose next request takes effect and then loses its answer on the way back. */
  const dropAfterEffect = new Map()
  /** An Agent id the next pairing delivery claims instead of the approved one. */
  let mispair
  let modelAnswer = model
  let healthReply
  let healthRefusal

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
    .map((row) => ({ id: row.id, name: row.name,
      ...(row.reconnectable === undefined ? {} : { reconnectable: row.reconnectable }) }))

  const projectContext = (body, allowed, bearer) => {
    for (const field of ['release', 'tools', 'digest', 'directUse', 'mode', 'explorationMode', 'source', 'command']) {
      if (body !== null && typeof body === 'object' && Object.hasOwn(body, field)) {
        refuse(400, `A client cannot supply ${field}. Nothing was changed.`, 'client_authority_refused')
      }
    }
    onlyFields(body, allowed)
    const device = grantUsable(deviceByToken(bearer))
    if (body.expectedAccountId !== device.accountId) refuse(409, 'The account shown on this computer is not this device\'s account.', 'account_changed')
    if (!device.agentIds.includes(body.agentId)) refuse(403, 'This device is not currently authorized for that Agent', 'not_authorized')
    const connection = connections.get(String(body.connectionId ?? ''))
    if (connection === undefined || connection.agentId !== body.agentId || connection.deviceId !== device.id || connection.revoked) {
      refuse(403, 'This Connection was not paired by this computer.', 'connection_not_of_this_device')
    }
    if (!['windows', 'posix'].includes(body.platform)) refuse(400, 'platform must be windows or posix', 'bad_command')
    const directory = String(body.directory ?? '')
    if (body.platform === 'windows' ? !/^[A-Za-z]:\\[^\\]/.test(directory) : !/^\/[^/]/.test(directory)) {
      refuse(400, body.platform === 'windows' ? 'Choose a folder such as D:\\folder.' : 'Choose a folder such as /home/you/folder.', 'bad_command')
    }
    const authorizationVersion = 'sha256:' + sha256(JSON.stringify([device.accountId, body.agentId, body.connectionId, device.id,
      directory, projectTools, 'non_strict']))
    return { device, accountId: device.accountId, agentId: body.agentId, connectionId: body.connectionId, directory,
      authorizationVersion, key: `${body.agentId}|${body.connectionId}|${directory}` }
  }
  const projectBase = (context, state) => ({
    state, accountId: context.accountId, agentId: context.agentId, agentName: enabled.get(context.agentId)?.name ?? '',
    connectionId: context.connectionId, connectionName: 'Workspace', directory: context.directory,
    authorizationVersion: context.authorizationVersion, computer: { deviceId: context.device.id, label: context.device.name },
    capability: { releaseDigest: 'sha256:' + 'e'.repeat(64), id: 'engineering_work', version: '1.0.0' },
    tools: projectTools.map((tool) => ({ ...tool })), mode: { requested: 'non_strict' },
  })
  /**
   * A recorded opening's state with the status `open` gives it: in progress (202, `retry`) for its remaining steps, a
   * terminal state (409, `confirm_again`), or ready (200). A state read answers the same body with 200.
   */
  const projectAdvance = (context, opened) => {
    const out = { ...projectBase(context, 'pending'), openRequestId: opened.openRequestId,
      project: { source: 'project', openRequestId: opened.openRequestId, originalRequestId: opened.originalRequestId } }
    if (opened.state === undefined && projectTerminal !== undefined) { opened.state = projectTerminal; projectTerminal = undefined }
    if (opened.state !== undefined) {
      return new Answer(409, { ...out, state: opened.state, recovery: 'confirm_again',
        teaching: 'Confirm the folder again from this computer to start a new opening.' })
    }
    if (opened.steps > 0) {
      const stage = opened.steps > 1 ? 'program' : 'mode'
      opened.steps -= 1
      return new Answer(202, { ...out, stage, recovery: 'retry', waitingFor: 'kernel_confirmation' })
    }
    return { ...out, state: 'ready', mode: { requested: 'non_strict', state: 'complete', current: 'non_strict' } }
  }

  const deviceRoutes = {
    'GET /local-devices/health': (_body, { bearer }) => {
      const device = grantUsable(deviceByToken(bearer))
      if (healthRefusal) refuse(401, healthRefusal, 'device_unauthorized')
      if (healthReply === undefined) refuse(404, 'Health is not offered by this service.')
      return { device: { deviceId: device.id, name: device.name, state: device.state, expiresAt: device.expiresAt },
        agents: [], truncated: false, ...healthReply }
    },
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
      onlyFields(body, ['agentId', 'submissionId', 'requestId', 'sessionKey', 'attachments', 'proofDigest', 'selectionDigest', 'custodyBindings'])
      if (!/^sha256:[0-9a-f]{64}$/.test(body.proofDigest ?? '')) refuse(400, 'Invalid task proof digest.', 'bad_command')
      if (!/^sha256:[0-9a-f]{64}$/.test(body.selectionDigest ?? '')
        || body.selectionDigest === body.proofDigest) refuse(400, 'Invalid material selection digest.', 'bad_command')
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
      if (body.custodyBindings !== undefined && (!Array.isArray(body.custodyBindings)
        || body.custodyBindings.length !== body.attachments.length
        || new Set(body.custodyBindings.map(row => row?.custodyId)).size !== body.custodyBindings.length
        || body.custodyBindings.some((row, index) => {
          onlyFields(row, ['selector', 'custodyId', 'digest', 'totalBytes'])
          return row.selector !== body.attachments[index].selector
            || row.digest !== body.attachments[index].digest
            || row.totalBytes !== body.attachments[index].totalBytes
            || !/^[A-Za-z0-9_.-]{1,128}$/.test(row.custodyId ?? '')
            || row.custodyId === row.selector
        }))) refuse(400, 'Invalid private material custody.', 'bad_command')
      const key = `${device.id}:${body.agentId}:${body.requestId}`
      const existing = materialSubmissions.get(key)
      if (existing !== undefined) {
        if (JSON.stringify(existing.body) !== JSON.stringify(body)) refuse(409, 'Submission identity changed.', 'request_conflict')
        return existing.reply
      }
      const reply = { deviceId: device.id, agentId: body.agentId, submissionId: body.submissionId,
        requestId: body.requestId, sessionKey: body.sessionKey, registeredAt: new Date().toISOString(), state: 'registered',
        attachments: body.attachments.map(row => ({ ...row })), proofDigest: body.proofDigest,
        selectionDigest: body.selectionDigest }
      materialSubmissions.set(key, { body: structuredClone(body), reply })
      return reply
    },
    // ACC-CONV-05/06: one conversation's settings, by its key; the Agent must be inside the grant.
    'POST /local-devices/conversations/state': (body, { bearer }) => {
      onlyFields(body, ['agentId', 'conversationKey'])
      const device = grantUsable(deviceByToken(bearer))
      if (!device.agentIds.includes(body.agentId)) refuse(403, 'This Agent is outside the device grant.', 'agent_out_of_scope')
      return { agentId: body.agentId, found: true, connections: [{ connectionId: 'conn-1', name: 'Workspace' }], reviewer: null,
        conversation: conversationRow(body.conversationKey) }
    },
    'POST /local-devices/conversations/exploration-mode': (body, { bearer }) => {
      onlyFields(body, ['agentId', 'conversationKey', 'connectionId', 'mode', 'requestId'])
      const device = grantUsable(deviceByToken(bearer))
      if (!device.agentIds.includes(body.agentId)) refuse(403, 'This Agent is outside the device grant.', 'agent_out_of_scope')
      if (!['strict', 'derived', 'non_strict'].includes(body.mode)) refuse(400, 'Unknown exploration mode', 'bad_command')
      conversationModes.set(body.conversationKey, body.mode)
      return { requestId: body.requestId, boardId: conversationRow(body.conversationKey).boardId, state: 'complete', result: { accepted: true } }
    },
    'POST /local-devices/conversations/review': (body, { bearer }) => {
      onlyFields(body, ['agentId', 'conversationKey', 'enabled'])
      const device = grantUsable(deviceByToken(bearer))
      if (!device.agentIds.includes(body.agentId)) refuse(403, 'This Agent is outside the device grant.', 'agent_out_of_scope')
      if (typeof body.enabled !== 'boolean') refuse(400, 'enabled must be true or false', 'bad_command')
      if (body.enabled === false && conversationModes.get(body.conversationKey) === 'derived')
        refuse(409, 'Switch this conversation out of derived mode before turning its review off.', 'derived_requires_review')
      conversationReview.set(body.conversationKey, body.enabled)
      return conversationRow(body.conversationKey)
    },
    'POST /local-devices/conversations/end-preview': (body, { bearer }) => {
      onlyFields(body, ['agentId', 'conversationKey'])
      const device = grantUsable(deviceByToken(bearer))
      if (!device.agentIds.includes(body.agentId)) refuse(403, 'This Agent is outside the device grant.', 'agent_out_of_scope')
      return { agentId: body.agentId, found: true, boardId: conversationRow(body.conversationKey).boardId, ended: conversationEnded.has(body.conversationKey),
        pendingCall: false, openGoals: [{ caseId: 'case-1', root: 'root-1', title: 'goal' }] }
    },
    'POST /local-devices/conversations/end': (body, { bearer }) => {
      onlyFields(body, ['agentId', 'conversationKey', 'requestId'])
      const device = grantUsable(deviceByToken(bearer))
      if (!device.agentIds.includes(body.agentId)) refuse(403, 'This Agent is outside the device grant.', 'agent_out_of_scope')
      conversationEnded.add(body.conversationKey)
      return { agentId: body.agentId, found: true, boardId: conversationRow(body.conversationKey).boardId, ended: true,
        endedAt: '2026-10-17T00:00:00Z', closedGoals: ['case-1'], unconfirmedGoals: [] }
    },
    // PSC 0.2.24: opening a project. The client names only the Agent, Connection, folder, platform and (to open) the
    // version of the confirmation the owner saw; the capability, tools, digests and mode are the server's.
    'POST /local-devices/projects/state': (body, { bearer }) => {
      const context = projectContext(body, ['expectedAccountId', 'agentId', 'connectionId', 'directory', 'platform'], bearer)
      const opened = projects.get(context.key)
      if (opened === undefined) return projectBase(context, 'not_open')
      const answered = projectAdvance(context, opened)
      return answered instanceof Answer ? answered.value : answered
    },
    'POST /local-devices/projects/open': (body, { bearer }) => {
      const context = projectContext(body, ['requestId', 'expectedAccountId', 'agentId', 'connectionId', 'directory', 'platform',
        'authorizationVersion'], bearer)
      if (typeof body.requestId !== 'string' || body.requestId === '') refuse(400, 'requestId is required', 'bad_command')
      const answer = (value, extra) => value instanceof Answer
        ? new Answer(value.status, { ...value.value, ...extra }) : { ...value, ...extra }
      const opened = projects.get(context.key)
      // Already open: the same opening continues. Only a new confirmation after a terminal state starts a new opening.
      if (opened !== undefined && (opened.state === undefined || body.requestId === opened.originalRequestId)) {
        return answer(projectAdvance(context, opened), { requestId: body.requestId, changed: false, alreadyOpen: true })
      }
      if (body.authorizationVersion !== context.authorizationVersion) {
        refuse(409, 'What this computer showed for confirmation no longer matches what opening the project would grant.'
          + ' Show the confirmation again. Nothing was changed.', 'authorization_changed')
      }
      // The configuration step waits for a gap between calls: nothing is recorded, the same request continues later.
      if (projectConfigurationWaits > 0) {
        projectConfigurationWaits -= 1
        return new Answer(202, { ...projectBase(context, 'pending'), stage: 'configuration', waitingFor: 'agent_call_pending',
          recovery: 'retry', changed: false, requestId: body.requestId })
      }
      const next = { openRequestId: 'open.' + sha256(body.requestId).slice(0, 16), originalRequestId: body.requestId, steps: projectSteps }
      projects.set(context.key, next)
      return answer(projectAdvance(context, next), { requestId: body.requestId, changed: true, alreadyOpen: opened !== undefined,
        ...(opened === undefined ? {} : { renews: opened.openRequestId }) })
    },
    'POST /local-devices/authoring/cases': (body, { bearer }) => {
      onlyFields(body, ['expectedAccountId', 'agentId', 'materialId', 'documentDigest', 'proposalDigest'])
      const device = grantUsable(deviceByToken(bearer))
      if (body.expectedAccountId !== device.accountId || !device.agentIds.includes(body.agentId))
        refuse(403, 'This Agent is outside the device grant.', 'agent_out_of_scope')
      return { cases: [] }
    },
    'POST /local-devices/pair': (body, { bearer }) => {
      onlyFields(body, ['pairingId', 'deviceSecret', 'agentId', 'replaceAgentToken', 'reconnectConnectionId'])
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
        if (body.reconnectConnectionId !== undefined && body.reconnectConnectionId !== pairing.connectionId)
          refuse(409, 'This pairing was already approved for a different Connection.', 'pairing_conflict')
        return { pairingId: pairing.id, agentId, connectionId: pairing.connectionId, state: 'approved', alreadyApproved: true }
      }
      if (body.reconnectConnectionId !== undefined
        && !(enabled.get(agentId)?.reconnectable ?? []).some(row => row?.connectionId === body.reconnectConnectionId)) {
        refuse(409, 'That Connection is no longer available to reconnect.', 'connection_unavailable')
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
      const connectionId = body.reconnectConnectionId ?? 'conn-' + randomUUID().slice(0, 8)
      const connectionKey = randomUUID().replace(/-/g, '')
      connections.set(connectionId, { ...connections.get(connectionId),
        id: connectionId, key: connectionKey, agentId, deviceId: device.id, revoked: false })
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
        const answered = handler(body, { bearer }) ?? {}
        const status = answered instanceof Answer ? answered.status : 200
        const value = answered instanceof Answer ? answered.value : answered
        // The effect happened and the answer never arrived — the shape a client must not read
        // as "nothing happened". Applied after the handler, deliberately.
        const drops = dropAfterEffect.get(url.pathname) ?? 0
        if (drops > 0) {
          dropAfterEffect.set(url.pathname, drops - 1)
          return void request.socket.destroy()
        }
        return void reply(status, value)
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
          return void send({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {}, experimental: { [RULITH_META]: CONTRACT.serverCapabilities } },
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
    setReconnectable(agentId, rows) { enabled.get(agentId).reconnectable = rows },
    setHealth(reply) { healthReply = reply },
    /**
     * The next opening: its first `configurationWaits` opens wait at the configuration step (nothing recorded), then it
     * stays in progress for `steps` more reads or retries (program, then mode).
     */
    projectInProgress(steps, configurationWaits = 0) { projectSteps = steps; projectConfigurationWaits = configurationWaits },
    /** The next read of an opened project finds that opening at this terminal state (for example `mode_changed`). */
    projectTerminalNext(state) { projectTerminal = state },
    projects,
    refuseHealth(teaching) { healthRefusal = teaching },
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

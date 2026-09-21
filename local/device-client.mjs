// SPDX-License-Identifier: Apache-2.0
/**
 * Browser-assisted account login for one Local installation.
 *
 * What this client is, and what it deliberately is not:
 *
 *   · It obtains a **device** grant, not an account session. The browser approves one
 *     device record; its Agent directory is the account's current enabled Agents, refreshed
 *     through this device grant. No cookie ever reaches this computer. The management token it does receive is an
 *     operator credential — it authorizes management calls, and it is never placed in a
 *     child process environment or in model context.
 *   · The token arrives **encrypted to a key this computer generated**, so a Console that
 *     is replayed, a proxy that logs bodies and a poll answered twice all fail to produce
 *     a usable credential. The proof (`deviceSecret`) is held here and only its SHA-256
 *     digest is published at grant time.
 *   · Delivery is **recoverable**. The token is persisted before the acknowledgement is
 *     sent, so a crash between the two leaves a device that can finish the handshake on
 *     the next poll rather than a grant that was delivered to nobody.
 *
 * Revocation and expiry are terminal here: a grant that the Gateway no longer accepts
 * makes this installation's status unusable and is reported as such. Nothing is rotated
 * or re-requested automatically, because re-authorizing is an account decision made in a
 * browser by a person.
 */
import { constants, createHash, generateKeyPairSync, privateDecrypt, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { setupOrigin } from './setup-service.mjs'
import { writeJsonAtomic } from './manager-registry.mjs'

const DEVICE_FORMAT = 'rulith-local-device/1'
const MAX_RESPONSE_BYTES = 262_144
const REQUEST_TIMEOUT_MS = 15_000
const digest = (value) => createHash('sha256').update(value).digest('hex')
const text = (value) => (typeof value === 'string' ? value : '')

/**
 * A refusal from the account service, carrying what the service said rather than a
 * conclusion this client drew from the status line alone.
 */
class DeviceRefused extends Error {
  constructor(message, { status, errorCode } = {}) {
    super(message)
    this.name = 'DeviceRefused'
    this.status = status
    this.errorCode = errorCode
  }
}
/**
 * The error codes that mean *this device grant* is finished, as opposed to this one request
 * being outside what it may do.
 *
 * The distinction is the whole point. `/local-devices/pair` refuses for two very different
 * reasons — the device is no longer authorized, or the chosen Agent is no longer enabled —
 * and an earlier version treated both as "signed out". One operator mistake (picking an
 * Agent that had been removed in Console) would then discard a perfectly valid device grant
 * and every instance's route back to it. So only these codes, or a failure of the route
 * whose entire subject is the device, may change local status.
 */
const DEVICE_INVALIDATION_CODES = new Set([
  'device_revoked', 'device_expired', 'device_unknown', 'device_not_found', 'device_unauthorized',
])
const refusedAuthorization = (error) => error instanceof DeviceRefused && (error.status === 401 || error.status === 403)

/**
 * The device record exists and cannot be understood.
 *
 * It gets the same treatment the registry gets, and for a sharper reason: this file holds the
 * credential that can revoke this computer's authorization. Overwriting it to "recover" would
 * destroy the only thing that can withdraw a grant the account service still honours. So it is
 * reported with its path and left exactly as it is, and the one operation offered is an
 * explicit clear that says plainly what it could not do.
 */
export class DeviceRecordUnreadableError extends Error {
  constructor(file, detail) {
    super(`The device record at ${file} cannot be read: ${detail}.`
      + ' Nothing was changed. This computer cannot use or revoke that authorization until the file is repaired or cleared;'
      + ' "Clear it and sign in again" removes it here, and the device should then be revoked in Console because the'
      + ' credential that would have revoked it could not be read.')
    this.name = 'DeviceRecordUnreadableError'
    this.file = file
  }
}

/**
 * One bounded server-to-server call.
 *
 * No `Origin` header (this is not a browser and the Gateway refuses one), no secret in a
 * query string, no redirects — a 30x to another origin would re-send a Bearer credential
 * to a host the operator never configured — and a hard cap on how much will be read.
 */
async function call(origin, path, { body, bearer, method } = {}) {
  const response = await fetch(setupOrigin(origin) + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(bearer === undefined ? {} : { authorization: 'Bearer ' + bearer }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const chunks = []
  let size = 0
  if (response.body !== null) {
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > MAX_RESPONSE_BYTES) throw new Error('The account service answered with more data than this step accepts.')
      chunks.push(chunk)
    }
  }
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { value = {} }
  if (!response.ok) {
    const teaching = text(value.teaching) || `The account service refused this step (HTTP ${response.status}).`
    throw new DeviceRefused(teaching, { status: response.status, errorCode: text(value.errorCode) || undefined })
  }
  return value
}

/**
 * The states this record can be in, and what each one means for what may happen next:
 *
 *   · `none`     — nothing here. A sign-in may start.
 *   · `pending`  — a grant exists at the service and a browser has not approved it.
 *   · `approved` — the token is on this computer and the acknowledgement is outstanding.
 *   · `linked`   — usable.
 *   · `revoked` / `expired` / `unusable` — the service no longer accepts this grant. Terminal
 *     until an operator clears it; nothing here re-authorizes or rotates by itself.
 *
 * @param {object} options
 * @param {string} options.root Manager home directory; the device record lives inside it.
 */
export function createDeviceClient({ root } = {}) {
  const file = join(root, 'device.json')
  let busy = false
  /**
   * Every write to this file is read-modify-write, and they are serialized here.
   *
   * `exclusive` covers the steps a person takes one at a time; it does not cover the writes
   * that happen *inside* other work — recording what a pairing produced, noting an
   * interrupted sign-out — or a write whose `current` was captured before a network call.
   * Two of those overlapping drop whichever entry the loser had read before. So no write
   * takes a snapshot from outside: each one re-reads inside this queue and is handed the
   * record as it is at that moment.
   */
  let writes = Promise.resolve()

  const load = () => {
    if (!existsSync(file)) return { format: DEVICE_FORMAT, state: 'none' }
    let raw
    try { raw = readFileSync(file, 'utf8') } catch (error) { throw new DeviceRecordUnreadableError(file, String(error?.code ?? error?.message ?? error)) }
    let value
    try { value = JSON.parse(raw) } catch (error) { throw new DeviceRecordUnreadableError(file, `invalid JSON (${error.message})`) }
    if (value?.format !== DEVICE_FORMAT) throw new DeviceRecordUnreadableError(file, `format ${JSON.stringify(value?.format)} is not ${DEVICE_FORMAT}`)
    return value
  }
  /**
   * Refuse a write that would move this record backwards.
   *
   * The states are a one-way sequence — `none` → `pending` → `approved` → `linked`, and from
   * anywhere to `revoked`/`expired`/`unusable`. A write that puts a linked grant back to
   * `pending` is a lost update wearing the shape of a legitimate step, and the damage is not
   * bookkeeping: the token stays on disk while the manager believes nobody is signed in, so
   * nothing offers to revoke it. `clear()` is how a record ends, not a state transition.
   */
  const RANK = { none: 0, pending: 1, approved: 2, linked: 3, revoked: 4, expired: 4, unusable: 4 }
  const mutate = (change) => {
    const run = writes.then(() => {
      const current = load()
      const next = change(current)
      if (next === undefined) return current
      const from = RANK[current.state ?? 'none'] ?? 0
      const to = RANK[next.state ?? 'none'] ?? 0
      if (to < from) {
        throw new Error(`Refusing to record this device as ${next.state} while it is ${current.state}.`
          + ' Nothing was changed; the account step that produced this was overtaken by another one.')
      }
      writeJsonAtomic(file, next)
      return next
    })
    writes = run.then(() => undefined, () => undefined)
    return run
  }
  const exclusive = async (action) => {
    if (busy) throw new Error('Wait for the current account step to finish.')
    busy = true
    try { return await action() } finally { busy = false }
  }
  /** Record that the service no longer accepts this grant. Only three callers may do this. */
  const markUnusable = (teaching, state = 'unusable') => mutate((current) => {
    if (current.state !== 'linked' && current.state !== 'approved') return undefined
    return { ...current, state, unusableTeaching: teaching, unusableAt: new Date().toISOString() }
  })
  /**
   * Re-throw a refusal of a route whose subject *is* the device — context, poll, ack — and
   * record that the grant is finished on the way past.
   */
  const deviceRouteRefusal = async (error) => {
    if (refusedAuthorization(error)) await markUnusable(error.message)
    throw error
  }
  /**
   * Did the service refuse *this operation*, or this *device*?
   *
   * Asked only when an operation route answered 401/403 without naming a device-level code.
   * A network failure while asking proves nothing and leaves the grant alone: "I could not
   * check" must never be recorded as "it is gone".
   */
  const grantStillAccepted = async (current) => {
    try {
      await call(current.origin, '/local-devices/context', { bearer: current.token })
      return true
    } catch (error) {
      if (refusedAuthorization(error)) return false
      return true
    }
  }
  /** Wrap an operation route so one denied request cannot sign this computer out. */
  const operationRefusal = async (error) => {
    if (!refusedAuthorization(error)) throw error
    if (DEVICE_INVALIDATION_CODES.has(error.errorCode ?? '')) {
      await markUnusable(error.message)
      throw error
    }
    const current = load()
    if (text(current.token) && !(await grantStillAccepted(current))) {
      await markUnusable('The account service no longer accepts this device authorization.')
    }
    throw error
  }
  const linked = () => {
    const current = load()
    if (current.state !== 'linked' || !text(current.token)) {
      throw new Error(current.state === 'revoked' || current.state === 'expired' || current.state === 'unusable'
        ? 'This device authorization is no longer usable. Sign in again from the manager.'
        : 'Sign in to a Rulith account from the manager first.')
    }
    return current
  }

  /**
   * What a browser page may see: status and names, never a secret or a key.
   *
   * A record that cannot be read is a *state*, not an exception thrown through the page. The
   * manager's whole view is assembled from this, so throwing here made one damaged file answer
   * every request with 400 and left the operator with no rendered page, no explanation and no
   * button — while the two operations that could have cleared it both began by reading it.
   */
  const status = () => {
    let current
    try { current = load() } catch (error) {
      if (!(error instanceof DeviceRecordUnreadableError)) throw error
      return { state: 'unreadable', origin: '', deviceName: '', deviceId: '', code: '', codeExpiresAt: '',
        consoleUrl: '', account: null, agents: [], expiresAt: '', signOut: null, teaching: error.message, file }
    }
    return {
      state: current.state ?? 'none',
      origin: text(current.origin),
      deviceName: text(current.name),
      deviceId: text(current.deviceId),
      code: current.state === 'pending' ? text(current.code) : '',
      codeExpiresAt: current.state === 'pending' ? text(current.codeExpiresAt) : '',
      consoleUrl: current.state === 'pending' ? text(current.consoleUrl) : '',
      account: current.account ?? null,
      agents: Array.isArray(current.agents) ? current.agents.map((row) => ({ id: String(row.id), name: String(row.name ?? row.id) })) : [],
      expiresAt: text(current.expiresAt),
      signOut: current.signOut ?? null,
      teaching: text(current.unusableTeaching) || text(current.signInTeaching),
    }
  }

  return {
    file,
    get busy() { return busy },
    status,
    /**
     * The raw record, for the manager's own bookkeeping. Never served to a browser.
     *
     * An unreadable file answers as a record in the `unreadable` state rather than throwing,
     * for the same reason `status` does: every caller here is deciding whether something may
     * run, and "I cannot tell" has to reach that decision as an answer it can refuse on.
     */
    peek: () => {
      try { return load() } catch (error) {
        if (!(error instanceof DeviceRecordUnreadableError)) throw error
        return { format: DEVICE_FORMAT, state: 'unreadable', unusableTeaching: error.message }
      }
    },

    /**
     * Ask the Gateway for a device grant and return the short code a person types into
     * Console. The proof and private key are written before the request is sent, so a
     * grant the server created is never one this computer cannot finish.
     */
    start: ({ consoleUrl, name } = {}) => exclusive(async () => {
      const current = load()
      if (current.state === 'linked' || current.state === 'approved') {
        throw new Error('This computer is already signed in. Sign out before connecting a different account.')
      }
      // A grant the service stopped accepting still has credentials on this computer that it
      // issued. Signing in over it would leave those behind as unusable leftovers that later
      // refuse the very instance they belong to, so clearing it is its own deliberate step.
      if (['revoked', 'expired', 'unusable'].includes(current.state)) {
        throw new Error('This device authorization is no longer usable, and the credentials it issued are still on this computer. Clear it first, then sign in again.')
      }
      const origin = setupOrigin(consoleUrl)
      const deviceName = text(name).trim() || hostname()
      if (deviceName.length > 120) throw new Error('Choose a device name of at most 120 characters.')
      const expired = current.codeExpiresAt !== undefined && Date.parse(current.codeExpiresAt) <= Date.now()
      let pending = current
      if (current.state !== 'pending' || current.origin !== origin || current.name !== deviceName || expired) {
        const keys = generateKeyPairSync('rsa', {
          modulusLength: 2048,
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        })
        pending = { format: DEVICE_FORMAT, state: 'pending', origin, name: deviceName,
          requestId: randomUUID(), deviceSecret: randomBytes(32).toString('hex'),
          publicKey: keys.publicKey, privateKey: keys.privateKey, instances: {} }
        pending = await mutate(() => pending)
      }
      let reply
      try {
        reply = await call(origin, '/local-devices/start', { body: {
          requestId: pending.requestId, deviceDigest: digest(pending.deviceSecret), name: deviceName, publicKey: pending.publicKey } })
        if (!text(reply.deviceId) || !text(reply.code)) throw new Error('The account service did not return a device code for this request.')
      } catch (error) {
        const teaching = error instanceof DeviceRefused && error.status === 404
          ? 'This Console does not provide device sign-in. Check the Console address or update its Gateway, then retry.'
          : 'Sign-in did not finish. Check the Console address and retry. ' + text(error.message)
        await mutate(latest => latest.requestId === pending.requestId ? { ...latest, signInTeaching: teaching } : latest)
        throw new Error(teaching)
      }
      const deviceId = text(reply.deviceId)
      const code = text(reply.code)
      if (!deviceId || !code) throw new Error('The account service did not return a device code for this request.')
      // A Console address the service supplies is used only when it is on the origin this
      // operator configured. Anything else is a redirect to a host they never chose, so the
      // link is built from the configured origin instead.
      const supplied = text(reply.consoleUrl)
      const sameOrigin = supplied !== '' && (() => { try { return new URL(supplied).origin === origin } catch { return false } })()
      await mutate((latest) => ({ ...(latest.requestId === pending.requestId ? latest : pending), ...pending, deviceId, code, signInTeaching: '',
        codeExpiresAt: text(reply.expiresAt),
        consoleUrl: sameOrigin ? supplied : origin + '/console/#/devices?code=' + encodeURIComponent(code) }))
      return status()
    }),

    /**
     * Has the browser approved this device yet?
     *
     * The order here is the whole point: decrypt, persist, *then* acknowledge. An ack that
     * preceded the write would let the service drop the ciphertext for a token this
     * computer had not stored, and the grant would be unreachable from both ends.
     */
    poll: () => exclusive(async () => {
      const current = load()
      if (current.state === 'linked') return status()
      if (current.state !== 'pending' && current.state !== 'approved') {
        throw new Error('There is no device sign-in in progress on this computer.')
      }
      let record = current
      if (record.state === 'pending') {
        if (!text(record.deviceId)) throw new Error('Sign-in did not receive a device code. Retry sign-in before checking approval.')
        const reply = await call(record.origin, '/local-devices/poll', { body: { deviceId: record.deviceId, deviceSecret: record.deviceSecret } }).catch(deviceRouteRefusal)
        const state = text(reply.state)
        if (state === 'revoked' || state === 'expired') {
          await mutate((latest) => ({ ...latest, state, unusableTeaching: 'The account service reports this device grant as ' + state + '.' }))
          return status()
        }
        if (state !== 'approved') return status()
        let token
        try {
          token = privateDecrypt({ key: record.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
            Buffer.from(text(reply.encryptedDeviceToken), 'base64')).toString('utf8')
        } catch { throw new Error('The approved device token could not be opened with this computer\'s key. Start the sign-in again.') }
        if (!token.trim()) throw new Error('The account service delivered an empty device token.')
        const account = reply.account ?? {}
        const agents = Array.isArray(reply.agents) ? reply.agents : []
        // A device may be linked while this account happens to have no enabled Agents. The
        // dynamic directory is empty in that state; it is not a failed device identity.
        if (!text(account.id)) throw new Error('The approval did not name an account.')
        record = { ...record, state: 'approved', token,
          account: { id: String(account.id), name: String(account.name ?? account.id) },
          agents: agents.map((row) => ({ id: String(row.id), name: String(row.name ?? row.id) })),
          expiresAt: text(reply.expiresAt), approvedAt: new Date().toISOString() }
        record = await mutate((latest) => ({ ...latest, ...record }))
      }
      // Reached on the first approval and on every restart that found a persisted token
      // with an unconfirmed acknowledgement.
      await call(record.origin, '/local-devices/ack', { body: { deviceId: record.deviceId, deviceSecret: record.deviceSecret } }).catch(deviceRouteRefusal)
      const delivered = { ...record, state: 'linked', linkedAt: new Date().toISOString() }
      // The proof and the private key have done their work. Keeping them would leave a
      // second way to claim this grant's delivery lying on disk for its whole lifetime.
      delete delivered.deviceSecret
      delete delivered.privateKey
      delete delivered.publicKey
      delete delivered.code
      delete delivered.codeExpiresAt
      delete delivered.consoleUrl
      await mutate((latest) => {
        const next = { ...latest, ...delivered }
        for (const field of ['deviceSecret', 'privateKey', 'publicKey', 'code', 'codeExpiresAt', 'consoleUrl']) delete next[field]
        return next
      })
      return status()
    }),

    /**
     * Re-read the account's enabled Agent directory from the Gateway.
     *
     * This list is dynamic account state, not a remembered approval selection: one disabled
     * in Console must stop being offered here, a newly enabled one must appear, and a grant
     * that has expired must stop looking usable. So this is
     * asked fresh rather than trusted from the local copy.
     */
    refresh: () => exclusive(async () => {
      const current = linked()
      const reply = await call(current.origin, '/local-devices/context', { bearer: current.token }).catch(deviceRouteRefusal)
      if (text(reply.deviceId) !== current.deviceId) throw new Error('The account service answered for a different device record.')
      const agents = (Array.isArray(reply.agents) ? reply.agents : []).map((row) => ({ id: String(row.id), name: String(row.name ?? row.id) }))
      await mutate((latest) => ({ ...latest, account: { id: String(reply.account?.id ?? latest.account?.id ?? ''), name: String(reply.account?.name ?? '') },
        agents, expiresAt: text(reply.expiresAt), refreshedAt: new Date().toISOString() }))
      return status()
    }),

    /**
     * Approve one instance's own pairing with this device's authority.
     *
     * Local has already called `/local-setup/start` with a fresh per-instance proof and
     * key; this hands the Gateway that exact pairing id together with the chosen Agent. The
     * instance's credential is issued by the ordinary pairing path and delivered to the
     * instance's own key — the device token is authority to approve, not a way to carry
     * somebody else's credential.
     */
    pair: ({ pairingId, deviceSecret, agentId, replaceAgentToken = false } = {}) => {
      const current = linked()
      if (!text(pairingId) || !text(deviceSecret) || !text(agentId)) throw new Error('Pairing approval needs the pairing id, its proof and the chosen Agent.')
      if (!current.agents?.some((row) => row.id === agentId)) {
        throw new Error('That Agent is not enabled in this account. Refresh Agents after enabling it in Console.')
      }
      // An operation route: a refusal here is usually about the Agent or the pairing, and
      // only the account service naming a device-level code — or the device route itself
      // refusing — may conclude that this computer is signed out.
      return call(current.origin, '/local-devices/pair', { bearer: current.token,
        body: { pairingId, deviceSecret, agentId, replaceAgentToken: replaceAgentToken === true } }).catch(operationRefusal)
    },

    // The manager supplies only the selected Agent's Worker projection. Document bytes never
    // pass through this device-control client.
    authoringPrepare: (body = {}) => {
      const current = linked()
      if (text(body.expectedAccountId) !== text(current.account?.id) || !current.agents?.some(row => row.id === text(body.agentId))) {
        throw new Error('The selected Agent is no longer enabled for this signed-in account.')
      }
      return call(current.origin, '/local-devices/authoring/prepare', { bearer: current.token, body }).catch(operationRefusal)
    },
    authoringSave: (body = {}) => {
      const current = linked()
      if (text(body.expectedAccountId) !== text(current.account?.id) || !current.agents?.some(row => row.id === text(body.agentId))) {
        throw new Error('The selected Agent is no longer enabled for this signed-in account.')
      }
      return call(current.origin, '/local-devices/authoring/save', { bearer: current.token, body }).catch(operationRefusal)
    },
    authoringCases: (body = {}) => {
      const current = linked()
      if (text(body.expectedAccountId) !== text(current.account?.id) || !current.agents?.some(row => row.id === text(body.agentId))) throw new Error('The selected Agent is no longer enabled for this signed-in account.')
      return call(current.origin, '/local-devices/authoring/cases', { bearer: current.token, body }).catch(operationRefusal)
    },

    /**
     * Remember what an instance's pairing produced, so a later revoke names the same thing.
     *
     * Serialized with every other write: two attachments finishing at once used to read the
     * same record and write back two versions of it, and the one that lost took its instance's
     * entry with it.
     */
    recordPairing: (instanceId, record) => mutate((current) => ({
      ...current,
      instances: { ...(current.instances ?? {}), [instanceId]: { ...record, at: new Date().toISOString() } },
    })),

    /**
     * Revoke this device at the Gateway.
     *
     * Three things make this survive the ways it can be interrupted:
     *
     *   · **One request id, persisted before it is sent.** A retry after a lost response is
     *     the same request, so the service's audit record has one revocation in it rather
     *     than one per network failure.
     *   · **It runs from any state that still holds a token**, including `unusable`. Local
     *     status saying "the service refused us" is not a reason to stop trying to revoke —
     *     that is precisely when the revoke may still be the thing that has not happened.
     *   · **`alreadyRevoked` is a success.** A grant the browser revoked first answers the
     *     self-revoke with the existing fact and does not write a second audit entry; that is
     *     the outcome this computer wanted, so it is reported as done rather than as failure.
     */
    revoke: () => exclusive(async () => {
      const current = load()
      if (!text(current.token)) throw new Error('There is no signed-in device to revoke on this computer.')
      const requestId = text(current.revokeRequestId) || randomUUID()
      if (requestId !== current.revokeRequestId) await mutate((latest) => ({ ...latest, revokeRequestId: text(latest.revokeRequestId) || requestId }))
      const stored = text(load().revokeRequestId) || requestId
      const reply = await call(current.origin, '/local-devices/revoke', { bearer: current.token, body: { requestId: stored } })
      return { state: text(reply.state) || 'revoked', requestId: stored, alreadyRevoked: reply.alreadyRevoked === true }
    }),

    /**
     * Forget the local half of the grant. Called only after a revoke the Gateway confirmed;
     * dropping the token first would leave a live remote grant nobody here can revoke.
     */
    clear: () => {
      rmSync(file, { force: true })
    },

    /** Progress of a sign-out that could not be finished, kept visible until it is. */
    noteSignOut: (signOut) => {
      if (!existsSync(file)) return Promise.resolve()
      return mutate((current) => ({ ...current, signOut })).catch(() => undefined)
    },
  }
}

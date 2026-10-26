// SPDX-License-Identifier: Apache-2.0
/**
 * The Rulith Local manager: the loopback service behind the Rulith app for an account, its enabled
 * Agents, and the independent Local instances running them. It serves no page (the English workbench
 * page is retired); the app's host is its client.
 *
 * This server is **operator software, not an Agent host**. It holds the device management
 * credential, and that credential never enters a child process environment, a model context,
 * or any response body. What a client gets is status: names, states, ports it may open, and
 * teachings about what failed. Nothing here is reachable by a model, because nothing here is
 * offered as a tool.
 *
 * The gate is the same shape the instance hosts use, for the same reason: loopback is shared
 * by every account and every application on the machine, so the per-run key is the only thing
 * separating them; the app's launcher hands it to the manager and to its own host, and nothing prints it.
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { acquireWorkbenchLease, createManagerRegistry, defaultManagerRoot } from './manager-registry.mjs'
import { createDeviceClient } from './device-client.mjs'
import { createInstanceManager } from './instance-manager.mjs'
import { mergeManagerHealth } from './manager-health.mjs'

const MAX_BODY = 64 * 1024
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
/**
 * The shape of a manager key: 16–128 URL-safe characters, as the app's launcher makes it (app-home.mjs) and as it travels
 * in a query string or header. A key outside it is refused when somebody sets it, not when a request first fails.
 */
export const MANAGER_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

const readJsonBody = (req) => new Promise((accept, reject) => {
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY) { reject(new Error('Request body exceeds 64KB.')); req.destroy(); return }
    chunks.push(chunk)
  })
  req.on('end', () => {
    try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(new Error('Body is not valid JSON.')) }
  })
})

/** Reject anything the request body was not supposed to carry, rather than ignoring it. */
const onlyFields = (body, allowed) => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('This operation takes a JSON object.')
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new Error(`Unexpected fields: ${unexpected.join(', ')}.`)
  return body
}

/**
 * @param {object} options
 * @param {string} [options.root] Manager home directory.
 * @param {number} [options.port]
 * @param {string} [options.key]  Per-run loopback key.
 */
export function createManagerServer({
  root = defaultManagerRoot(), port = 7780, key = randomUUID().replace(/-/g, ''),
  startConfirmMs, leaseWaitMs = 0, orphanRecheckMs,
  directoryRefreshMs = 30_000,
} = {}) {
  /** The installation claim, held from `listen` to `close`. */
  let lease
  if (!MANAGER_KEY_PATTERN.test(String(key))) {
    throw new Error('A Rulith manager key must be 16–128 characters of A–Z, a–z, 0–9, "-" or "_".')
  }
  const registry = createManagerRegistry({ root })
  const device = createDeviceClient({ root: registry.root })
  const instances = createInstanceManager({ registry, device, startConfirmMs, orphanRecheckMs })

  if (!Number.isFinite(directoryRefreshMs) || directoryRefreshMs < 20) throw new Error('Directory refresh interval must be at least 20 ms.')
  let directoryTimer, directoryPending, directoryLast, closing = false
  const deviceScope = grant => JSON.stringify([grant.origin, grant.deviceId, grant.account?.id])
  const directoryStatus = () => {
    const grant = device.status()
    if (grant.state !== 'linked') return null
    const scope = deviceScope(grant), last = directoryLast?.scope === scope ? directoryLast : null
    const checkedAt = grant.directoryCheckedAt || ''
    return { checking: directoryPending?.scope === scope, checkedAt, error: last?.error || '',
      stale: Boolean(last?.error) || !Number.isFinite(Date.parse(checkedAt)) || Date.now() - Date.parse(checkedAt) > directoryRefreshMs * 3 }
  }
  // One request per installation, independent of the number or visibility of browser tabs.
  // Sign-out drains this admitted refresh before it clears the device record.
  const refreshDirectory = () => {
    const scope = deviceScope(device.status())
    if (directoryPending?.scope === scope) return directoryPending.promise
    const pending = { scope }
    pending.promise = instances.refreshDevice().then(result => {
      if (deviceScope(device.status()) === scope) directoryLast = { scope, error: '' }
      return result
    }, error => {
      if (deviceScope(device.status()) === scope) directoryLast = { scope, error: String(error?.message ?? error) }
      throw error
    }).finally(() => { if (directoryPending === pending) directoryPending = undefined })
    directoryPending = pending
    return pending.promise
  }
  const scheduleDirectory = () => {
    if (closing) return
    directoryTimer = setTimeout(async () => {
      try { if (instances.phase === 'ready' && device.status().state === 'linked' && !device.busy) await refreshDirectory() }
      catch { /* The state projection exposes the error; a network failure is not sign-out. */ }
      finally { scheduleDirectory() }
    }, directoryRefreshMs)
    directoryTimer.unref?.()
  }

  /** Is this request from a loopback client addressing this server by a loopback name? */
  const localContext = (req) => {
    const origin = req.headers.origin
    if (origin !== undefined && !LOOPBACK_ORIGIN.test(origin)) return { status: 403, teaching: `Cross-origin request rejected (Origin: ${origin}).` }
    if (!LOOPBACK.test(String(req.headers.host ?? ''))) return { status: 403, teaching: 'Non-local Host rejected to prevent DNS rebinding.' }
    return null
  }
  const presentedKey = (req) => req.headers['x-rulith-manager'] ?? new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('k') ?? ''

  /**
   * One gate for every route.
   *
   * 401 says this request did not authenticate; 403 says it authenticated but arrived from a
   * context this server will not answer — a cross-origin page, or a rebound DNS name whose
   * `Host` is not loopback. Every read is gated: served unauthenticated, the state would be a
   * public description of which accounts and Agents this computer holds.
   */
  const gate = (req) => (presentedKey(req) !== key
    ? { status: 401, teaching: 'Missing or invalid Rulith manager key.' }
    : localContext(req))

  /** State operations additionally require the header and this exact origin, never any loopback one. */
  const sameOrigin = (req) => req.headers['x-rulith-manager'] === key
    && (req.headers.origin === undefined || req.headers.origin === 'http://' + req.headers.host)

  let stateRevision = 0
  const stateServerId = randomUUID()
  const state = () => ({
    stateServerId,
    stateRevision: ++stateRevision,
    root: registry.root,
    device: device.status(),
    directorySync: directoryStatus(),
    modelDefaults: instances.modelDefaults(),
    instances: instances.overview(),
  })
  const operations = {
    '/manager/device/start': (body) => instances.admit(() => device.start(onlyFields(body, ['consoleUrl', 'name']))),
    '/manager/device/poll': async (body) => {
      onlyFields(body, [])
      const result = await instances.admit(() => device.poll())
      if (device.status().state === 'linked') await instances.restoreWorkers()
      return result
    },
    '/manager/device/refresh': (body) => { onlyFields(body, []); return refreshDirectory() },
    '/manager/device/signout': (body) => { onlyFields(body, []); return instances.signOut() },
    '/manager/device/forget': (body) => { onlyFields(body, []); return instances.forgetDevice() },
    '/manager/model/default': (body) => instances.setDefaultModel(onlyFields(body, ['expectedOrigin', 'expectedAccountId', 'url', 'name', 'key', 'clearKey', 'thinking', 'maxOutputTokens'])),
    '/manager/instances/create': (body) => instances.create(onlyFields(body, ['name', 'mode', 'setupTarget'])),
    // PSC 0.2.27 ② ③: set one Agent of the signed-in account up on this computer — instance, pairing with automatic
    // Connection reuse, the general kit, the Worker, its reload. `{requestId, agentId, mode: 'setup'|'repair', kitHome?,
    // replaceAgentToken?}` starts it, or continues the same request from its first unfinished step; it answers at once
    // with `setup` (the step list), and `GET /manager/instances/setup-local?requestId=` reads it. `replaceAgentToken: true`
    // is the person's confirmation of replacing this Agent's token (SYS-LOCAL-01). See setup-local.mjs.
    '/manager/instances/setup-local': (body) => ({ setup: instances.setupLocal(onlyFields(body, ['requestId', 'agentId', 'mode', 'kitHome', 'replaceAgentToken'])) }),
    '/manager/instances/pair': (body) => {
      const fields = onlyFields(body, ['instanceId', 'agentId', 'replaceAgentToken', 'reconnectConnectionId'])
      return instances.pair(String(fields.instanceId ?? ''), { agentId: fields.agentId,
        replaceAgentToken: fields.replaceAgentToken, reconnectConnectionId: fields.reconnectConnectionId })
    },
    '/manager/instances/pair/poll': (body) => instances.pairPoll(String(onlyFields(body, ['instanceId']).instanceId ?? '')),
    '/manager/instances/pair/cancel': (body) => instances.cancelPairing(String(onlyFields(body, ['instanceId']).instanceId ?? '')),
    '/manager/instances/model/copy': (body) => {
      const fields = onlyFields(body, ['instanceId', 'fromInstanceId'])
      return instances.copyModelSettings(String(fields.instanceId ?? ''), String(fields.fromInstanceId ?? ''))
    },
    '/manager/instances/model': (body) => {
      const fields = onlyFields(body, ['instanceId', 'expectedOrigin', 'expectedAccountId', 'source', 'url', 'name', 'key', 'clearKey', 'thinking', 'maxOutputTokens'])
      return instances.setInstanceModel(String(fields.instanceId ?? ''), fields)
    },
    '/manager/instances/connection-key': (body) => {
      const fields = onlyFields(body, ['instanceId', 'expectedOrigin', 'expectedAccountId', 'expectedAgentId', 'expectedConnectionId', 'key'])
      return instances.setConnectionKey(String(fields.instanceId ?? ''), fields)
    },
    // ACC-CONV-05/06 (PSC 0.2.16 ③): the signed-in owner's client (Deep Rulith) switches one conversation's exploration
    // mode or post-call review through this computer's device grant. The manager only forwards the exact fields; the
    // device client checks the Agent is one of the grant's, the Gateway does the rest.
    '/manager/conversations/state': (body) => instances.admit(() => device.conversationState(onlyFields(body, ['agentId', 'conversationKey']))),
    '/manager/conversations/exploration-mode': (body) => instances.admit(() => device.conversationExplorationMode(
      onlyFields(body, ['agentId', 'conversationKey', 'connectionId', 'mode', 'requestId']))),
    '/manager/conversations/review': (body) => instances.admit(() => device.conversationReview(onlyFields(body, ['agentId', 'conversationKey', 'enabled']))),
    // Batch 4 (D-1024a): signing one goal's proposed criteria from the owner's client, after the person confirmed them there.
    '/manager/conversations/sign-acceptance': (body) => instances.admit(() => device.conversationSignAcceptance(
      onlyFields(body, ['agentId', 'conversationKey', 'goal', 'leaves', 'requestId']))),
    '/manager/conversations/end-preview': (body) => instances.admit(() => device.conversationEndPreview(onlyFields(body, ['agentId', 'conversationKey']))),
    '/manager/conversations/end': (body) => instances.admit(() => device.conversationEnd(onlyFields(body, ['agentId', 'conversationKey', 'requestId']))),
    // PSC 0.2.24 (D-1018b batch 3): the owner opens a folder of this computer as a project from their own client. The
    // confirmation's content comes from `state`; `open` carries the version of it the owner confirmed. The manager only
    // forwards these exact fields; a capability, tool, digest or mode never passes (the Gateway refuses them anyway).
    '/manager/projects/state': (body) => instances.admit(() => device.projectState(
      onlyFields(body, ['expectedAccountId', 'agentId', 'connectionId', 'directory', 'platform']))),
    '/manager/projects/open': (body) => instances.admit(() => device.projectOpen(
      onlyFields(body, ['requestId', 'expectedAccountId', 'agentId', 'connectionId', 'directory', 'platform', 'authorizationVersion']))),
    '/manager/instances/open': (body) => {
      const fields = onlyFields(body, ['instanceId', 'page'])
      return instances.open(String(fields.instanceId ?? ''), String(fields.page ?? '/'))
    },
    '/manager/instances/worker-setting': (body) => {
      const fields = onlyFields(body, ['instanceId', 'enabled'])
      return instances.setWorkerEnabled(String(fields.instanceId ?? ''), fields.enabled)
    },
    // PSC 0.2.31 ③: the owner's "Run without isolation (not recommended)" for one Agent on this computer, off by default.
    // Turning it on needs `confirmed: true`; only this operation (the manager key) writes it.
    '/manager/instances/isolation': (body) => {
      const fields = onlyFields(body, ['instanceId', 'runWithoutIsolation', 'confirmed'])
      return instances.setRunWithoutIsolation(String(fields.instanceId ?? ''), fields)
    },
    '/manager/instances/forget': (body) => instances.forget(String(onlyFields(body, ['instanceId']).instanceId ?? '')),
    // "Check again": try once more to move an Agent that kept its own tools into this environment's.
    '/manager/instances/tools': (body) => instances.checkTools(String(onlyFields(body, ['instanceId']).instanceId ?? '')),
    // This environment's tools. Changes go through admission, so a sign-out waits for them and
    // nothing is edited once the workbench is signing out or closing. Installing, preparing and
    // discovering do not: they reach the network or start a program, can take as long as they
    // take, and must not be what a sign-out waits for. None of these routes grants anything; what
    // an Agent may call is still Console's lock on its own Connection.
    '/manager/tools/save': (body) => instances.admit(() => instances.library.save(onlyFields(body, ['id', 'originalId', 'definition', 'revision', 'confirmed']))),
    '/manager/tools/remove': (body) => instances.admit(() => instances.library.remove(onlyFields(body, ['id', 'revision', 'confirmed']))),
    '/manager/tools/mcp-install': (body) => instances.library.install(onlyFields(body, ['catalogId']).catalogId),
    '/manager/tools/mcp-prepare': (body) => instances.library.prepare(onlyFields(body, ['serverName', 'version', 'optionId', 'reviewToken', 'values'])),
    '/manager/tools/mcp-probe': (body) => instances.library.probe(onlyFields(body, ['name', 'mode', 'originalName', 'isNew', 'preparationId',
      'directory', 'command', 'args', 'cwd', 'clearSecrets', 'env', 'url', 'token'])),
    '/manager/tools/mcp-apply': (body) => instances.admit(() => instances.library.apply(onlyFields(body, ['probeId', 'tools', 'confirmed']))),
    '/manager/tools/mcp-remove': (body) => instances.admit(() => instances.library.removeService(onlyFields(body, ['name', 'revision', 'confirmed']))),
  }
  /** Reads. Authenticated like everything else, and they change nothing. */
  const reads = {
    '/manager/instances/setup-local': query => ({ setup: instances.setupLocalStatus(query.get('requestId')) }),
    '/manager/health': async () => {
      let gateway, gatewayState = 'unavailable'
      if (device.status().state === 'linked') {
        try {
          gateway = await instances.admit(() => device.health())
          gatewayState = gateway === null ? 'unsupported' : 'available'
        } catch { /* Refusals update device status; transport failures prove no new state. */ }
      }
      const grant = device.peek(), local = instances.healthSnapshot()
      return { health: mergeManagerHealth({ device: device.status(), instances: local.instances,
        gateway, gatewayState, secrets: [key, grant.token, grant.deviceSecret, grant.privateKey, grant.publicKey, ...local.secrets] }) }
    },
    '/manager/tools/state': () => instances.library.state(),
    '/manager/tools/mcp-search': (query) => instances.library.search(query.get('q') ?? '', query.get('cursor') ?? ''),
    '/manager/tools/mcp-detail': (query) => instances.library.detail(query.get('name'), query.get('version') ?? 'latest'),
    '/manager/tools/mcp-downloads': (query) => instances.library.downloads(query.get('package')),
  }

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    // Authentication happens *outside* the try, and nothing inside it can be reached without
    // passing: the catch below answers with a full state snapshot — account, device, every
    // authorized Agent, every instance directory and port — and a snapshot served from an
    // unauthenticated failure would be that description handed to whoever provoked the
    // failure. Keeping the gate inside the try left the whole surface one parse error away
    // from being readable.
    let denied
    try { denied = gate(req) } catch (error) {
      return void json(res, 400, { ok: false, teaching: String(error?.message ?? error) })
    }
    if (denied !== null) return void json(res, denied.status, { ok: false, teaching: denied.teaching })
    try {
      if (path === '/manager/state' && req.method === 'GET') return void json(res, 200, { ok: true, ...state() })
      if (Object.hasOwn(reads, path) && req.method === 'GET') {
        return void json(res, 200, { ok: true, ...await reads[path](new URL(req.url ?? '/', 'http://127.0.0.1').searchParams) })
      }
      if (Object.hasOwn(operations, path) && req.method === 'POST') {
        if (!sameOrigin(req)) return void json(res, 403, { ok: false, teaching: 'Manager operations require the manager key and the same origin.' })
        const body = await readJsonBody(req)
        const result = await operations[path](body)
        return void json(res, 200, { ok: true, ...(result === undefined ? {} : result), ...state() })
      }
      json(res, 404, { ok: false, teaching: 'Endpoint not found.' })
    } catch (error) {
      if (path === '/manager/health') return void json(res, 400, { ok: false, teaching: 'Health could not be read. Refresh Health again.' })
      // A failed operation still answers with the current state, so a client never has to guess
      // whether a refused step changed anything. Reachable only after the gate above.
      let snapshot = {}
      try { snapshot = state() } catch { snapshot = {} }
      json(res, 400, { ...snapshot, ok: false, errorCode: error?.errorCode, teaching: String(error?.message ?? error) })
    }
  })

  return {
    key,
    registry,
    device,
    instances,
    get port() { return server.address()?.port ?? port },
    state,
    get lease() { return lease },
    listen: async () => {
      // One workbench per installation, claimed here rather than in the constructor: building
      // a manager to inspect it must not claim anything, and this repository's tests build
      // several in one process. Held for the run; released in `close`, after the children
      // this process still owns have been written down.
      lease = await acquireWorkbenchLease(join(registry.root, 'workbench.lock'), { waitMs: leaseWaitMs })
      // A manager that died left its instances marked as occupied. Clearing markers whose
      // process is gone is what makes a crash recoverable without an operator editing JSON.
      // Anything that fails before this server is listening releases the claim: a workbench
      // that never started must not leave the installation looking occupied.
      try {
        await registry.reclaimStale()
        await new Promise((accept, reject) => {
          server.once('error', reject)
          server.listen(port, '127.0.0.1', accept)
        })
        scheduleDirectory()
        // Before any Worker is restored, so that each starts on the tools it will keep. The Agents
        // it cannot move say so themselves and keep working on their own files; a failure here is
        // theirs to show, and is not a reason for the workbench not to open.
        await instances.migrateTools().catch(() => undefined)
        await instances.restoreWorkers()
      } catch (error) {
        lease.release()
        lease = undefined
        throw error
      }
    },
    /**
     * Close every host, then stop listening — and say what could not be finished.
     *
     * A manager can be closed while it is still a live object in a caller's process: this is
     * a library, and `close()` is not the same event as the process exiting. So a child that
     * had not exited when its host closed is reported here rather than assumed away, and so
     * is a registry write that failed. The caller decides what to do with that; what it must
     * not be told is that everything stopped.
     */
    close: async () => {
      closing = true
      clearTimeout(directoryTimer)
      const result = await instances.closeAll()
      await new Promise((accept) => server.close(accept))
      // Last, and only after `closeAll` recorded whatever children outlived their hosts: the
      // next workbench reads those markers, so releasing before writing them would hand the
      // installation over with a record that had not caught up.
      lease?.release()
      lease = undefined
      return result
    },
  }
}

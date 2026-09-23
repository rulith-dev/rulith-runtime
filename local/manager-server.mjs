// SPDX-License-Identifier: Apache-2.0
/**
 * The Rulith Local manager: one loopback page for an account, its enabled Agents, and the
 * independent Local instances running them.
 *
 * This server is **operator software, not an Agent host**. It holds the device management
 * credential, and that credential never enters a child process environment, a model context,
 * or any response body. What a browser gets is status: names, states, ports it may open, and
 * teachings about what failed. Nothing here is reachable by a model, because nothing here is
 * offered as a tool.
 *
 * The gate is the same shape the instance hosts use, for the same reason: loopback is shared
 * by every account and every application on the machine, so the per-run key is the only thing
 * separating them, and it travels in the URL the CLI prints rather than in the page.
 */
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { acquireWorkbenchLease, createManagerRegistry, defaultManagerRoot } from './manager-registry.mjs'
import { createDeviceClient } from './device-client.mjs'
import { createInstanceManager } from './instance-manager.mjs'
import { managerPage } from './manager-ui.mjs'
import { installAuthoringChecker } from './authoring-checker.mjs'
import { materialIdentity, openMaterialStore } from '../worker/material-store.mjs'
import { proposalDigest } from '../worker/local-authoring.mjs'

/** One checked proposal and certified Case are one logical private save, even after a browser retry or manager restart. */
export function localAuthoringSaveRequestId({ accountId, agentId, caseId, materialId, documentDigest, proposalDigest }) {
  return 'local-save:' + createHash('sha256').update(JSON.stringify([
    accountId, agentId, caseId, materialId, documentDigest, proposalDigest,
  ])).digest('hex')
}

const MAX_BODY = 64 * 1024
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
/**
 * The shape of a manager browser key, agreed with the Local pages that carry it back.
 *
 * `local/theme.mjs` builds the return link from a `manager=` parameter and will only render
 * a `k` matching this alphabet and length. A key outside it would produce a link the pages
 * silently drop, so the constructor refuses it here — at the moment somebody sets it — rather
 * than leaving a manager whose instance pages have no way back and no explanation.
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
  legacyConfigFile = join(homedir(), '.rulith', 'local.json'), startConfirmMs, leaseWaitMs = 0,
} = {}) {
  /** The installation claim, held from `listen` to `close`. */
  let lease
  if (!MANAGER_KEY_PATTERN.test(String(key))) {
    throw new Error('A Rulith manager key must be 16–128 characters of A–Z, a–z, 0–9, "-" or "_".'
      + ' The Local pages that carry the way back will not render a link outside that shape.')
  }
  const registry = createManagerRegistry({ root })
  const device = createDeviceClient({ root: registry.root })
  const instances = createInstanceManager({ registry, device, startConfirmMs,
    /**
     * The address an instance page is told to offer as the way back.
     *
     * It carries this run's browser key, because `GET /` needs it — the manager page is a
     * description of which accounts and Agents this computer holds, and serving it
     * unauthenticated would publish that to anything on loopback.
     *
     * This key is a **loopback browser capability of this run**, and it is a different thing
     * from the cloud device management token: the token authorizes account operations against
     * the Gateway and appears in no URL, no page, no child environment and no status body.
     * The key travels only where the operator navigates — the address bar of pages they
     * opened from this manager, on this machine.
     */
    managerReturnUrl: () => `http://127.0.0.1:${server.address()?.port ?? port}/?k=${encodeURIComponent(key)}` })

  /** Is this request from a loopback page addressing this server by a loopback name? */
  const localContext = (req) => {
    const origin = req.headers.origin
    if (origin !== undefined && !LOOPBACK_ORIGIN.test(origin)) return { status: 403, teaching: `Cross-origin request rejected (Origin: ${origin}).` }
    if (!LOOPBACK.test(String(req.headers.host ?? ''))) return { status: 403, teaching: 'Non-local Host rejected to prevent DNS rebinding.' }
    return null
  }
  const presentedKey = (req) => req.headers['x-rulith-manager'] ?? new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('k') ?? ''

  /**
   * One gate for every route, including the page.
   *
   * 401 says this request did not authenticate; 403 says it authenticated but arrived from a
   * context this server will not answer — a cross-origin page, or a rebound DNS name whose
   * `Host` is not loopback. The page is gated too: served unauthenticated, it would be a
   * public description of which accounts and Agents this computer holds.
   */
  const gate = (req) => (presentedKey(req) !== key
    ? { status: 401, teaching: 'Missing or invalid Rulith manager key. Open the URL printed at startup, which carries ?k=<key>.' }
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
    modelDefaults: instances.modelDefaults(),
    instances: instances.overview(),
    // Offered, never acted on: an installation is imported only when somebody asks for it.
    legacyInstall: existsSync(resolve(legacyConfigFile))
      ? { configFile: resolve(legacyConfigFile), imported: registry.read().instances.some((row) => row.importedFrom === resolve(legacyConfigFile)) }
      : null,
  })
  const authoringTarget = (instanceId, { requireWorker = false } = {}) => {
    const grant = device.status()
    if (grant.state !== 'linked') throw new Error('Sign in before preparing the local document assistant.')
    const row = instances.overview().find((entry) => entry.id === instanceId)
    if (!row || !row.paired || !row.agentId || !row.connectionId) throw new Error('Choose an attached Agent with its Worker connection before preparing the document assistant.')
    if (requireWorker && row.worker !== true) throw new Error('Start this Agent’s Worker and wait for its tool advertisement before preparing the document assistant.')
    if (row.origin !== grant.origin || row.accountId !== String(grant.account?.id ?? '') || !grant.agents.some((agent) => agent.id === row.agentId)) {
      throw new Error('The selected Agent is no longer enabled for this signed-in account.')
    }
    return { expectedAccountId: String(grant.account.id), agentId: row.agentId, connectionId: row.connectionId,
      materialRoot: String(row.authoring?.materialRoot ?? ''), toolDescriptors: Array.isArray(row.authoring?.toolDescriptors) ? row.authoring.toolDescriptors : [] }
  }
  const digest = (value) => 'sha256:' + createHash('sha256').update(value).digest('hex')
  const checkedResult = (instanceId, resultId = '') => {
    const target = authoringTarget(instanceId)
    const row = instances.overview().find((entry) => entry.id === instanceId)
    const identity = materialIdentity({ configFile: join(row.directory, 'local.json'), gatewayUrl: row.origin,
      connectionId: row.connectionId, agentId: row.agentId })
    const store = openMaterialStore(target.materialRoot, identity, { create: false })
    const rows = JSON.parse(readFileSync(join(target.materialRoot, 'local-authoring', 'results.json'), 'utf8'))
    if (!Array.isArray(rows)) throw new Error('The local authoring result index is invalid.')
    const index = rows.filter((entry) => entry.profile === identity.profile && entry.owner === identity.owner
      && (resultId === '' || entry.resultId === resultId)).at(-1)
    if (!index) throw new Error('No checked local authoring result belongs to this selected Agent.')
    const result = store.read(String(index.resultId)).bytes
    if (digest(result) !== index.resultDigest) throw new Error('The checked result bytes no longer match their immutable digest.')
    const payload = JSON.parse(result.toString('utf8'))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payload.draft || !payload.report) throw new Error('The checked result has an invalid draft/report payload.')
    const checkedProposalDigest = proposalDigest(payload.draft)
    const material = store.require(String(index.materialId))
    const node = 'node_' + createHash('sha256').update(String(index.materialId) + '\u0000' + String(index.documentDigest), 'utf8').digest('hex').slice(0, 32)
    if (material.digest !== index.documentDigest || index.proposalDigest !== checkedProposalDigest || payload.report.proposalDigest !== checkedProposalDigest || index.node !== node) {
      throw new Error('The checked result no longer matches its immutable material and proposal.')
    }
    return { taskId: index.materialId, materialId: index.materialId, documentDigest: index.documentDigest,
      proposalDigest: checkedProposalDigest, resultId: index.resultId, checkedAt: index.checkedAt, draft: payload.draft, report: payload.report }
  }

  const operations = {
    '/manager/device/start': (body) => instances.admit(() => device.start(onlyFields(body, ['consoleUrl', 'name']))),
    '/manager/device/poll': (body) => { onlyFields(body, []); return instances.admit(() => device.poll()) },
    '/manager/device/refresh': (body) => { onlyFields(body, []); return instances.refreshDevice() },
    '/manager/device/signout': (body) => { onlyFields(body, []); return instances.signOut() },
    '/manager/device/forget': (body) => { onlyFields(body, []); return instances.forgetDevice() },
    '/manager/model/default': (body) => instances.setDefaultModel(onlyFields(body, ['expectedOrigin', 'expectedAccountId', 'url', 'name', 'key', 'clearKey', 'thinking'])),
    '/manager/instances/create': (body) => instances.create(onlyFields(body, ['name', 'mode', 'setupTarget'])),
    '/manager/instances/import': (body) => instances.import(onlyFields(body, ['sourceConfigFile', 'name', 'mode'])),
    '/manager/instances/pair': (body) => {
      const fields = onlyFields(body, ['instanceId', 'agentId', 'replaceAgentToken'])
      return instances.pair(String(fields.instanceId ?? ''), { agentId: fields.agentId, replaceAgentToken: fields.replaceAgentToken })
    },
    '/manager/instances/pair/poll': (body) => instances.pairPoll(String(onlyFields(body, ['instanceId']).instanceId ?? '')),
    '/manager/instances/pair/cancel': (body) => instances.cancelPairing(String(onlyFields(body, ['instanceId']).instanceId ?? '')),
    '/manager/instances/model/copy': (body) => {
      const fields = onlyFields(body, ['instanceId', 'fromInstanceId'])
      return instances.copyModelSettings(String(fields.instanceId ?? ''), String(fields.fromInstanceId ?? ''))
    },
    '/manager/instances/model': (body) => {
      const fields = onlyFields(body, ['instanceId', 'expectedOrigin', 'expectedAccountId', 'source', 'url', 'name', 'key', 'clearKey', 'thinking'])
      return instances.setInstanceModel(String(fields.instanceId ?? ''), fields)
    },
    '/manager/instances/connection-key': (body) => {
      const fields = onlyFields(body, ['instanceId', 'expectedOrigin', 'expectedAccountId', 'expectedAgentId', 'expectedConnectionId', 'key'])
      return instances.setConnectionKey(String(fields.instanceId ?? ''), fields)
    },
    '/manager/authoring/status': (body) => {
      const fields = onlyFields(body, ['instanceId'])
      return instances.admit(() => {
        const { toolDescriptors, ...target } = authoringTarget(String(fields.instanceId ?? ''))
        return device.authoringStatus(target)
      })
    },
    '/manager/authoring/prepare': (body) => {
      const fields = onlyFields(body, ['instanceId', 'materialPermissions'])
      return instances.admit(async () => {
        await installAuthoringChecker()
        return device.authoringPrepare({ ...authoringTarget(String(fields.instanceId ?? ''), { requireWorker: true }),
          requestId: randomUUID(), materialPermissions: fields.materialPermissions })
      })
    },
    '/manager/authoring/save': (body) => {
      const fields = onlyFields(body, ['instanceId', 'resultId', 'caseId'])
      return instances.admit(() => {
        const checked = checkedResult(String(fields.instanceId ?? ''), String(fields.resultId ?? ''))
        const target = authoringTarget(String(fields.instanceId ?? ''))
        return device.authoringSave({ expectedAccountId: target.expectedAccountId, agentId: target.agentId, caseId: fields.caseId,
          materialId: checked.materialId, documentDigest: checked.documentDigest, proposalDigest: checked.proposalDigest,
          draft: checked.draft, requestId: localAuthoringSaveRequestId({ accountId: target.expectedAccountId,
            agentId: target.agentId, caseId: fields.caseId, materialId: checked.materialId,
            documentDigest: checked.documentDigest, proposalDigest: checked.proposalDigest }) })
      })
    },
    '/manager/authoring/review': (body) => {
      const fields = onlyFields(body, ['instanceId', 'resultId'])
      return instances.admit(async () => {
        const checked = checkedResult(String(fields.instanceId ?? ''), String(fields.resultId ?? ''))
        const target = authoringTarget(String(fields.instanceId ?? ''))
        const cases = await device.authoringCases({ expectedAccountId: target.expectedAccountId, agentId: target.agentId,
          materialId: checked.materialId, documentDigest: checked.documentDigest, proposalDigest: checked.proposalDigest })
        const saved = cases.saved && typeof cases.saved === 'object' && !Array.isArray(cases.saved) ? cases.saved : null
        return { ...checked, cases: Array.isArray(cases.cases) ? cases.cases : [],
          ...(saved && typeof saved.packId === 'string' && typeof saved.caseId === 'string'
            ? { savedPackId: saved.packId, savedCaseId: saved.caseId, savedEntryCurrent: saved.entryCurrent === true }
            : {}) }
      })
    },
    '/manager/instances/open': (body) => {
      const fields = onlyFields(body, ['instanceId', 'page'])
      return instances.open(String(fields.instanceId ?? ''), String(fields.page ?? '/'))
    },
    '/manager/instances/control': (body) => {
      const fields = onlyFields(body, ['instanceId', 'role', 'operation'])
      return instances.control(String(fields.instanceId ?? ''), { role: fields.role, operation: fields.operation })
    },
    '/manager/instances/start': (body) => instances.start(String(onlyFields(body, ['instanceId']).instanceId ?? '')),
    '/manager/instances/stop': (body) => instances.stop(String(onlyFields(body, ['instanceId']).instanceId ?? '')),
    '/manager/instances/forget': (body) => instances.forget(String(onlyFields(body, ['instanceId']).instanceId ?? '')),
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
      if (path === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        // The page carries no key. It reads one from its own address, so a copy of this
        // response is not a working credential.
        return void res.end(managerPage)
      }
      if (path === '/manager/state' && req.method === 'GET') return void json(res, 200, { ok: true, ...state() })
      if (Object.hasOwn(operations, path) && req.method === 'POST') {
        if (!sameOrigin(req)) return void json(res, 403, { ok: false, teaching: 'Manager operations require the manager page key and the same origin.' })
        const body = await readJsonBody(req)
        const result = await operations[path](body)
        return void json(res, 200, { ok: true, ...(result === undefined ? {} : result), ...state() })
      }
      json(res, 404, { ok: false, teaching: 'Endpoint not found.' })
    } catch (error) {
      // A failed operation still answers with the current state, so a page never has to guess
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

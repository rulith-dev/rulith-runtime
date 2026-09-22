// SPDX-License-Identifier: Apache-2.0
/**
 * Two loopback servers that answer exactly what the two real ones answer, so the pages can be
 * driven by a browser instead of by a shim.
 *
 * Everything the workbench and the conversation do that matters — the iframe actually loading
 * a different origin, a sandbox actually discarding a browser dialog, a header actually being
 * clipped at 415px, a closed drawer actually being in the tab order — is invisible to a test
 * that only reads the markup. This fixture exists so those can be checked by the thing that
 * decides them.
 *
 * It is a fixture and not a manager: no registry, no device grant, no child process, no
 * credential. It holds a list of objects in memory, shaped like `instances.overview()`, and it
 * hands out addresses of its own second server for them. The *pages* are the real ones,
 * imported from `local/`.
 */
import http from 'node:http'
import { managerPage } from '../../local/manager-ui.mjs'
import { localPage } from '../../local/local-ui.mjs'
import { setupPage } from '../../local/setup-ui.mjs'
import { workerToolsPage } from '../../local/worker-tools-ui.mjs'

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}
const html = (res, body) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}
const readBody = (req) => new Promise((accept) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => { try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { accept({}) } })
})
const listen = (server) => new Promise((accept) => server.listen(0, '127.0.0.1', () => accept(server.address().port)))

const instanceOf = (overrides = {}) => ({
  id: 'inst-1', name: 'Research', mode: 'local_agent', directory: 'D:/instances/inst-1',
  origin: '', accountId: '', agentId: '', agentName: '', connectionId: '', paired: true,
  open: false, roles: [], agent: false, worker: false, runningAgentId: '', pendingAgentId: '',
  blocked: '', orphaned: null, legacyImport: null, hostPort: 0, servePort: 0,
  signedOutAt: '', createdAt: '', importedFrom: '', ...overrides,
})

/**
 * @param {object} [options]
 * @param {Array} [options.instances]  Rows as `instances.overview()` produces them.
 * @param {Array} [options.agents]     The cloud Agents this "device" is authorized for.
 * @param {Array|object} [options.events]  Replayed on `/events`, as a real host replays its
 *   buffer. An array goes to every host; an object keyed by instance id gives each Agent its
 *   own transcript, which is what makes "the centre and the inspector switched together"
 *   provable. Empty by default, so an arm that is not about the transcript sees an empty
 *   conversation. The stream semantics are the host's own: replay, then stay open.
 */
export async function startMockWorkbench({ instances, agents, events = [], modelDefaults = null } = {}) {
  const MANAGER_KEY = 'manager-browser-key-0001'
  const HOST_KEY = 'host-browser-key-0001'
  /** The account and Console this device is signed in to; the directory joins on both. */
  const CONSOLE = 'https://console.example', ACCOUNT = 'acct-1'
  /** Flipped by a test: what the conversation host answers when a message is sent. */
  const control = { pageStatus: {}, pairPending: false, pairRefusal: '', pairCredentialRefusal: '', pairCancelUnknown: false, pairCancelAccountChange: false, pairRequests: [], pairCancels: [], refreshAgents: null, refreshRequests: [], modelRefusal: '', modelRequests: [], authoringQuestions: true, authoringSaves: [], cases: { ok: false, teaching: 'This Agent is not started, so the message was not sent.' } }

  // Configured Agents, as the manager reports them once pairing has completed: the directory
  // joins a profile to an Agent by account, Console origin and Agent id together.
  const rows = (instances ?? [
    instanceOf({ id: 'inst-1', name: 'Research', agentId: 'agent-alpha', agentName: 'Alpha', origin: CONSOLE, accountId: ACCOUNT }),
    instanceOf({ id: 'inst-2', name: 'Invoices', agentId: 'agent-beta', agentName: 'Beta', origin: CONSOLE, accountId: ACCOUNT }),
  ]).map((row) => ({ ...row }))

  const device = {
    state: 'linked', origin: CONSOLE, account: { id: ACCOUNT, name: 'Test Account' }, deviceName: 'Work laptop',
    agents: agents ?? [{ id: 'agent-alpha', name: 'Alpha' }, { id: 'agent-beta', name: 'Beta' }],
    code: '', codeExpiresAt: '', consoleUrl: CONSOLE, teaching: '', signOut: null,
  }

  // One host per Agent, as on a real computer: separate ports, separate documents, separate
  // conversations. Two frames pointed at one server would hide exactly the mistake the
  // A → B → A arm is there to catch.
  const hosts = new Map()
  const hostServer = (row) => http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (control.pageStatus[path]) return void json(res, control.pageStatus[path], { ok: false, teaching: 'The expected page is unavailable.' })
    if (path === '/') return void html(res, localPage)
    if (path === '/setup') return void html(res, setupPage)
    if (path === '/worker-tools') return void html(res, workerToolsPage)
    if (path === '/status') {
      return void json(res, 200, { ok: true, mode: 'agent+worker', roles: ['agent', 'worker'],
        agent: row.agent === true, worker: row.worker === true,
        runtime: { configFile: 'D:/instances/inst-1/local.json',
          agent: { id: row.agentId, credentialConfigured: true, modelService: 'http://127.0.0.1:8080/v1', model: 'test-model', modelKeyConfigured: true, thinking: 'standard' },
          worker: { connection: 'conn-1', credentialConfigured: true, workspaceTools: 'read', toolsFile: '', sourcesFile: '' } } })
    }
    if (path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(': open\n\n')
      for (const event of (Array.isArray(events) ? events : events[row.id] ?? [])) res.write('data: ' + JSON.stringify(event) + '\n\n')
      return
    }
    if (path === '/cases' && req.method === 'POST') { await readBody(req); return void json(res, 200, control.cases) }
    if (path === '/setup/state') return void json(res, 200, { ok: true, linked: true, code: '', expiresAt: '', consoleUrl: 'https://console.example', clientMode: 'local_agent', resources: [], services: [], machineName: 'Work laptop', model: { url: '', name: '' }, agentId: 'agent-alpha' })
    if (path === '/setup/context') return void json(res, 200, { ok: true, agentName: 'Alpha', agentId: 'agent-alpha', sources: [] })
    if (path === '/worker-tools/state') return void json(res, 200, { ok: true, tools: [], workspace: 'read', services: [] })
    if (path === '/mcp-services/state') return void json(res, 200, { ok: true, services: [] })
    json(res, 404, { ok: false, teaching: 'Not in this fixture.' })
  })
  for (const row of rows) {
    const server = hostServer(row)
    hosts.set(row.id, { server, port: await listen(server) })
  }
  /** Exactly what `instances.open()` returns: the host's own key, and the way back. */
  const hostUrl = (id, page) => 'http://127.0.0.1:' + hosts.get(id).port + page + '?k=' + HOST_KEY
    + '&manager=' + encodeURIComponent('http://127.0.0.1:' + managerPort + '/?k=' + MANAGER_KEY)

  const state = () => ({ ok: true, root: 'D:/manager', device, instances: rows, modelDefaults, legacyInstall: null })
  const find = (id) => rows.find((entry) => entry.id === id)

  const manager = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const presented = req.headers['x-rulith-manager'] ?? url.searchParams.get('k') ?? ''
    if (presented !== MANAGER_KEY) return void json(res, 401, { ok: false, teaching: 'Missing or invalid Rulith manager key.' })
    if (path === '/' && req.method === 'GET') return void html(res, managerPage)
    if (path === '/manager/state') return void json(res, 200, state())
    const body = req.method === 'POST' ? await readBody(req) : {}
    const row = find(String(body.instanceId ?? ''))
    if (path === '/manager/device/refresh') {
      control.refreshRequests.push(body)
      const before = new Set(device.agents.map((agent) => agent.id))
      const next = Array.isArray(control.refreshAgents) ? control.refreshAgents : device.agents
      device.agents = next.map((agent) => ({ ...agent }))
      return void json(res, 200, { ...state(), addedAgents: device.agents.filter((agent) => !before.has(agent.id)), removedAgents: [] })
    }
    if (path === '/manager/model/default' || path === '/manager/instances/model') {
      control.modelRequests.push({ path, ...body })
      if (control.modelRefusal) return void json(res, 409, { ...state(), ok: false, teaching: control.modelRefusal })
      if (body.expectedOrigin !== device.origin || body.expectedAccountId !== device.account.id)
        return void json(res, 409, { ...state(), ok: false, teaching: 'Account changed.' })
      if (path === '/manager/model/default') {
        modelDefaults = { available: true, origin: device.origin, accountId: device.account.id,
          url: body.url, name: body.name, thinking: body.thinking, keyConfigured: Boolean(body.key), configured: true }
        for (const entry of rows) if (entry.model?.source === 'default')
          entry.model = { ...modelDefaults, source: 'default', ready: true, reason: '' }
      } else {
        row.model = body.source === 'default' ? { ...modelDefaults, source: 'default', ready: true, reason: '' }
          : { source: 'custom', configured: true, ready: true, url: body.url, name: body.name,
            thinking: body.thinking, keyConfigured: Boolean(body.key), reason: '' }
      }
      return void json(res, 200, state())
    }
    if (path === '/manager/instances/open') {
      if (control.openRefusal) return void json(res, 409, { ...state(), ok: false, teaching: control.openRefusal })
      if (!row) return void json(res, 400, { ok: false, teaching: 'No such Agent.', ...state() })
      const port = hosts.get(row.id).port
      row.open = true; row.hostPort = port; row.roles = ['agent', 'worker']
      return void json(res, 200, { ok: true, url: hostUrl(row.id, String(body.page ?? '/')), hostPort: port, ...state() })
    }
    if (path === '/manager/instances/control') {
      if (control.roleRefusal) return void json(res, 409, { ...state(), ok: false, teaching: control.roleRefusal })
      if (!row) return void json(res, 400, { ok: false, teaching: 'No such Agent.', ...state() })
      row[body.role] = body.operation === 'start'
      return void json(res, 200, { ok: true, control: { role: body.role, state: body.operation === 'start' ? 'ready' : 'stopped' }, ...state() })
    }
    if (path === '/manager/authoring/status') return void json(res, 200, { ok: true, configured: true, bindingMatches: true,
      materialPermissions: { localRead: true, offMachine: true } })
    if (path === '/manager/authoring/review') return void json(res, 200, { ok: true, resultId: 'res_' + '1'.repeat(32),
      report: { compiled: true, examples: { total: 1, passed: 1 }, citations: { total: 1, verified: 1 } },
      draft: { program: { id: 'local-policy', title: 'Local policy', rules: [{ id: 'rule-1', label: 'Check invoices' }] }, citations: [{}], examples: [{}], questions: control.authoringQuestions ? [{ question: 'Which exception applies?' }] : [] },
      cases: [{ caseId: 'CASE-LOCAL', title: 'Local authoring Case' }, { caseId: 'CASE-SECOND', title: 'Second certified Case' }],
      ...(control.authoringSaves.length ? { savedPackId: 'local_policy', savedCaseId: control.authoringSaves.at(-1).caseId, savedEntryCurrent: true } : {}),
    })
    if (path === '/manager/authoring/save') {
      control.authoringSaves.push(body)
      return void json(res, 200, { ok: true, entry: { packId: 'local_policy' }, packId: 'local_policy', caseId: body.caseId })
    }
    if (path === '/manager/instances/pair') {
      control.pairRequests.push(body)
      if (!row) return void json(res, 400, { ok: false, teaching: 'No such Agent.', ...state() })
      if (control.pairCredentialRefusal && !body.replaceAgentToken) {
        row.pendingAgentId = String(body.agentId ?? '')
        row.pendingAgentName = (device.agents.find((a) => a.id === body.agentId) || {}).name ?? ''
        row.pendingOrigin = device.origin; row.pendingAccountId = device.account.id
        row.pendingError = { code: 'runtime_credential_exists', teaching: control.pairCredentialRefusal }
        return void json(res, 409, { ok: false, teaching: control.pairCredentialRefusal, ...state() })
      }
      if (control.pairPending) {
        row.pendingAgentId = String(body.agentId ?? '')
        row.pendingAgentName = (device.agents.find((a) => a.id === body.agentId) || {}).name ?? ''
        row.pendingOrigin = device.origin; row.pendingAccountId = device.account.id
        return void json(res, 200, { ok: true, ...state() })
      }
      if (control.pairRefusal) return void json(res, 400, { ok: false, teaching: control.pairRefusal, ...state() })
      row.paired = true; row.agentId = String(body.agentId ?? ''); row.agentName = (device.agents.find((a) => a.id === body.agentId) || {}).name ?? ''
      row.origin = device.origin; row.accountId = device.account.id
      row.pendingAgentId = ''; row.pendingAgentName = ''; row.pendingOrigin = ''; row.pendingAccountId = ''; row.pendingError = null
      return void json(res, 200, { ok: true, replaceAgentToken: body.replaceAgentToken === true, ...state() })
    }
    if (path === '/manager/instances/pair/cancel') {
      control.pairCancels.push(body)
      if (control.pairCancelUnknown) return void json(res, 409, { ok: false, teaching: 'The original connection attempt could not be confirmed as cancelled.', ...state() })
      if (!row) return void json(res, 400, { ok: false, teaching: 'No such Agent.', ...state() })
      row.pendingAgentId = ''; row.pendingAgentName = ''; row.pendingOrigin = ''; row.pendingAccountId = ''; row.pendingError = null
      if (control.pairCancelAccountChange) {
        device.account = { id: 'acct-changed', name: 'Changed Account' }
        device.agents = []
      }
      return void json(res, 200, state())
    }
    if (path === '/manager/instances/create') {
      const created = instanceOf({ id: 'inst-' + (rows.length + 1), name: String(body.name ?? ''),
        mode: String(body.mode ?? 'local_agent'), paired: false, agentId: '', agentName: '', setupTarget: body.setupTarget ?? null })
      rows.push(created)
      const server = hostServer(created)
      hosts.set(created.id, { server, port: await listen(server) })
      return void json(res, 200, { ok: true, ...created, ...state() })
    }
    if (path.startsWith('/manager/')) return void json(res, 200, { ok: true, ...state() })
    json(res, 404, { ok: false, teaching: 'Not in this fixture.' })
  })
  const managerPort = await listen(manager)

  return {
    managerUrl: 'http://127.0.0.1:' + managerPort + '/?k=' + MANAGER_KEY,
    managerKey: MANAGER_KEY,
    hostKey: HOST_KEY,
    portOf: (id) => hosts.get(id).port,
    rows,
    device,
    control,
    /** Cut the manager off the way a crash does: refuse new requests and drop the open ones. */
    silenceManager: async () => {
      manager.closeAllConnections?.()
      await new Promise((done) => manager.close(() => done()))
    },
    stop: async () => {
      for (const entry of hosts.values()) {
        entry.server.closeAllConnections?.()
        await new Promise((done) => entry.server.close(() => done()))
      }
      manager.closeAllConnections?.()
      await new Promise((done) => manager.close(() => done()))
    },
  }
}

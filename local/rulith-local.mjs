#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Rulith is one host with Agent, Worker, or Agent+Worker modes.
 * Roles remain separate child processes with separate credentials. Local owns
 * only lifecycle, a bounded diagnostic journal, and its loopback UI.
 */
import http from 'node:http'
import { conversationFile, openConversations } from '../agent/conversation-store.mjs'
import { createConversationReader } from '../agent/conversation-reader.mjs'
import { DEFAULT_MODEL_URL } from './model-settings.mjs'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { localPage, projectOperations } from './local-ui.mjs'
import { createMcpServices } from './mcp-services.mjs'
import { workerToolsPage } from './worker-tools-ui.mjs'
import { createWorkerToolManagement } from './worker-tool-management.mjs'
import { writeJsonAtomic } from './manager-registry.mjs'
import { createSetupService } from './setup-service.mjs'
import { setupPage } from './setup-ui.mjs'
import { attachmentInstruction, createMaterialService } from './material-service.mjs'
import { noteChildExited, noteChildStarted, processStamp } from './process-identity.mjs'
import { clearStaleLock } from './manager-registry.mjs'
import {
  MAX_MATERIAL_REQUEST_BYTES, MaterialError, defaultMaterialRoot, materialIdentity, materialDeviceFingerprint,
} from '../worker/material-store.mjs'

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
const HERE = dirname(fileURLToPath(import.meta.url))
const ROLE_SET = new Set(['agent', 'worker'])
const MAX_BODY = 64 * 1024

/** Local owns both sides of each port connection, so it validates once and gives the
 * parent and child the same integer. Falling back independently lets the Agent listen on
 * 7799 while Local keeps calling NaN or another value. */
export function localInteger(name, raw, fallback, { min = 1, max = 65_535 } = {}) {
  if (raw === undefined || String(raw).trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(String(raw))}.`)
  }
  return value
}

export function rolesOf(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').replaceAll('+', ',').split(',')
  const roles = [...new Set(raw.map((role) => String(role).trim()).filter(Boolean))]
  if (roles.length === 0 || roles.some((role) => !ROLE_SET.has(role))) throw new Error('roles must contain agent, worker, or both.')
  return roles
}

export function modeOf(roles) {
  const selected = rolesOf(roles)
  return selected.length === 2 ? 'agent+worker' : selected[0]
}

export function defaultLocalConfig() {
  return {
    roles: ['agent', 'worker'],
    agent: { args: [], env: {
      RULITH_URL: 'https://api.rulith.ai', RULITH_TOKEN: '',
      RULITH_MODEL_URL: 'https://api.anthropic.com/v1/messages', RULITH_MODEL: 'claude-sonnet-5', RULITH_MODEL_KEY: '',
    } },
    worker: { enabled: false, env: { RULITH_WORK_URL: 'https://api.rulith.ai/work', RULITH_CONNECTION: '', RULITH_CONNECTION_KEY: '' } },
    paths: {},
  }
}

export function normalizeLocalConfig(config) {
  const defaults = defaultLocalConfig()
  const { cloud: _retiredCloud, ...current } = config ?? {}
  const agentEnv = { ...defaults.agent.env, ...(config?.agent?.env ?? {}) }
  delete agentEnv.RULITH_AGENT
  return {
    ...defaults, ...current,
    roles: rolesOf(config?.roles ?? defaults.roles),
    agent: { ...defaults.agent, ...(config?.agent ?? {}), env: agentEnv },
    worker: { ...defaults.worker, ...(config?.worker ?? {}), env: { ...defaults.worker.env, ...(config?.worker?.env ?? {}) } },
    paths: { ...defaults.paths, ...(config?.paths ?? {}) },
  }
}

/** Non-empty deployment config wins; an empty placeholder means "inherit".
 * Generated example files intentionally contain blank credential slots, and
 * those blanks must not erase secrets supplied by the process supervisor. */
export function effectiveChildEnv(base, configured = {}) {
  const overlay = Object.fromEntries(Object.entries(configured).filter(([, value]) => String(value ?? '').trim() !== ''))
  return { ...base, ...overlay }
}

/**
 * Non-Rulith environment only, for a host that runs more than one identity.
 *
 * Inheritance is the right default for a single deployment: a process supervisor supplies
 * `RULITH_TOKEN` and the configuration file leaves the slot blank. It is the wrong default
 * the moment one process launches children for several different Agents. An inherited
 * `RULITH_TOKEN` would reach every instance's Agent, an inherited `RULITH_CONNECTION_KEY`
 * would reach every Worker, and `ANTHROPIC_API_KEY` is read by the Agent as a model key
 * whenever `RULITH_MODEL_KEY` is empty — so the operator's own shell would silently become
 * a credential source no instance configuration mentions.
 *
 * Every `RULITH_*` variable is removed rather than a curated list of the secret-looking
 * ones: the non-secret ones (`RULITH_URL`, `RULITH_MODEL`, `RULITH_WORKSPACE_TOOLS`)
 * select *which* identity and *which* resources a child uses, and inheriting those across
 * instances is the same class of mistake with a quieter symptom.
 *
 * This is application-level isolation of configuration, not an OS sandbox: a child process
 * can still read the filesystem this account can read.
 */
export const INHERITED_CREDENTIAL_VARIABLES = Object.freeze(['ANTHROPIC_API_KEY'])
export function isolatedEnvironmentBase(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    !/^RULITH_/i.test(name) && !INHERITED_CREDENTIAL_VARIABLES.includes(name)))
}

// Flushed to disk before the rename (see writeJsonAtomic).
const saveConfig = (configFile, config) => writeJsonAtomic(configFile, config)

const readJsonUpTo = (req, limit, over) => new Promise((accept, reject) => {
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > limit) { reject(new Error(over)); req.destroy(); return }
    chunks.push(chunk)
  })
  req.on('end', () => {
    try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(new Error('Body is not valid JSON.')) }
  })
})
const readJson = (req) => readJsonUpTo(req, MAX_BODY, 'Request body exceeds 64KB.')
/**
 * One file's worth of body, and no more.
 *
 * The ceiling is not the file limit: 8 MiB of bytes is about 10.7 MiB of canonical base64, and
 * refusing at 8 MiB would reject every file at the documented limit as if it were over it. This
 * is the smallest ceiling that admits a legal maximum request, and the *file* limit is checked
 * separately, on the decoded bytes, where it means what it says.
 */
const readMaterialJson = (req) => readJsonUpTo(req, MAX_MATERIAL_REQUEST_BYTES,
  `Request body exceeds ${Math.floor(MAX_MATERIAL_REQUEST_BYTES / (1024 * 1024))} MiB. One file per request.`)

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
const safeUrl = (value) => {
  try {
    const url = new URL(String(value ?? ''))
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    return url.toString()
  } catch { return String(value ?? '') }
}
const consoleOriginFor = (value) => {
  try {
    const origin = new URL(value)
    if (!['http:', 'https:'].includes(origin.protocol)) return ''
    if (origin.hostname === 'api.rulith.ai') origin.hostname = 'console.rulith.ai'
    return origin.origin
  } catch { return '' }
}

/**
 * What "this role started" means, and the event each role already sends to say it.
 *
 * A start is confirmed by the role's own readiness event, never by a timer:
 *
 *   · `agent` sends `start` once its task endpoint is listening — see `emit('start', …)` in
 *     `agent/rulith-agent.mjs`, which runs after `serveSrv.listen` resolves.
 *   · `worker` sends `up` once its Tool Manifest is loaded and it is entering its poll loop —
 *     see `say(… , 'up', …)` in `worker/rulith-worker.mjs`, after `await SOURCES_READY`.
 *
 * **Each role's own answer, not one this host imposes.** The two are deliberately not the same
 * shape, and pretending they were would misreport one of them. A Worker whose Source fetch
 * fails says so and comes up anyway, so an offline machine's healthy Worker is confirmed
 * started. The Agent establishes its authenticated MCP session before it serves and exits when
 * it cannot, so an unreachable Gateway reaches this host as what it is — a child that exited
 * during startup — rather than as a rule this host invented about the network.
 *
 * Both events already existed and are already forwarded to the Local event stream; this is the
 * consumer they were missing, not a new child protocol.
 */
const ROLE_READY_EVENT = Object.freeze({ agent: 'start', worker: 'up' })
/**
 * The ceiling on *not knowing*, not a wait.
 *
 * A confirmation ends the moment the readiness event or the child's exit arrives, so a healthy
 * start answers as fast as the child can report and a broken one as fast as it can die. This
 * bound is only reached by a program that does neither — an operator-configured `paths.*`
 * pointing at something that does not speak the readiness event — and that case is answered as
 * unconfirmed rather than as either success or failure. It is a host parameter rather than a
 * constant because it states how long "unknown" may last, which a caller that knows what it is
 * starting may hold an opinion about; the CLI below states none and takes this default.
 */
const START_CONFIRM_MS = 15_000
/**
 * How long a stop watches for the exit it asked for before saying it has not seen one.
 *
 * Short, because it is not a grace period and nothing follows it: a role that has not exited
 * is reported as still stopping, and no second signal is ever sent. A well-behaved child exits
 * far inside this, so the ordinary answer is unchanged.
 */
const STOP_OBSERVE_MS = 2_000
/**
 * How long preparing the calculation sample waits for a running Worker to exit.
 *
 * A managed stop first finishes the Worker's claimed work and its held Poll, and the Gateway
 * holds an idle Poll for up to 25 seconds. Past this bound nothing is prepared and the operator
 * is told the Worker is still stopping; nothing is forced.
 */
const SAMPLE_STOP_WAIT_MS = 40_000

export function createLocalHost({
  configFile, config, roles, port = 7790, key = randomUUID().replace(/-/g, ''),
  startConfirmMs = START_CONFIRM_MS, sampleStopWaitMs = SAMPLE_STOP_WAIT_MS, autoStart = true,
  isolateEnvironment = false, setupApprover, managedPolicy, managedCallToken, protectedPaths = [], onChildChange,
  materialRoot, onModelConfigured, modelOverlay, authorizeConnectionKey, conversationOwner,
  registerMaterialSubmission, acceptedMaterialBinding,
  getApprovedDeviceId, workerRestartDelays = [250, 1000, 4000, 10000], workerStableMs = 60_000, toolLibrary,
}) {
  const selectedRoles = rolesOf(roles)
  const configDir = dirname(resolve(configFile))
  const historyDirectory = join(configDir, 'conversations')
  const historyFile = conversationOwner ? conversationFile(historyDirectory, conversationOwner) : undefined
  let historyBusy = false
  let historyReader, historyReaderRetryAfter = 0
  const readHistory = async input => {
    if (historyReader?.failed) { void historyReader.close(); historyReader = undefined }
    if (!historyReader) {
      if (Date.now() < historyReaderRetryAfter) throw new Error('Conversation reader is temporarily unavailable. Retry opening Conversations in a few seconds.')
      historyReaderRetryAfter = Date.now() + 5000
      historyReader = createConversationReader(historyFile, conversationOwner)
    }
    return historyReader.read(input)
  }
  // An account default is runtime-only. It must never become part of `config`: Setup actions
  // clone and save that object, and doing so would turn an inherited provider key into a
  // durable per-instance credential.
  let activeModelOverlay = modelOverlay === undefined ? undefined : { ...modelOverlay }
  /** What a child inherits before this instance's own configuration is applied. */
  const baseEnv = () => (isolateEnvironment ? isolatedEnvironmentBase(process.env) : process.env)
  const agentEnvironment = () => effectiveChildEnv(baseEnv(), { ...config.agent?.env, ...(activeModelOverlay ?? {}) })
  /**
   * The owner's veto on the two things that change what this host is running under.
   *
   * A host launched by the manager is one *managed* instance: its Agent identity is frozen,
   * and whether it may run at all depends on a device grant that lives outside this process's
   * configuration file. The instance's own page is reachable by anyone holding this host's
   * key. First-message startup, the Worker setting and `POST /setup/*` could
   * otherwise start execution, or re-pair, or re-point a model, without the manager — and
   * therefore without the account lifecycle the manager is responsible for.
   *
   * So a managed host asks its owner first. The callback is bound to one instance id, so it
   * answers about *this* instance and never about whatever is selected in a browser
   * somewhere. A host with no owner — the single-instance deployment — has no policy and
   * keeps exactly the semantics it always had.
   */
  /**
   * `fromOwner` distinguishes the manager's own calls from everything else reaching this host.
   *
   * The owner already decided an operation may proceed before issuing it; re-applying its
   * installation-wide gate to its own in-flight call would refuse the second half of work it
   * had admitted. The marker is a secret this host was built with, so a page holding the
   * host key cannot claim to be the owner.
   */
  const permitted = async (operation, req) => {
    if (managedPolicy === undefined) return null
    const fromOwner = managedCallToken !== undefined && req?.headers['x-rulith-managed'] === managedCallToken
    const teaching = await managedPolicy({ ...operation, fromOwner })
    return typeof teaching === 'string' && teaching.trim() !== '' ? teaching : null
  }
  /**
   * Tell the owner, every time this host gains or loses a child process.
   *
   * Automatic first-message startup and Worker restarts also change ownership. Record every
   * spawn and exit so that a later manager knows which children may have survived a crash.
   */
  const announceChildren = () => {
    if (onChildChange === undefined) return
    try {
      const result = onChildChange(ownChildren())
      if (result !== undefined && typeof result.catch === 'function') result.catch(() => undefined)
    } catch { /* an owner that cannot record this must not take the host down with it */ }
  }
  const events = []
  // A bounded log is not the latest report of this Agent's operations. Keep this small
  // projection separately so a reconnect cannot turn an evicted report into "none reported".
  let operationsSnapshot = projectOperations([])
  const clients = new Set()
  let nextSequence = 1
  const components = {
    agent: { child: null, serveKey: '', servePort: 7799, agentId: 'unconfigured' },
    worker: { child: null },
  }
  const reloads = { agent: null, worker: null }
  const reloadAgain = { agent: false, worker: false }
  let agentStarting, workerRetryTimer, workerFailures = 0, workerFailure = '', workerCredentialRejected = false
  const workerEnabled = () => selectedRoles.includes('worker') && config.worker?.enabled === true
  const workerSetup = () => {
    const env = effectiveChildEnv(baseEnv(), config.worker?.env ?? {})
    return !!(env.RULITH_CONNECTION && env.RULITH_CONNECTION_KEY)
  }
  const hasLocalTools = () => {
    if (!selectedRoles.includes('worker')) return false
    if (!selectedRoles.includes('agent') || ['read', 'read-write'].includes(config.worker?.env?.RULITH_WORKSPACE_TOOLS)
      || mcpServices.overview().services.length > 0 || materials.inUse()
      || (toolLibrary?.active() === true && toolLibrary.hasTools())) return true
    try {
      const toolsFile = resolve(configDir, config.worker?.env?.RULITH_TOOLS_FILE || 'worker-tools.json')
      return Object.keys(JSON.parse(readFileSync(toolsFile, 'utf8')).tools ?? {}).length > 0
    } catch { return false }
  }
  const workerView = () => ({ enabled: workerEnabled(), visible: workerEnabled() || hasLocalTools(),
    state: !workerSetup() || (workerEnabled() && components.worker.availability === 'needs setup') ? 'needs setup'
      : running('worker') && components.worker.readyAt !== undefined && !stopRequested.has(components.worker.child)
        ? components.worker.availability ?? 'offline' : 'offline',
    reloading: !!reloads.worker, failures: workerFailures, failure: workerFailure,
    retryAt: components.worker.retryAt ?? null })
  /**
   * Who this host is, for the purposes of owning material.
   *
   * The binding is made of things that do **not** change when a credential is rotated: which
   * Gateway this profile talks to, which Connection it holds, and which Agent it is. Rotating a
   * token or a Connection key is the same owner continuing and must not make somebody's files
   * unreadable; re-pointing the profile at another Gateway or another Connection is a different
   * owner and fails closed. A profile with neither a Connection nor an Agent identity has no
   * owner to bind to at all, and the store refuses rather than bucketing it under a hash of the
   * empty string — which would make every unconfigured profile on this machine look like one.
   *
   * Recomputed on every call rather than captured once, because all three live in a
   * configuration file this host rewrites.
   */
  const materialIdentityNow = () => {
    const agentEnv = agentEnvironment()
    const workerEnv = effectiveChildEnv(baseEnv(), config.worker?.env ?? {})
    return materialIdentity({
      configFile: resolve(configFile),
      gatewayUrl: String(agentEnv.RULITH_URL ?? ''),
      connectionId: String(workerEnv.RULITH_CONNECTION ?? ''),
      agentId: components.agent.agentId,
      deviceId: getApprovedDeviceId?.() ?? '',
      modelUrl: String(agentEnv.RULITH_MODEL_URL ?? DEFAULT_MODEL_URL),
      model: String(agentEnv.RULITH_MODEL ?? ''),
    })
  }
  /**
   * Ask the Worker child to complete one locally delivered read.
   *
   * The custodian is the Worker: it holds the bytes and it holds the Connection the Gateway
   * issued the ticket to. It is purely outbound and opens no inbound port, so the request goes
   * over the IPC pipe this host already owns — which is also why the Agent cannot reach it
   * directly, and must not be able to.
   *
   * A Worker that is not running, or does not answer inside the bound, is reported as offline.
   * Nothing here substitutes a reading of its own for one it could not obtain.
   */
  const CUSTODIAN_TIMEOUT_MS = 20_000
  let nextCustodyCall = 1
  const custodian = (request) => new Promise((settle) => {
    const child = components.worker.child
    if (!running('worker') || child === null || !child.connected) {
      return void settle({ ok: false, errorCode: 'material_custodian_offline',
        teaching: 'The Worker that holds custody of this profile\'s local material is not running.' })
    }
    const id = `mlr-${nextCustodyCall++}`
    const done = (body) => { clearTimeout(timer); child.off('message', onMessage); settle(body) }
    const onMessage = (message) => {
      if (message?.protocol === 'rulith-local-material' && message.id === id) done(message)
    }
    const timer = setTimeout(() => done({ ok: false, errorCode: 'material_custodian_offline',
      teaching: 'The custodian did not answer this local read inside the delivery bound.' }), CUSTODIAN_TIMEOUT_MS)
    child.on('message', onMessage)
    child.send({ protocol: 'rulith-local-material', operation: 'read', id, ...request }, (error) => {
      if (error) done({ ok: false, errorCode: 'material_custodian_offline', teaching: String(error.message ?? error) })
    })
  })
  const materials = createMaterialService({
    root: materialRoot ?? defaultMaterialRoot(configFile),
    getIdentity: materialIdentityNow,
    custodian,
    key: randomUUID().replace(/-/g, ''),
  })
  /**
   * The material binding a Worker started now would receive.
   *
   * It is built here rather than inline at spawn so the Worker Tools page and the Worker see
   * the same input: the page composes the advertised Tool list from this environment, and a
   * page that composed it from a *different* environment would list a set the Worker does not
   * advertise — which is the exact confusion the shared composition rule exists to prevent.
   * Returns `{}` when the area cannot be opened at all, so the page and the Worker are both
   * without it rather than disagreeing about it.
   */
  const materialChildEnv = () => {
    const area = materials.configured ? materials.ensure() : undefined
    if (area === undefined) return {}
    let binding
    // A profile with no owner to bind to starts its roles without a material area rather than
    // with one nothing can open. `ensure` already answers `undefined` for that case; this is the
    // same refusal said again, because two callers reading one identity must not disagree about
    // whether it exists.
    try { binding = materialIdentityNow() } catch { return {} }
    const deviceId = getApprovedDeviceId?.() ?? ''
    if ((deviceId ? materialDeviceFingerprint(deviceId) : '') !== binding.deviceFingerprint) return {}
    return {
      RULITH_MATERIALS_ROOT: area,
      RULITH_MATERIALS_PROFILE: binding.profile,
      RULITH_MATERIALS_OWNER: binding.owner,
      RULITH_MATERIALS_AGENT_FINGERPRINT: binding.agentFingerprint,
      RULITH_MATERIALS_DEVICE_ID: deviceId,
      RULITH_MATERIALS_MODEL_DESTINATION: binding.modelDestination,
    }
  }
  const workerContext = () => ({ environment: { ...effectiveChildEnv(baseEnv(), config.worker?.env ?? {}), ...materialChildEnv() },
    directory: dirname(config.paths?.worker ? resolve(configDir, config.paths.worker) : resolve(HERE, '../worker/rulith-worker.mjs')) })
  const mcpServices = createMcpServices(configFile, { workerContext, protectedPaths })
  const toolManagement = createWorkerToolManagement({ mcpServices, workerContext, setWorkspaceMode: mode => {
    if (toolLibrary?.active() === true) {
      const { environment, directory } = workerContext(), own = mcpServices.projectWorkerInputs(environment, directory)
      toolLibrary.check({ tools: own.manifest.tools, vault: own.vault }, { ...environment, RULITH_WORKSPACE_TOOLS: mode })
    }
    // 只更新既有部署字段，保留文件中的其他配置；不在此编辑 Agent/模型凭据。
    const next = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : structuredClone(config)
    next.worker = { ...next.worker, env: { ...next.worker?.env, RULITH_WORKSPACE_TOOLS: mode } }
    saveConfig(configFile, next)
    config.worker = { ...config.worker, env: { ...config.worker?.env, RULITH_WORKSPACE_TOOLS: mode } }
  } })
  /**
   * What this Agent's Worker would start with now, composed from its own inputs and its
   * environment's and checked, but written nowhere: a digest that is equal to the one it started
   * with means nothing it runs has changed. Throws the teaching a start would be refused with.
   */
  const libraryDigest = () => {
    const { environment, directory } = workerContext()
    const own = mcpServices.projectWorkerInputs(environment, directory)
    return toolLibrary.check({ tools: own.manifest.tools, vault: own.vault }, environment)
  }
  const toolOverview = () => {
    const own = toolManagement.overview()
    if (toolLibrary?.active() !== true) return own
    const library = toolLibrary.inventory()
    return { ...own,
      tools: [...new Map([...library.tools.filter(tool => tool.origin !== 'builtin'), ...own.tools].map(tool => [tool.id, tool])).values()],
      services: [...new Map([...library.services, ...own.services].map(service => [service.name, service])).values()],
      library: { notice: toolLibrary.notice() } }
  }
  /**
   * What Setup is shown, for an Agent on its environment's tools: the services it has include the
   * environment's, and a selection is checked against the composition its Worker will start with.
   * Setup itself is unchanged and does not know there is an environment.
   */
  const setupServices = { overview: () => {
    const own = mcpServices.overview()
    return toolLibrary?.active() === true ? { ...own, services: [...own.services, ...toolLibrary.services()] } : own
  } }
  const setupTools = { overview: () => {
    const view = toolOverview()
    if (toolLibrary?.active() === true) libraryDigest()
    return view
  } }
  const running = (role) => components[role].child !== null && components[role].child.exitCode === null
  /**
   * The role processes this host owns right now, each with the stamp taken the moment it was
   * spawned (`process-identity.mjs`). The pid alone is what an owner used to record; the stamp is
   * what lets a later run tell this child from an unrelated process that got the same pid.
   */
  const ownChildren = () => ['agent', 'worker']
    .filter((role) => running(role))
    .map((role) => ({ role, pid: components[role].child.pid, ...components[role].stamp }))
  const setup = createSetupService({ configFile, getConfig: () => config,
    effectiveEnv: () => effectiveChildEnv(baseEnv(), config.worker?.env ?? {}),
    agentCredentialConfigured: () => !!agentEnvironment().RULITH_TOKEN,
    workerStopped: () => !running('worker'), mcpServices: setupServices, toolManagement: setupTools,
    approvePairing: setupApprover,
    onModelConfigured: async () => { activeModelOverlay = undefined; requestReload('worker'); return await onModelConfigured?.() },
    // A stopped Worker leaves its last launch environment for diagnostics. It must not remain
    // the source of truth after a key rotation, or status could describe a credential that the
    // next Worker will no longer receive.
    onConnectionKeyConfigured: () => { components.worker.roleEnv = undefined },
    authorizeConnectionKey,
    saveConfig: next => {
      const normalized = normalizeLocalConfig(next)
      const agentChanged = JSON.stringify(normalized.agent) !== JSON.stringify(config.agent)
      const workerChanged = JSON.stringify(normalized.worker?.env) !== JSON.stringify(config.worker?.env)
      saveConfig(configFile, normalized)
      config = normalized
      selectedRoles.splice(0, selectedRoles.length, ...rolesOf(config.roles))
      if (agentChanged) requestReload('agent')
      if (workerChanged) requestReload('worker')
    },
  })
  const emit = (src, type, data = {}) => {
    // Operations are reported under the account and Agent this host serves, so that the page
    // links a waiting operation to Console only when those still match.
    const operationsEvent = src === 'agent' && type === 'operations'
    const event = { sequence: nextSequence++, t: Date.now(), src, type, ...data,
      ...(operationsEvent ? { accountId: conversationOwner?.accountId || '', agentId: components.agent.agentId } : {}) }
    if (!event.historical) operationsSnapshot = projectOperations([event], operationsSnapshot)
    events.push(event)
    if (events.length > 2000) events.splice(0, events.length - 1500)
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const client of clients) { try { client.write(frame) } catch { clients.delete(client) } }
  }
  /**
   * The children an operator asked to stop, by process identity.
   *
   * A stopped child exits, and an exit is otherwise a startup failure. Without this the two
   * are indistinguishable and an owner stopping the host while a start was still being
   * confirmed was told to "fix the missing local configuration" — advice about a defect that
   * does not exist, for something they did on purpose. Keyed on the child object rather than
   * on the role, so it can never be read against the process that replaced it.
   *
   * **A request, not an acknowledgement.** `kill()` sends a signal; on POSIX the child decides
   * what to do with it, and may handle or ignore it. So this records that a stop was *asked
   * for*, and every place that wants to say something about the process asks the process —
   * `child.exitCode`/`signalCode`, or the exit event — instead of reading this set as if it
   * were the answer.
   */
  const stopRequested = new WeakSet()
  /** Has this child actually ended, as the process itself reports it? */
  const hasExited = (child) => child === null || child === undefined
    || child.exitCode !== null || child.signalCode !== null
  const wireChild = (src, child) => {
    child.on('message', (message) => {
      if (message?.protocol !== 'rulith-local-event') return
      const event = message.event
      if (event === null || typeof event !== 'object' || Array.isArray(event)) return
      // Readiness is recorded for **this** child only, and only while nobody has asked it to
      // stop. Process identity alone was not enough: a POSIX child may handle SIGTERM, and one
      // that answers the stop signal by reporting readiness would otherwise confirm the very
      // start the operator had just cancelled. A signal is a request, not an acknowledgement,
      // so a report that arrives after the request cannot be read as the report the pending
      // start was waiting for. The event still reaches the Trace stream below, unedited.
      if (event.type === ROLE_READY_EVENT[src] && components[src].child === child && !stopRequested.has(child)) {
        components[src].readyAt = Date.now()
        components[src].managedStop = event.managedStop === true
        const settle = components[src].onReady
        components[src].onReady = undefined
        settle?.()
      }
      if (src === 'worker' && components.worker.child === child && event.type === 'availability') {
        components.worker.availability = ['online', 'offline', 'needs setup'].includes(event.state) ? event.state : 'offline'
      }
      if (src === 'agent' && components.agent.child === child && !stopRequested.has(child)
        && event.type === 'start' && typeof event.agentId === 'string' && event.agentId.trim() !== '') {
        components.agent.agentId = event.agentId
      }
      const { type: _type, t: _time, ...rest } = event
      emit(src, event.type ?? 'log', { ...rest, at: event.t })
    })
    const buffers = { out: '', err: '' }
    const feed = (stream, chunk) => {
      buffers[stream] += chunk
      let boundary
      while ((boundary = buffers[stream].indexOf('\n')) >= 0) {
        const line = buffers[stream].slice(0, boundary)
        buffers[stream] = buffers[stream].slice(boundary + 1)
        if (line.trim() !== '') {
          emit(src, 'log', { line: line.slice(0, 400), ...(stream === 'err' ? { stderr: true } : {}) })
          if (stream === 'err') console.error(`[${src}] ${line.slice(0, 400)}`)
        }
      }
    }
    child.stdout.on('data', (chunk) => feed('out', String(chunk)))
    child.stderr.on('data', (chunk) => feed('err', String(chunk)))
  }
  /**
   * Set when `close()` begins. A request that was already in flight — preparing the calculation
   * sample holds one for tens of seconds — must not start a role after `close()` has stopped the
   * roles: that child would outlive the host that could stop it, known only as an unobserved pid.
   */
  let closing = false
  const closingRefusal = 'This Local host is closing, so nothing new is started. Open this Agent again to start it.'
  const startAgent = () => {
    if (closing) return closingRefusal
    if (historyBusy) return 'The conversation archive is finishing. Send your message again once it finishes.'
    if (running('agent')) return 'Agent is already running.'
    const path = config.paths?.agent ? resolve(configDir, config.paths.agent) : resolve(HERE, '../agent/rulith-agent.mjs')
    if (!existsSync(path)) return `Agent runtime not found at ${path}. Set paths.agent in the Rulith configuration.`
    const serveKey = randomUUID().replace(/-/g, '')
    const roleEnv = agentEnvironment()
    const servePort = localInteger(
      'RULITH_SERVE_PORT',
      roleEnv.RULITH_SERVE_PORT,
      7799,
    )
    const args = Array.isArray(config.agent?.args) ? [...config.agent.args] : []
    if (!args.includes('--serve')) args.push('--serve')
    // Roles can start in either order. A configured custodian can negotiate even before it
    // is online (claim then fails visibly); an Agent-only profile must use ordinary proxy reads.
    const materialConnection = selectedRoles.includes('worker') && materials.configured
      ? String(effectiveChildEnv(baseEnv(), config.worker?.env ?? {}).RULITH_CONNECTION ?? '').trim() : ''
    /**
     * A conversation lock an earlier Agent left behind is judged here, before the new Agent judges
     * it from inside itself.
     *
     * A crash or a stop of an older Agent can leave `<history>.lock`. Windows may give that pid
     * to this host or its Worker before the next Agent starts. This host knows its own pid,
     * session and the children it started, so
     * `clearStaleLock` removes the lock when that view proves its writer has ended. Nothing is
     * refused or waited for here: a lock that still looks held is left to the Agent, which says so.
     *
     * Safe only because no Agent that could hold this history runs in this process: this host's own
     * start is refused above while its Agent runs, and a workbench keeps one host per Agent
     * directory and closes it only once its children have exited. The rule "a child this process
     * started holds the pid, so another process's record of it has ended" is wrong for a record a
     * live child wrote about itself, and an Agent is the child that writes this lock; the Worker
     * never does. Nor can this host's own archive lease be held at this point: an archive in
     * progress refuses the start above.
     *
     * 中文说明：Agent 崩溃或旧版本被 kill 后，对话历史的锁文件可能留在原地。新 Agent 在自己的进程里
     * 判断这把锁，看不出锁上的 pid 现在属于本主机或它启动的 Worker；本主机知道，所以在启动前先清掉已被证明
     * 过期的锁。只有在没有 Agent 子进程运行时调用才安全。
     */
    if (historyFile) {
      try { clearStaleLock(historyFile + '.lock') } catch { /* the Agent judges the lock itself and reports what it finds */ }
    }
    const child = spawn(process.execPath, [path, ...args], {
      env: { ...roleEnv,
        // Only the manager can select the history owner; profile/environment values cannot override it.
        RULITH_CONVERSATION_DIR: historyFile ? historyDirectory : '',
        RULITH_CONVERSATION_OWNER: historyFile ? JSON.stringify(conversationOwner) : '',
        RULITH_LOCAL_EVENTS: 'ipc', RULITH_SERVE_KEY: serveKey, RULITH_SERVE_PORT: String(servePort),
        // The Agent is given the delivery endpoint and the one key that opens it — never this
        // host's page key, which would also open `/worker-setting` and `/setup/*`.
        RULITH_MATERIALS_CONNECTION: materialConnection,
        ...(materialConnection !== '' ? {
          RULITH_MATERIALS_DELIVER_URL: `http://127.0.0.1:${server.address()?.port ?? port}/materials/deliver`,
          RULITH_MATERIALS_KEY: materials.key,
        } : {}) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    components.agent = { ...components.agent, child, stamp: processStamp(child.pid, { script: path }), serveKey, servePort, agentId: 'unconfigured', readyAt: undefined, onReady: undefined, managedStop: false }
    noteChildStarted(child.pid)
    wireChild('agent', child)
    child.on('exit', (code) => {
      noteChildExited(child.pid)
      if (components.agent.child === child) {
        components.agent.child = null
        components.agent.agentId = 'unconfigured'
      }
      emit('agent', 'exit', { code })
      if (historyFile) {
        void readHistory({ kind: 'interrupted', stopped: true })
          .then(rows => { for (const row of rows) emit('agent', row.type, row) })
          .catch(error => emit('local', 'error', { note: error.message }))
      }
      announceChildren()
    })
    emit('agent', 'spawn', { pid: child.pid })
    announceChildren()
    return null
  }
  const startWorker = () => {
    if (closing) return closingRefusal
    if (running('worker')) return 'Worker is already running.'
    const path = config.paths?.worker ? resolve(configDir, config.paths.worker) : resolve(HERE, '../worker/rulith-worker.mjs')
    if (!existsSync(path)) return `Worker runtime not found at ${path}. Set paths.worker in the Rulith configuration.`
    let roleEnv
    try { roleEnv = mcpServices.workerEnvironment(effectiveChildEnv(baseEnv(), config.worker?.env ?? {}), dirname(path)) }
    catch (error) { return error.message }
    if (toolLibrary !== undefined) {
      // Where an environment's keys live is for composition to say and for nothing else to: a value
      // from this profile's own configuration is dropped, so that no setting can point a Worker at a
      // vault file the manager did not name. The manager directory is otherwise off limits to an
      // instance's paths (`managerExposure`); this is the one path into it a Worker is given.
      delete roleEnv.RULITH_ENVIRONMENT_SECRETS_FILE
      if (toolLibrary.active()) {
        // After the Agent's own inputs are in place, the environment's tools and services are added to
        // them, and the Worker is pointed at the two files that result. A refusal is its teaching.
        try { roleEnv = toolLibrary.workerEnvironment({ ...roleEnv, ...materialChildEnv() }, dirname(path)) }
        catch (error) { return error.message }
      }
    }
    // The Worker is told where the material area is and whose it is, and is given neither the
    // Agent credential nor anything it could reconstruct one from: the two bindings travel as
    // sha256 fingerprints, which it compares and never inverts. The same values the Worker
    // Tools page composed its list from — one function, so the two cannot disagree.
    const materialEnv = materialChildEnv()
    const child = spawn(process.execPath, [path], {
      env: { ...roleEnv, RULITH_LOCAL_CONFIG: resolve(configFile), RULITH_LOCAL_EVENTS: 'ipc', ...materialEnv },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], cwd: dirname(path),
    })
    components.worker = { ...components.worker, child, stamp: processStamp(child.pid, { script: path }), roleEnv,
      readyAt: undefined, onReady: undefined, managedStop: false, availability: 'offline' }
    noteChildStarted(child.pid)
    wireChild('worker', child)
    child.on('exit', (code) => {
      noteChildExited(child.pid)
      emit('worker', 'exit', { code })
      if (components.worker.child === child) components.worker.child = null
      announceChildren()
      if (closing || !workerEnabled() || stopRequested.has(child)) return
      if (code === 3) {
        components.worker.availability = 'needs setup'
        workerCredentialRejected = true
        workerFailures += 1
        workerFailure = 'The Worker credential was rejected. Replace its Connection key before enabling local tools again.'
        emit('worker', 'restart-failed', { note: workerFailure, code })
        return
      }
      if (Date.now() - components.worker.startedAt >= workerStableMs) workerFailures = 0
      const delay = workerRestartDelays[workerFailures++]
      if (delay === undefined) {
        workerFailure = 'The Worker repeatedly exited. Automatic retries have stopped. Review Trace and tool setup, then turn this setting on again.'
        emit('worker', 'restart-failed', { note: workerFailure, failures: workerFailures })
        return
      }
      components.worker.retryAt = Date.now() + delay
      emit('worker', 'restart-wait', { delay, failures: workerFailures })
      workerRetryTimer = setTimeout(() => {
        workerRetryTimer = undefined
        components.worker.retryAt = null
        void ensureWorker().catch(error => { workerFailure = error.message; emit('local', 'error', { note: workerFailure }) })
      }, delay)
      workerRetryTimer.unref?.()
    })
    components.worker.startedAt = Date.now()
    emit('worker', 'spawn', { pid: child.pid })
    announceChildren()
    return null
  }
  const stop = (role, { reload = false } = {}) => {
    if (role === 'worker') { clearTimeout(workerRetryTimer); workerRetryTimer = undefined; components.worker.retryAt = null }
    const child = components[role]?.child
    if (child === null || child === undefined) return `${role} is not running.`
    stopRequested.add(child)
    // Windows 的 kill 会直接结束 Worker，来不及关闭它启动的 stdio MCP 子进程。
    // 只给明确广告了托管停止能力的当前子进程发 IPC；仍以 exit 事件确认停止。
    if (components[role].managedStop && child.connected) {
      child.send({ protocol: 'rulith-local-control', operation: reload && role === 'agent' ? 'reload' : 'stop' }, error => { if (error) child.kill() })
    } else child.kill()
    return null
  }
  /**
   * Watch for the exit the stop asked for, and say which of the two actually happened.
   *
   * `child.kill()` sends SIGTERM and returns. On POSIX the child chooses what to do with it:
   * it may handle it, and it may keep running. Answering `stopped` at that moment reported an
   * intention as an outcome — a child that ignored the signal was still listed as running one
   * refresh later, with a message saying it had stopped.
   *
   * So the exit event this host already receives is what decides, within a short bound. A
   * well-behaved role exits in milliseconds and still answers `stopped`; one that does not is
   * answered `stopping`, truthfully. The manager's explicit exit/removal may then force its
   * owned child to end, but still has to observe that exit before claiming it stopped.
   */
  const observeExit = (role, waitMs = STOP_OBSERVE_MS, child = components[role]?.child) => new Promise((settle) => {
    if (hasExited(child)) return void settle('stopped')
    const finish = (outcome) => { clearTimeout(timer); child.off('exit', onExit); settle(outcome) }
    const onExit = () => finish('stopped')
    const timer = setTimeout(() => finish(hasExited(child) ? 'stopped' : 'stopping'), waitMs)
    child.once('exit', onExit)
  })
  /**
   * Did the role this request just started finish initializing, die trying, or neither?
   *
   * This replaces a fixed 350 ms sleep followed by "is it still running". That answered the
   * wrong question in both directions: on a busy machine a child that exits immediately has
   * not exited yet at 350 ms, so Local reported `200 {ok:true}` for a role that was already
   * dying — and a child that takes longer than 350 ms to *succeed* was never confirmed at all,
   * only assumed. The evidence is the readiness event the role already sends and the child's
   * own exit; the timer's only remaining job is to bound how long "I do not know" may last.
   *
   * Returns `{outcome, exited}` where outcome is `ready` | `exited` | `cancelled` |
   * `unconfirmed`. `cancelled` is decided by `stopRequested` — an explicit per-child record of
   * an operator gesture — and never by which listener happened to run first: a Stop that lands
   * while a start is still being confirmed would otherwise be reported as a startup failure and
   * blamed on the configuration.
   *
   * `exited` is separate from the outcome and is asked of the process, because the two really
   * are different questions. A stop that has been *requested* does not mean the child has gone:
   * a POSIX child may handle SIGTERM and stay. The caller needs both to say anything true, and
   * saying "it is not running" on the strength of the request alone was the untruth this split
   * removes.
   *
   * A late readiness cannot reach `ready` here either. `wireChild` stops recording readiness for
   * a child once its stop has been requested, so a process that answers the stop signal by
   * reporting itself ready confirms nothing — the report is still shown in Trace, it simply is
   * not evidence for a start the operator has already cancelled.
   *
   * There is deliberately no "replaced by a newer child" outcome. A start is refused while the
   * role is running, so a replacement can only follow this child's exit, and this settles on
   * that exit. An outcome nothing can reach is worse than one that is absent: it reads as a
   * case that was thought about and is really a case that cannot happen.
   */
  const confirmStart = (role) => new Promise((settle) => {
    const state = components[role]
    const child = state.child
    if (child === null || child === undefined) return void settle({ outcome: 'exited', exited: true })
    let done = false
    const finish = (outcome) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.off('exit', onExit)
      if (state.onReady === finishReady) state.onReady = undefined
      settle({ outcome, exited: hasExited(child) })
    }
    const finishReady = () => finish(stopRequested.has(child) ? 'cancelled' : 'ready')
    const ended = () => (stopRequested.has(child) ? 'cancelled' : 'exited')
    const onExit = () => finish(ended())
    const timer = setTimeout(() => finish(stopRequested.has(child) ? 'cancelled' : 'unconfirmed'), startConfirmMs)
    // Both answers may already be in hand: a fast child can report and even exit before this
    // runs, and neither event will be delivered a second time.
    if (state.readyAt !== undefined) return void finish(stopRequested.has(child) ? 'cancelled' : 'ready')
    if (hasExited(child)) return void finish(ended())
    state.onReady = finishReady
    child.once('exit', onExit)
  })
  // Internal role ownership, shared by first-message startup, sample setup and global exit.
  // Readiness and exit are confirmed by the child. There is no browser role-control route.
  const controlRole = async (role, operation, req, { stopWaitMs = STOP_OBSERVE_MS, forceAfterDrain = false } = {}) => {
    if (operation === 'start') {
      const refused = await permitted({ kind: 'start', role }, req)
      if (refused !== null) return { status: 409, body: { ok: false, state: 'refused', teaching: refused } }
    }
    if (operation === 'stop' && selectedRoles.includes(role)) {
      // Exit/removal supersedes a configuration reload waiting for this child's drain.
      reloads[role] = null
      reloadAgain[role] = false
    }
    let error = !selectedRoles.includes(role)
      ? `${role} is not enabled in mode ${modeOf(selectedRoles)}.`
      : operation === 'stop' ? stop(role)
        : operation === 'start' ? (role === 'agent' ? startAgent() : role === 'worker' ? startWorker() : 'role must be agent or worker.')
          : 'operation must be start or stop.'
    if (error === null && operation === 'stop') {
      const child = components[role].child
      let observed = await observeExit(role, stopWaitMs, child)
      let forced = false
      if (observed === 'stopping' && forceAfterDrain && !hasExited(child)) {
        // Only this host's ChildProcess is eligible, never a pid recovered from a registry.
        forced = child.kill('SIGKILL')
        emit('local', 'role-forced-stop', { role, pid: child.pid, forced,
          note: `The ${role === 'agent' ? 'Agent' : 'Worker'} did not exit within the graceful drain bound; forced termination was ${forced ? 'requested' : 'not sent'}.` })
        observed = await observeExit(role, STOP_OBSERVE_MS, child)
      }
      return { status: 200, body: observed === 'stopped'
        ? { ok: true, state: 'stopped', forced, ...(forced ? { teaching:
          `The ${role === 'agent' ? 'Agent' : 'Worker'} was killed after the graceful drain bound; its exit was observed. Work already handed to Rulith may still be running; check Console.` } : {}) }
        : { ok: true, state: 'stopping', forced, teaching:
            `The ${forced ? 'forced termination' : 'stop'} request was sent to ${role === 'agent' ? 'the Agent' : 'the Worker'}, and its exit has not been observed. It is still listed as running; check Trace and Console.` } }
    }
    if (error === null && operation === 'start') {
      const named = role === 'agent' ? 'Agent' : 'Worker'
      const { outcome, exited } = await confirmStart(role)
      if (outcome === 'exited') {
        error = `${named} exited during startup. Open Trace for the exact diagnostic and fix the missing local configuration before retrying.`
      } else if (outcome === 'cancelled') {
        // Said as a cancellation, not a defect: the operator stopped it, and there is
        // nothing here for them to go and fix. What is *not* claimed is that it has gone —
        // a stop is a request, and a child that handled the signal and stayed is described
        // as what it is, including when it answered that signal by reporting itself ready.
        // "A stop was requested", not "was stopped": the second half of this teaching may go
        // on to say the process has not exited, and an opening clause that had already
        // asserted it stopped would contradict it in the same breath.
        return { status: 409, body: { ok: false, state: 'cancelled', teaching:
          `A stop was requested for the ${named} before this start finished, so this start is not confirmed. Nothing about it failed.`
          + (exited
            ? ' It is not running; retry from the conversation or local tools setting when the workbench is ready.'
            : ' The stop signal was sent and it has not exited yet, so anything it reported'
              + ' after that is not a confirmation of this start. Watch Trace for its exit.') } }
      } else if (outcome === 'unconfirmed') {
        // Neither success nor failure, and said as itself. The process is alive, so calling
        // this a failure would be wrong; it has not reported that it finished initializing,
        // so calling it started would be the fake success this gate exists to prevent.
        return { status: 202, body: { ok: false, state: 'unconfirmed', teaching:
          `${named} was started and is still running, but it has not reported that it finished initializing.`
          + ` Rulith confirms a start by the role's own readiness event — the Agent reports its task endpoint is listening,`
          + ' the Worker reports its Tool Manifest is loaded — so a program configured under paths that does not send one cannot'
          + ' be confirmed here. Open Trace to read what it has printed so far.' } }
      }
    }
    // Only a confirmed start reaches here with `error === null`: a stop answered above with
    // what it observed, and every other start outcome answered with its own state. `ready`
    // is a statement about a role that reported it finished initializing and was not asked
    // to stop while doing so.
    return { status: error === null ? 200 : 400,
      body: error === null ? { ok: true, state: 'ready' } : { ok: false, teaching: error } }
  }
  // Reuse the role owner and its drain protocol; no second process manager or polling loop.
  const ensureWorker = async () => {
    if (closing || setup.busy || mcpServices.busy || !workerEnabled() || running('worker') || reloads.worker || workerRetryTimer
      || workerCredentialRejected || workerFailures > workerRestartDelays.length) return
    if (!workerSetup()) { workerFailure = 'Set up this Agent\'s Worker Connection before using local tools.'; return }
    const refused = await permitted({ kind: 'start', role: 'worker' })
    if (refused !== null) { workerFailure = refused; return }
    if (closing || !workerEnabled() || running('worker')) return
    workerFailure = ''
    const error = startWorker()
    if (error !== null) { workerFailure = error; emit('local', 'error', { role: 'worker', note: error }) }
  }
  const requestReload = (role, note) => {
    if (closing) return null
    if (reloads[role]) {
      if (running(role) && !stopRequested.has(components[role].child)) reloadAgain[role] = true
      return reloads[role]
    }
    const child = components[role].child
    if (!running(role)) {
      if (role === 'worker') { workerFailures = 0; workerFailure = ''; workerCredentialRejected = false; void ensureWorker() }
      return null
    }
    emit('local', 'role-reloading', { role, note: note ?? (role === 'agent'
      ? 'Model settings saved. The Agent restarts automatically after accepted turns finish.'
      : 'Tool settings saved. The Worker reloads automatically after its running executions drain.') })
    const exited = new Promise(done => child.once('exit', done))
    stop(role, { reload: true })
    const reload = exited.then(async () => {
      if (reloads[role] !== reload || closing || !selectedRoles.includes(role) || (role === 'worker' && !workerEnabled())) return
      const refused = await permitted({ kind: 'start', role })
      if (refused !== null) throw new Error(refused)
      if (reloads[role] !== reload || closing || (role === 'worker' && !workerEnabled())) return
      const error = role === 'agent' ? startAgent() : startWorker()
      if (error !== null) throw new Error(error)
      const confirmation = await confirmStart(role)
      if (confirmation.outcome !== 'ready') throw new Error(`${role === 'agent' ? 'Agent' : 'Worker'} reload is ${confirmation.outcome}. Review Trace and setup.`)
      emit('local', 'role-reloaded', { role, note: `${role === 'agent' ? 'Agent' : 'Worker'} reloaded automatically.` })
    }).catch(error => { workerFailure = role === 'worker' ? error.message : workerFailure; emit('local', 'error', { role, note: error.message }) })
      .finally(() => {
        if (reloads[role] !== reload) return
        reloads[role] = null
        if (reloadAgain[role]) { reloadAgain[role] = false; requestReload(role) }
      })
    reloads[role] = reload
    return reload
  }
  const ensureAgent = async (req, sessionKey) => {
    if (!selectedRoles.includes('agent')) throw new Error('This profile uses an existing Agent client.')
    const refused = await permitted({ kind: 'start', role: 'agent' }, req)
    if (refused !== null) throw new Error(refused)
    while (reloads.agent) await reloads.agent
    if (closing) throw new Error(closingRefusal)
    if (!running('agent') || components.agent.readyAt === undefined) {
      if (!agentStarting) {
        emit('local', 'agent-starting', { session: sessionKey, note: 'Starting…' })
        agentStarting = (async () => {
          if (running('agent')) {
            const ready = await confirmStart('agent')
            if (ready.outcome !== 'ready') throw new Error('The Agent has not finished starting. Check Trace and model setup.')
          } else {
            const answer = await controlRole('agent', 'start', req)
            if (!answer.body.ok) throw new Error(answer.body.teaching)
          }
        })().finally(() => { agentStarting = undefined })
      }
      await agentStarting
    }
  }
  const setWorkerEnabled = async (enabled, req) => {
    if (typeof enabled !== 'boolean' || !selectedRoles.includes('worker')) throw new Error('Choose whether this Agent uses this environment\'s tools and files.')
    if (setup.busy || mcpServices.busy) throw new Error('Wait for this Agent\'s configuration to finish before changing its local tools setting.')
    const refusal = await permitted({ kind: 'setup', path: '/worker-setting' }, req)
    if (refusal !== null) throw new Error(refusal)
    const next = { ...config, worker: { ...config.worker, enabled } }
    saveConfig(configFile, next)
    config = next
    workerFailures = 0; workerFailure = ''
    workerCredentialRejected = false
    clearTimeout(workerRetryTimer); workerRetryTimer = undefined; components.worker.retryAt = null
    if (enabled) {
      if (running('worker') && stopRequested.has(components.worker.child)) requestReload('worker')
      else await ensureWorker()
    }
    else if (running('worker')) requestReload('worker')
    return { ...workerView(), teaching: enabled
      ? 'Tools and files are enabled for this Agent. Permissions stay in Console.'
      : 'Local tools are off after running work finishes.' }
  }
  /**
   * The Worker controls the calculation sample step is given, bound to the request that asked.
   *
   * The stop waits for as long as a draining Worker may need: it finishes claimed work and its
   * held Poll first, and the Gateway holds an idle Poll for up to 25 seconds, so the ordinary
   * two-second observation would usually answer "still stopping" and prepare nothing. A start
   * is refused while Worker tools are being changed, as the route refuses it.
   */
  const sampleWorkerControls = (req) => ({
    stopWorker: async () => {
      const answer = await controlRole('worker', 'stop', req, { stopWaitMs: sampleStopWaitMs })
      if (running('worker') && workerEnabled() && !closing) {
        requestReload('worker', 'The enabled Worker resumes with its previous tools after execution drain; the sample has not been prepared.')
        answer.body.resuming = true
      }
      return answer
    },
    startWorker: async () => (mcpServices.busy
      ? { status: 409, body: { ok: false, teaching: 'Worker tools are being changed. The enabled Worker resumes when configuration finishes.' } }
      : controlRole('worker', 'start', req)),
    /** A start already known to be refused, said before a running Worker is stopped for it. */
    startRefusal: async () => (closing ? closingRefusal : mcpServices.busy ? 'Worker tools are being changed.'
      : await permitted({ kind: 'start', role: 'worker' }, req)),
    /** Has this host begun closing? Then nothing more is written for the sample either. */
    closing: () => closing,
    /**
     * The owner refuses to start a Worker whose root lies in its own directory, outside this
     * instance's part of it (`managerExposure`). Asked of the chosen directory before anything is
     * stopped or written, rather than discovered when the Worker will not start on it.
     */
    directoryRefusal: (target) => {
      const inside = (root, path) => { const rel = relative(resolve(root), resolve(path)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) }
      const protectedRoot = protectedPaths.find((root) => inside(root, target))
      return protectedRoot === undefined || inside(configDir, target) ? null
        : `Choose a directory outside ${resolve(protectedRoot)}: that directory holds this installation's credentials, and a Worker may only use this Agent's own folder inside it.`
    },
  })
  /**
   * One gate for every route, including `/`.
   *
   * `/` used to be served ahead of this function and had the per-run key substituted
   * into the page body, so any process on the machine could read the key with a single
   * unauthenticated `curl 127.0.0.1:7790/` — and, because the Host check also lives
   * here, a page reached through a rebound DNS name was served the key too. Loopback is
   * not a user boundary: every other local account, every other application, and any
   * process a browser page can talk to shares it.
   *
   * The key now travels the same way for the page as for the data routes: in the URL
   * the CLI prints. A missing or wrong key is 401 (this request did not authenticate);
   * a bad Origin or Host is 403 (authenticated shape, refused context).
   */
  /**
   * The context half of the gate: which origin asked, and which name it used to get here.
   *
   * Split out from the key check because one route on this host is authenticated by a
   * *different* secret — see `/materials/deliver` — and the browser-rebinding protections must
   * still apply to it. Splitting the function is how that route gets the same protections
   * without also being handed the key that starts and stops execution.
   */
  const contextGate = (req) => {
    const origin = req.headers.origin
    if (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return { status: 403, teaching: `Cross-origin request rejected (Origin: ${origin}).` }
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host ?? ''))) return { status: 403, teaching: 'Non-local Host rejected to prevent DNS rebinding.' }
    return null
  }
  const gate = (req) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const presented = req.headers['x-rulith-local'] ?? url.searchParams.get('k') ?? ''
    if (presented !== key) return { status: 401, teaching: 'Missing or invalid Rulith key. Open the URL printed at startup, which carries ?k=<key>.' }
    return contextGate(req)
  }
  /** A refusal that carries its code, so a caller can act on the case rather than on the prose. */
  const materialFailure = (res, error) => {
    if (error instanceof MaterialError) {
      return void json(res, error.code.startsWith('materials_store_') ? 500 : 400,
        { ok: false, errorCode: error.code, teaching: error.message })
    }
    return void json(res, 400, { ok: false, teaching: String(error?.message ?? error) })
  }
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      /**
       * Authorized local delivery, authenticated by its own secret and nothing else.
       *
       * This route is answered **before** the page gate, deliberately. The Agent is the caller,
       * and handing the Agent this host's page key to reach one read endpoint would also hand it
       * `/worker-setting`, `/setup/*` and every other route the key admits. It gets the materials key
       * instead, which admits exactly this. The rebinding and cross-origin protections are the
       * same ones every other route has — that is what `contextGate` is for — and a browser page
       * holding the page key does not hold this one.
       */
      if (path === '/materials/deliver' && req.method === 'POST') {
        const context = contextGate(req)
        if (context !== null) return void json(res, context.status, { ok: false, teaching: context.teaching })
        if (req.headers['x-rulith-material'] !== materials.key) {
          return void json(res, 401, { ok: false, errorCode: 'material_delivery_unauthorized',
            teaching: 'Local material delivery requires this host\'s materials key, which is issued only to the roles it starts.' })
        }
        res.setHeader('cache-control', 'no-store')
        try {
          return void json(res, 200, { ok: true, ...await materials.deliver(await readJson(req)) })
        } catch (error) { return materialFailure(res, error) }
      }
      const denied = gate(req)
      if (denied !== null) return void json(res, denied.status, { ok: false, teaching: denied.teaching })
      if (path === '/materials' && req.method === 'GET') {
        res.setHeader('cache-control', 'no-store')
        try {
          return void json(res, 200, { ok: true, ...materials.list() })
        } catch (error) { return materialFailure(res, error) }
      }
      if (path === '/materials' && req.method === 'POST') {
        // The same header-and-exact-origin requirement the other data-carrying POSTs have: a
        // loopback origin is not this page, and storing a file is an action on the operator's
        // behalf.
        if (req.headers['x-rulith-local'] !== key || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) {
          return void json(res, 403, { ok: false, teaching: 'Adding a material requires the Local page key and the same origin.' })
        }
        res.setHeader('cache-control', 'no-store')
        try {
          // The body is read first and stored whole before this answers. There is no partial
          // success to report: either the object landed under its own id, or nothing did.
          const added = materials.add(await readMaterialJson(req))
          // This route is how an operator's attachment arrives, so the answer the page polls for
          // ("does this Agent have attachments?") changes here, not a few seconds later.
          return void json(res, 200, { ok: true, ...added })
        } catch (error) { return materialFailure(res, error) }
      }
      if (path === '/setup' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        return void res.end(setupPage)
      }
      if (path === '/setup/state' && req.method === 'GET') return void json(res, 200, { ok: true, ...setup.overview() })
      if (path === '/setup/context' && req.method === 'GET') return void json(res, 200, { ok: true, ...await setup.context() })
      if (path.startsWith('/setup/') && req.method === 'POST') {
        if (req.headers['x-rulith-local'] !== key || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) return void json(res, 403, { ok: false, teaching: 'Setup requires the Local page key and the same origin.' })
        const body = await readJson(req)
        if (mcpServices.busy) return void json(res, 409, { ok: false, teaching: 'Wait for tool configuration to finish.' })
        const operation = { '/setup/pair/start': setup.start, '/setup/pair/poll': setup.poll, '/setup/pair/cancel': setup.cancel,
          '/setup/model': setup.model, '/setup/connection-key': setup.connectionKey,
          // The one setup step that stops and starts a role for the operator; see `example`.
          '/setup/example': (input) => setup.example(input, sampleWorkerControls(req)), '/setup/resources': setup.resources }[path]
        if (!operation) return void json(res, 404, { ok: false, teaching: 'Setup step not found.' })
        const refused = await permitted({ kind: 'setup', path }, req)
        if (refused !== null) return void json(res, 409, { ok: false, teaching: refused })
        res.setHeader('cache-control', 'no-store')
        try {
          const result = await operation(body)
          await ensureWorker()
          return void json(res, 200, { ok: true, ...result })
        } catch (error) {
          // The service's own code travels back to the caller. Cancelling a pairing has to
          // tell "already approved" apart from "could not be confirmed", and a flattened
          // message would make the second look like the first.
          if (error?.errorCode === undefined) throw error
          return void json(res, error.status === 409 ? 409 : 400,
            { ok: false, teaching: String(error.message), errorCode: error.errorCode })
        }
      }
      if (path === '/mcp-services' && req.method === 'GET') {
        // A retired address that still has to arrive somewhere useful. The launcher's return
        // address travels with it: dropping the parameter here is how a redirect quietly
        // becomes the one page in the product with no way back to where the operator came
        // from, which reads as the manager having lost the instance.
        const carried = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('manager')
        res.writeHead(302, { 'cache-control': 'no-store',
          location: '/worker-tools?k=' + encodeURIComponent(key) + (carried === null ? '' : '&manager=' + encodeURIComponent(carried)) })
        return void res.end()
      }
      if (path === '/worker-tools' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        return void res.end(workerToolsPage)
      }
      if (path === '/worker-tools/state' && req.method === 'GET') {
        return void json(res, 200, { ok: true, ...toolOverview() })
      }
      if (path === '/mcp-services/state' && req.method === 'GET') return void json(res, 200, { ok: true, ...mcpServices.overview() })
      if (req.method === 'GET' && ['/mcp-services/search', '/mcp-services/detail', '/mcp-services/downloads'].includes(path)) {
        const params = new URL(req.url, 'http://localhost').searchParams
        const result = path.endsWith('/search') ? await mcpServices.search(params.get('q') ?? '', params.get('cursor') ?? '')
          : path.endsWith('/downloads') ? await mcpServices.downloads(params.get('package'))
          : await mcpServices.detail(params.get('name'), params.get('version') ?? 'latest')
        return void json(res, 200, { ok: true, ...result })
      }
      if ((path.startsWith('/mcp-services/') || path.startsWith('/worker-tools/')) && req.method === 'POST') {
        // Installing executables requires the page's key header and its exact origin, not any loopback origin.
        if (req.headers['x-rulith-local'] !== key || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) {
          return void json(res, 403, { ok: false, teaching: 'Worker tool configuration requires the Local page key and the same origin.' })
        }
        // An Agent on its environment's tools does not edit them from here: they are shared by every
        // Agent, so the workbench is where they change. Its file-tool mode is its own and still saves here.
        if (toolLibrary?.active() === true && path !== '/worker-tools/workspace') {
          return void json(res, 409, { ok: false, teaching: `This Agent uses this environment's tools. Add or change them under "This environment's tools" in the Rulith workbench.` })
        }
        const body = await readJson(req)
        if (mcpServices.busy || setup.busy) return void json(res, 409, { ok: false, teaching: 'Wait for the current tool configuration operation to finish.' })
        const result = path === '/worker-tools/save' ? toolManagement.save(body)
          : path === '/worker-tools/remove' ? toolManagement.remove(body)
          : path === '/worker-tools/workspace' ? toolManagement.workspace(body)
          : path === '/mcp-services/install' ? await mcpServices.install(body.catalogId)
          : path === '/mcp-services/prepare' ? await mcpServices.prepareRegistry(body)
          : path === '/mcp-services/probe' ? await mcpServices.probe(body)
            : path === '/mcp-services/apply' ? await mcpServices.apply(body)
              : path === '/mcp-services/remove' ? await mcpServices.remove(body.name) : undefined
        if (result) {
          if (!['/mcp-services/probe', '/mcp-services/prepare'].includes(path)) requestReload('worker')
          return void json(res, 200, { ok: true, ...result,
            teaching: (result.teaching || 'Tool configuration saved.') + ' The Worker reloads automatically after running executions drain.' })
        }
      }
      if (path === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        // The page carries no embedded secret. It reads the key from its own URL, so a
        // response that escapes the gate would still not hand anyone a working key.
        return void res.end(localPage)
      }
      if ((path === '/conversations' || path === '/conversation') && req.method === 'GET') {
        res.setHeader('cache-control', 'no-store')
        if (!historyFile) return void json(res, 200, { ok: true, available: false, items: [] })
        try {
          if (path === '/conversations') return void json(res, 200, { ok: true, available: true,
            ...await readHistory({ kind: 'list', archived: url.searchParams.get('archived') === 'true', offset: url.searchParams.get('offset') }) })
          const page = await readHistory({ kind: 'page', sessionKey: url.searchParams.get('sessionKey') ?? '', before: url.searchParams.get('before'), stopped: !running('agent') })
          const consoleOrigin = consoleOriginFor(conversationOwner.origin)
          if (!consoleOrigin) throw new Error('The Console origin is unavailable for this conversation.')
          return void json(res, 200, { ok: true, available: true, ...page,
            caseBase: consoleOrigin + '/console/#/cases/' + encodeURIComponent(conversationOwner.agentId) + '/' })
        } catch (error) { return void json(res, 409, { ok: false, teaching: error.message }) }
      }
      if (path === '/conversation/archive' && req.method === 'POST') {
        if (req.headers['x-rulith-local'] !== key || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) return void json(res, 403, { ok: false, teaching: 'Archiving requires this page key and the same origin.' })
        if (!historyFile || historyBusy) return void json(res, 409, { ok: false, teaching: 'Conversation history is unavailable or another archive operation is running.' })
        historyBusy = true
        try {
          const body = await readJson(req)
          if (typeof body.sessionKey !== 'string' || typeof body.archived !== 'boolean') return void json(res, 400, { ok: false, teaching: 'Choose a conversation and archive or restore it.' })
          if (running('agent')) {
            if (components.agent.readyAt === undefined) await confirmStart('agent')
            const response = await fetch(`http://127.0.0.1:${components.agent.servePort}/conversation/archive`, {
              method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-serve': components.agent.serveKey },
              body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
            })
            return void json(res, response.status, await response.json())
          }
          const store = await openConversations(historyDirectory, conversationOwner, { recoverInterrupted: false })
          try { store.archive(body.sessionKey, body.archived, { stopped: true }) } finally { store.close() }
          return void json(res, 200, { ok: true, archived: body.archived })
        } catch (error) { return void json(res, 409, { ok: false, teaching: error.message }) }
        finally { historyBusy = false }
      }
      if (path === '/events' && req.method === 'GET') {
        let disconnected = false
        req.on('close', () => { disconnected = true; clients.delete(res) })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        let saved = []
        if (historyFile && url.searchParams.get('history') !== 'paged') {
          try { saved = await readHistory({ kind: 'recent', stopped: !running('agent') }) }
          catch (error) { saved = [{ src: 'local', type: 'error', note: error.message }] }
        }
        const known = new Set(saved.map(e => e.historyKey).filter(Boolean))
        const replay = [...saved, ...events.filter(e => !e.historyKey || !known.has(e.historyKey))]
          .sort((a, b) => (a.t ?? a.at ?? 0) - (b.t ?? b.at ?? 0))
        if (disconnected) return
        for (const event of replay) res.write(`data: ${JSON.stringify(event)}\n\n`)
        res.write(`data: ${JSON.stringify({ src: 'local', type: 'runtime-operations', operations: operationsSnapshot })}\n\n`)
        clients.add(res); return
      }
      if (path === '/status' && req.method === 'GET') {
        if (running('agent') && components.agent.readyAt !== undefined && components.agent.child.connected
          && !stopRequested.has(components.agent.child)) {
          components.agent.child.send({ protocol: 'rulith-local-control', operation: 'observe' }, () => {})
        }
        const agentEnv = agentEnvironment()
        const workerEnv = components.worker.roleEnv ?? effectiveChildEnv(baseEnv(), config.worker?.env ?? {})
        const consoleOrigin = conversationOwner?.origin ? consoleOriginFor(conversationOwner.origin) : ''
        return void json(res, 200, {
          ok: true, mode: modeOf(selectedRoles), roles: selectedRoles,
          agent: running('agent'), worker: running('worker'),
          ready: Object.fromEntries(['agent', 'worker'].map(role => [role,
            running(role) && components[role].readyAt !== undefined && !stopRequested.has(components[role].child)])),
          workerSetting: workerView(), agentReloading: !!reloads.agent,
          runtime: {
            configFile,
            ...(consoleOrigin && conversationOwner?.accountId
              && conversationOwner.agentId === components.agent.agentId
              ? { console: { origin: consoleOrigin,
                accountId: conversationOwner.accountId, agentId: conversationOwner.agentId } } : {}),
            // No launcher address here, deliberately. The way back to a manager is a link the
            // operator navigates, built by the page from its own address; putting the
            // manager's browser key in a machine-readable status body would make every holder
            // of this instance's key a holder of the manager's, which is a different and much
            // larger thing.
            agent: {
              id: components.agent.agentId, credentialConfigured: String(agentEnv.RULITH_TOKEN ?? '') !== '',
              modelService: safeUrl(agentEnv.RULITH_MODEL_URL ?? DEFAULT_MODEL_URL), model: String(agentEnv.RULITH_MODEL ?? ''),
              modelKeyConfigured: String(agentEnv.RULITH_MODEL_KEY ?? baseEnv().ANTHROPIC_API_KEY ?? '') !== '',
              thinking: agentEnv.RULITH_MODEL_THINKING === 'disabled' ? 'disabled' : agentEnv.RULITH_MODEL_THINKING === 'enabled' ? 'extended' : 'standard',
              maxOutputTokens: agentEnv.RULITH_MODEL_MAX_OUTPUT_TOKENS === undefined || agentEnv.RULITH_MODEL_MAX_OUTPUT_TOKENS === ''
                ? 6000 : Number(agentEnv.RULITH_MODEL_MAX_OUTPUT_TOKENS),
            },
            worker: {
              connection: String(workerEnv.RULITH_CONNECTION ?? ''), credentialConfigured: String(workerEnv.RULITH_CONNECTION_KEY ?? '') !== '',
              workspaceTools: String(workerEnv.RULITH_WORKSPACE_TOOLS ?? 'read'),
              toolsFile: String(workerEnv.RULITH_TOOLS_FILE ?? ''), sourcesFile: String(workerEnv.RULITH_SECRETS_FILE ?? ''),
            },
          },
        })
      }
      if (path === '/worker-setting' && req.method === 'POST') {
        if (req.headers['x-rulith-local'] !== key || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) return void json(res, 403, { ok: false, teaching: 'Changing this setting requires the Local page key and the same origin.' })
        const body = await readJson(req)
        if (Object.keys(body).some(field => field !== 'enabled')) throw new Error('Unexpected Worker setting fields.')
        return void json(res, 200, { ok: true, ...await setWorkerEnabled(body.enabled, req) })
      }
      if (path === '/turn/stop' && req.method === 'POST') {
        if (req.headers['x-rulith-local'] !== key || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) return void json(res, 403, { ok: false, teaching: 'Stopping a turn requires the Local page key and the same origin.' })
        const body = await readJson(req)
        if (!running('agent')) return void json(res, 200, { ok: true, state: 'idle' })
        const response = await fetch(`http://127.0.0.1:${components.agent.servePort}/turn/stop`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-serve': components.agent.serveKey },
          body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
        return void json(res, response.status, await response.json())
      }
      if (path === '/cases' && req.method === 'POST') {
        const body = await readJson(req)
        if (body.requestId !== undefined && (typeof body.requestId !== 'string'
          || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId))) {
          return void json(res, 400, { ok: false, teaching: 'requestId must be a short opaque identifier (16–100 letters, digits, _ or -).' })
        }
        if (Array.isArray(body.attachments) && body.attachments.length > 0 && body.requestId === undefined) {
          return void json(res, 400, { ok: false, errorCode: 'material_submission_invalid',
            teaching: 'Submitting an attachment needs the request id for this click.' })
        }
        if (body.caseId !== undefined && (typeof body.caseId !== 'string'
          || body.caseId.length > 256 || !/^[A-Za-z0-9:_-]+$/.test(body.caseId))) {
          return void json(res, 400, { ok: false, errorCode: 'material_case_invalid',
            teaching: 'An existing Case selection must be one exact Case id.' })
        }
        const sessionKey = String(body.sessionKey ?? '').trim() || (body.requestId
          ? 'ctx-' + createHash('sha256').update(String(body.requestId)).digest('hex').slice(0, 32)
          : `ctx-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`)
        const text = String(body.text ?? '')
        if (text.trim() === '' && (body.attachments === undefined || (Array.isArray(body.attachments) && body.attachments.length === 0))) {
          return void json(res, 400, { ok: false, teaching: 'A case submission needs a message, an attachment, or both.' })
        }
        // A durable proof must name the identity reported by a successfully started process.
        await ensureAgent(req, sessionKey)
        // Membership, ownership and disclosure are settled here, before anything is forwarded.
        // A submission naming one material this profile does not own fails whole: honouring the
        // rest would hand the Agent a list that does not say which of the operator's selections
        // were silently dropped.
        let selected
        try {
          selected = materials.attachments(body.attachments, {
            sessionKey, requestId: body.requestId, targetCaseId: body.caseId ?? '' })
        } catch (error) { return materialFailure(res, error) }
        let taskProof
        let selectionSecret
        if (selected.receipt) {
          try {
            if (!registerMaterialSubmission) throw new Error('Registration is unavailable')
            taskProof = selected.receipt.proofSecret
            if (!/^[0-9a-f]{64}$/.test(taskProof ?? '')) throw new Error('Durable task proof is unavailable')
            const proofDigest = 'sha256:' + createHash('sha256').update(Buffer.from(taskProof, 'hex')).digest('hex')
            selectionSecret = selected.receipt.selectionSecret
            if (selectionSecret !== undefined && (!/^[0-9a-f]{64}$/.test(selectionSecret)
              || selectionSecret === taskProof)) throw new Error('Durable selection secret is invalid')
            const selectionDigest = selectionSecret === undefined ? undefined
              : 'sha256:' + createHash('sha256').update(Buffer.from(selectionSecret, 'hex')).digest('hex')
            const { proofSecret: _privateProof, selectionSecret: _privateSelection,
              targetCaseId, ...registration } = selected.receipt
            const confirmed = await registerMaterialSubmission({ ...registration,
              ...(targetCaseId ? { targetCaseId } : {}), proofDigest, selectionDigest })
            if (confirmed?.state !== 'registered' || confirmed.agentId !== registration.agent
              || confirmed.submissionId !== registration.submissionId
              || confirmed.requestId !== registration.requestId
              || confirmed.sessionKey !== registration.sessionKey
              || confirmed.targetCaseId !== (targetCaseId || undefined)
              || confirmed.proofDigest !== proofDigest
              || (selectionDigest === undefined ? confirmed.selectionDigest !== undefined
                : confirmed.selectionDigest !== selectionDigest)
              || !Array.isArray(confirmed.attachments)
              || confirmed.attachments.length !== registration.attachments.length
              || confirmed.attachments.some((row, index) => row === null || typeof row !== 'object'
                || Array.isArray(row) || row.selector !== registration.attachments[index]?.selector
                || row.digest !== registration.attachments[index]?.digest
                || row.totalBytes !== registration.attachments[index]?.totalBytes
                || Object.keys(row).length !== 3)
              || typeof confirmed.registeredAt !== 'string' || !Number.isFinite(Date.parse(confirmed.registeredAt))) {
              throw new Error('The account service did not confirm this exact material task proof')
            }
          } catch {
            return void json(res, 503, { ok: false, errorCode: 'material_registration_unconfirmed',
              teaching: 'The material submission was kept locally but its task proof was not confirmed by the account service. Retry this exact request before starting the Agent task.' })
          }
        }
        // A person may attach files and write nothing. The host then says what was attached and
        // tells the model to go and find an authorized Action that reads it — it does not read
        // the files, and it puts no part of their content into the message.
        const taskBody = JSON.stringify({
          text: text.trim() === '' ? attachmentInstruction(selected.attachments) : text,
          sessionKey,
          ...(body.requestId === undefined ? {} : { requestId: body.requestId }),
          ...(selected.attachments.length === 0 ? {} : { attachments: selected.attachments }),
          ...(body.caseId === undefined ? {} : { caseId: body.caseId }),
          ...(body.historyModelDestination === undefined ? {} : { historyModelDestination: body.historyModelDestination }),
          ...(body.caseType === undefined ? {} : { caseType: body.caseType }),
          ...(body.businessKey === undefined ? {} : { businessKey: body.businessKey }) })
        const sendTask = () => fetch(`http://127.0.0.1:${components.agent.servePort}/task`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-serve': components.agent.serveKey,
            ...(taskProof ? { 'x-rulith-material-task-proof': taskProof } : {}),
            ...(selectionSecret ? { 'x-rulith-material-selection-key': selectionSecret } : {}) },
          body: taskBody,
        }).catch(() => undefined)
        // Registration or another page can begin a reload after the first readiness check.
        await ensureAgent(req, sessionKey)
        if (selected.receipt && selected.receipt.agent !== components.agent.agentId) {
          return void json(res, 409, { ok: false, errorCode: 'material_owner_changed',
            teaching: 'The Agent identity changed during submission. Nothing was sent to its task endpoint; reopen the material selection.' })
        }
        const taskChild = components.agent.child
        let response = await sendTask()
        if (response?.status === 503 && (reloads.agent || taskChild !== components.agent.child)) {
          await response.body?.cancel()
          await ensureAgent(req, sessionKey)
          if (selected.receipt && selected.receipt.agent !== components.agent.agentId) {
            return void json(res, 409, { ok: false, errorCode: 'material_owner_changed', teaching: 'The Agent identity changed while reloading. Nothing was resubmitted.' })
          }
          response = await sendTask()
        }
        if (response === undefined) return void json(res, 502, { ok: false, teaching: 'The Agent task endpoint did not respond.' })
        const answer = await response.json().catch(() => ({ ok: response.ok }))
        return void json(res, response.status, selected.receipt
          ? { ...answer, submissionReceipt: {
            submissionId: selected.receipt.submissionId, requestId: selected.receipt.requestId,
            agent: selected.receipt.agent, attachments: selected.receipt.attachments,
            ...(selected.receipt.targetCaseId ? { targetCaseId: selected.receipt.targetCaseId } : {}),
          } } : answer)
      }
      json(res, 404, { ok: false, teaching: 'Endpoint not found.' })
    } catch (error) { json(res, 400, { ok: false, teaching: String(error?.message ?? error) }) }
  })
  return {
    key, get port() { return server.address()?.port ?? port }, get mode() { return modeOf(selectedRoles) }, roles: selectedRoles,
    configFile: resolve(configFile),
    /**
     * The secret that opens local material delivery, and only that.
     *
     * It is deliberately a different value from `key`: the roles this host starts are given
     * this one, and giving them the page key would also give them `/worker-setting` and `/setup/*`.
     * It is never served over HTTP and never reaches a model.
     */
    materialsKey: materials.key,
    get materialRoot() { return materials.root },
    /** Manager-only recovery check. Never exposed on the page or forwarded to the Agent. */
    acceptedMaterialBinding: async receipt => {
      if (!acceptedMaterialBinding) throw new Error('Case binding lookup is unavailable')
      return acceptedMaterialBinding(receipt)
    },
    // The Agent identity this host's child reported for itself. A manager shows it beside
    // the instance, and a value it read from its own registry instead would be a second
    // claim about which Agent a running process is — exactly the claim that must come from
    // the process.
    get agentId() { return components.agent.agentId },
    /** Manager-only in-memory model replacement for an inherited account default.
     * It intentionally does not write local.json: an inherited key must not become a
     * per-instance credential just because this host happened to be open. */
    setAgentModel: ({ url = '', name = '', key: modelKey = '', thinking = 'standard', maxOutputTokens = 6000 } = {}) => {
      const replacement = {
        RULITH_MODEL_URL: String(url), RULITH_MODEL: String(name), RULITH_MODEL_KEY: String(modelKey),
        RULITH_MODEL_THINKING: ['enabled', 'disabled'].includes(thinking) ? thinking : '',
        RULITH_MODEL_MAX_OUTPUT_TOKENS: String(maxOutputTokens) }
      if (JSON.stringify(activeModelOverlay) === JSON.stringify(replacement)) return
      activeModelOverlay = replacement
      requestReload('agent')
      requestReload('worker')
    },
    /**
     * The operating-system processes this host currently owns.
     *
     * A supervisor that records only its own pid cannot tell, after it dies and restarts,
     * whether the roles it launched went with it — and they do not: a child outlives its
     * parent. Recording the children by pid is what lets the next manager ask the kernel
     * instead of assuming, and their stamps are what let it ask about these processes rather
     * than about whichever process holds the pid by then.
     */
    children: ownChildren,
    // Trusted in-process owner operations. Browser clients use /cases and /worker-setting.
    startRole: (role, req) => controlRole(role, 'start', req),
    stopRole: (role, options) => controlRole(role, 'stop', undefined, options),
    status: () => ({ mode: modeOf(selectedRoles), roles: selectedRoles, agent: running('agent'), worker: running('worker'), workerSetting: workerView(), agentReloading: !!reloads.agent,
      ready: Object.fromEntries(['agent', 'worker'].map(role => [role,
          running(role) && components[role].readyAt !== undefined && !stopRequested.has(components[role].child)])) }),
    reloadWorker: () => requestReload('worker'),
    toolsDigest: () => (toolLibrary?.active() === true ? libraryDigest() : undefined),
    resumeWorker: () => ensureWorker().catch(error => { workerFailure = error.message; emit('local', 'error', { role: 'worker', note: workerFailure }) }),
    events: () => events.map((event) => ({ ...event })),
    listen: () => new Promise((accept, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        if (autoStart) void ensureWorker()
        emit('local', 'start', { mode: modeOf(selectedRoles), roles: selectedRoles })
        accept()
      })
    }),
    close: async () => {
      closing = true
      clearTimeout(workerRetryTimer)
      await mcpServices.close()
      const exits = []
      for (const role of ['agent', 'worker']) if (running(role)) {
        const child = components[role].child
        exits.push(new Promise((accept) => {
          const timer = setTimeout(accept, 1000)
          child.once('exit', () => { clearTimeout(timer); accept() })
        }))
        stop(role)
      }
      await Promise.all(exits)
      for (const client of clients) client.end()
      clients.clear()
      await historyReader?.close()
      await new Promise((accept) => server.close(accept))
    },
  }
}

export const CLI_HELP = `Rulith

Usage:
  rulith                      Open the manager: accounts and independent Agent instances
  rulith setup                Same manager page, for a first installation
  rulith start                Same manager page

Environment:
  RULITH_MANAGER_HOME   Manager directory (default ~/.rulith/manager)
  RULITH_MANAGER_PORT   Manager loopback UI port (default 7780)
  RULITH_MANAGER_KEY    Fixed manager browser key: 16-128 of A-Z a-z 0-9 - _
                        (default: 32 random hex characters, new on every run)`

/** Parse without touching state. All supported commands open the same workbench. */
export function parseLocalCli(argv, env = {}) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  const input = [...argv]
  const command = ['setup', 'start', 'manager'].includes(input[0]) ? input.shift() : 'start'
  if (input.length > 0) throw new Error('Unknown Rulith option: ' + input[0])
  if (String(env.RULITH_LOCAL_CONFIG ?? '').trim() !== '') {
    throw new Error('RULITH_LOCAL_CONFIG is no longer supported. Unset it and run rulith to open the workbench.')
  }
  return { command }
}

if (IS_MAIN) {
  let cli
  try { cli = parseLocalCli(process.argv.slice(2), process.env) } catch (error) { console.error(error.message); process.exit(1) }
  if (cli.help) { console.log(CLI_HELP); process.exit(0) }
  /**
   * Started after this module finishes evaluating, deliberately.
   *
   * The manager builds its instance hosts out of `createLocalHost`, so its module graph
   * depends on this one. Importing it from a *top-level* await here would suspend this
   * module's evaluation while the manager's graph waited for this module to finish — a
   * cycle that never settles and exits with nothing printed. Loading it from a callback
   * lets this module complete first, which is all the cycle needs.
   */
  void import('./manager-server.mjs').then(async ({ createManagerServer }) => {
    const { defaultManagerRoot } = await import('./manager-registry.mjs')
    const root = (process.env.RULITH_MANAGER_HOME ?? '').trim() || defaultManagerRoot()
    const manager = createManagerServer({
      root,
      port: localInteger('RULITH_MANAGER_PORT', process.env.RULITH_MANAGER_PORT, 7780),
      key: (process.env.RULITH_MANAGER_KEY ?? '').trim() || randomUUID().replace(/-/g, ''),
    })
    await manager.listen()
    console.log('Rulith')
    console.log(`Workbench: http://127.0.0.1:${manager.port}/?k=${manager.key}`)
    console.log(`Instances: ${resolve(root)} · credentials are stored here; execution credentials are sent to their own configured Gateway.`)
    process.on('SIGINT', async () => { await manager.close(); process.exit(0) })
  }).catch((error) => {
    console.error(String(error?.message ?? error))
    process.exit(1)
  })
}

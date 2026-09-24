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
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { localPage, projectRecovery } from './local-ui.mjs'
import { createMcpServices } from './mcp-services.mjs'
import { workerToolsPage } from './worker-tools-ui.mjs'
import { createWorkerToolManagement } from './worker-tool-management.mjs'
import { createSetupService } from './setup-service.mjs'
import { setupPage } from './setup-ui.mjs'
import { attachmentInstruction, createMaterialService } from './material-service.mjs'
import {
  MAX_MATERIAL_REQUEST_BYTES, MaterialError, defaultMaterialRoot, materialIdentity,
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

export function rolesFromArgs(args, fallback) {
  const input = [...args]
  if (input[0] === 'start' || input[0] === 'setup') input.shift()
  if (input.includes('--help') || input.includes('-h')) return null
  let chosen
  for (let i = 0; i < input.length; i++) {
    if ((input[i] === '--role' || input[i] === '--roles') && input[i + 1] !== undefined) { chosen = input[++i]; continue }
    throw new Error(`Unknown Rulith option: ${input[i]}`)
  }
  return rolesOf(chosen ?? fallback)
}

export function defaultLocalConfig() {
  return {
    roles: ['agent', 'worker'],
    agent: { args: [], env: {
      RULITH_URL: 'https://api.rulith.ai', RULITH_TOKEN: '',
      RULITH_MODEL_URL: 'https://api.anthropic.com/v1/messages', RULITH_MODEL: 'claude-sonnet-5', RULITH_MODEL_KEY: '',
    } },
    worker: { env: { RULITH_WORK_URL: 'https://api.rulith.ai/work', RULITH_CONNECTION: '', RULITH_CONNECTION_KEY: '' } },
    paths: {},
  }
}

export function defaultConfigPath(home = homedir()) { return join(home, '.rulith', 'local.json') }

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

function loadConfig(configFile) {
  if (!existsSync(configFile)) {
    const config = defaultLocalConfig()
    mkdirSync(dirname(resolve(configFile)), { recursive: true, mode: 0o700 })
    writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 })
    console.log(`Created ${configFile}. Add credentials for the selected roles, then restart Rulith.`)
    return config
  }
  const raw = JSON.parse(readFileSync(configFile, 'utf8'))
  const config = normalizeLocalConfig(raw)
  if (raw.cloud !== undefined || raw.agent?.env?.RULITH_AGENT !== undefined) {
    saveConfig(configFile, config)
    console.warn('Removed retired Cloud-session or Agent-selector fields. The configured MCP token is now the only Agent identity source.')
  }
  return config
}

function saveConfig(configFile, config) {
  mkdirSync(dirname(resolve(configFile)), { recursive: true, mode: 0o700 })
  const temporary = configFile + '.' + randomUUID() + '.tmp'
  try { writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' }); renameSync(temporary, configFile) }
  finally { rmSync(temporary, { force: true }) }
}

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

export function createLocalHost({
  configFile, config, roles, port = 7790, key = randomUUID().replace(/-/g, ''),
  startConfirmMs = START_CONFIRM_MS, autoStart = true,
  isolateEnvironment = false, setupApprover, managedPolicy, managedCallToken, protectedPaths = [], onChildChange,
  materialRoot, onModelConfigured, modelOverlay, authorizeConnectionKey, conversationOwner,
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
   * key, and `POST /control` and `POST /setup/*` are exactly the two routes that could
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
   * A supervisor that only learns about children through its own start and stop calls has a
   * blind spot the size of this host's `/control` route: that route is reachable from the
   * instance's own page, which is a perfectly ordinary thing for an operator to use. A child
   * started that way existed only in this process's memory, so the record another manager
   * reads after a crash said there were none. This fires on spawn and on exit, whoever asked.
   */
  const announceChildren = () => {
    if (onChildChange === undefined) return
    try {
      const result = onChildChange(['agent', 'worker']
        .filter((role) => running(role))
        .map((role) => ({ role, pid: components[role].child.pid })))
      if (result !== undefined && typeof result.catch === 'function') result.catch(() => undefined)
    } catch { /* an owner that cannot record this must not take the host down with it */ }
  }
  const events = []
  // A bounded log is not the latest recovery observation. Keep this small
  // projection separately so a reconnect cannot turn an evicted warning into idle.
  let recoverySnapshot = projectRecovery([])
  const clients = new Set()
  let nextSequence = 1
  const components = {
    agent: { child: null, serveKey: '', servePort: 7799, agentId: 'unconfigured' },
    worker: { child: null },
  }
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
    return {
      RULITH_MATERIALS_ROOT: area,
      RULITH_MATERIALS_PROFILE: binding.profile,
      RULITH_MATERIALS_OWNER: binding.owner,
      RULITH_MATERIALS_AGENT_FINGERPRINT: binding.agentFingerprint,
      RULITH_MATERIALS_MODEL_DESTINATION: binding.modelDestination,
    }
  }
  const workerContext = () => ({ environment: { ...effectiveChildEnv(baseEnv(), config.worker?.env ?? {}), ...materialChildEnv() },
    directory: dirname(config.paths?.worker ? resolve(configDir, config.paths.worker) : resolve(HERE, '../worker/rulith-worker.mjs')) })
  const mcpServices = createMcpServices(configFile, { workerContext, protectedPaths })
  const toolManagement = createWorkerToolManagement({ mcpServices, workerContext, setWorkspaceMode: mode => {
    // 只更新既有部署字段，保留文件中的其他配置；不在此编辑 Agent/模型凭据。
    const next = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : structuredClone(config)
    next.worker = { ...next.worker, env: { ...next.worker?.env, RULITH_WORKSPACE_TOOLS: mode } }
    saveConfig(configFile, next)
    config.worker = { ...config.worker, env: { ...config.worker?.env, RULITH_WORKSPACE_TOOLS: mode } }
  } })
  const running = (role) => components[role].child !== null && components[role].child.exitCode === null
  const setup = createSetupService({ configFile, getConfig: () => config,
    effectiveEnv: () => effectiveChildEnv(baseEnv(), config.worker?.env ?? {}),
    agentCredentialConfigured: () => !!agentEnvironment().RULITH_TOKEN,
    stopped: () => !running('agent') && !running('worker'), agentStopped: () => !running('agent'), workerStopped: () => !running('worker'), mcpServices, toolManagement,
    approvePairing: setupApprover,
    onModelConfigured: async () => { activeModelOverlay = undefined; return await onModelConfigured?.() },
    // A stopped Worker leaves its last launch environment for diagnostics. It must not remain
    // the source of truth after a key rotation, or status could describe a credential that the
    // next Worker will no longer receive.
    onConnectionKeyConfigured: () => { components.worker.roleEnv = undefined },
    authorizeConnectionKey,
    saveConfig: next => {
      const normalized = normalizeLocalConfig(next)
      saveConfig(configFile, normalized)
      config = normalized
      selectedRoles.splice(0, selectedRoles.length, ...rolesOf(config.roles))
    },
  })
  const emit = (src, type, data = {}) => {
    const event = { sequence: nextSequence++, t: Date.now(), src, type, ...data }
    if (!event.historical) recoverySnapshot = projectRecovery([event], recoverySnapshot)
    events.push(event)
    if (events.length > 2000) events.splice(0, events.length - 1500)
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const client of clients) { try { client.write(frame) } catch { clients.delete(client) } }
  }
  /**
   * The children an operator asked to stop, by process identity.
   *
   * A stopped child exits, and an exit is otherwise a startup failure. Without this the two
   * are indistinguishable and the operator who pressed Stop while a start was still being
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
  const startAgent = () => {
    if (historyBusy) return 'Wait for the conversation archive operation to finish, then start the Agent.'
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
    const child = spawn(process.execPath, [path, ...args], {
      env: { ...roleEnv,
        // Only the manager can select the history owner; profile/environment values cannot override it.
        RULITH_CONVERSATION_DIR: historyFile ? historyDirectory : '',
        RULITH_CONVERSATION_OWNER: historyFile ? JSON.stringify(conversationOwner) : '',
        RULITH_LOCAL_EVENTS: 'ipc', RULITH_SERVE_KEY: serveKey, RULITH_SERVE_PORT: String(servePort),
        // The Agent is given the delivery endpoint and the one key that opens it — never this
        // host's page key, which would also open `/control` and `/setup/*`.
        RULITH_MATERIALS_CONNECTION: materialConnection,
        ...(materialConnection !== '' ? {
          RULITH_MATERIALS_DELIVER_URL: `http://127.0.0.1:${server.address()?.port ?? port}/materials/deliver`,
          RULITH_MATERIALS_KEY: materials.key,
        } : {}) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    components.agent = { ...components.agent, child, serveKey, servePort, agentId: 'unconfigured', readyAt: undefined, onReady: undefined }
    wireChild('agent', child)
    child.on('exit', (code) => {
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
    if (running('worker')) return 'Worker is already running.'
    const path = config.paths?.worker ? resolve(configDir, config.paths.worker) : resolve(HERE, '../worker/rulith-worker.mjs')
    if (!existsSync(path)) return `Worker runtime not found at ${path}. Set paths.worker in the Rulith configuration.`
    let roleEnv
    try { roleEnv = mcpServices.workerEnvironment(effectiveChildEnv(baseEnv(), config.worker?.env ?? {}), dirname(path)) }
    catch (error) { return error.message }
    // The Worker is told where the material area is and whose it is, and is given neither the
    // Agent credential nor anything it could reconstruct one from: the two bindings travel as
    // sha256 fingerprints, which it compares and never inverts. The same values the Worker
    // Tools page composed its list from — one function, so the two cannot disagree.
    const materialEnv = materialChildEnv()
    const child = spawn(process.execPath, [path], {
      env: { ...roleEnv, RULITH_LOCAL_CONFIG: resolve(configFile), RULITH_LOCAL_EVENTS: 'ipc', ...materialEnv },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], cwd: dirname(path),
    })
    components.worker = { ...components.worker, child, roleEnv, materialDestination: materialEnv.RULITH_MATERIALS_MODEL_DESTINATION,
      readyAt: undefined, onReady: undefined, managedStop: false }
    wireChild('worker', child)
    child.on('exit', (code) => { emit('worker', 'exit', { code }); components.worker.child = null; announceChildren() })
    emit('worker', 'spawn', { pid: child.pid })
    announceChildren()
    return null
  }
  const stop = (role) => {
    const child = components[role]?.child
    if (child === null || child === undefined) return `${role} is not running.`
    stopRequested.add(child)
    // Windows 的 kill 会直接结束 Worker，来不及关闭它启动的 stdio MCP 子进程。
    // 只给明确广告了托管停止能力的当前子进程发 IPC；仍以 exit 事件确认停止。
    if (components[role].managedStop && child.connected) {
      child.send({ protocol: 'rulith-local-control', operation: 'stop' }, error => { if (error) child.kill() })
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
   * answered `stopping`, truthfully. **Nothing is escalated**: no second signal, no SIGKILL, no
   * supervisor. Whether a process that refuses to leave should be forced is a decision this
   * host does not make, and reporting it accurately is what lets somebody else make it.
   */
  const observeExit = (role) => new Promise((settle) => {
    const child = components[role]?.child
    if (hasExited(child)) return void settle('stopped')
    const finish = (outcome) => { clearTimeout(timer); child.off('exit', onExit); settle(outcome) }
    const onExit = () => finish('stopped')
    const timer = setTimeout(() => finish(hasExited(child) ? 'stopped' : 'stopping'), STOP_OBSERVE_MS)
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
       * `/control`, `/setup/*` and every other route the key admits. It gets the materials key
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
          return void json(res, 200, { ok: true, ...materials.add(await readMaterialJson(req)) })
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
          '/setup/example': setup.example, '/setup/resources': setup.resources }[path]
        if (!operation) return void json(res, 404, { ok: false, teaching: 'Setup step not found.' })
        const refused = await permitted({ kind: 'setup', path }, req)
        if (refused !== null) return void json(res, 409, { ok: false, teaching: refused })
        res.setHeader('cache-control', 'no-store')
        try {
          return void json(res, 200, { ok: true, ...await operation(body) })
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
      if (path === '/worker-tools/state' && req.method === 'GET') return void json(res, 200, { ok: true, ...toolManagement.overview() })
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
        if (running('agent') || running('worker')) return void json(res, 409, { ok: false, teaching: 'Stop Agent and Worker in Runtime controls before changing Worker tools.' })
        const body = await readJson(req)
        if (running('agent') || running('worker')) return void json(res, 409, { ok: false, teaching: 'Runtime started while reading the request. Stop it before configuring Worker tools.' })
        if (mcpServices.busy || setup.busy) return void json(res, 409, { ok: false, teaching: 'Wait for the current tool configuration operation to finish.' })
        const result = path === '/worker-tools/save' ? toolManagement.save(body)
          : path === '/worker-tools/remove' ? toolManagement.remove(body)
          : path === '/worker-tools/workspace' ? toolManagement.workspace(body)
          : path === '/mcp-services/install' ? await mcpServices.install(body.catalogId)
          : path === '/mcp-services/prepare' ? await mcpServices.prepareRegistry(body)
          : path === '/mcp-services/probe' ? await mcpServices.probe(body)
            : path === '/mcp-services/apply' ? await mcpServices.apply(body)
              : path === '/mcp-services/remove' ? await mcpServices.remove(body.name) : undefined
        if (result) return void json(res, 200, { ok: true, ...result })
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
          const origin = new URL(conversationOwner.origin)
          if (origin.hostname === 'api.rulith.ai') origin.hostname = 'console.rulith.ai'
          return void json(res, 200, { ok: true, available: true, ...page,
            caseBase: origin.origin + '/console/#/cases/' + encodeURIComponent(conversationOwner.agentId) + '/' })
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
            if (components.agent.readyAt === undefined) return void json(res, 409, { ok: false, teaching: 'The Agent is still starting. Archive this conversation when it is ready, or stop it first.' })
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
        res.write(`data: ${JSON.stringify({ src: 'local', type: 'runtime-recovery', recovery: recoverySnapshot })}\n\n`)
        clients.add(res); return
      }
      if (path === '/status' && req.method === 'GET') {
        const agentEnv = agentEnvironment()
        const workerEnv = components.worker.roleEnv ?? effectiveChildEnv(baseEnv(), config.worker?.env ?? {})
        return void json(res, 200, {
          ok: true, mode: modeOf(selectedRoles), roles: selectedRoles,
          agent: running('agent'), worker: running('worker'),
          ready: Object.fromEntries(['agent', 'worker'].map(role => [role,
            running(role) && components[role].readyAt !== undefined && !stopRequested.has(components[role].child)])),
          runtime: {
            configFile,
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
            },
            worker: {
              connection: String(workerEnv.RULITH_CONNECTION ?? ''), credentialConfigured: String(workerEnv.RULITH_CONNECTION_KEY ?? '') !== '',
              workspaceTools: String(workerEnv.RULITH_WORKSPACE_TOOLS ?? 'read'),
              toolsFile: String(workerEnv.RULITH_TOOLS_FILE ?? ''), sourcesFile: String(workerEnv.RULITH_SECRETS_FILE ?? ''),
            },
          },
        })
      }
      if (path === '/control' && req.method === 'POST') {
        const body = await readJson(req)
        const role = String(body.role ?? '')
        if (body.operation === 'start' && (mcpServices.busy || setup.busy)) return void json(res, 409, { ok: false, teaching: 'Wait for configuration to finish before starting Runtime.' })
        if (body.operation === 'start') {
          const refused = await permitted({ kind: 'start', role }, req)
          if (refused !== null) return void json(res, 409, { ok: false, state: 'refused', teaching: refused })
        }
        let error = !selectedRoles.includes(role)
          ? `${role} is not enabled in mode ${modeOf(selectedRoles)}.`
          : body.operation === 'stop' ? stop(role)
            : body.operation === 'start' ? (role === 'agent' ? startAgent() : role === 'worker' ? startWorker() : 'role must be agent or worker.')
              : 'operation must be start or stop.'
        if (error === null && body.operation === 'stop') {
          // The signal has been sent; whether it was obeyed is the process's answer, not this
          // host's. `stopped` says an exit was observed. `stopping` says it was not — no second
          // signal follows, and the role is still listed as running until it really goes.
          const observed = await observeExit(role)
          return void json(res, 200, observed === 'stopped'
            ? { ok: true, state: 'stopped' }
            : { ok: true, state: 'stopping', teaching:
                `The stop signal was sent to ${role === 'agent' ? 'the Agent' : 'the Worker'}, and it has not exited yet.`
                + ' Rulith does not force a process to end; it is still listed as running,'
                + ' and its exit will appear in Trace if it does end.' })
        }
        if (error === null && body.operation === 'start') {
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
            return void json(res, 409, { ok: false, state: 'cancelled', teaching:
              `A stop was requested for the ${named} before this start finished, so this start is not confirmed. Nothing about it failed.`
              + (exited
                ? ' It is not running; start it again when you want it running.'
                : ' The stop signal was sent and it has not exited yet, so anything it reported'
                  + ' after that is not a confirmation of this start. Watch Trace for its exit.') })
          } else if (outcome === 'unconfirmed') {
            // Neither success nor failure, and said as itself. The process is alive, so calling
            // this a failure would be wrong; it has not reported that it finished initializing,
            // so calling it started would be the fake success this gate exists to prevent.
            return void json(res, 202, { ok: false, state: 'unconfirmed', teaching:
              `${named} was started and is still running, but it has not reported that it finished initializing.`
              + ` Rulith confirms a start by the role's own readiness event — the Agent reports its task endpoint is listening,`
              + ' the Worker reports its Tool Manifest is loaded — so a program configured under paths that does not send one cannot'
              + ' be confirmed here. Open Trace to read what it has printed so far.' })
          }
        }
        // Only a confirmed start reaches here with `error === null`: a stop answered above with
        // what it observed, and every other start outcome answered with its own state. `ready`
        // is a statement about a role that reported it finished initializing and was not asked
        // to stop while doing so.
        return void json(res, error === null ? 200 : 400,
          error === null ? { ok: true, state: 'ready' } : { ok: false, teaching: error })
      }
      if (path === '/cases' && req.method === 'POST') {
        if (!running('agent')) return void json(res, 409, { ok: false, teaching: 'This Local runtime is not running the Agent role.' })
        const body = await readJson(req)
        if (body.requestId !== undefined && (typeof body.requestId !== 'string'
          || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId))) {
          return void json(res, 400, { ok: false, teaching: 'requestId must be a short opaque identifier (16–100 letters, digits, _ or -).' })
        }
        if (Array.isArray(body.attachments) && body.attachments.length > 0 && body.requestId === undefined) {
          return void json(res, 400, { ok: false, errorCode: 'material_submission_invalid',
            teaching: 'Submitting an attachment needs the request id for this click.' })
        }
        const sessionKey = String(body.sessionKey ?? '').trim() || (body.requestId
          ? 'ctx-' + createHash('sha256').update(String(body.requestId)).digest('hex').slice(0, 32)
          : `ctx-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`)
        // Membership, ownership and disclosure are settled here, before anything is forwarded.
        // A submission naming one material this profile does not own fails whole: honouring the
        // rest would hand the Agent a list that does not say which of the operator's selections
        // were silently dropped.
        let selected
        try {
          selected = materials.attachments(body.attachments, { sessionKey, requestId: body.requestId })
        } catch (error) { return materialFailure(res, error) }
        // A person may attach files and write nothing. The host then says what was attached and
        // tells the model to go and find an authorized Action that reads it — it does not read
        // the files, and it puts no part of their content into the message.
        const text = String(body.text ?? '')
        if (text.trim() === '' && selected.attachments.length === 0) {
          return void json(res, 400, { ok: false, teaching: 'A case submission needs a message, an attachment, or both.' })
        }
        const response = await fetch(`http://127.0.0.1:${components.agent.servePort}/task`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-serve': components.agent.serveKey },
          body: JSON.stringify({
            text: text.trim() === '' ? attachmentInstruction(selected.attachments) : text,
            sessionKey,
            ...(body.requestId === undefined ? {} : { requestId: body.requestId }),
            ...(selected.attachments.length === 0 ? {} : { attachments: selected.attachments }),
            ...(body.caseId === undefined ? {} : { caseId: body.caseId }),
            ...(body.historyModelDestination === undefined ? {} : { historyModelDestination: body.historyModelDestination }),
            ...(body.caseType === undefined ? {} : { caseType: body.caseType }),
            ...(body.businessKey === undefined ? {} : { businessKey: body.businessKey }) }),
        }).catch(() => undefined)
        if (response === undefined) return void json(res, 502, { ok: false, teaching: 'The Agent task endpoint did not respond.' })
        const answer = await response.json().catch(() => ({ ok: response.ok }))
        return void json(res, response.status, selected.receipt
          ? { ...answer, submissionReceipt: {
            submissionId: selected.receipt.submissionId, requestId: selected.receipt.requestId,
            agent: selected.receipt.agent, attachments: selected.receipt.attachments,
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
     * this one, and giving them the page key would also give them `/control` and `/setup/*`.
     * It is never served over HTTP and never reaches a model.
     */
    materialsKey: materials.key,
    get materialRoot() { return materials.root },
    // The Agent identity this host's child reported for itself. A manager shows it beside
    // the instance, and a value it read from its own registry instead would be a second
    // claim about which Agent a running process is — exactly the claim that must come from
    // the process.
    get agentId() { return components.agent.agentId },
    // Material-read tools retain the destination their Worker started with. Report a
    // needed restart instead of moving an operator attachment's disclosure permission.
    get workerModelRestartRequired() {
      if (!running('worker')) return false
      try { return components.worker.materialDestination !== materialIdentityNow().modelDestination }
      catch { return false }
    },
    /** Manager-only in-memory model replacement for an inherited account default.
     * It intentionally does not write local.json: an inherited key must not become a
     * per-instance credential just because this host happened to be open. */
    setAgentModel: ({ url = '', name = '', key: modelKey = '', thinking = 'standard' } = {}) => {
      if (running('agent')) throw new Error('Stop Agent before changing its model.')
      activeModelOverlay = {
        RULITH_MODEL_URL: String(url), RULITH_MODEL: String(name), RULITH_MODEL_KEY: String(modelKey),
        RULITH_MODEL_THINKING: ['enabled', 'disabled'].includes(thinking) ? thinking : '' }
    },
    /**
     * The operating-system processes this host currently owns.
     *
     * A supervisor that records only its own pid cannot tell, after it dies and restarts,
     * whether the roles it launched went with it — and they do not: a child outlives its
     * parent. Recording the children by pid is what lets the next manager ask the kernel
     * instead of assuming.
     */
    children: () => ['agent', 'worker']
      .filter((role) => running(role))
      .map((role) => ({ role, pid: components[role].child.pid })),
    status: () => ({ mode: modeOf(selectedRoles), roles: selectedRoles, agent: running('agent'), worker: running('worker'),
      ready: Object.fromEntries(['agent', 'worker'].map(role => [role,
        running(role) && components[role].readyAt !== undefined && !stopRequested.has(components[role].child)])) }),
    events: () => events.map((event) => ({ ...event })),
    listen: () => new Promise((accept, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        for (const role of autoStart ? selectedRoles : []) {
          const error = role === 'agent' ? startAgent() : startWorker()
          if (error !== null) {
            emit('local', 'error', { role, note: error })
            console.error(`[${role}] ${error}`)
          }
        }
        emit('local', 'start', { mode: modeOf(selectedRoles), roles: selectedRoles })
        accept()
      })
    }),
    close: async () => {
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

  rulith start --legacy [--role agent|worker|agent+worker]
                              The original single-instance mode, on one configuration file
  rulith start --config <file>
                              Single-instance mode on that exact file

The single-instance mode is also selected by setting RULITH_LOCAL_CONFIG, or by naming
roles with --role: an existing deployment keeps working with the command it already uses.
Its configuration defaults to ~/.rulith/local.json and is never migrated or deleted by the
manager; the manager offers to import a copy into its own instance directory.

Environment:
  RULITH_LOCAL_CONFIG   Single-instance configuration file (also selects that mode)
  RULITH_LOCAL_PORT     Single-instance loopback UI port (default 7790)
  RULITH_MANAGER_HOME   Manager directory (default ~/.rulith/manager)
  RULITH_MANAGER_PORT   Manager loopback UI port (default 7780)
  RULITH_MANAGER_KEY    Fixed manager browser key: 16-128 of A-Z a-z 0-9 - _
                        (default: 32 random hex characters, new on every run)`

/**
 * Which of the two entry points this command line asked for.
 *
 * The manager is the normal entry now, and the single-instance mode has to stay reachable
 * *by the command an existing deployment already runs*. Three things select it, and each one
 * is an explicit statement that this invocation is about one configuration file: `--legacy`,
 * `--config <file>`, and `RULITH_LOCAL_CONFIG` in the environment. `--role` selects it too,
 * because roles are a property of one instance — under the manager each instance names its
 * own — so a command that passes them is describing the single-instance deployment it always
 * described.
 *
 * Nothing here reads or writes configuration. Choosing an entry point must not be the step
 * that creates a file.
 */
export function parseLocalCli(argv, env = {}) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  const input = [...argv]
  const command = ['setup', 'start', 'manager'].includes(input[0]) ? input.shift() : 'start'
  let configFile
  let legacy = false
  const roleArgs = []
  for (let index = 0; index < input.length; index++) {
    if (input[index] === '--legacy') { legacy = true; continue }
    if (input[index] === '--config') {
      if (input[index + 1] === undefined) throw new Error('--config needs a configuration file path.')
      configFile = input[++index]
      legacy = true
      continue
    }
    if (input[index] === '--role' || input[index] === '--roles') legacy = true
    roleArgs.push(input[index])
  }
  const inherited = String(env.RULITH_LOCAL_CONFIG ?? '').trim()
  if (command === 'manager') {
    if (legacy) throw new Error('rulith manager runs the multi-instance manager. Use "rulith start --legacy" or --config for the single-instance mode.')
    return { command: 'manager', legacy: false, roleArgs }
  }
  if (!legacy && inherited !== '') { legacy = true; configFile = inherited }
  if (!legacy && roleArgs.length > 0) throw new Error(`Unknown Rulith option: ${roleArgs[0]}`)
  return { command, legacy, roleArgs, ...(legacy ? { configFile: configFile ?? (inherited || defaultConfigPath()) } : {}) }
}

if (IS_MAIN) {
  let cli
  try { cli = parseLocalCli(process.argv.slice(2), process.env) } catch (error) { console.error(error.message); process.exit(1) }
  if (cli.help) { console.log(CLI_HELP); process.exit(0) }
  if (cli.legacy) {
    const port = localInteger('RULITH_LOCAL_PORT', process.env.RULITH_LOCAL_PORT, 7790)
    const key = (process.env.RULITH_LOCAL_KEY ?? '').trim() || randomUUID().replace(/-/g, '')
    const configFile = cli.configFile
    const config = loadConfig(configFile)
    let roles
    try { roles = rolesFromArgs(cli.roleArgs, config.roles) } catch (error) { console.error(error.message); process.exit(1) }
    const setupMode = cli.command === 'setup'
    const host = createLocalHost({ configFile, config, roles, port, key, autoStart: !setupMode })
    await host.listen()
    console.log(`Rulith · mode ${host.mode}`)
    if (setupMode) console.log(`Local UI: http://127.0.0.1:${host.port}/setup?k=${host.key}`)
    else console.log(`Local UI: http://127.0.0.1:${host.port}/?k=${host.key}`)
    console.log(`Configuration: ${resolve(configFile)} · credentials are stored here, and are sent only to the services they authenticate to.`)
    process.on('SIGINT', async () => { await host.close(); process.exit(0) })
  } else {
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
      if (existsSync(defaultConfigPath())) {
        console.log(`An existing single-instance configuration is at ${defaultConfigPath()}. It has not been read or changed:`
          + ' import a copy from the manager, or run "rulith start --legacy" to keep using it directly.')
      }
      process.on('SIGINT', async () => { await manager.close(); process.exit(0) })
    }).catch((error) => {
      console.error(String(error?.message ?? error))
      process.exit(1)
    })
  }
}

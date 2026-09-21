// SPDX-License-Identifier: Apache-2.0
/**
 * Several independent Local instances on one computer, and the rules that keep them apart.
 *
 * An instance is a **directory**, not a name and not a running process. Everything that can
 * differ between two Agents lives inside it: the configuration file (and therefore the MCP
 * state, which the existing services resolve from `dirname(config)`), the pairing state, the
 * Worker tool manifest and vault, the workspace root, the durable record of calls whose
 * outcome is unknown, and the ports. Two instances that shared any one of those would be one
 * instance wearing two names — and the symptom would be an Agent answering under another
 * Agent's identity, which is the failure this whole file exists to make impossible.
 *
 * Three invariants are worth stating because they are easy to lose:
 *
 *   · **A running host never changes identity.** A host is created once per instance, with
 *     that instance's configuration file and its own loopback key, and is cached. Choosing a
 *     different instance in the page is view state; it creates, stops and re-keys nothing.
 *   · **Every operation names an instance id.** No route acts on "the selected one". The id
 *     is stable, opaque and is also the directory name, so two instances may share a display
 *     name without ever sharing anything that matters.
 *   · **A pairing result is validated against the instance that started it.** The approval
 *     carries the Agent the operator chose, and the delivery is refused if it names another —
 *     regardless of what the page is showing by the time the answer arrives.
 */
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalHost, defaultLocalConfig, normalizeLocalConfig } from './rulith-local.mjs'
import { newInstanceId, processAlive, writeJsonAtomic } from './manager-registry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNTIME_ROOT = resolve(HERE, '..')
export const INSTANCE_MODES = Object.freeze(['local_agent', 'existing_client'])
/** Credentials a sign-out must remove from an instance; everything else is the operator's. */
const ISSUED_CREDENTIALS = Object.freeze({ agent: ['RULITH_TOKEN'], worker: ['RULITH_CONNECTION', 'RULITH_CONNECTION_KEY'] })
/**
 * The model configuration, and nothing adjacent to it.
 *
 * An allow-list rather than "the agent environment minus the tokens": a future variable that
 * happened to carry identity would be copied by a deny-list the day it was added, and the
 * symptom would be two instances quietly sharing something they must not.
 */
const MODEL_SETTINGS = Object.freeze(['RULITH_MODEL_URL', 'RULITH_MODEL', 'RULITH_MODEL_KEY', 'RULITH_MODEL_THINKING'])

const text = (value) => (typeof value === 'string' ? value : '')
const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback)

/** Is `target` the same path as `root`, or inside it? */
export function pathInside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** A loopback port nothing is listening on right now. */
export function freePort(exclude = new Set()) {
  return new Promise((accept, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const chosen = probe.address().port
      probe.close(() => (exclude.has(chosen) ? freePort(exclude).then(accept, reject) : accept(chosen)))
    })
  })
}

/** Can this process bind that exact loopback port? Used to re-check a remembered one. */
export function portAvailable(port) {
  return new Promise((accept) => {
    const probe = createServer()
    probe.once('error', () => accept(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => accept(true)))
  })
}

export const instanceConfigFile = (directory) => join(directory, 'local.json')
export const loadInstanceConfig = (directory) => normalizeLocalConfig(readJson(instanceConfigFile(directory), defaultLocalConfig()))
export const saveInstanceConfig = (directory, config) => writeJsonAtomic(instanceConfigFile(directory), normalizeLocalConfig(config))

/**
 * The configuration a fresh instance starts from.
 *
 * Every default that would otherwise resolve to a location *shared by all instances* is
 * pinned into this directory. Three of them are not obvious:
 *
 *   · `RULITH_TOOLS_FILE` / `RULITH_SECRETS_FILE` default to the Worker's own script
 *     directory — inside the installed runtime package. Left alone, every instance on the
 *     machine would edit one manifest and one credential vault.
 *   · `RULITH_WORKER_ROOT` defaults to the same place, so workspace tools would read and
 *     write inside the installed package rather than in this instance's workspace.
 *   · `RULITH_SESSION_FILE` defaults to `~/.rulith/agent-sessions.json`, the durable record
 *     of calls whose outcome is unknown. Two Agents sharing it is how one Agent's unresolved
 *     call becomes another's to explain.
 */
export function newInstanceConfig({ directory, mode = 'local_agent', servePort }) {
  const config = defaultLocalConfig()
  config.roles = mode === 'existing_client' ? ['worker'] : ['agent', 'worker']
  config.agent = { ...config.agent, env: { ...config.agent.env,
    RULITH_SERVE_PORT: String(servePort),
    RULITH_SESSION_FILE: join(directory, 'agent-sessions.json') } }
  config.worker = { ...config.worker, env: { ...config.worker.env,
    RULITH_TOOLS_FILE: join(directory, 'worker-tools.json'),
    RULITH_SECRETS_FILE: join(directory, 'worker-secrets.json'),
    RULITH_WORKER_ROOT: join(directory, 'workspace') } }
  return config
}

/**
 * Re-root every absolute path that pointed inside the original MCP directory.
 *
 * A saved MCP service carries absolute launch arguments and, for stdio servers, a working
 * directory Local created under `<config>/mcp/workspaces/<name>`. That working directory is
 * mutable state a server writes into; two instances pointing at one would interleave. Paths
 * the operator chose themselves — a project folder, a system executable — are outside the old
 * root and are left exactly as they are, because they are resource choices, not Local's
 * bookkeeping.
 */
export function rerootMcpPaths(value, fromRoot, toRoot) {
  if (typeof value === 'string') {
    return isAbsolute(value) && pathInside(fromRoot, value) ? join(toRoot, relative(resolve(fromRoot), resolve(value))) : value
  }
  if (Array.isArray(value)) return value.map((entry) => rerootMcpPaths(entry, fromRoot, toRoot))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rerootMcpPaths(entry, fromRoot, toRoot)]))
  }
  return value
}

/**
 * Destinations an import must refuse, and the many it must not.
 *
 * The obvious rule — "the instance may not live inside the installation" — is wrong, and
 * wrong in exactly the default case. The standard installation is `~/.rulith/local.json` and
 * the standard instance directory is `~/.rulith/manager/instances/<id>`, so a blanket
 * containment check refuses the one import anybody is ever offered.
 *
 * What actually has to be refused is narrower and is about what this function *copies*: the
 * source configuration directory itself (its `local.json` is the file being read), anything
 * that would make a recursive copy walk into its own destination, and a destination that
 * contains the source. Being a sibling directory deeper in the same tree is harmless, because
 * nothing here copies the source directory as a whole.
 */
function refuseUnsafeDestination(sourceFile, sourceDir, directory) {
  const target = resolve(directory)
  const sourceMcp = join(sourceDir, 'mcp')
  if (target === resolve(sourceDir)) throw new Error('Choose an instance directory of its own; the installation\'s own directory would be overwritten.')
  if (pathInside(target, sourceDir)) throw new Error('Choose an instance directory that does not contain the installation being imported.')
  if (pathInside(sourceMcp, target)) throw new Error('Choose an instance directory outside the installation\'s mcp directory, which is copied recursively.')
  if (pathInside(target, sourceFile)) throw new Error('Choose an instance directory that does not contain the configuration file being imported.')
}

/**
 * Build an instance directory from an existing single-instance installation.
 *
 * The original is read and never written: no migration, no deletion, no rewrite in place.
 *
 * What is produced is an **unpaired profile**. Everything the operator configured comes
 * across — model endpoint and key, tool manifest, Source vault, MCP services, workspace
 * choices, resource locations — and nothing that authenticates does. That is not caution for
 * its own sake:
 *
 *   · The existing Agent token and Worker Connection were issued long before this device
 *     existed and are not part of its grant. An instance holding them would sit in a list
 *     next to instances that a sign-out really does revoke, and "sign out and stop this
 *     device" would silently leave that one able to execute. Revoking a device cannot revoke
 *     credentials the device never issued, and the interface must not imply that it can.
 *   · Which account and Agent those credentials belong to is only knowable from the server.
 *     The old pairing state records a display id; believing it would let a file on disk
 *     decide what this manager thinks it is attached to.
 *   · Source bindings were authorized for the old Connection. Carrying them forward as though
 *     they were granted to a new one would be this import authorizing access.
 *
 * So the profile arrives ready to be attached, and attaching it is the explicit step that
 * gives it an identity — verified against the device grant, from the account service. The
 * original installation keeps its own credentials and keeps working under `rulith start
 * --legacy`, with its own independent authority; that is stated in the notes rather than left
 * for somebody to discover.
 *
 * Every decision that is not a pure copy is returned in `notes`, because an import that
 * quietly re-pointed a resource is indistinguishable from one that lost it.
 */
export function importLegacyInstall({ sourceConfigFile, directory, servePort, runtimeRoot = RUNTIME_ROOT }) {
  const sourceFile = resolve(sourceConfigFile)
  if (!existsSync(sourceFile) || !statSync(sourceFile).isFile()) throw new Error(`No Rulith configuration exists at ${sourceFile}.`)
  const sourceDir = dirname(sourceFile)
  refuseUnsafeDestination(sourceFile, sourceDir, directory)
  const raw = JSON.parse(readFileSync(sourceFile, 'utf8'))
  const notes = []
  const next = normalizeLocalConfig(raw)
  const agentEnv = { ...next.agent.env }
  const workerEnv = { ...next.worker.env }

  // Runtime executables: a relative path meant "beside the old configuration file".
  const paths = { ...next.paths }
  for (const role of ['agent', 'worker']) {
    const configured = text(raw.paths?.[role]).trim()
    if (configured === '') continue
    paths[role] = resolve(sourceDir, configured)
    if (!isAbsolute(configured)) notes.push(`paths.${role} was relative to the imported configuration and is now ${paths[role]}.`)
  }
  const sourceWorkerDir = dirname(paths.worker ? resolve(paths.worker) : resolve(runtimeRoot, 'worker/rulith-worker.mjs'))

  mkdirSync(directory, { recursive: true, mode: 0o700 })
  mkdirSync(join(directory, 'workspace'), { recursive: true, mode: 0o700 })

  /**
   * The Worker's two mutable configuration files always become this instance's own.
   *
   * These are edited in place by the tool management page: adding a Tool, removing one,
   * saving a Source. Two instances sharing one file is two owners of one mutable
   * configuration, which is the thing instances are separate to avoid — and it does not stop
   * being that because the operator chose the location. Where the file *came from* is
   * preserved in a note; what its tools point *at* — a project directory, an executable — is
   * untouched, because those are resource targets and re-pointing them would be this import
   * deciding where somebody's work lives.
   *
   * Worker file inputs are resolved against the Worker's directory, not the configuration's.
   */
  const relocate = (name, fallbackBase) => {
    const configured = text(workerEnv[name]).trim()
    const target = join(directory, fallbackBase)
    const absolute = configured === '' ? join(sourceWorkerDir, fallbackBase) : resolve(sourceWorkerDir, configured)
    workerEnv[name] = target
    if (existsSync(absolute) && resolve(absolute) !== target) {
      cpSync(absolute, target, { errorOnExist: false })
      notes.push(`${name}: ${absolute} was copied to ${target}. It is this instance's own file now; the original is unchanged and still used by the installation it came from.`)
      return
    }
    notes.push(configured === ''
      ? `${name} was unset and would have defaulted into the runtime package; this instance uses its own ${target}.`
      : `${name} pointed at ${absolute}, which does not exist; this instance uses its own ${target}.`)
  }
  relocate('RULITH_TOOLS_FILE', 'worker-tools.json')
  relocate('RULITH_SECRETS_FILE', 'worker-secrets.json')

  const workerRoot = text(workerEnv.RULITH_WORKER_ROOT).trim()
  if (workerRoot === '') {
    workerEnv.RULITH_WORKER_ROOT = join(directory, 'workspace')
    notes.push('RULITH_WORKER_ROOT was unset and defaulted into the runtime package; this instance uses its own workspace directory.')
  } else if (!isAbsolute(workerRoot)) {
    workerEnv.RULITH_WORKER_ROOT = resolve(sourceWorkerDir, workerRoot)
    notes.push(`RULITH_WORKER_ROOT was relative to the Worker directory and is now ${workerEnv.RULITH_WORKER_ROOT}.`)
  }

  // Ports: two instances cannot both serve tasks on one port, so this one is assigned.
  if (servePort !== undefined) {
    if (text(agentEnv.RULITH_SERVE_PORT).trim() !== '' && String(agentEnv.RULITH_SERVE_PORT) !== String(servePort)) {
      notes.push(`RULITH_SERVE_PORT ${agentEnv.RULITH_SERVE_PORT} was reassigned to ${servePort} so instances do not collide.`)
    }
    agentEnv.RULITH_SERVE_PORT = String(servePort)
  }

  // The durable record of calls whose outcome is unknown stays with the credential that
  // produced it.
  //
  // That store is keyed by endpoint — `${RULITH_URL}#sha256(token)[0:16]` — so a record only
  // means anything to the credential that made the call. This profile arrives unpaired and
  // will be given a different, newly issued credential under a different key; copying records
  // across would put them in a store where nothing can ever resolve them, while the
  // installation that *can* still reconcile them would look as though it had handed them over.
  // When an authenticated recovery path for a transferred Agent identity exists, this is where
  // it belongs; until then nothing pretends to have moved anything.
  const sourceStore = text(raw.agent?.env?.RULITH_SESSION_FILE).trim()
  const sourceStorePath = sourceStore === '' ? join(homedir(), '.rulith', 'agent-sessions.json')
    : sourceStore.toLowerCase() === 'off' ? '' : resolve(sourceDir, sourceStore)
  agentEnv.RULITH_SESSION_FILE = join(directory, 'agent-sessions.json')
  notes.push(sourceStorePath === ''
    ? `RULITH_SESSION_FILE was off; this instance records unresolved calls in ${agentEnv.RULITH_SESSION_FILE} once it is attached.`
    : `Unresolved-call records were left in ${sourceStorePath}: they belong to the credential that made those calls, and this profile will be given a different one. The original installation can still reconcile them.`)

  // Credentials: not imported. What this profile is attached to is decided by attaching it.
  const strippedCredentials = []
  for (const [role, names] of Object.entries(ISSUED_CREDENTIALS)) {
    const env = role === 'agent' ? agentEnv : workerEnv
    for (const name of names) if (text(env[name]).trim() !== '') { env[name] = ''; strippedCredentials.push(name) }
  }
  if (strippedCredentials.length > 0) {
    notes.push(`${strippedCredentials.join(', ')} were not imported. They were issued to the original installation, which still holds them and still runs with "rulith start --legacy" under its own authority — signing this device out does not revoke them. Attach an Agent to this profile to give it credentials of its own.`)
  }

  // Pairing state: the operator's local resource choices, without the identity they were
  // chosen under and without the material that would let this profile claim a delivery.
  const sourceSetup = readJson(sourceFile + '.setup.json', undefined)
  if (sourceSetup !== undefined) {
    const carried = { ...sourceSetup }
    for (const field of ['requestId', 'deviceSecret', 'privateKey', 'publicKey', 'credentialDigest',
      'agentId', 'connectionId', 'approvedAgentId', 'code', 'expiresAt']) delete carried[field]
    carried.importedFrom = sourceFile
    writeJsonAtomic(instanceConfigFile(directory) + '.setup.json', carried)
    notes.push('Local resource selections were copied. The Agent and Connection identity they were made under was not: they are proposals again until this profile is attached and they are authorized for its own Connection.')
  }

  // MCP: installed server code may be reused, but nothing mutable is shared. Saved services,
  // their per-server working directories and the packages they launch are copied; the npm
  // cache is not, because it is a rebuildable download cache and can be large.
  const sourceMcp = join(sourceDir, 'mcp')
  const targetMcp = join(directory, 'mcp')
  if (existsSync(sourceMcp)) {
    mkdirSync(targetMcp, { recursive: true, mode: 0o700 })
    const services = readJson(join(sourceMcp, 'services.json'), undefined)
    if (services !== undefined) {
      writeJsonAtomic(join(targetMcp, 'services.json'), rerootMcpPaths(services, sourceMcp, targetMcp))
      notes.push('Saved MCP services were copied; their launch paths and working directories now resolve inside this instance.')
    }
    for (const folder of ['packages', 'workspaces']) {
      if (existsSync(join(sourceMcp, folder))) cpSync(join(sourceMcp, folder), join(targetMcp, folder), { recursive: true, errorOnExist: false })
    }
    if (existsSync(join(sourceMcp, 'npm-cache'))) notes.push('The npm download cache was not copied; installing another MCP server re-downloads it.')
  }

  const config = normalizeLocalConfig({ ...next, paths, agent: { ...next.agent, env: agentEnv }, worker: { ...next.worker, env: workerEnv } })
  saveInstanceConfig(directory, config)
  return { config, notes, paired: false,
    legacy: { configFile: sourceFile, sessionStore: sourceStorePath, keptCredentials: strippedCredentials } }
}

/**
 * @param {object} options
 * @param {ReturnType<import('./manager-registry.mjs').createManagerRegistry>} options.registry
 * @param {ReturnType<import('./device-client.mjs').createDeviceClient>} options.device
 */
export function createInstanceManager({ registry, device, startConfirmMs, managerReturnUrl }) {
  /** Live hosts, by instance id. Created once, cached, never re-created on selection. */
  const hosts = new Map()
  const instancesRoot = join(registry.root, 'instances')

  /**
   * One owner at a time, per instance.
   *
   * `ensureHost` used to read `hosts.get(id)`, find nothing, and then `await` four times —
   * a stale-marker sweep, a port probe, a `listen` — before writing the entry back. Two
   * requests arriving together both passed the check and both listened: two loopback hosts,
   * two keys, one registered instance, and only the second one in `hosts`. The first was not
   * merely untracked; it was unstoppable. `close()` walks `hosts`, so it survived the manager
   * shutdown and kept the process alive, and anything holding its address could still reach
   * an instance directory the manager believed it had closed.
   *
   * A promise chain per id is enough and is the whole mechanism: opening, starting, stopping,
   * closing, attaching and copying settings for one instance happen one after another. They
   * never nest — the internal `…Locked` forms exist precisely so an operation that already
   * holds the lock never asks for it again — and work on *different* instances stays parallel,
   * because the point was never to serialize the manager.
   */
  const lifecycles = new Map()
  const lifecycle = (id, action) => {
    const previous = lifecycles.get(id) ?? Promise.resolve()
    const run = previous.then(action, action)
    lifecycles.set(id, run.then(() => undefined, () => undefined))
    return run
  }

  /**
   * Which whole-installation operations are open for business.
   *
   * The per-instance chain above keeps one instance consistent with itself. It says nothing
   * about the two operations whose subject is *every* instance: signing out, and closing. Both
   * of those snapshot the instances, then await stops and a network revoke — and a concurrent
   * `start`, `pair`, `open` or `create` slipped straight through the middle of that window.
   * The outcome was a manager reporting `signed_out` while a child it had just been asked to
   * start was alive and owned.
   *
   * So there is a phase, and it is deliberately small:
   *
   *   · `ready` — everything runs, and runs in parallel across instances. Nothing here
   *     serializes one Agent behind another; that would trade this race for a worse product.
   *   · `signing_out` — no new work is admitted, already-admitted work is waited for, and only
   *     then is the stop snapshot taken. Restored to `ready` afterwards, complete or not: an
   *     incomplete sign-out leaves a usable manager, and a successful one leaves a manager you
   *     can sign into again.
   *   · `closing` — terminal. This process is going away.
   *
   * Stopping is never gated. It is what draining *does*, so gating it would deadlock the drain
   * against itself; and refusing to stop something is never the safe direction.
   */
  let phase = 'ready'
  let admittedCount = 0
  let idleSettle
  let idle = Promise.resolve()
  const phaseTeaching = () => (phase === 'closing'
    ? 'This Rulith workbench is shutting down. Start it again to use this installation.'
    : 'This workbench is signing out of its account. Nothing new starts or is configured until that finishes; stopping still works.')
  const admit = async (action) => {
    if (phase !== 'ready') throw new Error(phaseTeaching())
    if (admittedCount === 0) idle = new Promise((done) => { idleSettle = done })
    admittedCount += 1
    try { return await action() } finally {
      admittedCount -= 1
      if (admittedCount === 0) idleSettle?.()
    }
  }
  /** Close admission, then wait for what was already admitted to finish. */
  const drain = async (next) => {
    phase = next
    await idle
  }

  const record = (id) => {
    const row = registry.instance(id)
    if (row === undefined) throw new Error(`No local instance ${id} is registered.`)
    return row
  }

  /**
   * Does the device grant currently permit this instance to run and to be configured?
   *
   * Asked fresh every time, because every input can change without this manager acting: the
   * browser can revoke the device, Console can remove an Agent from the grant, the grant can
   * expire. An instance whose recorded binding no longer matches what the account service
   * says is not merely out of date — it is an installation that would otherwise start an
   * Agent under an authorization nobody currently holds.
   *
   * It returns a teaching or null, and is deliberately the *same* function the instance
   * host's own `/control` and `/setup` routes consult. Those routes are reachable by anyone
   * with that host's key, so a check that lived only in the manager's own endpoints would be
   * a check an instance page could walk around.
   */
  const grantRefusal = (id, { requirePaired = false, grant = device.status(), row = registry.instance(id) } = {}) => {
    if (row === undefined) return `Instance ${id} is no longer registered with this manager.`
    if (row.orphaned !== undefined) {
      return `Instance ${row.name} still has processes from a manager that is gone (${row.orphaned.children.map((child) => `${child.role} pid ${child.pid}`).join(', ')}). Stop them before this instance is used again.`
    }
    if (grant.state !== 'linked') {
      return grant.state === 'none'
        ? 'Sign in to a Rulith account in the manager before running or configuring an instance.'
        : grant.state === 'unreadable'
          ? grant.teaching
          : `This device authorization is ${grant.state}, so instances it manages cannot run or be reconfigured. Sign in again from the manager.`
    }
    const attached = text(row.agentId)
    if (attached === '') {
      return requirePaired
        ? `Instance ${row.name} is not attached to an Agent yet. Attach one in the manager first.`
        : null
    }
    // Only starting is gated on the file layout: a host that refuses to *open* takes Setup and
    // Tools with it, and those are the only pages that could repair a path the operator (or a
    // setup step) pointed somewhere it must not go. Opening spawns nothing; starting does.
    if (requirePaired) {
      const exposure = managerExposure(loadInstanceConfig(resolve(row.directory)), resolve(row.directory))
      if (exposure !== null) return `Instance ${row.name} cannot start: ${exposure} Fix it in this instance's Setup or Tools page.`
    }
    if (text(row.origin) !== grant.origin || text(row.accountId) !== String(grant.account?.id ?? '')) {
      return `Instance ${row.name} was attached to a different account or Console address than the one signed in now. Attach it again before using it.`
    }
    if (!grant.agents.some((agent) => agent.id === attached)) {
      return `Agent ${row.agentName || attached} is no longer part of what this device is authorized for. Review it in Console, then attach this instance again.`
    }
    return null
  }
  /**
   * One control call to an instance's own loopback host.
   *
   * `connection: close` rather than a pooled socket, and one retry on a transport failure.
   * An instance that was stopped and started again takes the same remembered port, and a
   * keep-alive socket left over from the previous host on that port is dead — reusing it
   * answers a perfectly good start with "fetch failed", which reads as the instance being
   * broken rather than as this client holding a stale connection.
   */
  /** The secret every host this manager builds accepts as "this call is mine". */
  const managedCallToken = randomUUID()
  const localCall = async (host, path, body) => {
    const send = () => fetch(`http://127.0.0.1:${host.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      headers: { connection: 'close', 'x-rulith-local': host.key, 'x-rulith-managed': managedCallToken,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const response = await send().catch((error) => {
      if (!['ECONNRESET', 'ECONNREFUSED', 'UND_ERR_SOCKET'].includes(error?.cause?.code ?? '')) throw error
      return send()
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }

  /**
   * Configuration that would point an instance's Worker at the manager's own files.
   *
   * The manager directory holds the device management token and every *other* instance's
   * configuration and credentials. A Worker reads and writes the files it is configured with,
   * and with workspace tools enabled it reads and writes its workspace root — so a
   * `RULITH_WORKER_ROOT` or a tools/vault path inside the manager directory is a path from
   * one Agent's tools to this installation's account credential and to its siblings' tokens.
   *
   * Its own instance directory is the one part of that tree it owns. Everything else in there
   * is refused by name, before the host opens, rather than relied upon not to be reached.
   */
  const managerExposure = (config, directory) => {
    const own = resolve(directory)
    const configured = [
      ['RULITH_WORKER_ROOT', config.worker?.env?.RULITH_WORKER_ROOT],
      ['RULITH_TOOLS_FILE', config.worker?.env?.RULITH_TOOLS_FILE],
      ['RULITH_SECRETS_FILE', config.worker?.env?.RULITH_SECRETS_FILE],
      ['RULITH_SESSION_FILE', config.agent?.env?.RULITH_SESSION_FILE],
    ]
    for (const [name, raw] of configured) {
      const value = text(raw).trim()
      if (value === '' || value.toLowerCase() === 'off') continue
      const target = resolve(value)
      if (pathInside(own, target)) continue
      if (pathInside(registry.root, target) || pathInside(target, registry.root)) {
        return `${name} is set to ${target}, which overlaps the manager directory ${registry.root}.`
          + ' That directory holds this installation\'s device credential and every other instance\'s configuration; an instance may only use its own directory inside it.'
      }
    }
    return null
  }

  /**
   * What a managed host may do without asking the manager.
   *
   * Two routes on an instance host can change what is executing or what identity is being
   * configured: `POST /control` with `start`, and `POST /setup/*`. Both are reachable from
   * that instance's own page. For a *managed* instance that page is not the authority — the
   * device grant is — so the host consults this before either one.
   *
   * Pairing is the sharper case: `/setup/pair/start` opened directly from an instance page
   * would begin a pairing the manager did not ask for and had no chance to reserve, which is
   * the duplicate-attach hole reopened through the side door. So pairing is refused unless
   * this manager has a *persisted* reservation for this exact instance.
   */
  const policyFor = (id) => ({ kind, path, fromOwner }) => {
    // An instance page reaches its own host directly, so the drain has to be visible from
    // there too — otherwise signing out races a role somebody just started from a browser
    // tab. The manager's own calls are exempt: they belong to an operation that was already
    // admitted, and refusing them here would abandon work half-done. Stopping is not gated at
    // all: `policyFor` is only consulted for `start` and for `/setup/*`.
    if (phase !== 'ready' && fromOwner !== true) return phaseTeaching()
    if (kind === 'start') return grantRefusal(id, { requirePaired: true })
    if (path === '/setup/pair/start' || path === '/setup/pair/poll' || path === '/setup/pair/cancel') {
      const row = registry.instance(id)
      if (row?.pairing === undefined) {
        return 'Attaching an Agent is started from the Rulith manager, which reserves the Agent first. Use "Attach Agent" there.'
      }
      return grantRefusal(id)
    }
    return grantRefusal(id)
  }

  /**
   * The approval callback one instance's setup service is given.
   *
   * Bound to `id` at host creation, so it can only ever approve the pairing that instance
   * started, and it reads the **persisted** reservation rather than anything held in memory.
   * A manager that restarted mid-pairing still knows which Agent this instance reserved; a
   * process that never reserved one cannot spend device authority on whatever pairing
   * happened to be open.
   */
  const approverFor = (id) => async ({ pairingId, deviceSecret, base, clientMode }) => {
    const reservation = registry.instance(id)?.pairing
    if (reservation === undefined) throw new Error('This instance has no reserved Agent; start the attachment from the manager.')
    const grant = device.peek()
    if (base !== grant.origin) throw new Error('This pairing targets a different Console address than the signed-in account.')
    if (reservation.origin !== grant.origin || reservation.accountId !== text(grant.account?.id)) {
      throw new Error('The reserved attachment belongs to a different account or Console address than the one signed in now.')
    }
    // The mode decides whether an Agent token is minted at all and what roles the instance
    // ends up with, so a pairing started under a different one than was reserved is spending
    // the grant on something the operator did not choose.
    if (reservation.clientMode !== undefined && clientMode !== reservation.clientMode) {
      throw new Error(`This pairing was started as ${clientMode}, and the manager reserved ${reservation.clientMode} for this instance.`)
    }
    const approved = await device.pair({ pairingId, deviceSecret, agentId: reservation.agentId, replaceAgentToken: reservation.replaceAgentToken === true })
    const agentId = text(approved?.agentId).trim() || reservation.agentId
    if (agentId !== reservation.agentId) throw new Error('The account service approved a different Agent than this instance reserved.')
    await registry.patchInstance(id, (row) => ({ pairing: { ...row.pairing, pairingId, approvedAt: new Date().toISOString() } }))
    await device.recordPairing(id, { pairingId, agentId, origin: base, accountId: text(grant.account?.id) })
    return { agentId }
  }

  /**
   * Start this instance's loopback host, or return the one already running.
   *
   * The port is remembered so a link stays stable across restarts, and re-checked because
   * something else may have taken it; the Agent's task port is checked the same way. Neither
   * is fatal — a busy port is reassigned and recorded, which is what "choose unique available
   * ports automatically" has to mean on a machine Rulith does not own.
   */
  const ensureHostLocked = async (id) => {
    const live = hosts.get(id)
    if (live !== undefined) return live
    await registry.reclaimStale()
    const row = record(id)
    if (row.runtime !== undefined && row.runtime.pid !== process.pid && processAlive(row.runtime.pid)) {
      throw new Error(`Instance ${row.name} is already open in another Rulith manager (process ${row.runtime.pid}).`)
    }
    // A manager that died can leave its Agent and Worker running. Opening a second host over
    // them would give one instance directory two owners and one Agent credential two live
    // users — and whichever one lost would look "stopped" while still writing to a Board.
    if (row.orphaned !== undefined) {
      const named = row.orphaned.children.map((child) => `${child.role} pid ${child.pid}`).join(', ')
      throw new Error(`Instance ${row.name} still has processes from a Rulith manager that is gone (${named}).`
        + ' They hold this instance\'s credentials and may still be executing. Stop those processes, then open this instance again.')
    }
    const directory = resolve(row.directory)
    if (!existsSync(instanceConfigFile(directory))) throw new Error(`Instance ${row.name} has no configuration at ${instanceConfigFile(directory)}.`)
    const config = loadInstanceConfig(directory)
    const taken = new Set([...hosts.values()].flatMap((entry) => [entry.host.port, entry.servePort]))

    const wanted = Number(config.agent?.env?.RULITH_SERVE_PORT ?? 0)
    let servePort = wanted
    if (!Number.isSafeInteger(wanted) || wanted <= 0 || taken.has(wanted) || !(await portAvailable(wanted))) {
      servePort = await freePort(taken)
      config.agent = { ...config.agent, env: { ...config.agent.env, RULITH_SERVE_PORT: String(servePort) } }
      saveInstanceConfig(directory, config)
    }
    const build = (hostPort) => createLocalHost({
      configFile: instanceConfigFile(directory), config, roles: config.roles, port: hostPort,
      autoStart: false, isolateEnvironment: true,
      setupApprover: device === undefined ? undefined : approverFor(id),
      managedPolicy: policyFor(id),
      managedCallToken,
      protectedPaths: [registry.root],
      onChildChange: (children) => recordRuntime(id, children),
      ...(startConfirmMs === undefined ? {} : { startConfirmMs }),
    })
    if (phase !== 'ready') throw new Error(phaseTeaching())
    let host = build(Number(row.hostPort ?? 0) || 0)
    try { await host.listen() } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error
      // The remembered port belongs to somebody else now. Take any free one rather than
      // refusing to open an instance over a number.
      host = build(await freePort(taken))
      await host.listen()
    }
    if (phase === 'closing') {
      // Closed while this was listening: it never becomes anybody's host, so it is shut here
      // rather than left behind holding a port and a key.
      await host.close()
      throw new Error(phaseTeaching())
    }
    const entry = { host, servePort, directory, hostGeneration: randomUUID() }
    hosts.set(id, entry)
    await recordRuntime(id)
    return entry
  }

  /**
   * Which processes this instance owns, where another manager can read it after a crash.
   *
   * Refreshed whenever a role starts or stops — including from the instance's own page, which
   * never goes through this manager at all — because the point of the record is what a
   * *different* process sees later: the manager pid alone answers "was somebody managing
   * this", and only the child pids answer "is anything still running".
   *
   * A registry write that fails is not shrugged off. It used to be swallowed, which meant a
   * momentary lock contention silently produced the one state this record exists to prevent:
   * a marker claiming no children while children run. It is retried, and if it still cannot be
   * written the failure is kept and surfaced on the instance — an operator who can see
   * "this instance's processes are not recorded" can act; a silent gap cannot be acted on.
   */
  const runtimeRecordFailures = new Map()
  const recordRuntime = async (id, children) => {
    const live = hosts.get(id)
    if (live === undefined) return
    const observed = children ?? live.host.children()
    const write = () => registry.patchInstance(id, () => ({ hostPort: live.host.port, servePort: live.servePort,
      runtime: { pid: process.pid, startedAt: new Date().toISOString(), children: observed } }))
    try {
      await write()
      runtimeRecordFailures.delete(id)
    } catch (first) {
      await new Promise((done) => { const timer = setTimeout(done, 120); timer.unref?.() })
      try {
        await write()
        runtimeRecordFailures.delete(id)
      } catch (second) {
        runtimeRecordFailures.set(id, `The processes this instance is running (${observed.map((child) => `${child.role} pid ${child.pid}`).join(', ') || 'none'})`
          + ` could not be recorded in the manager registry: ${String(second?.message ?? second)}`
          + ' Another manager started after this one would not know about them.')
        throw second
      }
    }
  }

  /**
   * Close an instance's loopback host.
   *
   * Refused while a role is running, unless the whole process is going down. Closing a host
   * with a live child is not a tidy-up: `close()` signals, waits one second, and returns
   * whether or not the child went — so the host, the `hosts` entry and the registry's record
   * of that child all disappear while the child is still draining a call. Everything
   * downstream then answers truthfully about a world that no longer includes it: `stop`
   * reports `stopped` because there is no host, and sign-out revokes the device while a Worker
   * is still executing. Stopping and *observing* comes first; this only tidies up afterwards.
   */
  const closeHostLocked = async (id, { force = false } = {}) => {
    const live = hosts.get(id)
    if (live === undefined) return { closed: true, unobserved: [] }
    const running = runningRoles(id)
    if (running.length > 0 && !force) {
      throw new Error(`Instance ${record(id).name} is still running its ${running.join(' and ')}.`
        + ' Stop it first: closing a host while a child is draining would lose track of that child rather than end it.')
    }
    await live.host.close()
    // `close()` signals and waits a second; a child that was mid-call may outlive that. The
    // record of which processes this instance owns is therefore written from what the host
    // reports *after* closing, not from the intention that it should have stopped.
    const unobserved = live.host.children()
    hosts.delete(id)
    // Not swallowed. If the manager cannot write down what it owns, the next manager reads a
    // marker that is wrong in exactly the direction that matters, and the caller has to know.
    if (unobserved.length === 0) {
      await registry.patchInstance(id, (row) => { delete row.runtime; delete row.unobservedAt; return {} })
      return { closed: true, unobserved: [] }
    }
    // Shutting down does not license a false record. The children are kept, with their pids,
    // so the next run's orphan check sees a dead manager with living children and refuses to
    // open a second host over them.
    await registry.patchInstance(id, () => ({
      runtime: { pid: process.pid, startedAt: new Date().toISOString(), children: unobserved },
      unobservedAt: new Date().toISOString(),
    }))
    return { closed: true, unobserved }
  }

  /**
   * Remove what a grant issued, and only that.
   *
   * The Agent token and the Worker Connection came from a pairing the revoked device
   * approved, so they go. The model endpoint and key, the tool manifest, the workspace, the
   * resource selections already sent for authorization and the whole conversation history are
   * the operator's and stay exactly as they are — signing out of an account is not a reason
   * to lose the work done under it.
   */
  const clearIssuedCredentials = (rows) => {
    const cleared = []
    for (const row of rows) {
      const directory = resolve(row.directory)
      if (!existsSync(instanceConfigFile(directory))) continue
      const config = loadInstanceConfig(directory)
      for (const [role, names] of Object.entries(ISSUED_CREDENTIALS)) {
        for (const name of names) if (text(config[role]?.env?.[name]) !== '') config[role].env[name] = ''
      }
      saveInstanceConfig(directory, config)
      const setupFile = instanceConfigFile(directory) + '.setup.json'
      const setup = readJson(setupFile, undefined)
      if (setup !== undefined) {
        for (const field of ['agentId', 'connectionId', 'credentialDigest', 'approvedAgentId', 'deviceSecret', 'privateKey', 'publicKey', 'code', 'expiresAt', 'requestId']) delete setup[field]
        writeJsonAtomic(setupFile, setup)
      }
      cleared.push(row.name)
    }
    return cleared
  }

  /** Is this the same attachment request, in every part that decides what gets issued? */
  const sameTarget = (existing, target) => ['agentId', 'origin', 'accountId', 'clientMode'].every((field) => existing[field] === target[field])
    && existing.replaceAgentToken === target.replaceAgentToken

  /** The roles this instance is actually running right now, if its host is open. */
  const runningRoles = (id) => {
    const live = hosts.get(id)
    if (live === undefined) return []
    const status = live.host.status()
    return ['agent', 'worker'].filter((role) => status[role] === true)
  }

  // A dead host is not evidence that its children stopped. Inspect recorded PIDs again on
  // every attempt, so an orphan blocks credential cleanup only while it is actually alive.
  const survivingProcesses = (row) => {
    const children = [...(row.runtime?.children ?? []), ...(row.orphaned?.children ?? [])]
    const seen = new Set()
    const results = children.filter((child) => {
      if (seen.has(child.pid) || !processAlive(child.pid)) return false
      seen.add(child.pid)
      return true
    }).map((child) => ({ role: child.role, state: 'elsewhere', ok: false,
      teaching: `The ${child.role} process ${child.pid} is still running outside this workbench. Stop it before clearing its credentials.` }))
    if (row.runtime && row.runtime.pid !== process.pid && processAlive(row.runtime.pid)) {
      results.push({ role: 'host', state: 'elsewhere', ok: false,
        teaching: `This instance is open in another Rulith workbench (process ${row.runtime.pid}); stop it there first.` })
    }
    return results
  }

  const manager = {
    hosts,
    instancesRoot,
    /** The installation-wide phase, and the gate the device routes share with it. */
    get phase() { return phase },
    admit,

    /**
     * Public, secret-free state for the manager page.
     *
     * The grant and the registry are read once for the whole list rather than once per row.
     * This runs on every response, including a three-second page poll, and a per-instance
     * `device.status()` was a file read per card per poll.
     */
    overview: () => {
      const grant = device.status()
      return registry.read().instances.map((row) => {
      const live = hosts.get(row.id)
      const status = live?.host.status()
      return {
        id: row.id, name: row.name, mode: row.mode, directory: row.directory,
        createdAt: row.createdAt ?? '', importedFrom: row.importedFrom ?? '',
        origin: row.origin ?? '', accountId: row.accountId ?? '', agentId: row.agentId ?? '',
        agentName: row.agentName ?? '', connectionId: row.connectionId ?? '', paired: Boolean(row.agentId || row.connectionId),
        open: live !== undefined, roles: status?.roles ?? [],
        agent: status?.agent === true, worker: status?.worker === true,
        // Everything a card needs to explain why a button is unavailable, computed from the
        // device grant rather than from what the page last saw.
        pendingAgentId: row.pairing?.agentId ?? '', pendingAgentName: row.pairing?.agentName ?? '',
        pendingOrigin: row.pairing?.origin ?? '', pendingAccountId: row.pairing?.accountId ?? '',
        setupTarget: row.setupTarget ?? null,
        pendingApproved: row.pairing?.approvedAt !== undefined,
        blocked: grantRefusal(row.id, { requirePaired: true, grant, row }) ?? '',
        orphaned: row.orphaned ?? null,
        runtimeRecordWarning: runtimeRecordFailures.get(row.id) ?? '',
        legacyImport: row.importedFrom === undefined ? null : { configFile: row.importedFrom, credentialsLeftInPlace: row.legacyCredentials ?? [] },
        // Reported by the running child, not by this registry: a stored id is a memory of an
        // identity, and only the process can say which one it is actually using.
        runningAgentId: live === undefined ? '' : String(live.host.agentId ?? ''),
        hostPort: live === undefined ? 0 : live.host.port, hostGeneration: live?.hostGeneration ?? '', servePort: live?.servePort ?? row.servePort ?? 0,
        signedOutAt: row.signedOutAt ?? '',
      }
      })
    },

    create: ({ name, mode = 'local_agent', setupTarget } = {}) => admit(async () => {
      if (!INSTANCE_MODES.includes(mode)) throw new Error('Choose the Local agent, or an existing client using this computer as a Worker.')
      const display = text(name).trim()
      if (display === '' || display.length > 80) throw new Error('Give this instance a name of 1–80 characters.')
      // First-use intent survives a lost create response or a restart before pairing. It is
      // only an idempotency key, never an attachment or authority to run this profile.
      let target
      if (setupTarget !== undefined) {
        if (setupTarget === null || typeof setupTarget !== 'object' || Array.isArray(setupTarget)
          || Object.keys(setupTarget).some(key => !['origin', 'accountId', 'agentId'].includes(key))
          || ['origin', 'accountId', 'agentId'].some(key => typeof setupTarget[key] !== 'string' || !setupTarget[key])) {
          throw new Error('Choose an Agent from the signed-in account before setting it up.')
        }
        target = { origin: setupTarget.origin, accountId: setupTarget.accountId, agentId: setupTarget.agentId }
      }
      let result
      await registry.update(async (state) => {
        if (target) {
          const grant = device.status()
          if (grant.state !== 'linked' || grant.origin !== target.origin || grant.account?.id !== target.accountId
            || !grant.agents?.some(agent => agent.id === target.agentId)) {
            throw new Error('The account or Agent authorization changed. Choose the Agent again.')
          }
          const existing = state.instances.find(row => !row.agentId && !row.connectionId
            && ['origin', 'accountId', 'agentId'].every(key => row.setupTarget?.[key] === target[key]))
          if (existing) {
            if (existing.mode !== mode) throw new Error('This Agent already has an unfinished setup with a different runtime mode. Finish or remove that profile first.')
            result = existing
            return state
          }
        }
        const id = newInstanceId()
        const directory = join(instancesRoot, id)
        if (existsSync(directory) && readdirSync(directory).length > 0) throw new Error('That instance directory already exists and is not empty.')
        const servePort = await freePort(new Set([...hosts.values()].map(entry => entry.servePort)))
        mkdirSync(join(directory, 'workspace'), { recursive: true, mode: 0o700 })
        saveInstanceConfig(directory, newInstanceConfig({ directory, mode, servePort }))
        result = { id, name: display, mode, directory, servePort, createdAt: new Date().toISOString(), ...(target ? { setupTarget: target } : {}) }
        state.instances.push(result)
        return state
      })
      return { id: result.id, name: result.name, mode: result.mode, directory: result.directory, servePort: result.servePort }
    }),

    /**
     * Import an existing single-instance installation as an unpaired profile.
     *
     * Nothing is inferred about who the installation belongs to. Its pairing file records an
     * Agent id, and an earlier version read that to decide whether the import clashed with an
     * existing instance — which is a file on disk deciding what this manager believes it is
     * attached to. The profile arrives with no identity at all, and the only thing that gives
     * it one is attaching it, where the Agent is checked against the device grant that the
     * account service just confirmed.
     */
    import: ({ sourceConfigFile, name, mode } = {}) => admit(async () => {
      const display = text(name).trim()
      if (display === '' || display.length > 80) throw new Error('Give this instance a name of 1–80 characters.')
      const source = resolve(text(sourceConfigFile).trim() || join(homedir(), '.rulith', 'local.json'))
      if (!existsSync(source)) throw new Error(`No Rulith configuration exists at ${source}.`)
      const id = newInstanceId()
      const directory = join(instancesRoot, id)
      if (existsSync(directory) && readdirSync(directory).length > 0) throw new Error('That instance directory already exists and is not empty.')
      const servePort = await freePort(new Set([...hosts.values()].map((entry) => entry.servePort)))
      const imported = importLegacyInstall({ sourceConfigFile: source, directory, servePort })
      const chosen = INSTANCE_MODES.includes(mode) ? mode
        : imported.config.roles.includes('agent') ? 'local_agent' : 'existing_client'
      await registry.update((state) => {
        state.instances.push({ id, name: display, mode: chosen, directory, servePort, importedFrom: source,
          legacyCredentials: imported.legacy.keptCredentials, createdAt: new Date().toISOString() })
        return state
      })
      return { id, name: display, mode: chosen, directory, notes: imported.notes, paired: false, legacy: imported.legacy }
    }),

    /**
     * Open this instance's loopback UI and return the exact address for it.
     *
     * The address carries this instance's key, and `manager` names where the operator came
     * from so the page can render a way back. That parameter holds the manager's own browser
     * key, which is what `GET /` on the manager requires — the alternative tried first, a
     * single-use ticket redirecting to the real key, was worse in the way that matters:
     * whoever held the ticket could read the redirect's `Location` and end up with the full
     * key anyway, so it bought no isolation and cost a link that broke on a second click.
     *
     * That key is a loopback browser capability of this run, and an entirely different thing
     * from the cloud device management token, which appears in no URL, no page, no child
     * environment and no status body.
     */
    open: (id, page = '/') => admit(() => lifecycle(id, async () => {
      if (!['/', '/setup', '/worker-tools'].includes(page)) throw new Error('Open the conversation, setup, or tool page of an instance.')
      const { host, hostGeneration } = await ensureHostLocked(id)
      const back = managerReturnUrl === undefined ? '' : '&manager=' + encodeURIComponent(managerReturnUrl())
      return { url: `http://127.0.0.1:${host.port}${page}?k=${encodeURIComponent(host.key)}${back}`, hostPort: host.port, hostGeneration }
    })),

    /**
     * Start the roles this instance is configured for, reporting each role's own answer.
     *
     * The device grant is re-checked here *and* by the host's own policy, on purpose. This
     * check gives the operator one clear refusal instead of a per-role one; the host's is what
     * makes the rule true for a request that never came through here at all.
     *
     * The host's `/control` route is what decides whether a role started, unchanged: it waits
     * for the role's own readiness event, distinguishes a cancelled start from a failed one,
     * and refuses to call an unconfirmed start a success.
     */
    // 工作台按角色控制；Worker 按钮不应停止 Agent，也不能因切换页面关闭其 Host。
    control: (id, { role, operation } = {}) => {
      if (!['agent', 'worker'].includes(role) || !['start', 'stop'].includes(operation)) {
        return Promise.reject(new Error('Choose an Agent or Worker and a start or stop operation.'))
      }
      const run = () => lifecycle(id, () => manager.__control(id, { role, operation }))
      return operation === 'start' ? admit(run) : run()
    },

    __control: async (id, { role, operation }) => {
      const row = record(id)
      if (operation === 'start') {
        const refusal = grantRefusal(id, { requirePaired: true })
        if (refusal !== null) throw new Error(refusal)
      }
      const live = hosts.get(id)
      if (operation === 'stop' && live === undefined) {
        if (row.orphaned || row.runtime?.children?.some(child => processAlive(child.pid))
          || (row.runtime && row.runtime.pid !== process.pid && processAlive(row.runtime.pid))) {
          throw new Error('This Agent has processes outside this workbench. Stop them with their owning workbench before reporting them stopped.')
        }
        return { instanceId: id, role, state: 'stopped', stopped: true, results: [] }
      }
      const { host } = live ?? await ensureHostLocked(id)
      if (!host.roles.includes(role)) throw new Error(`This Agent does not run a local ${role}.`)
      const answer = await localCall(host, '/control', { role, operation })
      await recordRuntime(id)
      const result = { role, status: answer.status, state: text(answer.body.state) || 'unknown',
        ok: answer.body.ok === true, teaching: text(answer.body.teaching) }
      return { instanceId: id, role, ...answer.body, results: [result],
        stopped: operation === 'stop' && result.state === 'stopped',
        started: operation === 'start' && result.ok }
    },

    start: (id) => admit(() => lifecycle(id, async () => {
      const refusal = grantRefusal(id, { requirePaired: true })
      if (refusal !== null) throw new Error(refusal)
      const { host } = await ensureHostLocked(id)
      const results = []
      for (const role of host.roles) {
        const answer = await localCall(host, '/control', { role, operation: 'start' })
        results.push({ role, status: answer.status, state: text(answer.body.state) || (answer.body.ok ? 'ready' : 'failed'),
          ok: answer.body.ok === true, teaching: text(answer.body.teaching) })
      }
      await recordRuntime(id)
      return { instanceId: id, results, started: results.every((row) => row.ok) }
    })),

    /**
     * Stop this instance's roles, then close its host.
     *
     * `stopping` is a real answer and is passed through: a child that has been signalled and
     * has not exited is not stopped, and the host is left open so the operator can watch it.
     */
    stop: (id, { close = true } = {}) => lifecycle(id, async () => {
      const live = hosts.get(id)
      if (live === undefined) return { instanceId: id, results: [], stopped: true, open: false }
      const results = []
      for (const role of runningRoles(id)) {
        const answer = await localCall(live.host, '/control', { role, operation: 'stop' })
        results.push({ role, status: answer.status, state: text(answer.body.state) || 'unknown',
          ok: answer.body.ok === true && answer.body.state === 'stopped', teaching: text(answer.body.teaching) })
      }
      const stopped = results.every((row) => row.ok)
      if (stopped && close) await closeHostLocked(id)
      else await recordRuntime(id)
      return { instanceId: id, results, stopped, open: hosts.has(id) }
    }),

    closeHost: (id, options) => lifecycle(id, () => closeHostLocked(id, options)),

    /**
     * Attach one instance to one Agent from this device's authorized set.
     *
     * The ordinary pairing runs unchanged — a fresh per-instance proof and key, the same
     * `/local-setup` start, poll and acknowledge — and the device grant only *approves* it.
     * Nothing about the device token reaches the instance, and the Agent credential is
     * delivered encrypted to the key this instance just generated.
     */
    pair: (id, { agentId, replaceAgentToken = false } = {}) => admit(() => lifecycle(id, async () => {
      const grant = device.peek()
      if (grant.state !== 'linked') throw new Error('Sign in to a Rulith account from the manager before attaching an Agent.')
      const chosen = text(agentId).trim()
      const known = (grant.agents ?? []).find((row) => row.id === chosen)
      if (known === undefined) throw new Error('Choose one of the Agents this device is authorized for.')
      const accountId = text(grant.account?.id)
      const row = record(id)
      const config = loadInstanceConfig(resolve(row.directory))
      if (text(config.worker?.env?.RULITH_CONNECTION_KEY) || text(config.agent?.env?.RULITH_TOKEN)) {
        throw new Error(`Instance ${row.name} already holds execution credentials. Create a new instance rather than replacing them here.`)
      }
      const clientMode = row.mode === 'existing_client' ? 'existing_agent' : 'local_agent'
      // Reserve, then approve — in that order, and in one serialized registry edit.
      //
      // Reading the other instances and *then* going to the network leaves a window wide
      // enough to drive two attachments through: both read "nobody has this Agent", both call
      // the account service, and with `replaceAgentToken` set both succeed, at which point one
      // Agent has two live installations and the second silently invalidated the first's
      // token. The reservation closes that window because the registry write is the exclusive
      // step, and it is persisted because an interrupted delivery must still be able to say
      // which Agent this instance had claimed after a restart.
      //
      // The reservation records the **whole target**, and an existing one for this same
      // instance is not overwritten. Two requests for one instance naming different Agents
      // used to leave the second's reservation in place while the first was still walking to
      // the network — and the approver, which reads the persisted reservation, then spent the
      // grant on the *other* Agent and reported success to the caller who asked for neither.
      // `clientMode` is part of the target for the same reason: it decides whether an Agent
      // token is minted at all, and a delivery under the wrong one silently rewrites the
      // instance's roles.
      const target = { agentId: chosen, agentName: known.name, origin: grant.origin, accountId, clientMode,
        replaceAgentToken: replaceAgentToken === true }
      await registry.update((state) => {
        const entry = state.instances.find((candidate) => candidate.id === id)
        if (entry === undefined) throw new Error(`No local instance ${id} is registered.`)
        const existing = entry.pairing
        if (existing !== undefined && !sameTarget(existing, target)) {
          throw new Error(`Instance ${entry.name} is already attaching ${existing.agentName || existing.agentId}.`
            + ' Finish that attachment, or cancel it, before attaching a different Agent.')
        }
        const holder = state.instances.find((candidate) => candidate.id !== id
          && text(candidate.origin) === grant.origin && text(candidate.accountId) === accountId && candidate.agentId === chosen)
        if (holder !== undefined) throw new Error(`Agent ${known.name} is already attached to instance ${holder.name}. One Agent runs in one instance.`)
        const reserved = state.instances.find((candidate) => candidate.id !== id && candidate.pairing !== undefined
          && candidate.pairing.origin === grant.origin && candidate.pairing.accountId === accountId && candidate.pairing.agentId === chosen)
        if (reserved !== undefined) {
          throw new Error(`Agent ${known.name} is already being attached to instance ${reserved.name}.`
            + ' Finish or change that attachment first; one Agent runs in one instance.')
        }
        // An identical retry keeps the reservation it already made, proof and all: the setup
        // service reuses the same pairing id and secret, so this is the same request again
        // rather than a second one.
        entry.pairing = existing ?? { ...target, reservedAt: new Date().toISOString() }
        return state
      })
      try {
        // An attachment the account service already approved does not ask again. The
        // credential for that pairing exists; what is left is collecting it, and a second
        // approval would be a second request for something already granted.
        if (registry.instance(id)?.pairing?.approvedAt !== undefined) return await manager.__pairPoll(id)
        const { host } = await ensureHostLocked(id)
        const started = await localCall(host, '/setup/pair/start', { consoleUrl: grant.origin, name: row.name, clientMode })
        if (started.status !== 200 || started.body.ok === false) throw new Error(text(started.body.teaching) || 'This instance could not start a pairing.')
        return await manager.__pairPoll(id)
      } catch (error) {
        // Nothing is released here, deliberately.
        //
        // An earlier version dropped the reservation whenever the local record showed no
        // approval. That reads the absence of a *receipt* as the absence of an *effect*, and
        // the two come apart in exactly the cases that matter: an approval that succeeded and
        // whose response was lost, one still in flight, a crash between the service issuing a
        // credential and this computer writing that down. Dropping the reservation there
        // abandons a credential that exists, and — because the instance's own pending proof
        // would survive — lets a later attachment to a different Agent replay the old request.
        //
        // So a failed attempt keeps its reservation and its proof. Giving it up is an explicit
        // act that asks the authority (`cancelPairing`), and retrying is the same request.
        throw new Error(String(error?.message ?? error)
          + ` The attachment of ${known.name} to ${row.name} is still reserved: retry it, or cancel it, from the manager.`)
      }
    })),

    /**
     * Give up on an unfinished attachment — at the authority that owns it.
     *
     * This computer cannot decide this by itself. Its own record showing no delivered
     * credential proves only that it did not receive one, which is also what a lost response,
     * an in-flight approval and a crash mid-write look like from here. So the cancellation is
     * asked of the service with the pairing's original proof, through the instance that holds
     * it, and nothing local is dropped until the service answers `cancelled`.
     *
     * Three outcomes, and none of them is invented:
     *
     *   · **Cancelled.** Atomically, and no later start or approval can replay that pairing.
     *     The reservation and the pending proof go, and the Agent is free again.
     *   · **Already approved** (409 `local_setup_already_approved`). A credential exists.
     *     Nothing is touched anywhere; collecting it with "Check attachment" is what remains,
     *     and if it is genuinely unwanted, that Agent's token is revoked or replaced in
     *     Console. This manager will not make an issued credential disappear from a list.
     *   · **Not confirmed.** A timeout, a dropped response, any other error: nothing is
     *     dropped and the same cancellation can be sent again. An unknown answer is not a
     *     cancellation, and this is the one place it would be most tempting to pretend.
     */
    cancelPairing: (id) => admit(() => lifecycle(id, async () => {
      const row = record(id)
      const reservation = row.pairing
      if (reservation === undefined) return { instanceId: id, state: 'none' }
      const { host } = await ensureHostLocked(id)
      const answer = await localCall(host, '/setup/pair/cancel', {})
      if (answer.body.errorCode === 'local_setup_already_approved') {
        // Now known, from the authority rather than from a local absence. Recording it makes
        // the card offer the one action that can still finish this.
        await registry.patchInstance(id, (entry) => ({
          pairing: { ...entry.pairing, approvedAt: entry.pairing?.approvedAt ?? new Date().toISOString() } }))
        throw new Error(`The account service has already approved ${reservation.agentName || reservation.agentId} for ${row.name},`
          + ' so a credential for it exists and nothing was cancelled. Use "Check attachment" to finish collecting it —'
          + ' while its claim code remains valid. Otherwise, or if this attachment is unwanted, revoke this'
          + ' device in Console, then sign out here before connecting again.')
      }
      if (['local_setup_unknown', 'local_setup_expired'].includes(answer.body.errorCode)) {
        throw new Error('The original pairing receipt is no longer available. This does not prove that no credential was issued.'
          + ' Nothing was cleared here. Sign out and stop this computer, or revoke this device in Console, before connecting again.')
      }
      if (answer.status !== 200 || answer.body.ok === false) {
        throw new Error(String(text(answer.body.teaching) || 'The account service did not confirm the cancellation.')
          + ' Nothing was changed here, and the attachment is still reserved with its original request.'
          + ' Cancel it again to retry exactly the same cancellation.')
      }
      const state = text(answer.body.state)
      if (state !== 'cancelled' && state !== 'nothing_pending') {
        throw new Error(`The account service answered "${state || 'nothing'}" rather than confirming the cancellation.`
          + ' Nothing was changed here; cancel it again to retry the same request.')
      }
      await registry.patchInstance(id, (entry) => { delete entry.pairing; return {} })
      return { instanceId: id, state: 'cancelled', agentId: reservation.agentId }
    })),

    /**
     * Finish a pairing — the first time, or after an acknowledgement that did not complete.
     *
     * The delivered identity is checked against the **persisted** reservation and against the
     * device grant before it becomes this instance's identity. A restart between approval and
     * delivery therefore changes nothing about what this instance will accept: the reservation
     * outlived the process that made it.
     */
    pairPoll: (id) => admit(() => lifecycle(id, () => manager.__pairPoll(id))),

    __pairPoll: async (id) => {
      const row = record(id)
      const reservation = row.pairing
      if (reservation === undefined) throw new Error(`Instance ${row.name} has no attachment in progress.`)
      const grant = device.peek()
      if (text(grant.origin) !== reservation.origin || text(grant.account?.id) !== reservation.accountId) {
        throw new Error(`Instance ${row.name} reserved an Agent under a different account or Console address than the one signed in now. Attach it again.`)
      }
      const { host } = await ensureHostLocked(id)
      const polled = await localCall(host, '/setup/pair/poll', {})
      if (polled.status !== 200 || polled.body.ok === false) throw new Error(text(polled.body.teaching) || 'The pairing result could not be confirmed.')
      const saved = readJson(host.configFile + '.setup.json', {})
      const delivered = text(saved.agentId)
      if (delivered === '') return { instanceId: id, state: text(polled.body.state) || 'pending', agentId: '' }
      if (delivered !== reservation.agentId) {
        throw new Error(`Instance ${row.name} was delivered Agent ${delivered}, which is not the ${reservation.agentId} it reserved. No identity was recorded.`)
      }
      await registry.patchInstance(id, (entry) => {
        delete entry.pairing
        return { origin: reservation.origin, accountId: reservation.accountId, agentId: delivered,
          agentName: reservation.agentName, connectionId: text(saved.connectionId), signedOutAt: '' }
      })
      return { instanceId: id, state: text(polled.body.state) || 'delivered', agentId: delivered, agentName: reservation.agentName }
    },

    /**
     * Reuse the model configuration of another instance on this computer.
     *
     * One installation, several Agents, and one provider account is the ordinary case; making
     * a person paste the same endpoint and key into every instance is how that stops being
     * convenient. What moves is exactly the model settings — endpoint, name, key, thinking
     * mode — and nothing else: an Agent token or a Worker Connection copied this way would be
     * two installations sharing one identity, which is the whole thing instances exist to
     * prevent.
     *
     * The key is written into the target's configuration and is never returned; the response
     * says only which endpoint and model were applied.
     *
     * **It never tears anything down.** An earlier version refused only while the *Agent* was
     * running and then closed the host to make the new configuration take effect. For an
     * instance whose Worker was mid-call — an `existing_client` profile, or one with only the
     * Worker started — that closed the host, dropped the `hosts` entry and deleted the
     * registry's record of the child, all while the child was still draining: after which
     * `stop` answered `stopped` because there was no host to ask, and sign-out revoked the
     * device while a Worker was still executing. So this refuses while *any* role is running,
     * and applies the change through the instance's own `/setup/model` route when its host is
     * open, which updates the live configuration without closing anything.
     */
    copyModelSettings: (id, fromInstanceId) => admit(() => lifecycle(id, () => manager.__copyModelSettings(id, fromInstanceId))),

    __copyModelSettings: async (id, fromInstanceId) => {
      const target = record(id)
      const source = record(text(fromInstanceId))
      if (target.id === source.id) throw new Error('Choose a different instance to copy model settings from.')
      // A Worker-only profile has no model: its Agent is somebody else's client, and writing a
      // model endpoint into it would configure something that never reads it.
      if (target.mode !== 'local_agent') throw new Error(`Instance ${target.name} uses an existing client for its Agent, so it has no model of its own to configure.`)
      if (source.mode !== 'local_agent') throw new Error(`Instance ${source.name} uses an existing client for its Agent, so it has no model settings to copy.`)
      const grant = device.status()
      if (grant.state !== 'linked') throw new Error('Sign in to a Rulith account in the manager before copying settings between instances.')
      for (const row of [source, target]) {
        if (text(row.accountId) !== '' && (text(row.accountId) !== String(grant.account?.id ?? '') || text(row.origin) !== grant.origin)) {
          throw new Error(`Instance ${row.name} belongs to a different account or Console address than the one signed in now.`)
        }
      }
      const busy = runningRoles(id)
      if (busy.length > 0) {
        throw new Error(`Instance ${target.name} is running its ${busy.join(' and ')}. Stop it before changing its model configuration:`
          + ' this manager will not close a host while a child may still be finishing work.')
      }
      const from = loadInstanceConfig(resolve(source.directory)).agent?.env ?? {}
      const applied = {}
      for (const name of MODEL_SETTINGS) if (text(from[name]).trim() !== '') applied[name] = from[name]
      if (applied.RULITH_MODEL_URL === undefined || applied.RULITH_MODEL === undefined) {
        throw new Error(`Instance ${source.name} has no model endpoint and name configured yet.`)
      }
      const live = hosts.get(id)
      if (live === undefined) {
        const directory = resolve(target.directory)
        const config = loadInstanceConfig(directory)
        config.agent = { ...config.agent, env: { ...config.agent.env, ...applied } }
        saveInstanceConfig(directory, config)
      } else {
        // The host's own route, so the running host's configuration is the one that changes.
        const answer = await localCall(live.host, '/setup/model', {
          url: applied.RULITH_MODEL_URL, name: applied.RULITH_MODEL,
          key: applied.RULITH_MODEL_KEY ?? '',
          thinking: text(applied.RULITH_MODEL_THINKING) === 'enabled' ? 'enabled' : 'standard',
        })
        if (answer.status !== 200 || answer.body.ok === false) {
          throw new Error(text(answer.body.teaching) || `Instance ${target.name} did not accept the model configuration.`)
        }
      }
      return { instanceId: id, from: source.id,
        modelService: applied.RULITH_MODEL_URL, model: applied.RULITH_MODEL,
        modelKeyCopied: applied.RULITH_MODEL_KEY !== undefined }
    },

    /**
     * Remove an instance from the registry without touching its directory.
     *
     * Deleting credentials and history because somebody tidied a list is not a tidy-up, so
     * the files stay and the instance can be imported again from its own directory.
     */
    forget: (id) => admit(() => lifecycle(id, () => manager.__forget(id))),

    __forget: async (id) => {
      if (runningRoles(id).length > 0) throw new Error('Stop this instance before removing it from the list.')
      await closeHostLocked(id)
      const row = record(id)
      await registry.update((state) => { state.instances = state.instances.filter((entry) => entry.id !== id); return state })
      return { instanceId: id, directory: row.directory }
    },

    /**
     * Sign out and stop this device, in the only order that can be reported honestly.
     *
     * 1. Stop every child and **observe** it stop. Not a request — an observed exit.
     * 2. Revoke the device grant at the Gateway.
     * 3. Only then forget the device record and the credentials it issued.
     *
     * Any step that does not complete leaves the status incomplete, with the device record
     * and its revoke request id intact so the retry is the same request rather than a new
     * one. Reporting "signed out" while a child is still running, or while the Gateway still
     * accepts the grant, would be a claim about the world rather than about this computer.
     */
    signOut: async () => {
      if (phase !== 'ready') throw new Error(phaseTeaching())
      await drain('signing_out')
      try {
        return await manager.__signOut()
      } finally {
        // Complete or not, this manager is usable again: an incomplete sign-out must not
        // leave an installation that refuses everything, and a finished one is a manager you
        // can sign back into.
        if (phase === 'signing_out') phase = 'ready'
      }
    },

    __signOut: async () => {
      const state = registry.read()
      const running = []
      for (const row of state.instances) {
        if (hosts.has(row.id)) {
          const result = await manager.stop(row.id)
          if (!result.stopped) running.push({ id: row.id, name: row.name, results: result.results })
        } else {
          const results = survivingProcesses(row)
          if (results.length > 0) running.push({ id: row.id, name: row.name, results })
        }
      }
      if (running.length > 0) {
        const progress = { state: 'incomplete', step: 'stop', at: new Date().toISOString(), instances: running.map((row) => row.name) }
        await device.noteSignOut(progress)
        return { state: 'incomplete', step: 'stop', running,
          teaching: 'Some instances are still running, so this device was not revoked and is still signed in. Stop them and sign out again.' }
      }
      // Asked again, right before the irreversible step. The drain is what makes this
      // unreachable; checking anyway is what makes "nothing was running when this device was
      // revoked" a fact this code verified rather than one it inferred from its own design.
      const late = registry.read().instances.filter((row) => runningRoles(row.id).length > 0 || survivingProcesses(row).length > 0)
      if (late.length > 0) {
        return { state: 'incomplete', step: 'stop',
          running: late.map((row) => ({ id: row.id, name: row.name, results: survivingProcesses(row) })),
          teaching: `${late.map((row) => row.name).join(', ')} started running while this sign-out was in progress, so this device was not revoked.`
            + ' Nothing was revoked and nothing was cleared; sign out again.' }
      }
      let revoked
      try { revoked = await device.revoke() } catch (error) {
        const progress = { state: 'incomplete', step: 'revoke', at: new Date().toISOString(), teaching: String(error?.message ?? error) }
        await device.noteSignOut(progress)
        return { state: 'incomplete', step: 'revoke', teaching: 'Every instance stopped, but the account service did not confirm the revocation, so this device is still signed in. Retry sign-out: it repeats the same revoke request.' + ` (${String(error?.message ?? error)})` }
      }
      // `alreadyRevoked` is the browser having revoked this device first. The revocation this
      // computer wanted is a fact either way, so the rest of the sign-out proceeds; only the
      // report distinguishes them, because the audit entry belongs to whoever made it.
      const cleared = clearIssuedCredentials(state.instances)
      await registry.update((current) => {
        for (const row of current.instances) {
          row.origin = ''
          row.accountId = ''
          row.agentId = ''
          row.agentName = ''
          row.connectionId = ''
          row.signedOutAt = new Date().toISOString()
          // A reservation names an Agent of a grant that no longer exists; keeping it would
          // block that Agent from being attached again after the next sign-in.
          delete row.pairing
        }
        current.device = { state: 'none' }
        return current
      })
      device.clear()
      return { state: 'signed_out', revokeState: revoked.state, alreadyRevoked: revoked.alreadyRevoked === true, cleared }
    },

    /**
     * Clear a grant this computer can no longer use, having first tried once more to revoke it.
     *
     * Reachable only when the account service has already stopped accepting the grant, or when
     * nothing was ever delivered under it. A grant that is still live is withdrawn through
     * `signOut`, because forgetting a working token would leave a device authorized with
     * nobody here able to withdraw it.
     *
     * The retry matters: "the service refused us" and "the revocation happened" are different
     * facts, and a lost response produces the first while leaving the second unknown. So the
     * exact same revoke request is sent once more — same request id, so the audit record still
     * has one revocation in it — and its outcome is reported rather than assumed. An
     * unconfirmed revoke does not block the local clean-up here, because the credentials on
     * this computer are already refused by the service and leaving them on disk protects
     * nothing; what it does is say so.
     */
    forgetDevice: async () => {
      if (phase !== 'ready') throw new Error(phaseTeaching())
      await drain('signing_out')
      try {
        return await manager.__forgetDevice()
      } finally {
        if (phase === 'signing_out') phase = 'ready'
      }
    },

    __forgetDevice: async () => {
      const grant = device.peek()
      const state = grant.state ?? 'none'
      if (state === 'linked' || state === 'approved') {
        throw new Error('This device is still signed in. Use "Sign out and stop this device" so the authorization is revoked at the account service.')
      }
      if (state === 'none' || state === 'pending') { device.clear(); return { state: 'none', cleared: [], revoke: 'not_issued' } }
      const running = []
      for (const row of registry.read().instances) {
        if (hosts.has(row.id)) {
          const result = await manager.stop(row.id)
          if (!result.stopped) running.push({ id: row.id, name: row.name, results: result.results })
        } else {
          const results = survivingProcesses(row)
          if (results.length > 0) running.push({ id: row.id, name: row.name, results })
        }
      }
      if (running.length > 0) {
        return { state: 'incomplete', step: 'stop', running,
          teaching: 'Some instances are still running. Stop them before clearing the credentials this authorization issued.' }
      }
      const late = registry.read().instances.filter((row) => runningRoles(row.id).length > 0 || survivingProcesses(row).length > 0)
      if (late.length > 0) {
        return { state: 'incomplete', step: 'stop',
          running: late.map((row) => ({ id: row.id, name: row.name, results: survivingProcesses(row) })),
          teaching: 'Some processes are still running. Nothing was revoked or cleared; stop them and retry.' }
      }
      let revoke = 'not_issued'
      let revokeTeaching = ''
      if (state === 'unreadable') {
        // The credential that would have withdrawn this grant is the thing that could not be
        // read. Clearing the record is all this computer can do, and claiming a revocation it
        // never attempted would be the lie that matters most here.
        revoke = 'unreadable'
      } else if (text(grant.token) !== '') {
        try {
          const result = await device.revoke()
          revoke = result.alreadyRevoked ? 'already_revoked' : 'confirmed'
        } catch (error) {
          revoke = 'unconfirmed'
          revokeTeaching = String(error?.message ?? error)
        }
      }
      const cleared = clearIssuedCredentials(registry.read().instances)
      await registry.update((current) => {
        for (const row of current.instances) { Object.assign(row, { origin: '', accountId: '', agentId: '', agentName: '', connectionId: '', signedOutAt: new Date().toISOString() }); delete row.pairing }
        current.device = { state: 'none' }
        return current
      })
      device.clear()
      return { state: 'none', cleared, revoke,
        ...(revoke === 'unconfirmed'
          ? { teaching: `The credentials this authorization issued were cleared from every instance, and the account service did not confirm the revocation (${revokeTeaching}). It had already refused this device, so nothing here can still execute; check the device list in Console.` }
          : revoke === 'unreadable'
            ? { teaching: 'The device record could not be read, so the credential that would have revoked this device could not be used.'
                + ' Every instance was stopped and the credentials it issued were cleared from this computer; revoke this device in Console to withdraw it there.' }
            : {}) }
    },

    /**
     * The manager process is ending, so every host goes with it.
     *
     * Forced, because there is nothing left to protect the children *for*: this process is
     * exiting either way, and the IPC channel closing is what ends them. Every other caller
     * must stop and observe first.
     */
    closeAll: async () => {
      await drain('closing')
      const unobserved = []
      const failures = []
      // Until empty, not once over a snapshot: the loop itself awaits, and a host that was
      // being created when the drain began lands in `hosts` between iterations.
      while (hosts.size > 0) {
      for (const id of [...hosts.keys()]) {
        // Through the lock, so a shutdown racing an open or a start does not close a host
        // somebody is halfway through creating.
        try {
          const result = await lifecycle(id, () => closeHostLocked(id, { force: true }))
          if (result.unobserved.length > 0) unobserved.push({ instanceId: id, children: result.unobserved })
        } catch (error) {
          failures.push({ instanceId: id, teaching: String(error?.message ?? error) })
          hosts.delete(id)
        }
      }
      }
      // Reported, not swallowed. A shutdown that could not record what it still owns, or that
      // left a child running, is a thing the next run needs to know and the operator may need
      // to act on; `close()` returning quietly would be this manager's last untrue statement.
      return { unobserved, failures }
    },
  }
  return manager
}

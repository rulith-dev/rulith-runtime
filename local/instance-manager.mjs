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
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createLocalHost, defaultLocalConfig, normalizeLocalConfig } from './rulith-local.mjs'
import { newInstanceId, writeJsonAtomic } from './manager-registry.mjs'
import { instanceRecordedAt, processRecordRunning, processStamp } from './process-identity.mjs'
import { checkedModelInput, createModelSettings, maxOutputTokens, modelSignature, modelView, resolvedKey } from './model-settings.mjs'
import { createToolLibrary } from './tool-library.mjs'

export const INSTANCE_MODES = Object.freeze(['local_agent', 'existing_client'])
/** Credentials a sign-out must remove from an instance; everything else is the operator's. */
const ISSUED_CREDENTIALS = Object.freeze({ agent: ['RULITH_TOKEN'], worker: ['RULITH_CONNECTION', 'RULITH_CONNECTION_KEY'] })

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
 * @param {object} options
 * @param {ReturnType<import('./manager-registry.mjs').createManagerRegistry>} options.registry
 * @param {ReturnType<import('./device-client.mjs').createDeviceClient>} options.device
 */
export function createInstanceManager({ registry, device, startConfirmMs, managerReturnUrl, orphanRecheckMs = 10_000 }) {
  /** Live hosts, by instance id. Created once, cached, never re-created on selection. */
  const hosts = new Map()
  const instancesRoot = join(registry.root, 'instances')
  const modelSettings = createModelSettings({ root: registry.root })
  /**
   * The tools every Agent in this installation shares (`tool-library.mjs`), and the one place that
   * turns "this Agent is on the environment's tools" into what its Worker is started with.
   *
   * It lives beside the instances, not in one of them: an instance is still the only home of what
   * differs between two Agents — identity, workspace, materials, conversations — and the library
   * holds what two Agents should not have to keep twice. An instance reaches it only through the
   * composition its host runs at each Worker start, which is why `managerExposure` can go on
   * refusing every path an instance names inside the manager directory.
   */
  const library = createToolLibrary({ registry, hosts, loadConfig: loadInstanceConfig })

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
  // A crash-restart timer may have expired while admission was closed. Resume its
  // existing retry budget once the manager is ready; each host checks its grant again.
  const resumeWorkers = () => Promise.all([...hosts.values()].map(({ host }) => host.resumeWorker()))

  const record = (id) => {
    const row = registry.instance(id)
    if (row === undefined) throw new Error(`No local instance ${id} is registered.`)
    return row
  }

  const scopeFor = (row) => ({ origin: text(row.origin) || text(row.setupTarget?.origin),
    accountId: text(row.accountId) || text(row.setupTarget?.accountId) })
  const currentScope = (grant = device.status()) => ({ origin: text(grant.origin), accountId: text(grant.account?.id) })
  const modelSource = (row) => row.mode === 'existing_client' ? 'external' : row.modelSource === 'default' ? 'default' : 'custom'
  const defaultFor = (row, grant = device.status()) => {
    const scope = scopeFor(row), current = currentScope(grant)
    if (grant.state !== 'linked' || !scope.origin || scope.origin !== current.origin || scope.accountId !== current.accountId) return undefined
    return modelSettings.read(scope.origin, scope.accountId)
  }
  const modelFor = (row, grant = device.status()) => {
    const source = modelSource(row)
    if (source === 'external') return { source, url: '', name: '', key: '', thinking: 'standard' }
    if (source === 'default') return { source, ...(defaultFor(row, grant) ?? {}) }
    const env = loadInstanceConfig(resolve(row.directory)).agent?.env ?? {}
    return { source, url: text(env.RULITH_MODEL_URL), name: text(env.RULITH_MODEL), key: text(env.RULITH_MODEL_KEY),
      thinking: ['enabled', 'disabled'].includes(env.RULITH_MODEL_THINKING) ? env.RULITH_MODEL_THINKING : 'standard',
      maxOutputTokens: env.RULITH_MODEL_MAX_OUTPUT_TOKENS }
  }
  const publicModel = (row, grant = device.status()) => {
    const result = modelView(modelFor(row, grant))
    if (result.source === 'external') return { ...result, configured: false, ready: true, reason: '' }
    return result
  }
  const defaultView = (grant = device.status()) => {
    const scope = currentScope(grant)
    const value = grant.state === 'linked' ? modelSettings.read(scope.origin, scope.accountId) : undefined
    const view = modelView({ source: 'default', ...(value ?? {}) })
    return { available: grant.state === 'linked', origin: scope.origin, accountId: scope.accountId,
      url: view.url, name: view.name, thinking: view.thinking, maxOutputTokens: view.maxOutputTokens,
      keyConfigured: view.keyConfigured, configured: view.configured, reason: view.reason }
  }
  const assertExpectedScope = ({ expectedOrigin, expectedAccountId }) => {
    const grant = device.status(), current = currentScope(grant)
    if (grant.state !== 'linked' || text(expectedOrigin) !== current.origin || text(expectedAccountId) !== current.accountId) {
      throw new Error('The account or Console address changed. Reopen model settings before saving.')
    }
    return { grant, ...current }
  }
  const assertRowScope = (row, scope) => {
    const owned = scopeFor(row)
    if (owned.origin && (owned.origin !== scope.origin || owned.accountId !== scope.accountId)) {
      throw new Error(`Instance ${row.name} belongs to a different account or Console address than the one open in this page.`)
    }
  }
  /** Refresh an open Worker-only host immediately before its Agent is started. */
  const refreshInheritedModel = (id, row, grant = device.status()) => {
    if (modelSource(row) !== 'default' || runningRoles(id).includes('agent')) return
    const live = hosts.get(id)
    if (live === undefined) return
    const inherited = defaultFor(row, grant)
    live.host.setAgentModel({ url: text(inherited?.url), name: text(inherited?.name), key: text(inherited?.key),
      thinking: inherited?.thinking, maxOutputTokens: inherited?.maxOutputTokens })
    live.inheritedModelSignature = modelSignature(inherited ?? {})
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
   * host's own conversation, Worker setting and setup routes consult. Those routes are reachable by anyone
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
      return `Agent ${row.agentName || attached} is no longer enabled in this account. Refresh Agents after enabling it in Console, then attach this instance again.`
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
   * An instance host can change what is executing or what identity is being configured
   * through first-message startup, `POST /worker-setting`, and `POST /setup/*`. All are reachable from
   * that instance's own page. For a *managed* instance that page is not the authority — the
   * device grant is — so the host consults this before each operation.
   *
   * Pairing is the sharper case: `/setup/pair/start` opened directly from an instance page
   * would begin a pairing the manager did not ask for and had no chance to reserve, which is
   * the duplicate-attach hole reopened through the side door. So pairing is refused unless
   * this manager has a *persisted* reservation for this exact instance.
   */
  const policyFor = (id) => ({ kind, path, role, fromOwner }) => {
    // An instance page reaches its own host directly, so the drain has to be visible from
    // there too — otherwise signing out races a role somebody just started from a browser
    // tab. The manager's own calls are exempt: they belong to an operation that was already
    // admitted, and refusing them here would abandon work half-done. Stopping is not gated at
    // all: `policyFor` is consulted for automatic starts, settings and `/setup/*`.
    if (phase !== 'ready' && fromOwner !== true) return phaseTeaching()
    if (kind === 'start') {
      const refusal = grantRefusal(id, { requirePaired: true })
      if (refusal !== null) return refusal
      const row = record(id)
      if (role === 'agent' && row.mode === 'local_agent' && !publicModel(row).ready) {
        return `Instance ${row.name} has no ready model configuration. Set a default model or choose a custom model before starting its Agent.`
      }
      if (role === 'agent') refreshInheritedModel(id, row)
      return null
    }
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
    const approved = await device.pair({ pairingId, deviceSecret, agentId: reservation.agentId,
      replaceAgentToken: reservation.replaceAgentToken === true, reconnectConnectionId: reservation.reconnectConnectionId })
    const agentId = text(approved?.agentId).trim() || reservation.agentId
    if (agentId !== reservation.agentId) throw new Error('The account service approved a different Agent than this instance reserved.')
    await registry.patchInstance(id, (row) => ({ pairing: { ...row.pairing, lastError: undefined, pairingId, approvedAt: new Date().toISOString() } }))
    await device.recordPairing(id, { pairingId, agentId, origin: base, accountId: text(grant.account?.id) })
    return { agentId }
  }

  /** The manager alone spends its device grant for an exact, already durable Host click. */
  const registerMaterialSubmissionFor = (id) => async (receipt) => {
    if (phase !== 'ready') throw new Error(phaseTeaching())
    const row = record(id), grant = device.status()
    const refusal = grantRefusal(id, { requirePaired: true, grant, row })
    if (refusal !== null || receipt?.agent !== row.agentId
      || hosts.get(id)?.host.agentId !== row.agentId) {
      throw new Error(refusal ?? 'The submitted material belongs to a different Agent or instance.')
    }
    const scope = { origin: row.origin, accountId: row.accountId, agentId: row.agentId,
      connectionId: row.connectionId, deviceId: grant.deviceId }
    const answer = await device.registerMaterialSubmission({
      expectedAccountId: scope.accountId, agentId: scope.agentId,
      submissionId: receipt.submissionId, requestId: receipt.requestId,
      sessionKey: receipt.sessionKey, attachments: receipt.attachments,
      custodyBindings: receipt.custodyBindings,
      proofDigest: receipt.proofDigest, selectionDigest: receipt.selectionDigest,
      ...(receipt.targetCaseId ? { targetCaseId: receipt.targetCaseId } : {}),
    })
    const latest = record(id), current = device.status()
    if (phase !== 'ready' || Object.entries(scope).some(([field, value]) =>
      (field === 'deviceId' ? current.deviceId : field === 'accountId' ? latest.accountId
        : latest[field]) !== value)
      || current.origin !== scope.origin || text(current.account?.id) !== scope.accountId
      || grantRefusal(id, { requirePaired: true, grant: current, row: latest }) !== null
      || hosts.get(id)?.host.agentId !== scope.agentId) {
      throw new Error('The instance, account, or Agent changed before material registration completed.')
    }
    return answer
  }

  const acceptedMaterialBindingFor = (id) => async (receipt) => {
    if (phase !== 'ready') throw new Error(phaseTeaching())
    const row = record(id), grant = device.status()
    const refusal = grantRefusal(id, { requirePaired: true, grant, row })
    if (refusal !== null || receipt?.agent !== row.agentId
      || hosts.get(id)?.host.agentId !== row.agentId) {
      throw new Error(refusal ?? 'The durable submission belongs to a different Agent or instance.')
    }
    const binding = await device.acceptedMaterialBinding({ expectedAccountId: row.accountId, receipt })
    const latest = record(id), current = device.status()
    if (phase !== 'ready' || latest.accountId !== row.accountId || latest.agentId !== row.agentId
      || latest.origin !== row.origin || current.deviceId !== grant.deviceId
      || current.origin !== row.origin || text(current.account?.id) !== row.accountId
      || grantRefusal(id, { requirePaired: true, grant: current, row: latest }) !== null
      || hosts.get(id)?.host.agentId !== row.agentId) {
      throw new Error('The instance, account, or Agent changed before the Case binding was confirmed.')
    }
    return binding
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
    if (row.runtime !== undefined && row.runtime.pid !== process.pid
      && processRecordRunning(row.runtime, { recordedAt: instanceRecordedAt(row) })) {
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
    // Defaults are resolved only as a host is built, under the account that currently owns
    // this instance. They are never copied to local.json, so a later sign-in cannot inherit
    // a prior account's provider key through an old profile file.
    const inherited = modelSource(row) === 'default' ? defaultFor(row) : undefined
    const taken = new Set([...hosts.values()].flatMap((entry) => [entry.host.port, entry.servePort]))

    const wanted = Number(config.agent?.env?.RULITH_SERVE_PORT ?? 0)
    let servePort = wanted
    if (!Number.isSafeInteger(wanted) || wanted <= 0 || taken.has(wanted) || !(await portAvailable(wanted))) {
      servePort = await freePort(taken)
      config.agent = { ...config.agent, env: { ...config.agent.env, RULITH_SERVE_PORT: String(servePort) } }
      saveInstanceConfig(directory, config)
    }
    const toolLibrary = library.forInstance(id)
    const build = (hostPort) => createLocalHost({
      configFile: instanceConfigFile(directory), config, roles: config.roles, port: hostPort,
      autoStart: true, isolateEnvironment: true,
      ...(row.origin && row.accountId && row.agentId ? { conversationOwner: { origin: row.origin, accountId: row.accountId, agentId: row.agentId } } : {}),
      setupApprover: device === undefined ? undefined : approverFor(id),
      registerMaterialSubmission: registerMaterialSubmissionFor(id),
      acceptedMaterialBinding: acceptedMaterialBindingFor(id),
      // This is a private launch input, derived from the live, confirmed device record.
      // It is never copied into local.json or served by the instance page.
      getApprovedDeviceId: () => {
        const current = device.status(), latest = record(id)
        if (phase !== 'ready' || current.state !== 'linked' || !text(current.deviceId)
          || grantRefusal(id, { requirePaired: true, grant: current, row: latest }) !== null) return ''
        return current.deviceId
      },
      managedPolicy: policyFor(id),
      managedCallToken,
      protectedPaths: [registry.root],
      toolLibrary,
      onChildChange: (children) => {
        // The record of which processes this instance owns comes first, and nothing below can keep it
        // from being written: it is what the next manager reads after a crash, and the host that calls
        // this swallows whatever an owner throws.
        const recorded = recordRuntime(id, children)
        // The files a Worker was composed into hold service credentials, so they go with the Worker. A
        // file that will not go (Windows can hold one open for a scanner) is retried by the library;
        // that it is wrapped here is only so that this callback cannot throw.
        if (!children.some((child) => child.role === 'worker')) {
          try { toolLibrary.stopped() } catch { /* `stopped` retries what it could not remove and does not throw */ }
        }
        return recorded
      },
      onModelConfigured: () => registry.patchInstance(id, () => ({ modelSource: 'custom' })),
      authorizeConnectionKey: async ({ expectedOrigin, expectedAccountId, expectedAgentId, expectedConnectionId }) => {
        const current = record(id), grant = device.status()
        if (text(expectedOrigin) !== text(grant.origin) || text(expectedAccountId) !== text(grant.account?.id)
          || current.origin !== expectedOrigin || current.accountId !== expectedAccountId
          || current.agentId !== expectedAgentId || current.connectionId !== expectedConnectionId) {
          throw new Error('The account, Agent, or Connection changed while the replacement key was being verified. Nothing was saved.')
        }
        const refusal = grantRefusal(id, { requirePaired: true, grant, row: current })
        if (refusal !== null) throw new Error('The account or Agent is no longer available for this Connection. Nothing was saved.')
      },
      modelOverlay: modelSource(row) === 'default' ? {
        RULITH_MODEL_URL: text(inherited?.url), RULITH_MODEL: text(inherited?.name),
        RULITH_MODEL_KEY: text(inherited?.key), RULITH_MODEL_THINKING: ['enabled', 'disabled'].includes(inherited?.thinking) ? inherited.thinking : '',
        RULITH_MODEL_MAX_OUTPUT_TOKENS: String(inherited?.maxOutputTokens ?? 6000),
      } : undefined,
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
    const entry = { host, servePort, directory, hostGeneration: randomUUID(),
      inheritedModelSignature: inherited === undefined ? '' : modelSignature(inherited) }
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
   *
   * Each process is written down with what identifies it (`process-identity.mjs`): this
   * manager's own stamp, taken once and naming the script this process was started with, and
   * each child's, taken by the host the moment it spawned that child. A later run can then tell a
   * recorded process from an unrelated one that was given the same pid, which after a reboot is
   * the ordinary case on Windows.
   */
  const runtimeRecordFailures = new Map()
  const accessStopWarnings = new Map()
  const managerStamp = processStamp(process.pid, { script: process.argv[1] })
  const recordRuntime = async (id, children) => {
    const live = hosts.get(id)
    if (live === undefined) return
    const observed = children ?? live.host.children()
    const write = () => registry.patchInstance(id, () => ({ hostPort: live.host.port, servePort: live.servePort,
      runtime: { pid: process.pid, ...managerStamp, children: observed } }))
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
      runtime: { pid: process.pid, ...managerStamp, children: unobserved },
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
    && text(existing.reconnectConnectionId) === text(target.reconnectConnectionId)

  /** The roles this instance is actually running right now, if its host is open. */
  const runningRoles = (id) => {
    const live = hosts.get(id)
    if (live === undefined) return []
    const status = live.host.status()
    return ['agent', 'worker'].filter((role) => status[role] === true)
  }

  // A dead host is not evidence that its children stopped. Inspect recorded processes again on
  // every attempt, so an orphan blocks credential cleanup only while it is actually alive — and
  // only while the process under its pid is still the recorded one. A pid that an unrelated
  // program took over after a reboot is not a running Agent (`process-identity.mjs`).
  const survivingProcesses = (row) => {
    const recordedAt = instanceRecordedAt(row)
    const children = [...(row.runtime?.children ?? []), ...(row.orphaned?.children ?? [])]
    const seen = new Set()
    const results = children.filter((child) => {
      if (seen.has(child.pid) || !processRecordRunning(child, { recordedAt })) return false
      seen.add(child.pid)
      return true
    }).map((child) => ({ role: child.role, pid: child.pid, state: 'elsewhere', ok: false,
      teaching: `The ${child.role} process ${child.pid} is still running outside this workbench. Stop it before clearing its credentials.` }))
    if (row.runtime && row.runtime.pid !== process.pid && processRecordRunning(row.runtime, { recordedAt })) {
      results.push({ role: 'host', pid: row.runtime.pid, state: 'elsewhere', ok: false,
        teaching: `This instance is open in another Rulith workbench (process ${row.runtime.pid}); stop it there first.` })
    }
    return results
  }
  /**
   * Which Agents are still running, and what, in one line an operator can act on.
   *
   * The account notice shows only a teaching, so the names and pids that decide what to stop
   * have to be in it. Before this, "Some instances are still running" left the operator to
   * work out which process, which is how an unrelated terminal holding a reused pid went
   * unnoticed.
   */
  const stillRunning = (running) => running.map((row) => {
    const parts = (row.results ?? []).filter((result) => result.ok !== true).map((result) =>
      result.role === 'host' ? `open in another workbench${result.pid ? `, process ${result.pid}` : ''}`
        : `${result.role === 'agent' ? 'Agent' : result.role === 'worker' ? 'Worker' : String(result.role ?? 'process')}`
          + `${result.pid ? ` process ${result.pid}` : ''}${result.state === 'stopping' ? ' still stopping' : ''}`)
    return parts.length === 0 ? row.name : `${row.name} (${parts.join(', ')})`
  }).join('; ')

  /**
   * Clear orphan markers whose processes have ended since the last check, without a restart.
   *
   * A marker is re-examined when a host is opened and when the workbench starts. Neither
   * happens while an operator is looking at "processes from a manager that is gone are still
   * running", and the controls that would open a host are exactly the ones that marker
   * disables. So while any marker exists, the page's own polling re-runs the same
   * `reclaimStale` — at most every ten seconds, never while closing — and a marker whose
   * processes the operator has since stopped clears by itself. Nothing is cleared that the
   * startup check would have kept.
   */
  let orphanRecheck
  let orphanRecheckAt = -Infinity
  const recheckOrphans = (rows) => {
    if (phase === 'closing' || orphanRecheck !== undefined || performance.now() - orphanRecheckAt < orphanRecheckMs) return
    orphanRecheckAt = performance.now()
    // Asked outside the registry lock, and the registry is written only when `reclaimStale` would
    // change something: a marker whose manager is gone names a process that has ended. While
    // every orphan still runs, or the manager's own record still looks alive, nothing is rewritten.
    const ended = rows.some((row) => {
      if (row.orphaned === undefined || row.runtime === undefined) return false
      const recordedAt = instanceRecordedAt(row)
      if (processRecordRunning(row.runtime, { recordedAt })) return false
      return (row.orphaned.children ?? []).some((child) => !processRecordRunning(child, { recordedAt }))
    })
    if (!ended) return
    orphanRecheck = registry.reclaimStale().catch(() => undefined).finally(() => { orphanRecheck = undefined })
  }

  const rememberPairingError = (id, error) => registry.patchInstance(id, (row) => row.pairing ? {
    pairing: { ...row.pairing, lastError: {
      code: text(error?.errorCode).slice(0, 100), teaching: String(error?.message ?? error).slice(0, 2000),
    } },
  } : {})

  /** What a page may be told about how an Agent gets its tools: which way, and why not the library if it does not. */
  const toolsView = (row) => (row.tools === undefined ? null
    : { source: row.tools.source === 'library' ? 'library' : 'own', conflicts: row.tools.conflicts ?? [], notice: row.tools.notice ?? null })

  const manager = {
    hosts,
    instancesRoot,
    library,
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
      const rows = registry.read().instances
      if (rows.some((row) => row.orphaned !== undefined)) recheckOrphans(rows)
      return rows.map((row) => {
      const live = hosts.get(row.id)
      const status = live?.host.status()
      if (runningRoles(row.id).length === 0) accessStopWarnings.delete(row.id)
      const model = publicModel(row, grant)
      const worker = loadInstanceConfig(resolve(row.directory)).worker?.env ?? {}
      const manifest = readJson(text(worker.RULITH_TOOLS_FILE), { tools: {} })
      const toolDescriptors = Object.entries(manifest?.tools ?? {}).map(([id, value]) => ({
        id, title: text(value?.title) || id, sourceTypes: Array.isArray(value?.sourceTypes) ? value.sourceTypes : [],
        digest: text(value?.digest),
      }))
      return {
        id: row.id, name: row.name, mode: row.mode, directory: row.directory,
        createdAt: row.createdAt ?? '', importedFrom: row.importedFrom ?? '',
        origin: row.origin ?? '', accountId: row.accountId ?? '', agentId: row.agentId ?? '',
        agentName: row.agentName ?? '', connectionId: row.connectionId ?? '', paired: Boolean(row.agentId || row.connectionId),
        open: live !== undefined, roles: status?.roles ?? [],
        agent: status?.agent === true, worker: status?.worker === true,
        workerSetting: status?.workerSetting ?? { enabled: loadInstanceConfig(resolve(row.directory)).worker.enabled === true,
          visible: row.mode === 'existing_client' || loadInstanceConfig(resolve(row.directory)).worker.enabled === true || Object.keys(manifest?.tools ?? {}).length > 0
            || (row.tools?.source === 'library' && library.hasTools()),
          state: row.connectionId ? 'offline' : 'needs setup' },
        agentReloading: status?.agentReloading === true,
        ready: status?.ready ?? { agent: false, worker: false },
        tools: toolsView(row),
        // Everything a card needs to explain why a button is unavailable, computed from the
        // device grant rather than from what the page last saw.
        pendingAgentId: row.pairing?.agentId ?? '', pendingAgentName: row.pairing?.agentName ?? '',
        pendingError: row.pairing?.lastError ?? null,
        pendingReplace: row.pairing?.replaceAgentToken === true,
        pendingReconnect: text(row.pairing?.reconnectConnectionId),
        pendingOrigin: row.pairing?.origin ?? '', pendingAccountId: row.pairing?.accountId ?? '',
        setupTarget: row.setupTarget ?? null,
        model,
        pendingApproved: row.pairing?.approvedAt !== undefined,
        blocked: grantRefusal(row.id, { requirePaired: true, grant, row }) ?? '',
        orphaned: row.orphaned ?? null,
        runtimeRecordWarning: runtimeRecordFailures.get(row.id) ?? '',
        accessStopWarning: accessStopWarnings.get(row.id) ?? '',
        legacyImport: row.importedFrom === undefined ? null : { configFile: row.importedFrom, credentialsLeftInPlace: row.legacyCredentials ?? [] },
        // Reported by the running child, not by this registry: a stored id is a memory of an
        // identity, and only the process can say which one it is actually using.
        runningAgentId: live === undefined ? '' : String(live.host.agentId ?? ''),
        hostPort: live === undefined ? 0 : live.host.port, hostGeneration: live?.hostGeneration ?? '', servePort: live?.servePort ?? row.servePort ?? 0,
        signedOutAt: row.signedOutAt ?? '',
        // Attachments and immutable checked results are the profile's material store, never the
        // Worker workspace (which is mutable tool scratch space).
        authoring: { materialRoot: join(resolve(row.directory), 'materials'), toolDescriptors },
      }
      })
    },

    modelDefaults: () => defaultView(),

    /**
     * Move every Agent whose tools can move into the environment's, once, as the workbench starts.
     * Nothing is started or stopped by it, and an Agent it cannot move keeps working on its own files.
     */
    migrateTools: () => admit(async () => { const outcome = await library.migrateAll(); await library.reloadAffected(); return outcome }),
    /**
     * "Check again" for one Agent that kept its own tools: try to move it now, then reload the
     * Workers the environment's new tools reach. Refused while this Agent's own Worker runs.
     */
    checkTools: (id) => admit(() => lifecycle(id, async () => {
      const outcome = await library.migrateInstance(id)
      const { pending } = await library.reloadAffected()
      return { instanceId: id, teaching: outcome.teaching + library.pendingNote(pending, 'Checked;') }
    })),

    /** Refresh the enabled account directory, then stop profiles whose Agent was disabled.
     * The refresh is not an authorization expansion: it records the service's current
     * directory, and a removed Agent is stopped through the same observed-stop path as
     * sign-out before this method reports it stopped. */
    refreshDevice: () => admit(async () => {
      const before = device.status()
      const stopRows = async rows => {
        const stopped = [], stopping = []
        for (const row of rows) {
          try {
            const result = await manager.stop(row.id)
            ;(result.stopped ? stopped : stopping).push({ id: row.id, name: row.name, results: result.results })
            if (result.stopped) accessStopWarnings.delete(row.id)
            else accessStopWarnings.set(row.id, 'Account access changed. Local roles have been asked to stop and have not exited. Check their executions in Console.')
          } catch (error) {
            stopping.push({ id: row.id, name: row.name, teaching: String(error?.message ?? error) })
            accessStopWarnings.set(row.id, 'Account access changed and stopping local processes failed: ' + String(error?.message ?? error))
          }
        }
        return { stoppedInstances: stopped, stoppingInstances: stopping }
      }
      let refreshed
      try { refreshed = await device.refresh() }
      catch (error) {
        // Only a confirmed device refusal withdraws access. A transient outage preserves
        // the last directory and must not stop unrelated running work.
        const after = device.status()
        if (['unusable', 'revoked', 'expired'].includes(after.state) && after.deviceId === before.deviceId) {
          const outcome = await stopRows(registry.read().instances.filter(row => row.origin === before.origin && row.accountId === String(before.account?.id ?? '')))
          Object.assign(error, outcome)
          if (outcome.stoppingInstances.length) error.message += ' Local processes still need attention: ' + outcome.stoppingInstances.map(row => row.name).join(', ') + '.'
        }
        throw error
      }
      const beforeIds = new Set((before.agents ?? []).map(agent => agent.id))
      const afterIds = new Set((refreshed.agents ?? []).map(agent => agent.id))
      const addedAgents = (refreshed.agents ?? []).filter(agent => !beforeIds.has(agent.id))
      const removedAgents = (before.agents ?? []).filter(agent => !afterIds.has(agent.id))
      const outcome = await stopRows(registry.read().instances.filter(row => row.agentId && row.origin === refreshed.origin
        && row.accountId === String(refreshed.account?.id ?? '') && !afterIds.has(row.agentId)))
      return { addedAgents, removedAgents, ...outcome }
    }),

    setDefaultModel: (body = {}) => admit(async () => {
      const scope = assertExpectedScope(body)
      const input = checkedModelInput(body)
      const previous = modelSettings.read(scope.origin, scope.accountId)
      const saved = modelSettings.save(scope.origin, scope.accountId, {
        url: input.url, name: input.name,
        key: resolvedKey(previous, input.url, input),
        thinking: body.thinking === undefined ? (['enabled', 'disabled'].includes(previous?.thinking) ? previous.thinking : 'standard') : input.thinking,
        maxOutputTokens: body.maxOutputTokens === undefined ? maxOutputTokens(previous?.maxOutputTokens) : input.maxOutputTokens,
      })
      // A Worker may remain up while its Agent is stopped. Update that open host's in-memory
      // inherited values so the *next* Agent start uses the new default without closing the
      // Worker or writing the default key into the profile.
      for (const [id, live] of hosts) {
        const row = registry.instance(id)
        if (row === undefined || modelSource(row) !== 'default') continue
        const rowScope = scopeFor(row)
        if (rowScope.origin !== scope.origin || rowScope.accountId !== scope.accountId) continue
        live.host.setAgentModel(saved)
        live.inheritedModelSignature = modelSignature(saved)
      }
      return { modelDefaults: defaultView() }
    }),

    /**
     * Replace only this profile's Worker Connection key.
     *
     * The manager binds the request to the account page that opened it and to the profile's
     * already-issued Agent/Connection pair. The instance host then proves the new key to that
     * same Work origin before its atomic config write. No secret crosses the registry or a
     * status response, and a key for another Connection cannot become this Worker's key.
     */
    setConnectionKey: (id, body = {}) => admit(() => lifecycle(id, async () => {
      const scope = assertExpectedScope(body)
      const row = record(id)
      assertRowScope(row, scope)
      const agentId = text(body.expectedAgentId), connectionId = text(body.expectedConnectionId)
      if (!agentId || !connectionId || row.agentId !== agentId || row.connectionId !== connectionId) {
        throw new Error('The Agent or Connection changed. Reopen its details before replacing the Connection key.')
      }
      const refusal = grantRefusal(id, { requirePaired: true, grant: scope.grant, row })
      if (refusal !== null) throw new Error(refusal)
      const key = text(body.key)
      if (key.trim() === '') throw new Error('Enter the replacement Connection key.')
      const { host } = await ensureHostLocked(id)
      const answer = await localCall(host, '/setup/connection-key', { expectedOrigin: scope.origin, expectedAccountId: scope.accountId,
        expectedAgentId: agentId, expectedConnectionId: connectionId, key })
      if (answer.status !== 200 || answer.body.ok === false) {
        // A hostile Work service must not reflect a submitted secret through its teaching text
        // into this manager response.
        throw new Error(`Instance ${row.name} could not verify the replacement Connection key. Nothing was saved.`)
      }
      if (text(answer.body.agentId) !== agentId || text(answer.body.connectionId) !== connectionId) {
        throw new Error('The replacement key verification did not confirm this Agent and Connection.')
      }
      return { instanceId: id, agentId, connectionId, keyConfigured: true,
        teaching: 'Connection key saved. The Worker reloads automatically after running executions drain.' }
    })),

    setInstanceModel: (id, body = {}) => admit(() => lifecycle(id, async () => {
      const scope = assertExpectedScope(body)
      const row = record(id)
      assertRowScope(row, scope)
      if (row.mode !== 'local_agent') throw new Error(`Instance ${row.name} uses an existing client for its Agent, so it has no model of its own to configure.`)
      if (!['default', 'custom'].includes(body.source)) throw new Error('Choose the account default model or a custom model.')
      if (body.source === 'default') {
        if (['url', 'name', 'key', 'clearKey', 'thinking', 'maxOutputTokens'].some(field => body[field] !== undefined)) {
          throw new Error('A default model selection does not accept custom model fields.')
        }
        await registry.patchInstance(id, () => ({ modelSource: 'default' }))
        const live = hosts.get(id)
        const inherited = defaultFor(record(id), scope.grant)
        if (live !== undefined) {
          live.host.setAgentModel(inherited ?? {})
          live.inheritedModelSignature = modelSignature(inherited ?? {})
        }
        return { instanceId: id, model: publicModel(record(id)),
          teaching: 'Model settings saved. The Agent applies them automatically between turns.' }
      }
      const input = checkedModelInput(body)
      // Leaving account inheritance is not a transfer of the account default credential.
      // Only a profile that was already custom may retain its own key across a same-service
      // edit. A new custom remote endpoint therefore needs an explicitly entered key.
      const previous = modelSource(row) === 'custom' ? modelFor(row, scope.grant) : undefined
      const key = resolvedKey(previous, input.url, input)
      const budget = body.maxOutputTokens === undefined ? maxOutputTokens(previous?.maxOutputTokens) : input.maxOutputTokens
      const live = hosts.get(id)
      if (live === undefined) {
        const directory = resolve(row.directory), config = loadInstanceConfig(directory)
        config.agent = { ...config.agent, env: { ...config.agent.env, RULITH_MODEL_URL: input.url, RULITH_MODEL: input.name,
          RULITH_MODEL_KEY: key, RULITH_MODEL_THINKING: ['enabled', 'disabled'].includes(input.thinking) ? input.thinking : '' } }
        config.agent.env.RULITH_MODEL_MAX_OUTPUT_TOKENS = String(budget)
        saveInstanceConfig(directory, config)
        await registry.patchInstance(id, () => ({ modelSource: 'custom' }))
      } else {
        const answer = await localCall(live.host, '/setup/model', { url: input.url, name: input.name,
          // `key` is resolved above from the persistent source selected by this operation.
          // Tell Setup that empty is final: letting its live host resolve an empty value again
          // would retain an old custom key after default → custom switched this profile away.
          key, clearKey: key === '', thinking: input.thinking, maxOutputTokens: budget })
        if (answer.status !== 200 || answer.body.ok === false) throw new Error(text(answer.body.teaching) || `Instance ${row.name} did not accept the model configuration.`)
      }
      return { instanceId: id, model: publicModel(record(id)), teaching: 'Model settings saved. The Agent restarts automatically between turns.' }
    })),

    create: ({ name, mode = 'local_agent', setupTarget } = {}) => admit(async () => {
      if (!INSTANCE_MODES.includes(mode)) throw new Error('Choose the local Agent, or an existing client using this environment\'s tools.')
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
        // A new Agent has nothing of its own to carry over, so it starts on the environment's tools.
        result = { id, name: display, mode, directory, servePort, createdAt: new Date().toISOString(), tools: { source: 'library', conflicts: [] },
          ...(target ? { setupTarget: target } : {}),
          ...(target && mode === 'local_agent' ? { modelSource: 'default' } : {}) }
        state.instances.push(result)
        return state
      })
      return { id: result.id, name: result.name, mode: result.mode, directory: result.directory, servePort: result.servePort }
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
    setWorkerEnabled: (id, enabled) => admit(() => lifecycle(id, async () => {
      const refusal = grantRefusal(id, { requirePaired: true })
      if (refusal !== null) throw new Error(refusal)
      const { host } = await ensureHostLocked(id)
      const answer = await localCall(host, '/worker-setting', { enabled })
      if (!answer.body.ok) throw new Error(answer.body.teaching)
      return { instanceId: id, ...answer.body }
    })),
    restoreWorkers: () => admit(async () => {
      for (const row of registry.read().instances) {
        if (grantRefusal(row.id, { requirePaired: true }) !== null) continue
        if (loadInstanceConfig(resolve(row.directory)).worker.enabled !== true) continue
        await lifecycle(row.id, () => ensureHostLocked(row.id))
      }
    }),

    /**
     * Stop this instance's roles, then close its host.
     *
     * Graceful drain is bounded for an explicit stop. Then only this host's owned child
     * may be killed; an observed exit decides the result and permits closing the host.
     */
    stop: (id, { close = true, forceAfterDrain = true } = {}) => lifecycle(id, async () => {
      const live = hosts.get(id)
      if (live === undefined) return { instanceId: id, results: [], stopped: true, open: false }
      const results = []
      for (const role of runningRoles(id)) {
        const answer = await live.host.stopRole(role, { forceAfterDrain })
        results.push({ role, status: answer.status, state: text(answer.body.state) || 'unknown',
          ok: answer.body.ok === true && answer.body.state === 'stopped', forced: answer.body.forced === true,
          teaching: text(answer.body.teaching) })
      }
      const stopped = results.every((row) => row.ok)
      if (stopped && close) await closeHostLocked(id)
      else await recordRuntime(id)
      return { instanceId: id, results, stopped, open: hosts.has(id) }
    }),

    closeHost: (id, options) => lifecycle(id, () => closeHostLocked(id, options)),

    /**
     * Attach one instance to one currently enabled Agent from this account.
     *
     * The ordinary pairing runs unchanged — a fresh per-instance proof and key, the same
     * `/local-setup` start, poll and acknowledge — and the device grant only *approves* it.
     * Nothing about the device token reaches the instance, and the Agent credential is
     * delivered encrypted to the key this instance just generated.
     */
    pair: (id, { agentId, replaceAgentToken = false, reconnectConnectionId } = {}) => admit(() => lifecycle(id, async () => {
      const grant = device.peek()
      if (grant.state !== 'linked') throw new Error('Sign in to a Rulith account from the manager before attaching an Agent.')
      const chosen = text(agentId).trim()
      const known = (grant.agents ?? []).find((row) => row.id === chosen)
      if (known === undefined) throw new Error('Choose one of the enabled Agents in this account. Refresh Agents if Console changed it.')
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
        replaceAgentToken: replaceAgentToken === true,
        ...(text(reconnectConnectionId) ? { reconnectConnectionId } : {}) }
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
        if (started.status !== 200 || started.body.ok === false) throw Object.assign(new Error(text(started.body.teaching) || 'This instance could not start a pairing.'), { errorCode: started.body.errorCode })
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
        await rememberPairingError(id, error).catch(() => undefined)
        throw Object.assign(new Error(String(error?.message ?? error)
          + ` The attachment of ${known.name} to ${row.name} is still reserved: retry it, or cancel it, from the manager.`), { errorCode: error?.errorCode })
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
          + ' Nothing was cleared here. Sign out and stop this environment, or revoke this device in Console, before connecting again.')
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
    pairPoll: (id) => admit(() => lifecycle(id, async () => {
      try { return await manager.__pairPoll(id) } catch (error) {
        await rememberPairingError(id, error).catch(() => undefined)
        throw error
      }
    })),

    __pairPoll: async (id) => {
      const row = record(id)
      const reservation = row.pairing
      if (reservation === undefined) throw new Error(`Instance ${row.name} has no attachment in progress.`)
      const grant = device.peek()
      if (text(grant.origin) !== reservation.origin || text(grant.account?.id) !== reservation.accountId) {
        throw new Error(`Instance ${row.name} reserved an Agent under a different account or Console address than the one signed in now. Attach it again.`)
      }
      const { host } = await ensureHostLocked(id)
      let polled = await localCall(host, '/setup/pair/poll', {})
      // Collect first: an approval may have succeeded even if its receipt was lost, and its
      // delivery can still be available after the local code deadline. Only an unapproved
      // reply (or an unknown original start) retries start with the retained proof. The setup
      // service itself requires confirmed cancellation before replacing any expired request.
      const waiting = polled.status === 200 && ['waiting', 'pending', 'not_started', 'expired'].includes(polled.body.state)
      if (!reservation.approvedAt && (waiting || ['local_setup_unknown', 'local_setup_expired'].includes(polled.body.errorCode))) {
        const started = await localCall(host, '/setup/pair/start', {
          consoleUrl: reservation.origin, name: row.name,
          clientMode: reservation.clientMode ?? (row.mode === 'existing_client' ? 'existing_agent' : 'local_agent'),
        })
        if (started.status !== 200 || started.body.ok === false) throw Object.assign(
          new Error(text(started.body.teaching) || 'This instance could not finish connecting.'), { errorCode: started.body.errorCode })
        polled = await localCall(host, '/setup/pair/poll', {})
      }
      if (polled.status !== 200 || polled.body.ok === false) throw Object.assign(new Error(text(polled.body.teaching) || 'The pairing result could not be confirmed.'), { errorCode: polled.body.errorCode })
      const saved = readJson(host.configFile + '.setup.json', {})
      const delivered = text(saved.agentId)
      if (delivered === '') {
        await registry.patchInstance(id, entry => entry.pairing
          ? { pairing: { ...entry.pairing, lastError: undefined } } : {}).catch(() => undefined)
        return { instanceId: id, state: text(polled.body.state) || 'pending', agentId: '' }
      }
      if (delivered !== reservation.agentId) {
        throw new Error(`Instance ${row.name} was delivered Agent ${delivered}, which is not the ${reservation.agentId} it reserved. No identity was recorded.`)
      }
      await registry.patchInstance(id, (entry) => {
        delete entry.pairing
        return { origin: reservation.origin, accountId: reservation.accountId, agentId: delivered,
          agentName: reservation.agentName, connectionId: text(saved.connectionId), signedOutAt: '' }
      })
      // 配对前的 host 没有已认证账号归属；重新打开后才可加载这个 Agent 的历史。
      await closeHostLocked(id)
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
     * The host stays open and keeps ownership of its children. Applying the change through
     * its `/setup/model` route updates the live configuration and reloads the Agent between
     * turns and the Worker after execution drain. A running role needs no manual stop.
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
        assertRowScope(row, currentScope(grant))
      }
      const from = modelFor(source, grant)
      if (!text(from.url).trim() || !text(from.name).trim()) {
        throw new Error(`Instance ${source.name} has no model endpoint and name configured yet.`)
      }
      // Copy the resolved model even when the source inherits it. Empty fields also replace
      // the target: an absent source key must never retain the target's previous provider key.
      const applied = { RULITH_MODEL_URL: from.url, RULITH_MODEL: from.name,
        RULITH_MODEL_KEY: text(from.key), RULITH_MODEL_THINKING: ['enabled', 'disabled'].includes(from.thinking) ? from.thinking : '',
        RULITH_MODEL_MAX_OUTPUT_TOKENS: String(maxOutputTokens(from.maxOutputTokens)) }
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
          clearKey: !text(applied.RULITH_MODEL_KEY).trim(),
          thinking: ['enabled', 'disabled'].includes(applied.RULITH_MODEL_THINKING) ? applied.RULITH_MODEL_THINKING : 'standard',
          maxOutputTokens: Number(applied.RULITH_MODEL_MAX_OUTPUT_TOKENS),
        })
        if (answer.status !== 200 || answer.body.ok === false) {
          throw new Error(text(answer.body.teaching) || `Instance ${target.name} did not accept the model configuration.`)
        }
      }
      await registry.patchInstance(id, () => ({ modelSource: 'custom' }))
      return { instanceId: id, from: source.id,
        modelService: applied.RULITH_MODEL_URL, model: applied.RULITH_MODEL,
        modelKeyCopied: text(applied.RULITH_MODEL_KEY).trim() !== '' }
    },

    /**
     * Remove an instance from the registry without touching its directory.
     *
     * Deleting credentials and history because somebody tidied a list is not a tidy-up, so
     * the files stay and the instance can be imported again from its own directory.
     */
    forget: (id) => admit(() => lifecycle(id, () => manager.__forget(id))),

    __forget: async (id) => {
      const host = hosts.get(id)?.host
      const results = []
      for (const role of runningRoles(id)) {
        const answer = await host.stopRole(role, { forceAfterDrain: true })
        results.push({ role, state: answer.body.state, forced: answer.body.forced === true, teaching: text(answer.body.teaching) })
      }
      if (runningRoles(id).length > 0) throw new Error('The owned processes have been asked to end after the graceful drain bound, but their exit has not been observed. Nothing was removed; check Trace and retry.')
      await closeHostLocked(id)
      const row = record(id)
      await registry.update((state) => { state.instances = state.instances.filter((entry) => entry.id !== id); return state })
      return { instanceId: id, directory: row.directory, results,
        ...(results.some(row => row.forced) ? { teaching: 'Owned processes were killed after the graceful drain bound and their exits were observed. The instance directory was kept. Work already handed to Rulith may still be running; check Console.' } : {}) }
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
        if (phase === 'signing_out') { phase = 'ready'; await resumeWorkers() }
      }
    },

    __signOut: async () => {
      const state = registry.read()
      const running = []
      const stops = []
      for (const row of state.instances) {
        if (hosts.has(row.id)) {
          const result = await manager.stop(row.id)
          stops.push({ id: row.id, name: row.name, results: result.results })
          if (!result.stopped) running.push({ id: row.id, name: row.name, results: result.results })
        } else {
          const results = survivingProcesses(row)
          if (results.length > 0) running.push({ id: row.id, name: row.name, results })
        }
      }
      if (running.length > 0) {
        const progress = { state: 'incomplete', step: 'stop', at: new Date().toISOString(), instances: running.map((row) => row.name) }
        await device.noteSignOut(progress)
        return { state: 'incomplete', step: 'stop', running, stops,
          teaching: `Still running: ${stillRunning(running)}. This device was not revoked and is still signed in. Stop them and sign out again.` }
      }
      // Asked again, right before the irreversible step. The drain is what makes this
      // unreachable; checking anyway is what makes "nothing was running when this device was
      // revoked" a fact this code verified rather than one it inferred from its own design.
      const late = registry.read().instances.filter((row) => runningRoles(row.id).length > 0 || survivingProcesses(row).length > 0)
      if (late.length > 0) {
        const lateRunning = late.map((row) => ({ id: row.id, name: row.name, results: survivingProcesses(row) }))
        return { state: 'incomplete', step: 'stop', running: lateRunning, stops,
          teaching: `Started running while this sign-out was in progress: ${stillRunning(lateRunning)}. This device was not revoked.`
            + ' Nothing was revoked and nothing was cleared; sign out again.' }
      }
      let revoked
      try { revoked = await device.revoke() } catch (error) {
        const progress = { state: 'incomplete', step: 'revoke', at: new Date().toISOString(), teaching: String(error?.message ?? error) }
        await device.noteSignOut(progress)
        return { state: 'incomplete', step: 'revoke', stops, teaching: 'Every instance stopped, but the account service did not confirm the revocation, so this device is still signed in. Retry sign-out: it repeats the same revoke request.' + ` (${String(error?.message ?? error)})` }
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
      return { state: 'signed_out', revokeState: revoked.state, alreadyRevoked: revoked.alreadyRevoked === true, cleared, stops,
        ...(stops.some(row => row.results.some(result => result.forced)) ? { teaching: 'Signed out. Owned processes were killed after the graceful drain bound and their exits were observed before revocation. Work already handed to Rulith may still be running; check Console.' } : {}) }
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
        if (phase === 'signing_out') { phase = 'ready'; await resumeWorkers() }
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
      const stops = []
      for (const row of registry.read().instances) {
        if (hosts.has(row.id)) {
          const result = await manager.stop(row.id)
          stops.push({ id: row.id, name: row.name, results: result.results })
          if (!result.stopped) running.push({ id: row.id, name: row.name, results: result.results })
        } else {
          const results = survivingProcesses(row)
          if (results.length > 0) running.push({ id: row.id, name: row.name, results })
        }
      }
      if (running.length > 0) {
        return { state: 'incomplete', step: 'stop', running, stops,
          teaching: `Still running: ${stillRunning(running)}. Stop them before clearing the credentials this authorization issued.` }
      }
      const late = registry.read().instances.filter((row) => runningRoles(row.id).length > 0 || survivingProcesses(row).length > 0)
      if (late.length > 0) {
        const lateRunning = late.map((row) => ({ id: row.id, name: row.name, results: survivingProcesses(row) }))
        return { state: 'incomplete', step: 'stop', running: lateRunning, stops,
          teaching: `Still running: ${stillRunning(lateRunning)}. Nothing was revoked or cleared; stop them and retry.` }
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
      return { state: 'none', cleared, revoke, stops,
        ...(revoke === 'unconfirmed'
          ? { teaching: `The credentials this authorization issued were cleared from every instance, and the account service did not confirm the revocation (${revokeTeaching}). It had already refused this device, so nothing here can still execute; check the device list in Console.` }
          : revoke === 'unreadable'
            ? { teaching: 'The device record could not be read, so the credential that would have revoked this device could not be used.'
                + ' Every instance was stopped and the credentials it issued were cleared from this environment; revoke this device in Console to withdraw it there.' }
            : stops.some(row => row.results.some(result => result.forced))
              ? { teaching: 'The authorization was cleared after owned processes were killed at the graceful drain bound and their exits were observed. Work already handed to Rulith may still be running; check Console.' }
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
      // A marker re-check started by the page's last poll finishes before anything closes, so no
      // registry edit from this workbench is still in flight after it has shut down.
      await orphanRecheck
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
      // The environment's own installs and discovery are the last thing in flight, and nothing
      // that could start one is admitted any more.
      await library.close()
      // Reported, not swallowed. A shutdown that could not record what it still owns, or that
      // left a child running, is a thing the next run needs to know and the operator may need
      // to act on; `close()` returning quietly would be this manager's last untrue statement.
      return { unobserved, failures }
    },
  }
  return manager
}
